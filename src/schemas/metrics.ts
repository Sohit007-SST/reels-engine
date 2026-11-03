import { z } from 'zod';
import { IsoDateTime, NullableMetric, ReelId, SchemaV1 } from './common';

/** Reels insight metric names we request (spec 7.11). plays/impressions are deprecated. */
export const METRIC_NAMES = [
  'views',
  'reach',
  'likes',
  'comments',
  'shares',
  'saved',
  'total_interactions',
  'ig_reels_avg_watch_time',
  'ig_reels_video_view_total_time',
  'reels_skip_rate',
] as const;

export const MetricValues = z.object(
  Object.fromEntries(METRIC_NAMES.map((m) => [m, NullableMetric])) as Record<
    (typeof METRIC_NAMES)[number],
    typeof NullableMetric
  >,
);
export type MetricValues = z.infer<typeof MetricValues>;

export const MetricsSnapshot = z.object({
  window: z.enum(['24h', '72h', '7d', 'adhoc']),
  capturedAt: IsoDateTime,
  values: MetricValues,
  /** Metrics the API did not return for this account (kept null above, never 0). */
  unavailable: z.array(z.string()),
});
export type MetricsSnapshot = z.infer<typeof MetricsSnapshot>;

/** data/metrics/<reelId>.json — time series of insight snapshots. */
export const Metrics = z.object({
  schemaVersion: SchemaV1,
  reelId: ReelId,
  mediaId: z.string().min(1),
  publishedAt: IsoDateTime.nullable(),
  snapshots: z.array(MetricsSnapshot),
});
export type Metrics = z.infer<typeof Metrics>;
