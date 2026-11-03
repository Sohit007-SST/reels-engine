import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ReelSpec } from '../../src/schemas';
import { VisualReview } from '../../src/qa/visual';
import { FAKE_REVIEWER_LABEL, FIXTURE_SPEC_PATH, fakeReviewer } from '../../src/pipeline/produce';

describe('produce vertical slice', () => {
  it('fixture spec is a valid what-if space ReelSpec with only HYPOTHETICAL/SUPPORTED claims', async () => {
    const spec = ReelSpec.parse(JSON.parse(await readFile(FIXTURE_SPEC_PATH, 'utf8')));
    expect(spec.format).toBe('what_if');
    expect(spec.hook.spoken.startsWith('What if')).toBe(true);
    expect(spec.facts.length).toBeGreaterThan(0);
    for (const f of spec.facts) {
      expect(['HYPOTHETICAL', 'SUPPORTED']).toContain(f.status);
      if (f.status === 'SUPPORTED') expect(f.sourceUrl).toMatch(/^https:\/\//);
    }
    const words = spec.beats
      .map((b) => b.voiceover)
      .join(' ')
      .split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(55);
    expect(words).toBeLessThanOrEqual(110);
  });

  it('fake reviewer is schema-valid and clearly labelled', async () => {
    const out = VisualReview.parse(
      await fakeReviewer({ reelId: 'x', framesDir: '/tmp', frames: [], spec: null, brand: {} as never }),
    );
    expect(out.summary).toBe(FAKE_REVIEWER_LABEL);
    expect(out.summary).toMatch(/FAKE REVIEWER/);
  });
});
