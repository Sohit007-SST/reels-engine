import { z } from 'zod';
import { IsoDate, IsoDateTime, SchemaV1 } from './common';

/** data/control.json — kill switch. Checked before every publishing job and before each external write. */
export const Control = z.object({
  schemaVersion: SchemaV1,
  paused: z.boolean(),
  reason: z.string().nullable(),
  updatedAt: IsoDateTime,
  updatedBy: z.enum(['owner', 'system', 'setup']),
});
export type Control = z.infer<typeof Control>;

export const ProviderUsage = z.object({
  used: z.number().nonnegative(),
  /** Daily allowance; null = unknown => provider must be skipped (spec 7.5 quota guard). */
  limit: z.number().positive().nullable(),
  unit: z.string().min(1),
  updatedAt: IsoDateTime,
});
export type ProviderUsage = z.infer<typeof ProviderUsage>;

/** data/usage.json — per-provider daily counters. */
export const Usage = z.object({
  schemaVersion: SchemaV1,
  date: IsoDate,
  providers: z.record(z.string(), ProviderUsage),
});
export type Usage = z.infer<typeof Usage>;

/** Quota guard: stop at the reserve margin (default 85%); unknown usage or limit => not allowed. */
export function quotaAllows(u: ProviderUsage | undefined, cost: number, reserve = 0.85): boolean {
  if (!u || u.limit === null || !Number.isFinite(u.used)) return false;
  return u.used + cost <= u.limit * reserve;
}
