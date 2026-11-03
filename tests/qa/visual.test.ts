import { beforeAll, describe, expect, it } from 'vitest';
import type { Brand } from '../../src/schemas';
import {
  checkFrameStats,
  reviewToChecks,
  runVisualQa,
  sampleFramePlan,
  sampleFrames,
  VisualReview,
  type VisualReviewer,
} from '../../src/qa/visual';
import { ensureQaFixtures } from '../fixtures/qa/generate';
import { brandAndBlocklist, makeRenderReport, makeSpec } from '../fixtures/qa/factories';
import { HAS_FFMPEG, MEDIA_TIMEOUT, scratchDir } from './helpers';

const goodReview = (over: Partial<VisualReview> = {}): VisualReview => ({
  schemaVersion: 1,
  hookReadable: true,
  textCutOff: false,
  garbledText: false,
  deformedAnatomy: false,
  logosOrRealPeople: false,
  onBrand: true,
  issues: [],
  summary: 'looks fine',
  ...over,
});

describe('scene-aware frame sampling', () => {
  it('samples frame 0, cover, and first/middle/last of every scene', () => {
    const r = makeRenderReport(9, 3); // 270 frames, scenes [0,90) [90,180) [180,270), cover 12
    expect(sampleFrames(r)).toEqual([0, 12, 44, 89, 90, 134, 179, 180, 224, 269]);
    const plan = sampleFramePlan(r);
    expect(plan.find((p) => p.frame === 0)?.labels).toEqual(
      expect.arrayContaining(['frame0', 'scene_first']),
    );
    expect(plan.find((p) => p.frame === 12)?.labels).toContain('cover');
    expect(plan.find((p) => p.frame === 269)?.sceneIndex).toBe(2);
  });

  it('clamps an out-of-range cover frame and dedupes', () => {
    const r = makeRenderReport(3, 1, { coverFrame: 10_000 });
    const frames = sampleFrames(r);
    expect(Math.max(...frames)).toBe(89);
    expect(new Set(frames).size).toBe(frames.length);
  });
});

describe('frame stats + review mapping (defect injection)', () => {
  const plan = sampleFramePlan(makeRenderReport(9, 3));
  it('flat frame -> visual.blank_frame fail; missing frame -> frames_extracted fail', () => {
    const stats = plan.map((p) => ({ frame: p.frame, yLow: 16, yHigh: p.frame === 89 ? 18 : 200 }));
    const checks = checkFrameStats(stats, plan);
    expect(checks.some((c) => c.id === 'visual.blank_frame' && c.status === 'fail')).toBe(true);
    const missing = checkFrameStats(stats.slice(1), plan);
    expect(missing.some((c) => c.id === 'visual.frames_extracted' && c.status === 'fail')).toBe(true);
  });

  it.each([
    ['hookReadable', false, 'visual.hook_readable'],
    ['textCutOff', true, 'visual.text_cut_off'],
    ['garbledText', true, 'visual.garbled_text'],
    ['deformedAnatomy', true, 'visual.anatomy'],
    ['logosOrRealPeople', true, 'visual.logos_people'],
    ['onBrand', false, 'visual.on_brand'],
  ] as const)('%s=%s -> %s fails', (key, val, id) => {
    expect(reviewToChecks(goodReview()).every((c) => c.status === 'pass')).toBe(true);
    const c = reviewToChecks(goodReview({ [key]: val }));
    expect(c.find((x) => x.id === id)?.status).toBe('fail');
  });
});

describe.skipIf(!HAS_FFMPEG)('runVisualQa on real frames', () => {
  let brand: Brand;
  let fx: Awaited<ReturnType<typeof ensureQaFixtures>>;
  beforeAll(async () => {
    brand = (await brandAndBlocklist()).brand;
    fx = await ensureQaFixtures(['good', 'scene_glitch']);
  }, MEDIA_TIMEOUT);

  const input = async (name: 'good' | 'scene_glitch', seconds: number) => ({
    videoPath: fx[name],
    renderReport: makeRenderReport(seconds, 3),
    brand,
    spec: makeSpec(),
    framesDir: await scratchDir('frames'),
  });

  it(
    'extracts every planned frame and passes a clean review to the fake reviewer',
    async () => {
      let seen = 0;
      const reviewer: VisualReviewer = async (i) => {
        seen = i.frames.length;
        expect(i.frames.every((f) => f.path.startsWith(i.framesDir))).toBe(true);
        return goodReview();
      };
      const r = await runVisualQa(await input('good', 9), reviewer);
      expect(seen).toBe(10);
      expect(r.checks.filter((c) => c.status === 'fail')).toEqual([]);
      expect(r.unreviewed).toBe(false);
    },
    MEDIA_TIMEOUT,
  );

  it(
    'catches the injected flat frame at a scene boundary',
    async () => {
      const r = await runVisualQa(await input('scene_glitch', 9), async () => goodReview());
      expect(r.checks.find((c) => c.id === 'visual.blank_frame')?.status).toBe('fail');
    },
    MEDIA_TIMEOUT,
  );

  it(
    'no reviewer -> warn + unreviewed; invalid reviewer JSON or throw -> fail closed',
    async () => {
      const none = await runVisualQa(await input('good', 9), null);
      expect(none.unreviewed).toBe(true);
      expect(none.checks.find((c) => c.id === 'visual.review')?.status).toBe('warn');
      const bad = await runVisualQa(await input('good', 9), async () => ({ ok: true }));
      expect(bad.checks.find((c) => c.id === 'visual.review')?.status).toBe('fail');
      const thrown = await runVisualQa(await input('good', 9), async () => {
        throw new Error('boom');
      });
      expect(thrown.checks.find((c) => c.id === 'visual.review')?.status).toBe('fail');
    },
    MEDIA_TIMEOUT,
  );

  it(
    'missing video -> frames_extracted fail',
    async () => {
      const i = await input('good', 9);
      const r = await runVisualQa({ ...i, videoPath: `${i.framesDir}/nope.mp4` }, async () => goodReview());
      expect(r.checks.find((c) => c.id === 'visual.frames_extracted')?.status).toBe('fail');
    },
    MEDIA_TIMEOUT,
  );
});
