import { describe, expect, it } from 'vitest';

import { normalizeMathSymbolsForTts } from '@/lib/audio/tts-utils';

describe('normalizeMathSymbolsForTts', () => {
  it.each([
    ['π', '派', 'pi'],
    ['θ', '西塔', 'theta'],
    ['α', '阿尔法', 'alpha'],
    ['β', '贝塔', 'beta'],
    ['λ', '拉姆达', 'lambda'],
    ['ω', '欧米伽', 'omega'],
    ['Σ', '西格玛', 'sigma'],
    ['Π', '派', 'pi'],
  ])('reads %s as %s in Chinese and %s in English', (symbol, zh, en) => {
    expect(normalizeMathSymbolsForTts(`值${symbol}`)).toBe(`值${zh}`);
    expect(normalizeMathSymbolsForTts(`value ${symbol}`)).toBe(`value ${en}`);
  });

  it('rewrites the reported caption homophones only on the TTS string', () => {
    expect(normalizeMathSymbolsForTts('从负π到正π')).toBe('从负派到正派');
    expect(normalizeMathSymbolsForTts('一除以π')).toBe('一除以派');
    expect(normalizeMathSymbolsForTts('from negative π to positive π')).toBe(
      'from negative pi to positive pi',
    );
    expect(normalizeMathSymbolsForTts('one divided by π')).toBe('one divided by pi');
  });

  it('separates a symbol from adjacent ASCII so English TTS does not glue the word', () => {
    expect(normalizeMathSymbolsForTts('2πr')).toBe('2 pi r');
    expect(normalizeMathSymbolsForTts('半径2π')).toBe('半径2派');
  });

  it('leaves homophones, the constant e, and non-Greek symbols untouched', () => {
    expect(normalizeMathSymbolsForTts('负派到正派')).toBe('负派到正派');
    expect(normalizeMathSymbolsForTts('一除以派')).toBe('一除以派');
    expect(normalizeMathSymbolsForTts('自然常数 e')).toBe('自然常数 e');
    expect(normalizeMathSymbolsForTts('the constant e')).toBe('the constant e');
    expect(normalizeMathSymbolsForTts('x ≥ 1')).toBe('x ≥ 1');
    expect(normalizeMathSymbolsForTts('')).toBe('');
  });

  it('is idempotent', () => {
    const spoken = normalizeMathSymbolsForTts('从负π到正π');
    expect(normalizeMathSymbolsForTts(spoken)).toBe(spoken);
    const english = normalizeMathSymbolsForTts('2πr');
    expect(normalizeMathSymbolsForTts(english)).toBe(english);
  });
});
