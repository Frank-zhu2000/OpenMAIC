/**
 * Shared TTS utilities used by both client-side and server-side generation.
 */

import type { TTSProviderId } from './types';
import type { Action, SpeechAction } from '@/lib/types/action';
import { createLogger } from '@/lib/logger';

const log = createLogger('TTS');

/** Provider-specific max text length limits. */
export const TTS_MAX_TEXT_LENGTH: Partial<Record<TTSProviderId, number>> = {
  'glm-tts': 1024,
};

/**
 * Spoken readings for Greek letters. Captions, the HTML player, and narration
 * export keep the symbol; only the string sent to a TTS engine is rewritten.
 * ASCII `e` is intentionally absent — it is already a letter, and rewriting it
 * would change ordinary words.
 *
 * Each row is `letters`, Chinese reading, English reading. Variant glyphs
 * (final sigma, lunate epsilon, and the math forms of theta/phi/pi/rho) share
 * the letter's reading.
 */
const GREEK_READINGS: ReadonlyArray<readonly [string, string, string]> = [
  ['Αα', '阿尔法', 'alpha'],
  ['Ββ', '贝塔', 'beta'],
  ['Γγ', '伽马', 'gamma'],
  ['Δδ', '德尔塔', 'delta'],
  ['Εεϵ', '艾普西龙', 'epsilon'],
  ['Ζζ', '泽塔', 'zeta'],
  ['Ηη', '伊塔', 'eta'],
  ['Θθϑ', '西塔', 'theta'],
  ['Ιι', '约塔', 'iota'],
  ['Κκ', '卡帕', 'kappa'],
  ['Λλ', '拉姆达', 'lambda'],
  ['Μμ', '缪', 'mu'],
  ['Νν', '纽', 'nu'],
  ['Ξξ', '克西', 'xi'],
  ['Οο', '奥密克戎', 'omicron'],
  ['Ππϖ', '派', 'pi'],
  ['Ρρϱ', '柔', 'rho'],
  ['Σσς', '西格玛', 'sigma'],
  ['Ττ', '陶', 'tau'],
  ['Υυ', '宇普西龙', 'upsilon'],
  ['Φφϕ', '斐', 'phi'],
  ['Χχ', '凯', 'chi'],
  ['Ψψ', '普西', 'psi'],
  ['Ωω', '欧米伽', 'omega'],
];

function greekReadingTable(column: 1 | 2): Record<string, string> {
  const table: Record<string, string> = {};
  for (const row of GREEK_READINGS) {
    for (const symbol of row[0]) table[symbol] = row[column];
  }
  return table;
}

const ZH_GREEK_READING = greekReadingTable(1);
const EN_GREEK_READING = greekReadingTable(2);
const GREEK_LETTER_RE = new RegExp(`[${Object.keys(ZH_GREEK_READING).join('')}]`, 'gu');
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/u;

/**
 * Rewrite Greek letters into a spoken reading for TTS only.
 *
 * Chinese narration (any Han character) uses the classroom reading, so `π`
 * becomes `派`. Other narration uses the English letter name (`pi`), with a
 * space inserted when the symbol sits against an ASCII letter or digit so
 * `2πr` is not spoken as one glued token. Text that already uses a homophone
 * is left unchanged — this does not repair captions that were generated before
 * the symbol-form prompt.
 */
export function normalizeMathSymbolsForTts(text: string): string {
  if (!text) return text;
  GREEK_LETTER_RE.lastIndex = 0;
  if (!GREEK_LETTER_RE.test(text)) return text;
  GREEK_LETTER_RE.lastIndex = 0;

  const chinese = HAN_RE.test(text);
  const table = chinese ? ZH_GREEK_READING : EN_GREEK_READING;
  return text.replace(GREEK_LETTER_RE, (symbol, offset) => {
    const word = table[symbol] ?? symbol;
    if (chinese || word === symbol) return word;
    const prev = offset > 0 ? text[offset - 1] : '';
    const next = text[offset + symbol.length] ?? '';
    const lead = prev && /[A-Za-z0-9]/.test(prev) ? ' ' : '';
    const trail = next && /[A-Za-z0-9]/.test(next) ? ' ' : '';
    return `${lead}${word}${trail}`;
  });
}

/**
 * Split long text into chunks that respect sentence boundaries.
 * Tries splitting at sentence-ending punctuation first, then clause-level
 * punctuation, and finally hard-splits at maxLength as a last resort.
 */
export function splitLongSpeechText(text: string, maxLength: number): string[] {
  const normalized = text.trim();
  if (!normalized || normalized.length <= maxLength) return [normalized];

  const units = normalized
    .split(/(?<=[。！？!?；;：:\n])/u)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  const pushChunk = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) chunks.push(trimmed);
  };

  const appendUnit = (unit: string) => {
    if (!current) {
      current = unit;
      return;
    }
    if ((current + unit).length <= maxLength) {
      current += unit;
      return;
    }
    pushChunk(current);
    current = unit;
  };

  const hardSplitUnit = (unit: string) => {
    const parts = unit.split(/(?<=[，,、])/u).filter(Boolean);
    if (parts.length > 1) {
      for (const part of parts) {
        if (part.length <= maxLength) appendUnit(part);
        else hardSplitUnit(part);
      }
      return;
    }

    let start = 0;
    while (start < unit.length) {
      appendUnit(unit.slice(start, start + maxLength));
      start += maxLength;
    }
  };

  for (const unit of units.length > 0 ? units : [normalized]) {
    if (unit.length <= maxLength) appendUnit(unit);
    else hardSplitUnit(unit);
  }

  pushChunk(current);
  return chunks;
}

/**
 * Split long speech actions into multiple shorter actions so each stays
 * within the TTS provider's text length limit. Each sub-action gets its
 * own independent audio file — no byte concatenation needed.
 */
export function splitLongSpeechActions(actions: Action[], providerId: TTSProviderId): Action[] {
  const maxLength = TTS_MAX_TEXT_LENGTH[providerId];
  if (!maxLength) return actions;

  let didSplit = false;
  const nextActions: Action[] = actions.flatMap((action) => {
    if (action.type !== 'speech' || !action.text || action.text.length <= maxLength)
      return [action];

    const chunks = splitLongSpeechText(action.text, maxLength);
    if (chunks.length <= 1) return [action];
    didSplit = true;
    const { audioId: _audioId, ...baseAction } = action as SpeechAction;

    log.info(
      `Split speech for ${providerId}: action=${action.id}, len=${action.text.length}, chunks=${chunks.length}`,
    );
    return chunks.map((chunk, i) => ({
      ...baseAction,
      id: `${action.id}_tts_${i + 1}`,
      text: chunk,
    }));
  });
  return didSplit ? nextActions : actions;
}
