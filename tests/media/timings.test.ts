import { describe, expect, it } from 'vitest';
import {
  alignWords,
  captionDriftProblems,
  captionTimingProblems,
  normalizeToken,
  proportionalWords,
  similarity,
  splitScriptWords,
  type BeatWindow,
  type RecognizedWord,
} from '../../src/media/timings';

/** Recognized words laid out evenly inside [startMs, endMs]. */
function rec(words: string[], startMs: number, endMs: number): RecognizedWord[] {
  const step = (endMs - startMs) / words.length;
  return words.map((w, i) => ({
    word: w,
    startMs: startMs + i * step,
    endMs: startMs + (i + 1) * step - 10,
  }));
}

const beats: BeatWindow[] = [
  { index: 0, startMs: 0, durationMs: 1500, text: 'What if the Moon vanished tonight?' },
  { index: 1, startMs: 1620, durationMs: 2000, text: 'Tides would shrink, and nights would darken.' },
];

describe('normalizeToken / splitScriptWords / similarity', () => {
  it('normalizes case, punctuation and apostrophes', () => {
    expect(normalizeToken('Tonight?')).toBe('tonight');
    expect(normalizeToken("Planet's")).toBe('planets');
    expect(normalizeToken('—')).toBe('');
    expect(normalizeToken('चाँद।')).toBe('चाँद');
  });
  it('drops punctuation-only tokens from script words but keeps canonical text', () => {
    expect(splitScriptWords('Wait — what?  Really!')).toEqual(['Wait', 'what?', 'Really!']);
  });
  it('similarity is 1 for equal and lower for different tokens', () => {
    expect(similarity('moon', 'moon')).toBe(1);
    expect(similarity('moon', 'moons')).toBeGreaterThan(0.6);
    expect(similarity('moon', 'tides')).toBeLessThan(0.6);
  });
});

describe('alignWords', () => {
  it('matches every word when recognition is perfect and keeps canonical script text', () => {
    const r = [
      ...rec(['what', 'if', 'the', 'moon', 'vanished', 'tonight'], 0, 1450),
      ...rec(['tides', 'would', 'shrink', 'and', 'nights', 'would', 'darken'], 1620, 3600),
    ];
    const { words, unmatchedWordCount } = alignWords(beats, r);
    expect(unmatchedWordCount).toBe(0);
    expect(words.map((w) => w.text)).toEqual([
      'What',
      'if',
      'the',
      'Moon',
      'vanished',
      'tonight?',
      'Tides',
      'would',
      'shrink,',
      'and',
      'nights',
      'would',
      'darken.',
    ]);
    expect(words.every((w) => w.matched)).toBe(true);
    expect(words[3]!.startMs).toBeCloseTo(r[3]!.startMs, 0);
    expect(words[6]!.beatIndex).toBe(1);
  });

  it('interpolates unmatched words inside their beat and flags them', () => {
    // "vanished" misrecognized as "banished"? (similar => still matched); "tonight" lost entirely,
    // and "shrink" recognized as an unrelated word.
    const r = [
      ...rec(['what', 'if', 'the', 'moon', 'vanished'], 0, 1100),
      ...rec(['tides', 'would', 'xylophone', 'and', 'nights', 'would', 'darken'], 1620, 3600),
    ];
    const { words, unmatchedWordCount } = alignWords(beats, r);
    expect(unmatchedWordCount).toBe(2);
    const tonight = words.find((w) => w.text === 'tonight?')!;
    const shrink = words.find((w) => w.text === 'shrink,')!;
    expect(tonight.matched).toBe(false);
    expect(shrink.matched).toBe(false);
    // tonight? sits after "vanished" and before the end of beat 0
    const vanished = words.find((w) => w.text === 'vanished')!;
    expect(tonight.startMs).toBeGreaterThanOrEqual(vanished.endMs - 0.1);
    expect(tonight.endMs).toBeLessThanOrEqual(1500);
    // shrink, sits between "would" and "and" in beat 1
    const iShrink = words.indexOf(shrink);
    expect(shrink.startMs).toBeGreaterThanOrEqual(words[iShrink - 1]!.endMs - 0.1);
    expect(shrink.endMs).toBeLessThanOrEqual(words[iShrink + 1]!.startMs + 0.1);
  });

  it('flags every word and stays inside beats when there is no recognition at all', () => {
    const { words, unmatchedWordCount } = proportionalWords(beats);
    expect(unmatchedWordCount).toBe(words.length);
    for (const w of words) {
      const b = beats[w.beatIndex]!;
      expect(w.startMs).toBeGreaterThanOrEqual(b.startMs);
      expect(w.endMs).toBeLessThanOrEqual(b.startMs + b.durationMs + 0.1);
    }
    expect(words[0]!.startMs).toBe(0);
    expect(words.find((w) => w.beatIndex === 1)!.startMs).toBe(1620);
  });

  it('handles a script word split into two recognized words (1:2) and two script words joined (2:1)', () => {
    const b: BeatWindow[] = [
      { index: 0, startMs: 0, durationMs: 3000, text: 'Sixty-nine people, every one curious.' },
    ];
    const r = rec(['sixty', 'nine', 'people', 'everyone', 'curious'], 0, 2900);
    const { words, unmatchedWordCount } = alignWords(b, r);
    expect(unmatchedWordCount).toBe(0);
    expect(words.map((w) => w.text)).toEqual(['Sixty-nine', 'people,', 'every', 'one', 'curious.']);
    expect(words[0]!.startMs).toBeCloseTo(r[0]!.startMs, 0);
    expect(words[0]!.endMs).toBeCloseTo(r[1]!.endMs, 0);
    expect(words[2]!.startMs).toBeLessThan(words[3]!.startMs);
    expect(words[3]!.endMs).toBeCloseTo(r[3]!.endMs, 0);
  });

  it('ignores hallucinated extra recognized words', () => {
    const r = [
      ...rec(['um', 'what', 'if', 'the', 'moon', 'vanished', 'tonight', 'subscribe'], 0, 1450),
      ...rec(['tides', 'would', 'shrink', 'and', 'nights', 'would', 'darken'], 1620, 3600),
    ];
    const { words, unmatchedWordCount } = alignWords(beats, r);
    expect(unmatchedWordCount).toBe(0);
    expect(words).toHaveLength(13);
  });

  it('does not match a word recognized in the wrong beat window', () => {
    // "tides" recognized far inside beat 0 must not be used for the beat-1 word.
    const b: BeatWindow[] = [
      { index: 0, startMs: 0, durationMs: 1000, text: 'Alpha bravo' },
      { index: 1, startMs: 2000, durationMs: 1000, text: 'tides rise' },
    ];
    const r: RecognizedWord[] = [
      { word: 'alpha', startMs: 0, endMs: 300 },
      { word: 'tides', startMs: 400, endMs: 600 },
      { word: 'rise', startMs: 2500, endMs: 2900 },
    ];
    const { words } = alignWords(b, r);
    const tides = words.find((w) => w.text === 'tides')!;
    expect(tides.matched).toBe(false);
    expect(tides.startMs).toBeGreaterThanOrEqual(2000);
    expect(words.find((w) => w.text === 'bravo')!.matched).toBe(false);
  });

  it('produces monotonic, non-negative-length words', () => {
    const r: RecognizedWord[] = [
      { word: 'what', startMs: 0, endMs: 200 },
      { word: 'if', startMs: 150, endMs: 260 }, // overlapping recognizer output
      { word: 'the', startMs: 140, endMs: 300 }, // out of order
      { word: 'moon', startMs: 320, endMs: 600 },
    ];
    const { words } = alignWords([{ index: 0, startMs: 0, durationMs: 1000, text: 'What if the Moon' }], r);
    for (let i = 1; i < words.length; i++)
      expect(words[i]!.startMs).toBeGreaterThanOrEqual(words[i - 1]!.startMs);
    for (const w of words) expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
  });
});

describe('caption timing tolerance (±150 ms)', () => {
  const trackBeats = [
    { index: 0, audioPath: 'b0.wav', durationMs: 1500, startMs: 0, text: '' },
    { index: 1, audioPath: 'b1.wav', durationMs: 2000, startMs: 1620, text: '' },
  ];
  const good = alignWords(beats, [
    ...rec(['what', 'if', 'the', 'moon', 'vanished', 'tonight'], 20, 1450),
    ...rec(['tides', 'would', 'shrink', 'and', 'nights', 'would', 'darken'], 1650, 3600),
  ]).words;

  it('passes when first words are within tolerance of the speech onset', () => {
    const res = captionTimingProblems({ beats: trackBeats, words: good }, [0, 1620]);
    expect(res.ok).toBe(true);
    expect(res.maxOnsetDriftMs).toBeLessThanOrEqual(150);
    expect(res.matchedRatio).toBe(1);
  });

  it('fails when a beat is shifted beyond 150 ms', () => {
    const shifted = good.map((w) =>
      w.beatIndex === 1 ? { ...w, startMs: w.startMs + 400, endMs: w.endMs + 400 } : w,
    );
    const res = captionTimingProblems({ beats: trackBeats, words: shifted }, [0, 1620]);
    expect(res.ok).toBe(false);
    expect(res.problems.join(' ')).toMatch(/beat 1: first caption word is \d+ ms from the speech onset/);
  });

  it('fails on missing captions for a beat and on words outside their beat', () => {
    const onlyBeat0 = good.filter((w) => w.beatIndex === 0);
    expect(captionTimingProblems({ beats: trackBeats, words: onlyBeat0 }, [0, 1620]).problems).toContain(
      'beat 1 has no caption words',
    );
    const outside = good.map((w, i) => (i === 2 ? { ...w, startMs: 5000, endMs: 5100 } : w));
    expect(captionTimingProblems({ beats: trackBeats, words: outside }, [0, 1620]).ok).toBe(false);
  });

  it('captionDriftProblems flags per-word drift beyond tolerance only', () => {
    const ref = good.map((w) => ({ startMs: w.startMs }));
    expect(captionDriftProblems(good, ref)).toEqual([]);
    const drifted = good.map((w, i) =>
      i === 4 ? { ...w, startMs: w.startMs + 151 } : i === 5 ? { ...w, startMs: w.startMs + 149 } : w,
    );
    const problems = captionDriftProblems(drifted, ref);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/word 4/);
  });
});
