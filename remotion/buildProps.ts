/**
 * Pure mapping ReelSpec + VoiceTrack -> Reel composition props (no I/O; shared by Node and the
 * bundle for Studio previews). Node-side validation and asset staging live in src/render/.
 */
import type { ReelSpec } from '../src/schemas/reelSpec';
import type { VoiceTrack } from '../src/schemas/media';
import type { ReelRenderPropsInput, SceneImage } from './props';
import { defaultSafeZonePct, timing, type SafeZonePct } from './theme';

export interface BuildPropsOptions {
  /** Voice/mix audio as a bundle public path or URL; null = silent. */
  audioSrc: string | null;
  /** Staged images by beat index. */
  images?: Record<number, SceneImage>;
  showSafeZone?: boolean;
  showCaptions?: boolean;
  mascotEnabled?: boolean;
  safeZone?: SafeZonePct;
  tailMs?: number;
}

export type TimingsLike = Pick<VoiceTrack, 'beats' | 'words' | 'totalMs' | 'gapMs'>;

export function buildRenderProps(
  spec: ReelSpec,
  timings: TimingsLike,
  opts: BuildPropsOptions,
): ReelRenderPropsInput {
  if (timings.beats.length !== spec.beats.length) {
    throw new Error(`voice track has ${timings.beats.length} beats but the spec has ${spec.beats.length}`);
  }
  const beats = [...timings.beats].sort((a, b) => a.index - b.index);
  return {
    schemaVersion: 1,
    reelId: spec.id,
    format: spec.format,
    scenes: spec.beats.map((beat, i) => {
      const audio = beats[i]!;
      return {
        index: i,
        sceneType: beat.sceneType,
        role: beat.role,
        onScreenText: beat.onScreenText,
        voiceover: beat.voiceover,
        motion: beat.motion,
        sfx: beat.sfx,
        params: beat.visual.params ?? {},
        image: opts.images?.[i] ?? null,
        startMs: audio.startMs,
        durationMs: audio.durationMs,
      };
    }),
    words: timings.words.map((w) => ({ ...w })),
    audioSrc: opts.audioSrc,
    totalMs: timings.totalMs,
    tailMs: opts.tailMs ?? timing.tailMs,
    coverOffsetMs: spec.coverOffsetMs,
    commentQuestion: spec.commentQuestion ?? null,
    safeZone: opts.safeZone ?? defaultSafeZonePct,
    showSafeZone: opts.showSafeZone ?? false,
    showCaptions: opts.showCaptions ?? true,
    showProgressBar: true,
    mascotEnabled: opts.mascotEnabled ?? true,
    transitionFrames: timing.transitionFrames,
    layout: null,
  };
}

/**
 * Estimated timings for previews and fixtures without synthesized audio (timingSource
 * "proportional", every word flagged unmatched). Real reels always use the measured VoiceTrack.
 */
export function syntheticTimings(
  spec: ReelSpec,
  wordsPerSecond = 2.7,
  gapMs: number = timing.beatGapMs,
): VoiceTrack {
  let t = 0;
  const words: VoiceTrack['words'] = [];
  const beats = spec.beats.map((beat, index) => {
    const ws = beat.voiceover.trim().split(/\s+/).filter(Boolean);
    const durationMs = Math.max(1200, Math.round((ws.length / wordsPerSecond) * 1000));
    const per = durationMs / Math.max(1, ws.length);
    ws.forEach((w, k) => {
      words.push({
        text: w,
        startMs: Math.round(t + k * per),
        endMs: Math.round(t + (k + 1) * per - 40),
        beatIndex: index,
        matched: false,
      });
    });
    const b = { index, audioPath: `synthetic://beat-${index}`, durationMs, startMs: t, text: beat.voiceover };
    t += durationMs + gapMs;
    return b;
  });
  const totalMs = t - gapMs;
  return {
    schemaVersion: 1,
    reelId: spec.id,
    createdAt: new Date(0).toISOString(),
    voiceId: 'none',
    speed: 1,
    gapMs,
    beats,
    voicePath: 'synthetic://none',
    totalMs,
    words,
    unmatchedWordCount: words.length,
    timingSource: 'proportional',
    mix: null,
  };
}
