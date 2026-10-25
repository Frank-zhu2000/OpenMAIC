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
 * Hiragana and katakana letters, iteration marks, and the prolonged sound mark.
 * U+30FB (・) and the other punctuation in U+3040–U+30FF are excluded so a
 * Chinese name such as 马丁・路德・金 is not treated as Japanese.
 * Checked before Han, as in detectLegacyLanguage.
 */
const KANA_RE = /[\u3041-\u3096\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff]/u;
const GREEK_CHAR = new Set(Object.keys(ZH_GREEK_READING));

function primarySpeechSubtag(language: string): string {
  return language.trim().toLowerCase().replace(/_/g, '-').split('-')[0] ?? '';
}

/** zh, zh-CN, zh-TW, zh-HK, zh-Hans, and cmn are Chinese speech locales. */
function isChineseSpeechLang(language: string): boolean {
  const primary = primarySpeechSubtag(language);
  return primary === 'zh' || primary === 'cmn';
}

function isJapaneseSpeechLang(language: string): boolean {
  return primarySpeechSubtag(language) === 'ja';
}

function isGreekSpeechLang(language: string): boolean {
  return primarySpeechSubtag(language) === 'el';
}

/**
 * Chinese readings for a zh locale, or — when the caller did not pass ja —
 * for Han text that contains no kana. Kana never selects 派, including when a
 * voice tag says zh. Any other locale keeps that script check, so Chinese
 * narration on an English-tagged voice still says 派.
 */
function prefersChineseGreekReading(text: string, language?: string): boolean {
  if (KANA_RE.test(text)) return false;
  if (language && isJapaneseSpeechLang(language)) return false;
  if (language && isChineseSpeechLang(language)) return true;
  return HAN_RE.test(text);
}

/**
 * Rewrite Greek letters into a spoken reading for TTS only.
 *
 * Pass `language` when the caller knows the voice or speech locale (`ja-JP`,
 * `zh-CN`). Chinese narration uses the classroom reading, so `π` becomes `派`.
 * Japanese and other narration use the English letter name (`pi`), except Greek
 * (`el`), which is left unchanged. A space is added when the name sits against an
 * ASCII letter, a digit, or another Greek letter so `2πr` and `αβ` are not spoken
 * as one glued token. Text that
 * already uses a homophone is left unchanged — symbol-form output is best-effort,
 * and this does not repair a caption that already says 派.
 */
export function normalizeMathSymbolsForTts(text: string, language?: string): string {
  if (!text) return text;
  // A Greek voice already pronounces Greek letters. The English table would
  // spell ordinary words out ("eta tau…") because those letters are also
  // math symbols.
  if (language && isGreekSpeechLang(language)) return text;
  GREEK_LETTER_RE.lastIndex = 0;
  if (!GREEK_LETTER_RE.test(text)) return text;
  GREEK_LETTER_RE.lastIndex = 0;

  const chinese = prefersChineseGreekReading(text, language);
  const table = chinese ? ZH_GREEK_READING : EN_GREEK_READING;
  return text.replace(GREEK_LETTER_RE, (symbol, offset) => {
    const word = table[symbol] ?? symbol;
    if (chinese || word === symbol) return word;
    const prev = offset > 0 ? text[offset - 1] : '';
    const next = text[offset + symbol.length] ?? '';
    const lead = prev && (/[A-Za-z0-9]/.test(prev) || GREEK_CHAR.has(prev)) ? ' ' : '';
    const trail = next && /[A-Za-z0-9]/.test(next) ? ' ' : '';
    return `${lead}${word}${trail}`;
  });
}

/**
 * Split long text into chunks that respect sentence boundaries.
 * Tries splitting at sentence-ending punctuation first, then clause-level
 * punctuation, and finally hard-splits as a last resort.
 * `lengthOf` defaults to the raw length. A spoken-length measure keeps each
 * returned piece of the original text within the provider limit after symbol
 * expansion.
 */
export function splitLongSpeechText(
  text: string,
  maxLength: number,
  lengthOf: (value: string) => number = (value) => value.length,
): string[] {
  const normalized = text.trim();
  if (!normalized || lengthOf(normalized) <= maxLength) return [normalized];

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
    if (lengthOf(current + unit) <= maxLength) {
      current += unit;
      return;
    }
    pushChunk(current);
    current = unit;
  };

  const fittingPrefixLength = (unit: string): number => {
    if (lengthOf(unit) <= maxLength) return unit.length;
    let low = 1;
    let high = unit.length - 1;
    let best = 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (lengthOf(unit.slice(0, mid)) <= maxLength) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  };

  const hardSplitUnit = (unit: string) => {
    const parts = unit.split(/(?<=[，,、])/u).filter(Boolean);
    if (parts.length > 1) {
      for (const part of parts) {
        if (lengthOf(part) <= maxLength) appendUnit(part);
        else hardSplitUnit(part);
      }
      return;
    }

    let start = 0;
    while (start < unit.length) {
      const size = fittingPrefixLength(unit.slice(start));
      appendUnit(unit.slice(start, start + size));
      start += Math.max(size, 1);
    }
  };

  for (const unit of units.length > 0 ? units : [normalized]) {
    if (lengthOf(unit) <= maxLength) appendUnit(unit);
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

  // Longest spoken form. Han with no kana makes an `en` probe use the shorter
  // Chinese reading (π → 派), while a ja voice says pi / alpha. Measure `ja`
  // as well as `zh`. A Greek voice does not expand. The stored chunk stays the
  // original caption, so the symbol is not written back as a word.
  const lengthOf = (value: string) =>
    Math.max(
      normalizeMathSymbolsForTts(value, 'zh').length,
      normalizeMathSymbolsForTts(value, 'ja').length,
    );

  let didSplit = false;
  const nextActions: Action[] = actions.flatMap((action) => {
    if (action.type !== 'speech' || !action.text || lengthOf(action.text) <= maxLength)
      return [action];

    const chunks = splitLongSpeechText(action.text, maxLength, lengthOf);
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
