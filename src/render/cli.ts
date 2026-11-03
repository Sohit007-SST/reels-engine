/**
 * Entry point for `npm run render | reel:fixture` (and `tsx src/render/cli.ts smoke|stills`).
 *   render  --spec <spec.json> --timings <voice-track.json> [--audio <wav>] [--out <mp4>] [--safe-zone]
 *   fixture [--out out/fixture/reel.mp4] [--safe-zone]     full fixture reel, synthetic timings, silent audio
 *   smoke   [--out out/smoke/smoke.mp4]                     2-second fixture render + ffprobe check
 *   stills  [--out out/fixture/stills]                      one PNG per fixture scene
 *   mascot  [--out assets/mascot]                           export the 4 mascot expressions as SVG
 * Local only: no network writes, no external APIs.
 */
import path from 'node:path';
import { runMain } from '../lib/cli';
import { readJson } from '../lib/store';
import { ReelSpec } from '../schemas/reelSpec';
import { VoiceTrack } from '../schemas/media';
import { FIXTURE_SPEC } from '../../remotion/fixture';
import { syntheticTimings } from '../../remotion/buildProps';
import { VIDEO } from '../../remotion/theme';
import { renderReel, renderSceneStills } from './render';
import { PROJECT_ROOT } from '../config';
import { smokeRender } from './smoke';
import { exportMascotSvgs } from './mascotExport';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const [cmd = 'fixture', ...argv] = process.argv.slice(2);
  const safe = argv.includes('--safe-zone');
  if (cmd === 'smoke') {
    const res = await smokeRender(arg(argv, 'out'));
    const p = res.probe;
    const ok = !p || (p.width === VIDEO.width && p.height === VIDEO.height);
    console.log(JSON.stringify({ ok, output: res.outputPath, probe: p, renderMs: res.renderMs }));
    return ok ? 0 : 1;
  }
  if (cmd === 'fixture') {
    const res = await renderReel({
      spec: FIXTURE_SPEC,
      audioPath: null,
      timings: syntheticTimings(FIXTURE_SPEC),
      outPath: arg(argv, 'out') ?? path.join(PROJECT_ROOT, 'out', 'fixture', 'reel.mp4'),
      showSafeZone: safe,
    });
    console.log(JSON.stringify({ output: res.outputPath, report: res.reportPath, warnings: res.warnings }));
    return res.warnings.length ? 1 : 0;
  }
  if (cmd === 'stills') {
    const stills = await renderSceneStills({
      spec: FIXTURE_SPEC,
      audioPath: null,
      timings: syntheticTimings(FIXTURE_SPEC),
      outDir: arg(argv, 'out') ?? path.join(PROJECT_ROOT, 'out', 'fixture', 'stills'),
      showSafeZone: safe,
    });
    console.log(JSON.stringify(stills.map((s) => s.path)));
    return 0;
  }
  if (cmd === 'mascot') {
    console.log(JSON.stringify(await exportMascotSvgs(arg(argv, 'out'))));
    return 0;
  }
  if (cmd === 'render') {
    const specPath = arg(argv, 'spec');
    const timingsPath = arg(argv, 'timings');
    if (!specPath || !timingsPath) {
      console.error(
        'usage: render --spec <spec.json> --timings <voice-track.json> [--audio <wav>] [--out <mp4>]',
      );
      return 64;
    }
    const spec = await readJson(specPath, ReelSpec);
    const timings = await readJson(timingsPath, VoiceTrack);
    const audioPath = arg(argv, 'audio') ?? timings.mix?.path ?? null;
    const res = await renderReel({
      spec,
      audioPath,
      timings,
      outPath: arg(argv, 'out') ?? path.join(PROJECT_ROOT, 'out', spec.id, 'reel.mp4'),
      showSafeZone: safe,
    });
    console.log(JSON.stringify({ output: res.outputPath, report: res.reportPath, warnings: res.warnings }));
    return res.warnings.length ? 1 : 0;
  }
  console.error(`unknown command: ${cmd}`);
  return 64;
}

runMain('render', main);
