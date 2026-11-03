import { z } from 'zod';
import { Confidence, IsoDate, IsoDateTime, NullableMetric, SchemaV1 } from './common';

export const TrendSourceName = z.enum([
  'ig_business_discovery',
  'own_insights',
  'youtube',
  'google_trends',
  'web_search',
  'manual',
]);
export type TrendSourceName = z.infer<typeof TrendSourceName>;

/** trend-scout's analysis of WHY something works. Patterns only, never copied wording. */
export const TrendAnalysis = z.strictObject({
  topic: z.string().min(1),
  hookPattern: z.string().min(1).describe('written as a formula, not a quote'),
  format: z.string().min(1),
  structure: z.string().min(1),
  pacing: z.string().min(1),
  emotion: z.string().min(1),
  whyItWorks: z.string().min(1),
  originalAngle: z.string().min(1).describe('how to make an original version'),
});
export type TrendAnalysis = z.infer<typeof TrendAnalysis>;

export const Trend = z.object({
  schemaVersion: SchemaV1,
  id: z.string().min(1),
  source: TrendSourceName,
  /** Username, video id, feed URL or query that produced this item. */
  sourceRef: z.string().min(1),
  permalink: z.string().nullable(),
  capturedAt: IsoDateTime,
  postedAt: IsoDateTime.nullable(),
  /** Untrusted text kept ONLY for originality comparison. Never sent to agents as instructions. */
  captionText: z.string().nullable(),
  metrics: z.object({
    views: NullableMetric,
    likes: NullableMetric,
    comments: NullableMetric,
    followers: NullableMetric,
  }),
  viralScore: z.number().nonnegative().nullable(),
  /** true when likes + 3 x comments was used because views were missing. */
  viralScoreIsProxy: z.boolean(),
  sampleSize: z.number().int().nonnegative(),
  confidence: Confidence,
  analysis: TrendAnalysis.nullable(),
});
export type Trend = z.infer<typeof Trend>;

export const TrendSourceStatus = z.object({
  source: TrendSourceName,
  status: z.enum(['ok', 'empty', 'error', 'skipped']),
  itemCount: z.number().int().nonnegative(),
  /** Redacted error message, if any. */
  error: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
});
export type TrendSourceStatus = z.infer<typeof TrendSourceStatus>;

/** data/trends/DATE.json */
export const TrendFile = z.object({
  schemaVersion: SchemaV1,
  date: IsoDate,
  runId: z.string().min(1),
  generatedAt: IsoDateTime,
  sources: z.array(TrendSourceStatus),
  trends: z.array(Trend),
});
export type TrendFile = z.infer<typeof TrendFile>;
