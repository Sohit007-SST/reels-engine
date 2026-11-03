/**
 * Queue store (T5.1): data/queue/<reelId>.json, one file per reel.
 *
 * Every state change goes through transitionItem(), which takes the per-file lock,
 * re-reads the current item, optionally checks the expected source state
 * (compare-and-swap against concurrent writers), applies the central validator from
 * src/lib/transitions.ts and writes atomically. Invalid transitions never reach disk.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { applyTransition, recordAttemptFailure, type TransitionContext } from '../lib/transitions';
import { readJsonOrNull, updateJsonAtomic, withFileLock, writeJsonAtomic } from '../lib/store';
import { QueueItem, type ArtifactRef, type QueueState } from '../schemas/queue';
import type { DataPaths } from './paths';

export class QueueConflictError extends Error {
  constructor(
    readonly reelId: string,
    readonly expected: readonly QueueState[],
    readonly actual: QueueState | null,
  ) {
    super(`queue item ${reelId} is in ${actual ?? 'MISSING'}, expected ${expected.join('|')}`);
    this.name = 'QueueConflictError';
  }
}

export class DuplicateSubmissionError extends Error {
  constructor(readonly reelId: string) {
    super(`queue item ${reelId} already exists with a different artifact or caption version`);
    this.name = 'DuplicateSubmissionError';
  }
}

export function queueFile(paths: DataPaths, reelId: string): string {
  return path.join(paths.queueDir, `${reelId}.json`);
}

export async function readQueueItem(paths: DataPaths, reelId: string): Promise<QueueItem | null> {
  return readJsonOrNull(queueFile(paths, reelId), QueueItem);
}

/** All queue items, sorted by scheduledAt then reelId. Unreadable files are reported, not thrown. */
export async function listQueueItems(
  paths: DataPaths,
): Promise<{ items: QueueItem[]; errors: Array<{ file: string; error: string }> }> {
  let names: string[];
  try {
    names = await fs.readdir(paths.queueDir);
  } catch {
    return { items: [], errors: [] };
  }
  const items: QueueItem[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  for (const name of names.sort()) {
    if (!/^\d{4}-\d{2}-\d{2}-\d{2}\.json$/.test(name)) continue;
    const file = path.join(paths.queueDir, name);
    try {
      const it = await readJsonOrNull(file, QueueItem);
      if (it) items.push(it);
    } catch (err) {
      errors.push({ file: name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  items.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.reelId.localeCompare(b.reelId));
  return { items, errors };
}

export interface EnqueueInput {
  reelId: string;
  placement: 'main' | 'trial';
  slot: { date: string; time: string };
  scheduledAt: string;
  artifact: ArtifactRef;
  captionVersion: number;
  now?: Date;
}

/**
 * Create the queue item in RENDERED (called by produce after render).
 * Idempotent for duplicate submissions of the same artifact + caption version;
 * a different submission for an existing reel throws DuplicateSubmissionError.
 */
export async function enqueueRendered(paths: DataPaths, input: EnqueueInput): Promise<QueueItem> {
  const file = queueFile(paths, input.reelId);
  return withFileLock(file, async () => {
    const existing = await readJsonOrNull(file, QueueItem);
    if (existing) {
      if (
        existing.artifact?.sha256 === input.artifact.sha256 &&
        existing.captionVersion === input.captionVersion
      ) {
        return existing;
      }
      throw new DuplicateSubmissionError(input.reelId);
    }
    const at = (input.now ?? new Date()).toISOString();
    const item = QueueItem.parse({
      schemaVersion: 1,
      reelId: input.reelId,
      state: 'RENDERED',
      placement: input.placement,
      slot: input.slot,
      scheduledAt: input.scheduledAt,
      artifact: input.artifact,
      captionVersion: input.captionVersion,
      attempts: 0,
      lastError: null,
      approvalId: null,
      containerId: null,
      createdAt: at,
      updatedAt: at,
      history: [{ from: null, to: 'RENDERED', at, attempt: 0, error: null, note: 'enqueued', runId: null }],
    });
    await writeJsonAtomic(file, item, QueueItem);
    return item;
  });
}

export interface TransitionOptions extends TransitionContext {
  /** Compare-and-swap: the transition only happens when the stored state is one of these. */
  expectFrom?: readonly QueueState[];
  /** Extra field changes applied together with the transition (same atomic write). */
  patch?: Partial<Pick<QueueItem, 'artifact' | 'captionVersion' | 'placement'>>;
}

/** Locked, validated, atomic transition. Throws TransitionError / QueueConflictError. */
export async function transitionItem(
  paths: DataPaths,
  reelId: string,
  to: QueueState,
  opts: TransitionOptions,
): Promise<QueueItem> {
  const file = queueFile(paths, reelId);
  return updateJsonAtomic(file, QueueItem, (current) => {
    if (!current) throw new QueueConflictError(reelId, opts.expectFrom ?? [], null);
    if (opts.expectFrom && !opts.expectFrom.includes(current.state)) {
      throw new QueueConflictError(reelId, opts.expectFrom, current.state);
    }
    const next = applyTransition(current, to, opts);
    return opts.patch ? { ...next, ...opts.patch } : next;
  });
}

/** Record a failed attempt (state unchanged). Returns the updated item. */
export async function recordFailure(
  paths: DataPaths,
  reelId: string,
  error: string,
  now: Date = new Date(),
): Promise<QueueItem> {
  return updateJsonAtomic(queueFile(paths, reelId), QueueItem, (current) => {
    if (!current) throw new QueueConflictError(reelId, [], null);
    return recordAttemptFailure(current, error, now);
  });
}

/**
 * Caption edit / regeneration: bump captionVersion (and/or swap the artifact) and send the
 * item back for approval. Earlier approvals stop matching (see approvals.ts) and are cancelled.
 */
export async function reviseItem(
  paths: DataPaths,
  reelId: string,
  change: { captionVersion?: number; artifact?: ArtifactRef },
  ctx: TransitionContext,
): Promise<QueueItem> {
  const file = queueFile(paths, reelId);
  return updateJsonAtomic(file, QueueItem, (current) => {
    if (!current) throw new QueueConflictError(reelId, [], null);
    const patch = {
      captionVersion: change.captionVersion ?? current.captionVersion,
      artifact: change.artifact ?? current.artifact,
    };
    if (current.state === 'APPROVED' || current.state === 'AWAITING_APPROVAL') {
      const to: QueueState = change.artifact ? 'RENDERED' : 'AWAITING_APPROVAL';
      if (current.state === 'AWAITING_APPROVAL' && to === 'AWAITING_APPROVAL') {
        return { ...current, ...patch, approvalId: null, updatedAt: (ctx.now ?? new Date()).toISOString() };
      }
      return { ...applyTransition(current, to, { ...ctx, approvalId: null }), ...patch };
    }
    if (current.state === 'RENDERED' || current.state === 'QA_PASSED') {
      return { ...current, ...patch, updatedAt: (ctx.now ?? new Date()).toISOString() };
    }
    throw new QueueConflictError(
      reelId,
      ['RENDERED', 'QA_PASSED', 'AWAITING_APPROVAL', 'APPROVED'],
      current.state,
    );
  });
}
