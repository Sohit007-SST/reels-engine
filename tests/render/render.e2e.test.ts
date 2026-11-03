/**
 * Real Remotion renders (local Chrome headless shell, no network writes).
 * Skip with SKIP_RENDER_TESTS=1 (e.g. on machines without the downloaded browser).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderSceneStills } from '../../src/render/render';
import { smokeRender, SMOKE_SECONDS } from '../../src/render/smoke';
import { ffprobeAvailable } from '../../src/render/probe';
import { FIXTURE_SPEC } from '../../remotion/fixture';
import { syntheticTimings } from '../../remotion/buildProps';
import { imageSize } from '../../src/render/files';
import { PROJECT_ROOT } from '../../src/config';

const OUT = path.join(PROJECT_ROOT, 'out', 'test-render');
const skip = process.env.SKIP_RENDER_TESTS === '1';

describe.skipIf(skip)('remotion render', () => {
  it('renders a 1080x1920 still for every fixture scene', { timeout: 300_000 }, async () => {
    const stills = await renderSceneStills({
      spec: FIXTURE_SPEC,
      audioPath: null,
      timings: syntheticTimings(FIXTURE_SPEC),
      outDir: path.join(OUT, 'stills'),
      showSafeZone: true,
      concurrency: 2,
    });
    expect(stills).toHaveLength(FIXTURE_SPEC.beats.length);
    for (const s of stills) {
      const st = await fs.stat(s.path);
      expect(st.size).toBeGreaterThan(10_000);
      expect(await imageSize(s.path)).toMatchObject({ width: 1080, height: 1920 });
    }
  });

  it('2-second smoke render produces a 1080x1920 H.264/AAC mp4 + reports', { timeout: 300_000 }, async () => {
    const res = await smokeRender(path.join(OUT, 'smoke.mp4'));
    expect((await fs.stat(res.outputPath)).size).toBeGreaterThan(10_000);
    const bounds = JSON.parse(await fs.readFile(res.boundsPath, 'utf8'));
    expect(bounds).toBeTruthy();
    expect(res.report.schemaVersion).toBe(1);
    if (await ffprobeAvailable()) {
      expect(res.probe).toMatchObject({
        width: 1080,
        height: 1920,
        videoCodec: 'h264',
        audioCodec: 'aac',
        sampleRate: 48_000,
      });
      expect(res.probe?.durationSec ?? 0).toBeGreaterThan(SMOKE_SECONDS - 0.3);
      expect(res.probe?.durationSec ?? 99).toBeLessThan(SMOKE_SECONDS + 0.5);
    }
  });
});
