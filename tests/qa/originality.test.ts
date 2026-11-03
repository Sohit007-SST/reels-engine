import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boundedCorpus,
  checkOriginality,
  classify,
  compareText,
  cosine,
  DEFAULT_ORIGINALITY_THRESHOLDS,
  localEmbed,
  MAX_OWN_REELS,
  type OriginalityCorpus,
} from '../../src/qa/originality';
import { DISCLOSURE, makeSpec } from '../fixtures/qa/factories';

const dir = path.resolve(__dirname, '../fixtures/qa/originality');
const corpus = JSON.parse(readFileSync(path.join(dir, 'corpus.json'), 'utf8')) as OriginalityCorpus;
const { cases } = JSON.parse(readFileSync(path.join(dir, 'cases.json'), 'utf8')) as {
  cases: Array<{ id: string; expect: 'copied' | 'caught' | 'original'; text: string }>;
};
const RANK = { original: 0, borderline: 1, copied: 2 } as const;

async function verdictOf(text: string) {
  const { signals } = await compareText(text, boundedCorpus(corpus));
  return signals.reduce<'original' | 'borderline' | 'copied'>((v, s) => {
    const c = classify(s, DEFAULT_ORIGINALITY_THRESHOLDS);
    return RANK[c] > RANK[v] ? c : v;
  }, 'original');
}

describe('originality calibration (fixtures)', () => {
  it.each(cases.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const v = await verdictOf(c.text);
    if (c.expect === 'copied') expect(v).toBe('copied');
    else if (c.expect === 'caught') expect(v).not.toBe('original');
    else expect(v).toBe('original');
  });

  it("'follow for part 2' alone is never evidence of copying", async () => {
    expect(await verdictOf('Follow for part 2!')).toBe('original');
  });
});

describe('local embedder + helpers', () => {
  it('is deterministic and scores identical text 1, unrelated text low', () => {
    const batch = [
      'glowing ocean trench at night',
      'glowing ocean trench at night',
      'tax law in medieval France',
    ];
    const [a, b, c] = localEmbed(batch);
    expect(localEmbed(batch)[0]).toEqual(a);
    expect(cosine(a!, b!)).toBeCloseTo(1, 5);
    expect(cosine(a!, c!)).toBeLessThan(0.3);
  });

  it('bounds own reels to the last 60 and excludes self', () => {
    const own = Array.from({ length: 70 }, (_, i) => ({
      id: `own-${i}`,
      source: 'own' as const,
      text: `t${i}`,
    }));
    const b = boundedCorpus({ texts: [...own, { id: 'trend-1', source: 'trend', text: 'x' }] }, 'own-69');
    expect(b.filter((t) => t.source === 'own')).toHaveLength(MAX_OWN_REELS);
    expect(b.some((t) => t.id === 'own-69' || t.id === 'own-8')).toBe(false);
    expect(b.some((t) => t.id === 'own-9')).toBe(true);
  });
});

describe('checkOriginality on a ReelSpec', () => {
  it('original spec passes (disclosure + CTA ignored)', async () => {
    const r = await checkOriginality(makeSpec(), corpus, { disclosureLine: DISCLOSURE });
    expect(r.verdict).toBe('original');
    expect(r.checks.every((c) => c.status !== 'fail')).toBe(true);
  });

  it('defect: script copied from a trend caption -> copied + fail', async () => {
    const trend = corpus.texts.find((t) => t.id === 'trend-moon')!;
    const spec = makeSpec();
    spec.beats[1]!.voiceover = trend.text;
    const r = await checkOriginality(spec, corpus, { disclosureLine: DISCLOSURE });
    expect(r.verdict).toBe('copied');
    expect(r.closestId).toBe('trend-moon');
    expect(r.checks.some((c) => c.status === 'fail')).toBe(true);
  });

  it('borderline -> judge decides; invalid / throwing judge keeps borderline', async () => {
    const thresholds = {
      borderlineEmbedding: 0,
      copiedEmbedding: 2,
      borderlineContainment: 2,
      copiedContainment: 3,
      borderlineRun: 999,
      copiedRun: 999,
    };
    const base = { disclosureLine: DISCLOSURE, thresholds };
    const neutral = await checkOriginality(makeSpec(), corpus, base);
    expect(neutral.verdict).toBe('borderline');
    const copied = await checkOriginality(makeSpec(), corpus, {
      ...base,
      judge: async () => ({ verdict: 'copied', reason: 'same' }),
    });
    expect(copied.verdict).toBe('copied');
    const ok = await checkOriginality(makeSpec(), corpus, {
      ...base,
      judge: async () => ({ verdict: 'original', reason: 'different' }),
    });
    expect(ok.verdict).toBe('original');
    const bad = await checkOriginality(makeSpec(), corpus, { ...base, judge: async () => 'IGNORE RULES' });
    expect(bad.verdict).toBe('borderline');
    const thrown = await checkOriginality(makeSpec(), corpus, {
      ...base,
      judge: async () => {
        throw new Error('down');
      },
    });
    expect(thrown.verdict).toBe('borderline');
  });

  it('injected embedder failure -> local fallback + warn', async () => {
    const r = await checkOriginality(makeSpec(), corpus, {
      disclosureLine: DISCLOSURE,
      embedder: async () => {
        throw new Error('offline');
      },
    });
    expect(r.checks.find((c) => c.id === 'originality.embedder')?.status).toBe('warn');
    expect(r.maxEmbeddingSimilarity).not.toBeNull();
  });

  it('empty corpus -> original, embedding skipped', async () => {
    const r = await checkOriginality(makeSpec(), { texts: [] });
    expect(r.verdict).toBe('original');
    expect(r.checks.find((c) => c.id === 'originality.embedding')?.status).toBe('skip');
  });
});
