/**
 * Central queue-state transition validator (spec 7.8, gate G5).
 *
 * Every state change goes through applyTransition(), which:
 *  - rejects transitions not in ALLOWED_TRANSITIONS,
 *  - allows QA_PASSED -> APPROVED only in PUBLISH_MODE=auto,
 *  - forbids re-entering CONTAINER_CREATED or PUBLISH_REQUESTED once a publish was requested
 *    (a blind duplicate publish is impossible: such items must go through NEEDS_REVIEW),
 *  - appends an audit history entry (timestamp, attempt, error, note, runId).
 * Persist the returned item with writeJsonAtomic (one file per reel).
 */
import type { QueueItem, QueueState } from '../schemas/queue';

export const TERMINAL_STATES: ReadonlySet<QueueState> = new Set(['PUBLISHED', 'REJECTED', 'SKIPPED']);

export const ALLOWED_TRANSITIONS: Readonly<Record<QueueState, readonly QueueState[]>> = {
  RENDERED: ['QA_PASSED', 'FAILED', 'SKIPPED', 'NEEDS_REVIEW'],
  QA_PASSED: ['AWAITING_APPROVAL', 'APPROVED', 'SKIPPED', 'FAILED'],
  AWAITING_APPROVAL: ['APPROVED', 'REJECTED', 'EXPIRED', 'SKIPPED', 'RENDERED'],
  // APPROVED -> AWAITING_APPROVAL: caption edited / regenerated => earlier approval cancelled.
  APPROVED: ['CONTAINER_CREATED', 'AWAITING_APPROVAL', 'EXPIRED', 'SKIPPED', 'FAILED', 'RENDERED'],
  CONTAINER_CREATED: ['UPLOADED', 'EXPIRED', 'FAILED', 'NEEDS_REVIEW', 'SKIPPED'],
  UPLOADED: ['READY', 'EXPIRED', 'FAILED', 'NEEDS_REVIEW'],
  READY: ['PUBLISH_REQUESTED', 'EXPIRED', 'SKIPPED', 'NEEDS_REVIEW'],
  // After a publish request only remote evidence decides: PUBLISHED or NEEDS_REVIEW. Never FAILED+retry.
  PUBLISH_REQUESTED: ['PUBLISHED', 'NEEDS_REVIEW'],
  PUBLISHED: [],
  REJECTED: [],
  // Expired container: re-create only from a retained, hash-matching MP4 (-> APPROVED);
  // expired approval: ask again (-> AWAITING_APPROVAL); artifact gone: SKIPPED.
  EXPIRED: ['APPROVED', 'AWAITING_APPROVAL', 'SKIPPED'],
  // Failed before any publish request: may retry from APPROVED; otherwise review or skip.
  FAILED: ['APPROVED', 'NEEDS_REVIEW', 'SKIPPED', 'RENDERED'],
  // Owner / reconciliation resolves review items.
  NEEDS_REVIEW: ['PUBLISHED', 'SKIPPED', 'REJECTED', 'FAILED', 'APPROVED'],
  SKIPPED: [],
};

export class TransitionError extends Error {
  constructor(
    readonly from: QueueState,
    readonly to: QueueState,
    reason: string,
  ) {
    super(`invalid transition ${from} -> ${to}: ${reason}`);
    this.name = 'TransitionError';
  }
}

export interface TransitionContext {
  publishMode: 'dry_run' | 'approval' | 'auto';
  now?: Date;
  error?: string | null;
  note?: string | null;
  runId?: string | null;
  /** Container id to record when entering CONTAINER_CREATED. */
  containerId?: string | null;
  approvalId?: string | null;
}

function publishWasRequested(item: Pick<QueueItem, 'history'>): boolean {
  return item.history.some((h) => h.to === 'PUBLISH_REQUESTED');
}

/** Returns null if allowed, otherwise the reason. */
export function transitionProblem(
  item: Pick<QueueItem, 'state' | 'history'>,
  to: QueueState,
  ctx: Pick<TransitionContext, 'publishMode'>,
): string | null {
  const from = item.state;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) return 'not an allowed transition';
  if (from === 'QA_PASSED' && to === 'APPROVED' && ctx.publishMode !== 'auto') {
    return 'QA_PASSED -> APPROVED is only allowed in auto mode';
  }
  if (publishWasRequested(item)) {
    if (to === 'CONTAINER_CREATED' || to === 'PUBLISH_REQUESTED' || to === 'APPROVED') {
      return 'a publish was already requested for this reel; reconcile (NEEDS_REVIEW) instead of retrying';
    }
  }
  if (to === 'PUBLISHED' && from === 'NEEDS_REVIEW' && !publishWasRequested(item)) {
    return 'cannot mark PUBLISHED without a prior publish request';
  }
  return null;
}

export function canTransition(
  item: Pick<QueueItem, 'state' | 'history'>,
  to: QueueState,
  ctx: Pick<TransitionContext, 'publishMode'>,
): boolean {
  return transitionProblem(item, to, ctx) === null;
}

export function assertTransition(
  item: Pick<QueueItem, 'state' | 'history'>,
  to: QueueState,
  ctx: Pick<TransitionContext, 'publishMode'>,
): void {
  const p = transitionProblem(item, to, ctx);
  if (p) throw new TransitionError(item.state, to, p);
}

/** Pure: returns a new QueueItem in state `to` with an audit entry. Throws TransitionError if invalid. */
export function applyTransition(item: QueueItem, to: QueueState, ctx: TransitionContext): QueueItem {
  assertTransition(item, to, ctx);
  const at = (ctx.now ?? new Date()).toISOString();
  return {
    ...item,
    state: to,
    attempts: 0,
    lastError: ctx.error ?? null,
    containerId: ctx.containerId !== undefined ? ctx.containerId : item.containerId,
    approvalId: ctx.approvalId !== undefined ? ctx.approvalId : item.approvalId,
    updatedAt: at,
    history: [
      ...item.history,
      {
        from: item.state,
        to,
        at,
        attempt: item.attempts,
        error: ctx.error ?? null,
        note: ctx.note ?? null,
        runId: ctx.runId ?? null,
      },
    ],
  };
}

/** Record a failed attempt without changing state (bounded by the caller's retry policy). */
export function recordAttemptFailure(item: QueueItem, error: string, now: Date = new Date()): QueueItem {
  return { ...item, attempts: item.attempts + 1, lastError: error, updatedAt: now.toISOString() };
}
