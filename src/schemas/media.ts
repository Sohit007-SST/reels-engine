import { z } from 'zod';
import { IsoDateTime, ReelId, SchemaV1 } from './common';

/** One synthesized beat (measured, not estimated). */
export const BeatAudio = z.object({
  index: z.number().int().nonnegative(),
  audioPath: z.string().min(1),
  /** Measured duration of the voice audio for this beat. */
  durationMs: z.number().positive(),
  /** Start within the full voice track (includes gaps). */
  startMs: z.number().nonnegative(),
  text: z.string(),
});
export type BeatAudio = z.infer<typeof BeatAudio>;

/** Caption word with timing. `text` is ALWAYS the canonical script word. */
export const CaptionWord = z.object({
  text: z.string().min(1),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  beatIndex: z.number().int().nonnegative(),
  /** false => timing interpolated within the beat (flagged). */
  matched: z.boolean(),
});
export type CaptionWord = z.infer<typeof CaptionWord>;

/**
 * out/<reelId>/voice.json — produced by the audio module, consumed by render and QA.
 * Scene durations in render come from beats[].durationMs (+ gap).
 */
export const VoiceTrack = z.object({
  schemaVersion: SchemaV1,
  reelId: ReelId,
  createdAt: IsoDateTime,
  voiceId: z.string(),
  speed: z.number(),
  gapMs: z.number().nonnegative(),
  beats: z.array(BeatAudio).min(1),
  voicePath: z.string().min(1),
  totalMs: z.number().positive(),
  words: z.array(CaptionWord),
  unmatchedWordCount: z.number().int().nonnegative(),
  timingSource: z.enum(['faster-whisper', 'cloudflare-whisper', 'proportional']),
  /** Final mix (voice + ducked music + sfx), when produced. */
  mix: z
    .object({
      path: z.string().min(1),
      integratedLufs: z.number(),
      truePeakDb: z.number(),
      musicMood: z.string().nullable(),
    })
    .nullable(),
});
export type VoiceTrack = z.infer<typeof VoiceTrack>;

export const TextBox = z.object({
  id: z.string().min(1),
  text: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  fontSize: z.number().positive(),
  /** true if the text had to be shrunk/clipped to fit. */
  overflow: z.boolean(),
});
export type TextBox = z.infer<typeof TextBox>;

/** out/<reelId>/render-report.json — written by render, checked by QA against the safe zone. */
export const RenderReport = z.object({
  schemaVersion: SchemaV1,
  reelId: ReelId,
  createdAt: IsoDateTime,
  outputPath: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  durationInFrames: z.number().int().positive(),
  safeZonePx: z.object({ top: z.number(), bottom: z.number(), left: z.number(), right: z.number() }),
  scenes: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      sceneType: z.string(),
      startFrame: z.number().int().nonnegative(),
      endFrame: z.number().int().nonnegative(),
      textBoxes: z.array(TextBox),
    }),
  ),
  captionBoxes: z.array(TextBox),
  coverFrame: z.number().int().nonnegative(),
  renderMs: z.number().nonnegative().nullable(),
});
export type RenderReport = z.infer<typeof RenderReport>;
