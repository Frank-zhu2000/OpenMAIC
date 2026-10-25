import { describe, expect, it } from 'vitest';

import {
  normalizeMathSymbolsForTts,
  splitLongSpeechText,
  splitLongSpeechActions,
  TTS_MAX_TEXT_LENGTH,
} from '@/lib/audio/tts-utils';
import type { Action, SpeechAction } from '@/lib/types/action';

describe('splitLongSpeechText', () => {
  it('returns the trimmed text unchanged when within the limit', () => {
    expect(splitLongSpeechText('  hello world  ', 100)).toEqual(['hello world']);
  });

  it('splits at sentence boundaries, keeping the punctuation', () => {
    expect(splitLongSpeechText('句子一。句子二！句子三？', 6)).toEqual([
      '句子一。',
      '句子二！',
      '句子三？',
    ]);
  });

  it('packs consecutive short sentences up to the limit', () => {
    const out = splitLongSpeechText('aa。bb。cc。dd。', 6);
    expect(out).toEqual(['aa。bb。', 'cc。dd。']);
    expect(out.join('')).toBe('aa。bb。cc。dd。');
  });

  it('falls back to clause punctuation for an over-long sentence', () => {
    const out = splitLongSpeechText('一，二，三，四，五', 4);
    expect(out.every((c) => c.length <= 4)).toBe(true);
    expect(out.join('').replace(/，/g, '')).toContain('一');
  });

  it('hard-splits a long run with no punctuation', () => {
    expect(splitLongSpeechText('x'.repeat(25), 10)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });

  it('never emits a chunk longer than maxLength, nor an empty chunk (invariant)', () => {
    const text = '这是一个很长的句子，包含很多子句、标点。'.repeat(50) + 'z'.repeat(120);
    for (const max of [8, 16, 64, 200]) {
      const out = splitLongSpeechText(text, max);
      expect(
        out.every((c) => c.length <= max),
        `max=${max}`,
      ).toBe(true);
      expect(
        out.some((c) => c.length === 0),
        `max=${max}`,
      ).toBe(false);
    }
  });

  it('keeps whitespace after sentence delimiters on the following unit', () => {
    const text = '甲。 乙！ 丙？ 丁! 戊； 己; 庚： 辛: 壬\n 癸';
    const out = splitLongSpeechText(text, 4);
    expect(out.join('')).toBe(text);
    expect(out.every((chunk) => chunk.length <= 4)).toBe(true);
    expect(out.some((chunk) => chunk.length === 0)).toBe(false);
  });

  it('keeps a newline that fits on neither neighboring sentence', () => {
    const left = '字'.repeat(8) + '。';
    const right = '字'.repeat(9);
    const text = `${left}\n${right}`;
    const out = splitLongSpeechText(text, left.length);
    expect(out.join('')).toBe(text);
    expect(out.every((chunk) => chunk.length <= left.length)).toBe(true);
    expect(out.some((chunk) => chunk.length === 0)).toBe(false);
  });
});

describe('splitLongSpeechActions', () => {
  const speech = (id: string, text: string): SpeechAction =>
    ({ id, type: 'speech', text }) as SpeechAction;

  it('returns actions untouched for a provider with no length limit', () => {
    const actions: Action[] = [speech('a', 'x'.repeat(5000))];
    expect(splitLongSpeechActions(actions, 'openai-tts')).toBe(actions);
  });

  it('leaves short speech and non-speech actions unchanged', () => {
    const actions: Action[] = [speech('s', 'short'), { id: 'sp', type: 'spotlight' } as Action];
    expect(splitLongSpeechActions(actions, 'glm-tts')).toBe(actions);
  });

  it('splits an over-limit speech action into chunked sub-actions', () => {
    const max = TTS_MAX_TEXT_LENGTH['glm-tts']!; // 1024
    const long = '句子。'.repeat(400); // 1200 chars > 1024
    const out = splitLongSpeechActions([speech('a', long)], 'glm-tts') as SpeechAction[];

    expect(out.length).toBeGreaterThan(1);
    expect(out.every((a) => a.type === 'speech' && a.text.length <= max)).toBe(true);
    // deterministic sub-action ids…
    expect(out.map((a) => a.id)).toEqual(out.map((_, i) => `a_tts_${i + 1}`));
    // …each gets its own audio (the parent audioId is dropped)…
    expect(out.every((a) => a.audioId === undefined)).toBe(true);
    // …and the text is preserved across the split.
    expect(out.map((a) => a.text).join('')).toBe(long);
  });

  it('splits a caption that fits the raw limit once Greek letters are spoken', () => {
    const max = TTS_MAX_TEXT_LENGTH['glm-tts']!;
    const text = `${'x'.repeat(max - 1)}α`;
    const actions: Action[] = [speech('a', text)];
    const out = splitLongSpeechActions(actions, 'glm-tts') as SpeechAction[];

    expect(text.length).toBe(max);
    expect(out.length).toBeGreaterThan(1);
    expect(out.map((action) => action.text).join('')).toBe(text);
    expect(out.every((action) => action.id.startsWith('a_tts_'))).toBe(true);
    for (const chunk of out.map((action) => action.text)) {
      expect(chunk.includes('阿尔法') || chunk.includes('alpha')).toBe(false);
      const hasAlpha = chunk.includes('α');
      // 阿尔法 replaces α (+2). A preceding letter makes the English reading " alpha" (+5).
      expect(chunk.length + (hasAlpha ? 2 : 0)).toBeLessThanOrEqual(max);
      expect(chunk.length + (hasAlpha ? 5 : 0)).toBeLessThanOrEqual(max);
    }
  });

  it('does not split a limit-length caption that has no expandable symbol', () => {
    const text = 'x'.repeat(TTS_MAX_TEXT_LENGTH['glm-tts']!);
    const actions: Action[] = [speech('a', text)];
    expect(splitLongSpeechActions(actions, 'glm-tts')).toBe(actions);
  });

  it('splits a Han caption that fits in Chinese once the Japanese reading exceeds the limit', () => {
    const max = TTS_MAX_TEXT_LENGTH['glm-tts']!;
    // 1024 characters. 派 is one character, so the Chinese reading stays 1024.
    // pi is two, so ja-JP is 1025. The en probe still selects the Chinese table.
    const text = `${'字'.repeat(max - 1)}π`;
    const actions: Action[] = [speech('a', text)];

    expect(text.length).toBe(max);
    expect(normalizeMathSymbolsForTts(text, 'zh').length).toBe(max);
    expect(normalizeMathSymbolsForTts(text, 'en').length).toBe(max);
    expect(normalizeMathSymbolsForTts(text, 'ja-JP').length).toBe(max + 1);

    const out = splitLongSpeechActions(actions, 'glm-tts') as SpeechAction[];
    expect(out.length).toBeGreaterThan(1);
    expect(out.map((action) => action.text).join('')).toBe(text);
    for (const chunk of out.map((action) => action.text)) {
      expect(chunk.includes('派') || chunk.includes('pi')).toBe(false);
      expect(normalizeMathSymbolsForTts(chunk, 'ja-JP').length).toBeLessThanOrEqual(max);
      expect(normalizeMathSymbolsForTts(chunk, 'zh').length).toBeLessThanOrEqual(max);
    }
  });

  it('keeps every Han chunk inside the Japanese spoken limit', () => {
    const max = TTS_MAX_TEXT_LENGTH['glm-tts']!;
    // 980 characters, no sentence break. Japanese reads 1139.
    const dense = `${'円'.repeat(900)}${'π'.repeat(80)}`;
    // 1250 characters. A raw split packs 1020, which Japanese reads as 1224.
    const repeated = '円周率π。'.repeat(250);

    expect(dense.length).toBeLessThanOrEqual(max);
    expect(normalizeMathSymbolsForTts(dense, 'ja').length).toBeGreaterThan(max);
    expect(normalizeMathSymbolsForTts(repeated, 'ja').length).toBeGreaterThan(max);

    for (const text of [dense, repeated]) {
      const out = splitLongSpeechActions([speech('a', text)], 'glm-tts') as SpeechAction[];
      expect(out.length).toBeGreaterThan(1);
      expect(out.map((action) => action.text).join('')).toBe(text);
      for (const chunk of out.map((action) => action.text)) {
        expect(normalizeMathSymbolsForTts(chunk, 'ja').length).toBeLessThanOrEqual(max);
        expect(normalizeMathSymbolsForTts(chunk, 'zh-CN').length).toBeLessThanOrEqual(max);
      }
    }
  });

  it('does not split a Han caption whose Japanese reading is exactly the limit', () => {
    const max = TTS_MAX_TEXT_LENGTH['glm-tts']!;
    const text = `${'字'.repeat(max - 2)}π`;
    const actions: Action[] = [speech('a', text)];

    expect(normalizeMathSymbolsForTts(text, 'ja-JP').length).toBe(max);
    expect(splitLongSpeechActions(actions, 'glm-tts')).toBe(actions);
  });

  it('keeps an internal space when a Greek caption is split for the spoken budget', () => {
    const max = TTS_MAX_TEXT_LENGTH['glm-tts']!;
    const sentence = 'Η τιμή του π είναι περίπου 3.14. ';
    let text = '';
    while (text.length < 363) text += sentence;
    text = text.slice(0, 363);
    const caption = text.trim();

    // Raw and Greek lengths fit. Japanese expansion of the letters does not,
    // so the ja budget splits a caption an el voice would have kept whole.
    expect(text.length).toBeLessThanOrEqual(max);
    expect(normalizeMathSymbolsForTts(text, 'el-GR').length).toBeLessThanOrEqual(max);
    expect(normalizeMathSymbolsForTts(text, 'ja').length).toBeGreaterThan(max);
    expect(caption.includes('Η τιμή')).toBe(true);

    const out = splitLongSpeechActions([speech('a', text)], 'glm-tts') as SpeechAction[];
    expect(out.length).toBeGreaterThan(1);
    // The hard cut lands on the space in "Η τιμή". That space has to stay in
    // some stored chunk. The outer trim of a final space is unchanged.
    expect(out.map((action) => action.text).join('')).toBe(caption);
    for (const chunk of out.map((action) => action.text)) {
      expect(chunk.includes('π')).toBe(true);
      expect(normalizeMathSymbolsForTts(chunk, 'ja').length).toBeLessThanOrEqual(max);
      expect(normalizeMathSymbolsForTts(chunk, 'zh').length).toBeLessThanOrEqual(max);
    }
  });

  it('uses the trimmed chunk when only outer padding exceeds the spoken budget', () => {
    const max = TTS_MAX_TEXT_LENGTH['glm-tts']!;
    const text = ` ${'字'.repeat(max - 2)}π\n`;
    const trimmed = text.trim();

    expect(text.length).toBe(max + 1);
    expect(normalizeMathSymbolsForTts(text, 'zh').length).toBe(max + 1);
    expect(normalizeMathSymbolsForTts(text, 'ja-JP').length).toBe(max + 2);
    expect(normalizeMathSymbolsForTts(trimmed, 'ja-JP').length).toBe(max);

    const out = splitLongSpeechActions([speech('a', text)], 'glm-tts') as SpeechAction[];
    expect(out.map((action) => action.text).join('')).toBe(trimmed);
    expect(out).toHaveLength(1);
    for (const chunk of out.map((action) => action.text)) {
      expect(chunk.includes('派') || chunk.includes('pi')).toBe(false);
      expect(normalizeMathSymbolsForTts(chunk, 'ja-JP').length).toBeLessThanOrEqual(max);
      expect(normalizeMathSymbolsForTts(chunk, 'zh').length).toBeLessThanOrEqual(max);
    }
  });

  it('keeps spaces after sentence punctuation when a caption is split for the spoken budget', () => {
    const max = TTS_MAX_TEXT_LENGTH['glm-tts']!;
    const text = `Hello!  ${'x'.repeat(max - 9)}α`;

    expect(text.length).toBe(max);
    expect(text.startsWith('Hello!  ')).toBe(true);
    expect(normalizeMathSymbolsForTts(text, 'zh').length).toBe(max + 2);
    expect(normalizeMathSymbolsForTts(text, 'ja').length).toBe(max + 5);

    const out = splitLongSpeechActions([speech('a', text)], 'glm-tts') as SpeechAction[];
    expect(out.length).toBeGreaterThan(1);
    expect(out.map((action) => action.text).join('')).toBe(text.trim());
    for (const chunk of out.map((action) => action.text)) {
      expect(chunk.includes('阿尔法') || chunk.includes('alpha')).toBe(false);
      expect(normalizeMathSymbolsForTts(chunk, 'ja').length).toBeLessThanOrEqual(max);
      expect(normalizeMathSymbolsForTts(chunk, 'zh').length).toBeLessThanOrEqual(max);
    }
  });

  it('keeps the space after a full stop when Japanese expansion crosses the limit', () => {
    const max = TTS_MAX_TEXT_LENGTH['glm-tts']!;
    const text = `${'甲'.repeat(400)}。 ${'乙'.repeat(621)}π`;

    expect(text.length).toBe(max);
    expect(text.includes('。 ')).toBe(true);
    expect(normalizeMathSymbolsForTts(text, 'zh').length).toBe(max);
    expect(normalizeMathSymbolsForTts(text, 'ja').length).toBe(max + 1);

    const out = splitLongSpeechActions([speech('a', text)], 'glm-tts') as SpeechAction[];
    expect(out.length).toBeGreaterThan(1);
    expect(out.map((action) => action.text).join('')).toBe(text.trim());
    for (const chunk of out.map((action) => action.text)) {
      expect(chunk.includes('派') || chunk.includes('pi')).toBe(false);
      expect(normalizeMathSymbolsForTts(chunk, 'ja').length).toBeLessThanOrEqual(max);
      expect(normalizeMathSymbolsForTts(chunk, 'zh').length).toBeLessThanOrEqual(max);
    }
  });
});
