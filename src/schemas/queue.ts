import { z } from 'zod';
import { HHMM, IsoDate, IsoDateTime, Placement, ReelId, SchemaV1, Sha256 } from './common';

/** Queue states (spec 7.8). Transitions are validated centrally in src/lib/transitions.ts. */
export const QUEUE_STATES = [
  'RENDERED',
  'QA_PASSED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'CONTAINER_CREATED',
  'UPLOADED',
  'READY',
  'PUBLISH_REQUESTED',
  'PUBLISHED',
  'REJECTED',
  'EXPIRED',
  'SKIPPED',
  'FAILED',
  'NEEDS_REVIEW',
] as const;
export const QueueState = z.enum(QUEUE_STATES);
export type QueueState = z.infer<typeof QueueState>;

export const QueueHistoryEntry = z.object({
  from: QueueState.nullable(),
  to: QueueState,
  at: IsoDateTime,
  attempt: z.number().int().nonnegative(),
  error: z.string().nullable(),
  note: z.string().nullable().default(null),
  runId: z.string().nullable().default(null),
});
export type QueueHistoryEntry = z.infer<typeof QueueHistoryEntry>;

export const ArtifactRef = z.object({
  /** GitHub Actions artifact name (or local path key on the Mac runtime). */
  name: z.string().min(1),
  sha256: Sha256,
  sizeBytes: z.number().int().positive(),
  localPath: z.string().nullable(),
  retainedUntil: IsoDateTime,
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/** data/queue/<reelId>.json — one file per reel, written atomically on every transition. */
export const QueueItem = z.object({
  schemaVersion: SchemaV1,
  reelId: ReelId,
  state: QueueState,
  placement: Placement,
  slot: z.object({ date: IsoDate, time: HHMM }),
  /** UTC instant of the slot. */
  scheduledAt: IsoDateTime,
  artifact: ArtifactRef.nullable(),
  captionVersion: z.number().int().positive(),
  /** Attempts in the current state (reset on successful transition to a new state). */
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  approvalId: z.string().nullable(),
  containerId: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  history: z.array(QueueHistoryEntry),
});
export type QueueItem = z.infer<typeof QueueItem>;
