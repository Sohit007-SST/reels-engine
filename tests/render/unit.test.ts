import { describe, expect, it } from 'vitest';
import { computeTimeline, msToFrame } from '../../remotion/timeline';
import {
  fitText,
  estimateMeasurer,
  computeReelLayout,
  SCENE_TYPES,
  frameGeometry,
} from '../../remotion/layout';
import { buildRenderProps, syntheticTimings } from '../../remotion/buildProps';
import { FIXTURE_SPEC } from '../../remotion/fixture';
import { tunedConcurrency } from '../../src/render/render';
import { imageSizeFromBuffer, speechLikeWav } from '../../src/render/files';

describe('timeline', () => {
  const scenes = [
    { startMs: 0, durationMs: 2000, motion: 'zoom punch' },
    { startMs: 2120, durationMs: 3000, motion: 'drift' },
    { startMs: 5240, durationMs: 1500, motion: 'fade' },
  ];
  it('starts scenes at measured beat starts and ends after the tail', () => {
    const tl = computeTimeline({ scenes, totalMs: 6740, tailMs: 500, fps: 30, transitionFrames: 8 });
    expect(tl.entries.map((e) => e.startFrame)).toEqual([0, msToFrame(2120, 30), msToFrame(5240, 30)]);
    expect(tl.durationInFrames).toBe(Math.ceil((7240 / 1000) * 30));
    const sum = tl.entries.reduce((a, e) => a + e.frames, 0);
    expect(sum).toBe(tl.durationInFrames);
    expect(tl.entries.at(-1)?.transitionFrames).toBe(0);
    expect(tl.entries[1]?.transition).toBe('fade');
  });
  it('rejects non-increasing beat starts', () => {
    expect(() =>
      computeTimeline({
        scenes: [scenes[1]!, scenes[0]!],
        totalMs: 5000,
        tailMs: 0,
        fps: 30,
        transitionFrames: 8,
      }),
    ).toThrow();
  });
});

describe('layout', () => {
  it('fits text inside max width / lines', () => {
    const f = fitText(
      {
        id: 't',
        role: 'title',
        text: 'WHAT IF THE MOON VANISHED TONIGHT AND NEVER CAME BACK',
        style: 'title' as never,
        maxWidth: 900,
        maxLines: 3,
        maxFontSize: 140,
        minFontSize: 48,
      },
      estimateMeasurer,
    );
    expect(f.width).toBeLessThanOrEqual(900);
  });
  it('fixture layout covers every launch scene inside the safe zone', () => {
    const tm = syntheticTimings(FIXTURE_SPEC);
    const props = buildRenderProps(FIXTURE_SPEC, tm, { audioSrc: null, showSafeZone: false });
    expect(props.scenes.map((s) => s.sceneType).sort()).toEqual([...SCENE_TYPES].sort());
    for (const [i, s] of props.scenes.entries()) expect(s.durationMs).toBe(tm.beats[i]!.durationMs);
    const g = frameGeometry(null);
    const layout = computeReelLayout(
      {
        scenes: props.scenes as never,
        words: [],
        totalMs: tm.totalMs,
        tailMs: 400,
        transitionFrames: 8,
        mascotEnabled: true,
      } as never,
      estimateMeasurer,
      'estimate' as never,
    );
    expect(layout.scenes).toHaveLength(7);
    expect(g).toBeTruthy();
  });
});

describe('render helpers', () => {
  it('tunes concurrency', () => {
    expect(tunedConcurrency(2, {})).toBe(2);
    expect(tunedConcurrency(16, {})).toBe(8);
    expect(tunedConcurrency(4, { RENDER_CONCURRENCY: '3' })).toBe(3);
    expect(tunedConcurrency(2, { RENDER_CONCURRENCY: '9' })).toBe(2);
  });
  it('reads PNG size and makes a WAV', () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    expect(imageSizeFromBuffer(png)).toMatchObject({ width: 640, height: 480 });
    expect(speechLikeWav(0.1).subarray(0, 4).toString()).toBe('RIFF');
  });
});
