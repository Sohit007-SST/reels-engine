import { z } from 'zod';
import { IsoDateTime, ReelId, SchemaV1 } from './common';

export const QaCategory = z.enum(['technical', 'visual', 'facts', 'originality', 'policy', 'content']);
export const QaStatus = z.enum(['pass', 'fail', 'warn', 'skip']);

export const QaCheck = z.object({
  id: z.string().min(1),
  category: QaCategory,
  status: QaStatus,
  message: z.string(),
  /** Measured values (numbers, frame indexes, scores). */
  details: z.record(z.string(), z.unknown()).default({}),
  /** Which beat/scene to regenerate for the one automatic fix, if applicable. */
  beatIndex: z.number().int().nonnegative().nullable().default(null),
});
export type QaCheck = z.infer<typeof QaCheck>;

/** data/qa/DATE/<reelId>.json */
export const QaReport = z.object({
  schemaVersion: SchemaV1,
  reelId: ReelId,
  createdAt: IsoDateTime,
  /** pass = no failing checks; flagged = borderline originality etc. needing owner eyes. */
  verdict: z.enum(['pass', 'fail', 'flagged']),
  checks: z.array(QaCheck),
  autoFixAttempted: z.boolean(),
});
export type QaReport = z.infer<typeof QaReport>;

export function qaVerdict(checks: QaCheck[], flagged = false): 'pass' | 'fail' | 'flagged' {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  return flagged ? 'flagged' : 'pass';
}
