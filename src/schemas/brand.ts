import { z } from 'zod';
import { HHMM, IsoDate, IsoDateTime, Language, NullableMetric, SchemaV1 } from './common';

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #RRGGBB');

/** brand/brand.json */
export const Brand = z.object({
  schemaVersion: SchemaV1,
  /** Display name of the channel (owner decides; "TBD" until then). */
  name: z.string().min(1),
  handle: z.string().nullable(),
  niche: z.string().min(1),
  audience: z.string().min(1),
  language: Language,
  voice: z.object({
    provider: z.enum(['kokoro', 'elevenlabs']),
    voiceId: z.string().min(1),
    /** Kokoro language code, e.g. "en-us". */
    lang: z.string().min(1),
    speed: z.number().min(0.8).max(1.3),
    beatGapMs: z.number().int().min(0).max(1000),
  }),
  tone: z.string().min(1),
  palette: z.object({
    background: HexColor,
    surface: HexColor,
    primary: HexColor,
    accent: HexColor,
    text: HexColor,
    mutedText: HexColor,
    highlight: HexColor,
  }),
  fonts: z.object({ heading: z.string().min(1), body: z.string().min(1), captions: z.string().min(1) }),
  video: z.object({
    width: z.literal(1080),
    height: z.literal(1920),
    fps: z.literal(30),
    minSeconds: z.number().positive(),
    maxSeconds: z.number().positive().max(60),
    targetSeconds: z.number().positive(),
    maxBytes: z.number().int().positive(),
  }),
  /** Percent of frame kept free of text (spec 7.6). */
  safeZone: z.object({
    topPct: z.number().min(0).max(50),
    bottomPct: z.number().min(0).max(50),
    leftPct: z.number().min(0).max(50),
    rightPct: z.number().min(0).max(50),
  }),
  audio: z.object({
    targetLufs: z.number(),
    truePeakDb: z.number().max(0),
    musicDuckDb: z.number().max(0),
    defaultMood: z.string().min(1),
  }),
  /** Publishing slots in IST, keyed by reels-per-day. */
  slots: z.record(z.string().regex(/^\d+$/), z.array(HHMM).min(1)),
  hashtagPool: z.array(z.string().regex(/^#[\p{L}\p{N}_]+$/u)).min(3),
  hashtagsPerReel: z.object({ min: z.number().int().min(1), max: z.number().int().max(5) }),
  disclosure: z.object({
    captionLine: z.string(),
    includeInCaption: z.boolean(),
    bioLine: z.string(),
  }),
  styleSuffix: z.string().min(1),
  negativePrompt: z.string().min(1),
  mascot: z.object({ enabled: z.boolean(), name: z.string().nullable(), notes: z.string() }),
  formats: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      weight: z.number().min(0),
      enabled: z.boolean(),
    }),
  ),
  scoringWeights: z.object({
    watchTime: z.number().min(0),
    shares: z.number().min(0),
    saves: z.number().min(0),
    comments: z.number().min(0),
    skipRate: z.number().min(0),
  }),
  retention: z.object({
    videoDays: z.number().int().positive(),
    logDays: z.number().int().positive(),
    localOutDays: z.number().int().positive(),
  }),
});
export type Brand = z.infer<typeof Brand>;

export const HookFormula = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  template: z.string().min(1),
  description: z.string().min(1),
  example: z.string().min(1),
  enabled: z.boolean(),
});
export type HookFormula = z.infer<typeof HookFormula>;

export const HookLeaderboardEntry = z.object({
  formulaId: z.string(),
  uses: z.number().int().nonnegative(),
  avgWatchTimeSec: NullableMetric,
  sharesPer1k: NullableMetric,
  savesPer1k: NullableMetric,
  updatedAt: IsoDateTime.nullable(),
});

/** brand/hooks.json */
export const HookLibrary = z.object({
  schemaVersion: SchemaV1,
  formulas: z.array(HookFormula).min(1),
  leaderboard: z.array(HookLeaderboardEntry),
});
export type HookLibrary = z.infer<typeof HookLibrary>;

/** brand/blocklist.json */
export const Blocklist = z.object({
  schemaVersion: SchemaV1,
  topics: z.array(z.string()),
  words: z.array(z.string()),
  /** Case-insensitive regex sources. */
  patterns: z.array(z.string()),
  notes: z.string().optional(),
});
export type Blocklist = z.infer<typeof Blocklist>;

/** brand/watchlist.json (owner confirms in M12). */
export const Watchlist = z.object({
  schemaVersion: SchemaV1,
  status: z.string().min(1),
  confirmedAt: IsoDate.nullable(),
  accounts: z.array(
    z.object({
      username: z.string().regex(/^[A-Za-z0-9._]{1,30}$/),
      reason: z.string(),
      addedAt: IsoDate,
      confirmedByOwner: z.boolean(),
    }),
  ),
});
export type Watchlist = z.infer<typeof Watchlist>;
