import { z } from 'zod';
import { IsoDateTime, ReelId, SchemaV1, Sha256 } from './common';

export const ApprovalDecision = z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/**
 * data/approvals/<reelId>-<approvalId>.json. Bound to artifact hash + caption version + expiry;
 * accepted once (replay-safe). Regenerating or editing the caption cancels earlier approvals.
 */
export const Approval = z.object({
  schemaVersion: SchemaV1,
  id: z.string().min(1),
  reelId: ReelId,
  kind: z.enum(['publish', 'reply', 'learning', 'live_test']),
  artifactSha256: Sha256.nullable(),
  captionVersion: z.number().int().positive().nullable(),
  /** Short hash of artifact hash + caption version, carried in callback data (<= 64 bytes total). */
  versionHash: z.string().min(6).max(16),
  /** One-time nonce for replay protection. */
  nonce: z.string().min(6).max(16),
  requestedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  decision: ApprovalDecision,
  decidedAt: IsoDateTime.nullable(),
  /** "owner" when TELEGRAM_CHAT_ID matched; raw chat ids are never stored for others. */
  decidedBy: z.enum(['owner', 'system']).nullable(),
  consumed: z.boolean(),
  telegramMessageId: z.number().int().nullable(),
  note: z.string().nullable().default(null),
});
export type Approval = z.infer<typeof Approval>;
