/**
 * Frame timeline from MEASURED beat audio (spec 7.4/7.6). Pure; shared by Node and the bundle.
 *
 * Scene i owns the frames [start_i, start_{i+1}) where start_i comes from the measured beat start
 * on the voice track (so the ~0.12 s gaps belong to the scene before them). The last scene runs to
 * totalMs + tailMs. Inside a TransitionSeries a transition overlaps two sequences and shortens the
 * total, so each sequence is extended by its outgoing transition: scene starts stay voice-aligned.
 */
import type { TimelineEntry } from './props';

export const TRANSITION_KINDS = ['slide', 'wipe', 'fade', 'zoom'] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export interface TimelineInput {
  scenes: { startMs: number; durationMs: number; motion: string }[];
  totalMs: number;
  tailMs: number;
  fps: number;
  transitionFrames: number;
}

export const msToFrame = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

/** Pick the transition INTO scene `nextIndex`: an explicit motion keyword wins, else a fixed rotation. */
export function transitionFor(nextMotion: string, nextIndex: number): TransitionKind {
  const m = nextMotion.toLowerCase();
  if (m.includes('slide') || m.includes('pan')) return 'slide';
  if (m.includes('wipe')) return 'wipe';
  if (m.includes('fade') || m.includes('dissolve')) return 'fade';
  if (m.includes('zoom') || m.includes('punch')) return 'zoom';
  return TRANSITION_KINDS[nextIndex % TRANSITION_KINDS.length] ?? 'fade';
}

export function computeTimeline(input: TimelineInput): {
  durationInFrames: number;
  entries: TimelineEntry[];
} {
  const { scenes, fps } = input;
  if (scenes.length === 0) throw new Error('timeline needs at least one scene');
  const lastScene = scenes[scenes.length - 1]!;
  const voiceEnd = Math.max(input.totalMs, lastScene.startMs + lastScene.durationMs);
  const end = Math.max(1, Math.ceil(((voiceEnd + input.tailMs) / 1000) * fps));
  const starts = scenes.map((s, i) => (i === 0 ? 0 : msToFrame(s.startMs, fps)));
  for (let i = 1; i < starts.length; i++) {
    if (starts[i]! <= starts[i - 1]!) {
      throw new Error(`scene ${i} starts at or before scene ${i - 1} (beat starts must increase)`);
    }
  }
  if (starts[starts.length - 1]! >= end) throw new Error('last scene starts after the end of the reel');

  const frames = starts.map((s, i) => (starts[i + 1] ?? end) - s);
  const entries: TimelineEntry[] = frames.map((f, i) => {
    const next = frames[i + 1];
    const nextScene = scenes[i + 1];
    const t =
      next === undefined || nextScene === undefined
        ? 0
        : Math.max(0, Math.min(input.transitionFrames, Math.floor(f / 3), Math.floor(next / 3)));
    return {
      index: i,
      startFrame: starts[i]!,
      frames: f,
      sequenceFrames: f + t,
      transitionFrames: t,
      transition: nextScene ? transitionFor(nextScene.motion, i + 1) : 'none',
    };
  });
  return { durationInFrames: end, entries };
}
