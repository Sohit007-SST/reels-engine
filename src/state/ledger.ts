/**
 * Publication ledger (data/ledger/<reelId>.json). Only remote evidence (a media ID from
 * media_publish, a container status of PUBLISHED, or a matching recent media item) proves
 * publication. A local publish_requested event never does.
 */
import path from 'node:path';
import { readJsonOrNull, updateJsonAtomic } from '../lib/store';
import { Ledger } from '../schemas/ledger';
import type { DataPaths } from './paths';

export type LedgerEvent = Ledger['events'][number]['type'];
export type LedgerPatch = Partial<Omit<Ledger, 'schemaVersion' | 'reelId' | 'events'>>;

export function ledgerFile(paths: DataPaths, reelId: string): string {
  return path.join(paths.ledgerDir, `${reelId}.json`);
}

export function emptyLedger(reelId: string): Ledger {
  return {
    schemaVersion: 1,
    reelId,
    igUserId: null,
    artifactSha256: null,
    containerId: null,
    containerCreatedAt: null,
    uploadedAt: null,
    publishRequestedAt: null,
    mediaId: null,
    permalink: null,
    publishedAt: null,
    confirmedVia: null,
    events: [],
  };
}

export async function readLedger(paths: DataPaths, reelId: string): Promise<Ledger | null> {
  return readJsonOrNull(ledgerFile(paths, reelId), Ledger);
}

/** Append one event and apply a patch, atomically (creates the ledger if missing). */
export async function appendLedger(
  paths: DataPaths,
  reelId: string,
  type: LedgerEvent,
  opts: { detail?: string | null; patch?: LedgerPatch; runId?: string | null; now?: Date } = {},
): Promise<Ledger> {
  const at = (opts.now ?? new Date()).toISOString();
  return updateJsonAtomic(ledgerFile(paths, reelId), Ledger, (current) => {
    const base = current ?? emptyLedger(reelId);
    return {
      ...base,
      ...(opts.patch ?? {}),
      events: [...base.events, { at, type, detail: opts.detail ?? null, runId: opts.runId ?? null }],
    };
  });
}

/** True when the ledger records an event of this type after the latest container_created. */
export function hasEventSinceContainer(ledger: Ledger | null, type: LedgerEvent): boolean {
  if (!ledger) return false;
  let lastContainer = -1;
  ledger.events.forEach((e, i) => {
    if (e.type === 'container_created') lastContainer = i;
  });
  return ledger.events.some((e, i) => i > lastContainer && e.type === type);
}
