import { z } from 'zod';
import { HHMM, IsoDate, Language, Placement, ReelId, SchemaV1, VisualTier, wordCount } from './common';

export const BeatRole = z.enum(['hook', 'setup', 'escalation', 'payoff', 'loop', 'cta']);
export type BeatRole = z.infer<typeof BeatRole>;

/** Scene components the render module provides (render may add more; sceneType stays a string). */
export const KNOWN_SCENE_TYPES = [
  'HookTitle',
  'KineticText',
  'ImageKenBurns',
  'ImageParallax',
  'FactCard',
  'CountdownList',
  'QuizReveal',
  'SplitCompare',
  'Timeline',
  'StatCounter',
  'BarChart',
  'MapPin',
  'MascotTalk',
  'QuoteCard',
  'CTAEnd',
] as const;

export const SfxCue = z.enum(['none', 'hit', 'whoosh', 'pop', 'riser', 'ding', 'click']);
export type SfxCue = z.infer<typeof SfxCue>;

export const BeatVisual = z.strictObject({
  tier: VisualTier,
  /** Image/clip prompt (tiers B/C/D). The brand style suffix is appended by the media module. */
  prompt: z.string().optional(),
  /** Motion-graphic parameters (tier A) or scene props. */
  params: z.record(z.string(), z.unknown()).optional(),
});
export type BeatVisual = z.infer<typeof BeatVisual>;

export const Beat = z.strictObject({
  role: BeatRole,
  voiceover: z.string().min(1),
  onScreenText: z.string().refine((s) => wordCount(s) <= 6, 'onScreenText must be 6 words or fewer'),
  sceneType: z.string().min(1),
  visual: BeatVisual,
  motion: z.string().min(1),
  sfx: SfxCue.default('none'),
});
export type Beat = z.infer<typeof Beat>;

export const FactStatus = z.enum(['PENDING', 'SUPPORTED', 'HYPOTHETICAL', 'UNSUPPORTED', 'CUT']);
export type FactStatus = z.infer<typeof FactStatus>;

/** Claim-level evidence record (spec 7.3). A URL alone is not evidence. */
export const Fact = z.strictObject({
  claim: z.string().min(1),
  sourceUrl: z.string().nullable(),
  publisher: z.string().nullable(),
  retrievedAt: IsoDate.nullable(),
  supportingQuote: z.string().nullable(),
  status: FactStatus,
  /** Filled by the separate verification step. */
  verifiedAt: z.string().nullable().optional(),
  verifierNote: z.string().nullable().optional(),
});
export type Fact = z.infer<typeof Fact>;

export const SpecHook = z.strictObject({
  formulaId: z.string().min(1),
  spoken: z.string().min(1),
  onScreen: z.string().refine((s) => wordCount(s) <= 7, 'on-screen hook must be 7 words or fewer'),
  alternates: z.array(z.string()).max(2),
});

export const ReelTags = z.strictObject({
  hookFormula: z.string().min(1),
  format: z.string().min(1),
  visualTiers: z.array(VisualTier).min(1),
  targetSeconds: z.number().min(5).max(60),
  slot: HHMM.nullable(),
});

/** data/specs/DATE/<id>.json — the contract between script-writer, media, render and QA. */
export const ReelSpec = z.strictObject({
  schemaVersion: SchemaV1,
  id: ReelId,
  promptVersion: z.string().min(1),
  model: z.string().min(1),
  language: Language,
  placement: Placement,
  format: z.string().min(1),
  hook: SpecHook,
  beats: z.array(Beat).min(1).max(12),
  caption: z.string().min(1).max(2200),
  captionVersion: z.number().int().positive(),
  hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]+$/u, 'hashtag must look like #word')).max(5),
  /** The one specific question asked for comments. */
  commentQuestion: z.string().optional(),
  facts: z.array(Fact),
  coverOffsetMs: z.number().int().nonnegative(),
  tags: ReelTags,
  /** Music mood key from the procedural generator. */
  musicMood: z.string().optional(),
  /** Idea this spec came from (null for hand-written fixtures). */
  ideaId: z.string().nullable().optional(),
});
export type ReelSpec = z.infer<typeof ReelSpec>;
export type ReelSpecInput = z.input<typeof ReelSpec>;

/** Structural checks beyond the schema (beat order 7.3); returns problems, empty = OK. */
export function reelSpecStructureProblems(spec: ReelSpec): string[] {
  const problems: string[] = [];
  const roles = spec.beats.map((b) => b.role);
  if (roles[0] !== 'hook') problems.push('first beat must be the hook');
  const esc = roles.filter((r) => r === 'escalation').length;
  if (esc < 2 || esc > 4) problems.push(`expected 2-4 escalation beats, got ${esc}`);
  if (!roles.includes('setup')) problems.push('missing setup beat');
  if (!roles.includes('payoff')) problems.push('missing payoff beat');
  const last = roles[roles.length - 1];
  if (last !== 'loop' && last !== 'cta') problems.push('last beat must be loop or cta');
  const words = spec.beats.reduce((n, b) => n + wordCount(b.voiceover), 0);
  if (spec.language === 'en' && (words < 60 || words > 110))
    problems.push(`voiceover has ${words} words (target 60-110)`);
  if (spec.hashtags.length < 3) problems.push('need 3-5 hashtags');
  return problems;
}
