import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { QaReport, type Blocklist, type Brand } from '../../src/schemas';
import { runQA, writeQaReport, type AutoFixHook, type FullQaInput } from '../../src/qa/index';
import type { VisualReviewer } from '../../src/qa/visual';
import { ensureQaFixtures } from '../fixtures/qa/generate';
import { brandAndBlocklist, makeRenderReport, makeSpec, makeVoiceTrack } from '../fixtures/qa/factories';
import { HAS_FFMPEG, MEDIA_TIMEOUT, scratchDir } from './helpers';

const fakeReviewer: VisualReviewer = async () => ({
  schemaVersion: 1,
  hookReadable: true,
  textCutOff: false,
  garbledText: false,
  deformedAnatomy: false,
  logosOrRealPeople: false,
  onBrand: true,
  issues: [],
  summary: 'fake reviewer: ok',
});

describe.skipIf(!HAS_FFMPEG)('runQA (aggregate + one auto-fix)', () => {
  let brand: Brand;
  let blocklist: Blocklist;
  let fx: Awaited<ReturnType<typeof ensureQaFixtures>>;
  beforeAll(async () => {
    ({ brand, blocklist } = await brandAndBlocklist());
    fx = await ensureQaFixtures(['good', 'wrong_aspect', 'voice']);
  }, MEDIA_TIMEOUT);

  const input = async (
    video: 'good' | 'wrong_aspect',
    seconds: number,
    over: Partial<FullQaInput> = {},
  ): Promise<FullQaInput> => ({
    videoPath: fx[video],
    brand,
    blocklist,
    renderReport: makeRenderReport(seconds),
    voiceTrack: makeVoiceTrack(fx.voice),
    spec: makeSpec(),
    corpus: { texts: [] },
    publishMode: 'approval',
    framesDir: await scratchDir('runqa'),
    reviewer: fakeReviewer,
    originality: { disclosureLine: brand.disclosure.captionLine },
    now: () => new Date('2026-11-05T00:00:00Z'),
    ...over,
  });

  it(
    'good reel -> pass; report validates and is written atomically',
    async () => {
      const out = await runQA(await input('good', 20));
      const fails = out.report.checks.filter((c) => c.status === 'fail');
      expect(fails).toEqual([]);
      expect(out.report.verdict).toBe('pass');
      expect(out.dropped).toBe(false);
      const dir = await scratchDir('report');
      const p = await writeQaReport(dir, out.report);
      expect(p).toBe(path.join(dir, 'qa', '2026-11-05', '2026-11-05-01.json'));
      expect(QaReport.parse(JSON.parse(await readFile(p, 'utf8'))).verdict).toBe('pass');
    },
    MEDIA_TIMEOUT,
  );

  it(
    'no reviewer -> flagged (owner must look), not pass',
    async () => {
      const out = await runQA(await input('good', 20, { reviewer: null }));
      expect(out.report.verdict).toBe('flagged');
    },
    MEDIA_TIMEOUT,
  );

  it(
    'defect: wrong aspect -> exactly one auto-fix, then pass',
    async () => {
      let calls = 0;
      const fix: AutoFixHook = async (ctx) => {
        calls++;
        expect(ctx.failing.some((c) => c.id.startsWith('tech.'))).toBe(true);
        return input('good', 20);
      };
      const out = await runQA(await input('wrong_aspect', 6), fix);
      expect(calls).toBe(1);
      expect(out.report.autoFixAttempted).toBe(true);
      expect(out.report.verdict).toBe('pass');
      expect(out.dropped).toBe(false);
    },
    MEDIA_TIMEOUT,
  );

  it(
    'defect: fix does not help -> dropped after ONE attempt (no loop)',
    async () => {
      let calls = 0;
      const out = await runQA(await input('wrong_aspect', 6), async () => {
        calls++;
        return input('wrong_aspect', 6);
      });
      expect(calls).toBe(1);
      expect(out.dropped).toBe(true);
      expect(out.dropReason).toMatch(/after one auto-fix/);
    },
    MEDIA_TIMEOUT,
  );

  it(
    'defect: unfixable (policy) failure -> dropped without calling auto-fix',
    async () => {
      let calls = 0;
      const spec = makeSpec();
      spec.beats[2]!.voiceover = 'This is guaranteed.';
      const out = await runQA(await input('good', 20, { spec }), async () => {
        calls++;
        return null;
      });
      expect(calls).toBe(0);
      expect(out.dropped).toBe(true);
      expect(out.report.verdict).toBe('fail');
    },
    MEDIA_TIMEOUT,
  );

  it(
    'borderline originality in auto mode -> not auto-publishable',
    async () => {
      const corpus = {
        texts: [{ id: 'own-x', source: 'own' as const, text: makeSpec().beats[1]!.voiceover }],
      };
      const out = await runQA(await input('good', 20, { corpus, publishMode: 'auto' }));
      expect(out.report.verdict).not.toBe('pass');
    },
    MEDIA_TIMEOUT,
  );
});
