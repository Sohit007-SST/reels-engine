/**
 * Input props of the "Reel" composition. Built in Node by src/render/props.ts from a ReelSpec
 * plus the measured VoiceTrack, validated here with zod, and enriched in the browser by
 * calculateMetadata() with the measured text layout (layout.ts).
 */
import { z } from 'zod';

export const SceneImage = z.object({
  /** Path inside the bundle's public dir (resolved with staticFile), or an http(s)/data URL. */
  src: z.string().min(1),
  /** Natural pixel size of the image; used to never upscale it beyond its native resolution. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type SceneImage = z.infer<typeof SceneImage>;

export const SceneProps = z.object({
  index: z.number().int().nonnegative(),
  sceneType: z.string().min(1),
  role: z.string().min(1),
  onScreenText: z.string(),
  voiceover: z.string(),
  motion: z.string(),
  sfx: z.string().default('none'),
  params: z.record(z.string(), z.unknown()).default({}),
  image: SceneImage.nullable().default(null),
  /** Start of this scene on the voice track (measured beat start). */
  startMs: z.number().nonnegative(),
  /** Measured voice duration of the beat (excluding the gap). */
  durationMs: z.number().positive(),
});
export type SceneProps = z.infer<typeof SceneProps>;
export type SceneInput = z.input<typeof SceneProps>;

export const RenderWord = z.object({
  text: z.string().min(1),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  beatIndex: z.number().int().nonnegative(),
  matched: z.boolean(),
});
export type RenderWord = z.infer<typeof RenderWord>;

const BoxSchema = z.object({
  id: z.string(),
  text: z.string(),
  lines: z.array(z.string()),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  fontSize: z.number(),
  lineHeight: z.number(),
  overflow: z.boolean(),
  role: z.string(),
});
export type LaidOutBox = z.infer<typeof BoxSchema>;

const RectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

export const SceneLayout = z.object({
  index: z.number().int().nonnegative(),
  sceneType: z.string(),
  /** sceneType actually rendered (unknown types fall back to KineticText). */
  renderedAs: z.string(),
  boxes: z.array(BoxSchema),
  /** Non-text regions (image card, mascot, panel) for previews/QA. */
  regions: z.record(z.string(), RectSchema),
});
export type SceneLayout = z.infer<typeof SceneLayout>;

export const CaptionPageLayout = z.object({
  index: z.number().int().nonnegative(),
  startMs: z.number(),
  endMs: z.number(),
  tokens: z.array(z.object({ text: z.string(), fromMs: z.number(), toMs: z.number() })),
  box: BoxSchema,
});
export type CaptionPageLayout = z.infer<typeof CaptionPageLayout>;

export const TimelineEntry = z.object({
  index: z.number().int().nonnegative(),
  startFrame: z.number().int().nonnegative(),
  /** Frames this scene owns on the voice timeline. */
  frames: z.number().int().positive(),
  /** Sequence length inside TransitionSeries (= frames + outgoing transition). */
  sequenceFrames: z.number().int().positive(),
  /** Outgoing transition length (0 for the last scene). */
  transitionFrames: z.number().int().nonnegative(),
  transition: z.string(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const ReelLayout = z.object({
  measuredWith: z.enum(['layout-utils', 'estimate']),
  durationInFrames: z.number().int().positive(),
  timeline: z.array(TimelineEntry),
  scenes: z.array(SceneLayout),
  captions: z.array(CaptionPageLayout),
});
export type ReelLayout = z.infer<typeof ReelLayout>;

export const ReelRenderProps = z.object({
  schemaVersion: z.literal(1).default(1),
  reelId: z.string().min(1),
  format: z.string().default('what_if'),
  scenes: z.array(SceneProps).min(1),
  words: z.array(RenderWord).default([]),
  /** Voice/mix track: bundle public path or URL. null = silent (a silent AAC track is still written). */
  audioSrc: z.string().nullable().default(null),
  /** Total length of the voice track. */
  totalMs: z.number().positive(),
  tailMs: z.number().nonnegative().default(700),
  coverOffsetMs: z.number().nonnegative().default(400),
  commentQuestion: z.string().nullable().default(null),
  safeZone: z
    .object({ topPct: z.number(), bottomPct: z.number(), leftPct: z.number(), rightPct: z.number() })
    .nullable()
    .default(null),
  showSafeZone: z.boolean().default(false),
  showCaptions: z.boolean().default(true),
  showProgressBar: z.boolean().default(true),
  mascotEnabled: z.boolean().default(true),
  transitionFrames: z.number().int().nonnegative().default(8),
  /** Filled by calculateMetadata(); null before measuring. */
  layout: ReelLayout.nullable().default(null),
});
export type ReelRenderProps = z.infer<typeof ReelRenderProps>;
export type ReelRenderPropsInput = z.input<typeof ReelRenderProps>;
