/**
 * Schemas for state files that only the publish module writes (all carry schemaVersion: 1).
 * Shared contracts (QueueItem, Ledger, Approval, Control, Usage, Metrics, RunReport) live in src/schemas.
 */
import { z } from 'zod';
import { IsoDate, IsoDateTime, ReelId, SchemaV1 } from '../schemas/common';

/** data/telegram/cursor.json — next getUpdates offset (updates are kept by Telegram only 24 h). */
export const TelegramCursor = z.object({
  schemaVersion: SchemaV1,
  offset: z.number().int().nonnegative(),
  updatedAt: IsoDateTime,
});
export type TelegramCursor = z.infer<typeof TelegramCursor>;

/** data/trial_control.json — set by the suppression alert (spec 7.11). */
export const TrialControl = z.object({
  schemaVersion: SchemaV1,
  trialPaused: z.boolean(),
  reason: z.string().nullable(),
  updatedAt: IsoDateTime,
});
export type TrialControl = z.infer<typeof TrialControl>;

export const ReplyStatus = z.enum([
  'drafted',
  'awaiting_approval',
  'approved',
  'posting',
  'posted',
  'skipped',
  'rejected',
  'failed',
]);
export type ReplyStatus = z.infer<typeof ReplyStatus>;

/** One record per comment ever seen. Guarantees "never two replies to the same comment". */
export const ReplyRecord = z.object({
  commentId: z.string().min(1),
  reelId: ReelId,
  mediaId: z.string().min(1),
  status: ReplyStatus,
  /** Reason for skipped/failed (spam, hate, personal data, ...). */
  reason: z.string().nullable(),
  draft: z.string().nullable(),
  replyId: z.string().nullable(),
  approvalId: z.string().nullable(),
  seenAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ReplyRecord = z.infer<typeof ReplyRecord>;

/** data/engage/replies.json — index of every comment handled. */
export const ReplyIndex = z.object({
  schemaVersion: SchemaV1,
  records: z.record(z.string(), ReplyRecord),
});
export type ReplyIndex = z.infer<typeof ReplyIndex>;

/** data/engage/DATE.json — what one day's engage runs did. */
export const EngageDay = z.object({
  schemaVersion: SchemaV1,
  date: IsoDate,
  runs: z.array(
    z.object({
      runId: z.string(),
      at: IsoDateTime,
      replyMode: z.enum(['off', 'approval', 'auto']),
      fetched: z.number().int().nonnegative(),
      drafted: z.number().int().nonnegative(),
      posted: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      requestsAdded: z.number().int().nonnegative(),
      errors: z.array(z.string()),
    }),
  ),
});
export type EngageDay = z.infer<typeof EngageDay>;

/** data/requests.json — "make part 2" / "do X next" requests from comments (idea bonus). */
export const RequestsFile = z.object({
  schemaVersion: SchemaV1,
  requests: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string().min(1).max(200),
      kind: z.enum(['part2', 'topic']),
      reelId: ReelId,
      commentId: z.string().min(1),
      at: IsoDateTime,
      used: z.boolean(),
    }),
  ),
});
export type RequestsFile = z.infer<typeof RequestsFile>;

/** data/metrics/scores.json — latest score per reel (analyze). */
export const ScoreEntry = z.object({
  reelId: ReelId,
  publishedAt: IsoDateTime.nullable(),
  window: z.enum(['24h', '72h', '7d']),
  views: z.number().nullable(),
  reach: z.number().nullable(),
  avgWatchTime: z.number().nullable(),
  sharesPer1k: z.number().nullable(),
  savesPer1k: z.number().nullable(),
  commentsPer1k: z.number().nullable(),
  skipRate: z.number().nullable(),
  /** Weighted ratio vs the 14-day median (1.0 = median); null when not computable. */
  scoreVsMedian: z.number().nullable(),
  format: z.string().nullable(),
  hookFormula: z.string().nullable(),
  slot: z.string().nullable(),
  placement: z.enum(['main', 'trial']).nullable(),
});
export type ScoreEntry = z.infer<typeof ScoreEntry>;

export const ScoresFile = z.object({
  schemaVersion: SchemaV1,
  updatedAt: IsoDateTime,
  weights: z.object({
    watchTime: z.number(),
    shares: z.number(),
    saves: z.number(),
    comments: z.number(),
    skipRate: z.number(),
  }),
  entries: z.array(ScoreEntry),
});
export type ScoresFile = z.infer<typeof ScoresFile>;

/** data/proposals/week-YYYY-WW.json — weekly learning proposals. */
export const ProposalChange = z.object({
  kind: z.enum(['format_weight', 'hook_promote', 'hook_retire', 'slot_note']),
  target: z.string().min(1),
  from: z.number().nullable(),
  to: z.number().nullable(),
  evidence: z.string().min(1),
});
export type ProposalChange = z.infer<typeof ProposalChange>;

export const ProposalFile = z.object({
  schemaVersion: SchemaV1,
  week: z.string().regex(/^\d{4}-\d{2}$/),
  createdAt: IsoDateTime,
  learningMode: z.enum(['propose', 'bounded_auto']),
  enoughData: z.boolean(),
  summary: z.string(),
  changes: z.array(ProposalChange),
  status: z.enum(['not_enough_data', 'proposed', 'applied', 'rejected']),
  approvalId: z.string().nullable(),
  appliedAt: IsoDateTime.nullable(),
  playbookVersion: z.number().int().positive().nullable(),
});
export type ProposalFile = z.infer<typeof ProposalFile>;

/** data/runs/<runId>.json — what a publish/engage/analyze run did (report input). */
export const RunSummary = z.object({
  schemaVersion: SchemaV1,
  runId: z.string().min(1),
  kind: z.enum(['publish', 'engage', 'analyze', 'learn']),
  date: IsoDate,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  dryRun: z.boolean(),
  published: z.array(
    z.object({
      reelId: ReelId,
      at: IsoDateTime,
      placement: z.enum(['main', 'trial']),
      permalink: z.string().nullable(),
      lateStart: z.boolean(),
    }),
  ),
  wouldPublish: z.array(ReelId),
  lateStarts: z.array(z.object({ reelId: ReelId, minutesLate: z.number() })),
  needsReview: z.array(ReelId),
  quota: z.object({ used: z.number(), limit: z.number().nullable() }).nullable(),
  repliesPosted: z.number().int().nonnegative(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type RunSummary = z.infer<typeof RunSummary>;
