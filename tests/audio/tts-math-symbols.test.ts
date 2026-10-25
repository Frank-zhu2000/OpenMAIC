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

  it('does not read π as 派 in Japanese narration that uses kanji and kana', () => {
    const spoken = normalizeMathSymbolsForTts('半径がπのとき、円周は2πです。');
    expect(spoken).toBe('半径がpiのとき、円周は2 piです。');
    expect(spoken).not.toContain('派');
    expect(normalizeMathSymbolsForTts('半径がπのとき、円周は2πです。', 'ja-JP')).toBe(spoken);
  });

  it('uses the English name for a ja locale even when the line is kanji only', () => {
    expect(normalizeMathSymbolsForTts('円周率π', 'ja-JP')).toBe('円周率pi');
    expect(normalizeMathSymbolsForTts('值π', 'ja')).toBe('值pi');
    expect(normalizeMathSymbolsForTts('从负π到正π', 'ja-JP')).toBe('从负pi到正pi');
  });

  it('keeps Chinese readings for zh locales and for Han text without kana', () => {
    expect(normalizeMathSymbolsForTts('从负π到正π')).toBe('从负派到正派');
    expect(normalizeMathSymbolsForTts('π', 'zh-CN')).toBe('派');
    expect(normalizeMathSymbolsForTts('π', 'zh-TW')).toBe('派');
    expect(normalizeMathSymbolsForTts('π', 'zh-HK')).toBe('派');
    expect(normalizeMathSymbolsForTts('π', 'zh')).toBe('派');
    expect(normalizeMathSymbolsForTts('π', 'zh-Hans')).toBe('派');
    expect(normalizeMathSymbolsForTts('2πr', 'zh-CN')).toBe('2派r');
    expect(normalizeMathSymbolsForTts('円周率π')).toBe('円周率派');
  });

  it('does not use the Chinese reading when Japanese kana is present, even for a zh locale', () => {
    expect(normalizeMathSymbolsForTts('半径がπです', 'zh-CN')).toBe('半径がpiです');
  });

  it('spaces adjacent Greek letter names on the English path', () => {
    expect(normalizeMathSymbolsForTts('αβ')).toBe('alpha beta');
    expect(normalizeMathSymbolsForTts('2πα')).toBe('2 pi alpha');
  });

  it('does not rewrite Greek letters when narration is Greek', () => {
    const sentence = 'Η τιμή του π είναι περίπου 3.14';
    expect(normalizeMathSymbolsForTts(sentence, 'el-GR')).toBe(sentence);
    expect(normalizeMathSymbolsForTts(sentence, 'el')).toBe(sentence);
    expect(normalizeMathSymbolsForTts(sentence, 'el_GR')).toBe(sentence);
    expect(normalizeMathSymbolsForTts('2πr', 'el-GR')).toBe('2πr');
    expect(normalizeMathSymbolsForTts('2πr', 'en')).toBe('2 pi r');
  });

  it('does not treat a katakana middle dot as kana when choosing the Chinese reading', () => {
    expect(normalizeMathSymbolsForTts('马丁\u30fb路德的π', 'zh-CN')).toBe('马丁\u30fb路德的派');
    expect(normalizeMathSymbolsForTts('马丁\u30fb路德的π')).toBe('马丁\u30fb路德的派');
    expect(normalizeMathSymbolsForTts('ジョン\u30fbスミスのπ')).toBe('ジョン\u30fbスミスのpi');
  });
});
