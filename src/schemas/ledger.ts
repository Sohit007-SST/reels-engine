import { z } from 'zod';
import { IsoDateTime, ReelId, SchemaV1 } from './common';

export const LedgerEventType = z.enum([
  'container_created',
  'upload_started',
  'upload_finished',
  'status_polled',
  'publish_requested',
  'publish_confirmed',
  'reconciled',
  'needs_review',
  'error',
]);

/**
 * data/ledger/<reelId>.json — publication ledger. Only remote evidence (mediaId/permalink)
 * proves publication; a local publish_requested event never does.
 */
export const Ledger = z.object({
  schemaVersion: SchemaV1,
  reelId: ReelId,
  igUserId: z.string().nullable(),
  artifactSha256: z.string().nullable(),
  containerId: z.string().nullable(),
  containerCreatedAt: IsoDateTime.nullable(),
  uploadedAt: IsoDateTime.nullable(),
  publishRequestedAt: IsoDateTime.nullable(),
  mediaId: z.string().nullable(),
  permalink: z.string().nullable(),
  publishedAt: IsoDateTime.nullable(),
  confirmedVia: z.enum(['media_publish_response', 'container_status', 'recent_media']).nullable(),
  events: z.array(
    z.object({
      at: IsoDateTime,
      type: LedgerEventType,
      detail: z.string().nullable(),
      runId: z.string().nullable().default(null),
    }),
  ),
});
export type Ledger = z.infer<typeof Ledger>;
