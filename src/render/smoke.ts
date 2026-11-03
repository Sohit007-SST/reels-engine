/** 2-second fixture smoke render (silent AAC track, synthetic timings). Local only. */
import path from 'node:path';
import { PROJECT_ROOT } from '../config';
import { FIXTURE_SPEC } from '../../remotion/fixture';
import { syntheticTimings } from '../../remotion/buildProps';
import { VIDEO } from '../../remotion/theme';
import { renderReel, type RenderReelResult } from './render';

export const SMOKE_SECONDS = 2;

export function smokeRender(
  out = path.join(PROJECT_ROOT, 'out', 'smoke', 'smoke.mp4'),
): Promise<RenderReelResult> {
  return renderReel({
    spec: FIXTURE_SPEC,
    audioPath: null,
    timings: syntheticTimings(FIXTURE_SPEC),
    outPath: out,
    frameRange: [0, SMOKE_SECONDS * VIDEO.fps - 1],
  });
}
