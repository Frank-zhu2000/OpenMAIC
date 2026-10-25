import { describe, expect, it } from 'vitest';

import {
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
});
