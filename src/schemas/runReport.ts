import { z } from 'zod';
import { Confidence, IsoDate, IsoDateTime, LearningMode, PublishMode, ReplyMode, SchemaV1 } from './common';

export const RunKind = z.enum([
  'produce',
  'publish',
  'analyze',
  'learn',
  'engage',
  'trends',
  'daily',
  'dummy',
]);

const UsageMeter = z
  .object({ used: z.number().nonnegative(), limit: z.number().positive().nullable() })
  .nullable();

/**
 * Daily run report. Rendered to progress/runs/DATE.md with the 02 section 5.7 template
 * by src/lib/runReport.ts, and saved as JSON next to the run's state.
 */
export const RunReport = z.object({
  schemaVersion: SchemaV1,
  runId: z.string().min(1),
  kind: RunKind,
  date: IsoDate,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  modes: z.object({ publish: PublishMode, reply: ReplyMode, learning: LearningMode }),
  status: z.enum(['OK', 'WARN', 'FAILED']),
  trends: z.array(
    z.object({
      source: z.string(),
      why: z.string(),
      pattern: z.string(),
      confidence: Confidence,
      link: z.string().nullable(),
    }),
  ),
  reelsProduced: z.array(
    z.object({
      id: z.string(),
      hook: z.string(),
      format: z.string(),
      visualTiers: z.array(z.string()),
      lengthSec: z.number().nullable(),
      qa: z.enum(['PASS', 'FAIL', 'FLAGGED', 'PENDING']),
      slot: z.string().nullable(),
      placement: z.enum(['main', 'trial']),
    }),
  ),
  published: z.array(
    z.object({
      timeIst: z.string(),
      reelId: z.string(),
      placement: z.enum(['main', 'trial']),
      link: z.string().nullable(),
      lateStart: z.boolean(),
    }),
  ),
  approvals: z.object({ approved: z.number().int(), rejected: z.number().int(), expired: z.number().int() }),
  replies: z.object({ posted: z.number().int(), draftsAwaiting: z.number().int() }),
  needsReview: z.array(z.string()),
  performance: z.array(
    z.object({
      reelId: z.string(),
      views: z.number().nullable(),
      avgWatchTimeSec: z.number().nullable(),
      shares: z.number().nullable(),
      saves: z.number().nullable(),
      scoreVsMedian: z.number().nullable(),
    }),
  ),
  usage: z.object({
    cloudflareNeurons: UsageMeter,
    igPublishQuota: UsageMeter,
    githubMinutesThisMonth: UsageMeter,
  }),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  plan: z.array(z.string()),
});
export type RunReport = z.infer<typeof RunReport>;
