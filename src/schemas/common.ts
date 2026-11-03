/** Shared primitives for every schema. All persisted files carry `schemaVersion`. */
import { z } from 'zod';

export const SchemaV1 = z.literal(1);

/** ISO-8601 timestamp with offset, e.g. "2026-11-05T05:17:00.000Z" or "+05:30". */
export const IsoDateTime = z.iso.datetime({ offset: true });
/** Calendar date "YYYY-MM-DD". */
export const IsoDate = z.iso.date();
/** Wall-clock "HH:MM" (24 h). */
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
/** Reel id "YYYY-MM-DD-NN". */
export const ReelId = z.string().regex(/^\d{4}-\d{2}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD-NN');
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected lowercase hex sha256');
export const HttpUrl = z.url({ protocol: /^https?$/ });
export const Score10 = z.number().min(1).max(10);
/** A metric that may be unavailable. Missing data is null, NEVER 0. */
export const NullableMetric = z.number().nonnegative().nullable();

export const Language = z.enum(['en', 'hi']);
export const Placement = z.enum(['main', 'trial']);
export const Confidence = z.enum(['low', 'medium', 'high']);
export const PublishMode = z.enum(['dry_run', 'approval', 'auto']);
export const ReplyMode = z.enum(['off', 'approval', 'auto']);
export const LearningMode = z.enum(['propose', 'bounded_auto']);
export const VisualTier = z.enum(['A', 'B', 'C', 'D']);

/** Count words the way on-screen limits are judged (whitespace separated). */
export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
