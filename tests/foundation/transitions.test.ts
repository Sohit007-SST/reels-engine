import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  applyTransition,
  canTransition,
  recordAttemptFailure,
  TransitionError,
} from '../../src/lib/transitions';
import { QUEUE_STATES, QueueItem, type QueueState } from '../../src/schemas';

const now = new Date('2026-11-05T00:00:00.000Z');

function item(state: QueueState = 'RENDERED'): QueueItem {
  return QueueItem.parse({
    schemaVersion: 1,
    reelId: '2026-11-05-01',
    state,
    placement: 'main',
    slot: { date: '2026-11-05', time: '08:30' },
    scheduledAt: '2026-11-05T03:00:00.000Z',
    artifact: null,
    captionVersion: 1,
    attempts: 0,
    lastError: null,
    approvalId: null,
    containerId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    history: [],
  });
}

const walk = (states: QueueState[], mode: 'dry_run' | 'approval' | 'auto' = 'approval') =>
  states.reduce((it, s) => applyTransition(it, s, { publishMode: mode, now }), item());

describe('queue transitions', () => {
  it('happy path in approval mode with full audit history', () => {
    const final = walk([
      'QA_PASSED',
      'AWAITING_APPROVAL',
      'APPROVED',
      'CONTAINER_CREATED',
      'UPLOADED',
      'READY',
      'PUBLISH_REQUESTED',
      'PUBLISHED',
    ]);
    expect(final.state).toBe('PUBLISHED');
    expect(final.history).toHaveLength(8);
    expect(final.history[0]).toMatchObject({ from: 'RENDERED', to: 'QA_PASSED' });
    expect(QueueItem.safeParse(final).success).toBe(true);
  });

  it('QA_PASSED -> APPROVED only in auto mode', () => {
    const qa = applyTransition(item(), 'QA_PASSED', { publishMode: 'approval', now });
    expect(canTransition(qa, 'APPROVED', { publishMode: 'approval' })).toBe(false);
    expect(canTransition(qa, 'APPROVED', { publishMode: 'dry_run' })).toBe(false);
    expect(canTransition(qa, 'APPROVED', { publishMode: 'auto' })).toBe(true);
  });

  it.each<[QueueState, QueueState]>([
    ['RENDERED', 'PUBLISHED'],
    ['RENDERED', 'APPROVED'],
    ['AWAITING_APPROVAL', 'CONTAINER_CREATED'],
    ['APPROVED', 'PUBLISH_REQUESTED'],
    ['UPLOADED', 'PUBLISHED'],
    ['PUBLISH_REQUESTED', 'FAILED'],
    ['PUBLISH_REQUESTED', 'CONTAINER_CREATED'],
    ['PUBLISHED', 'RENDERED'],
    ['REJECTED', 'APPROVED'],
    ['SKIPPED', 'APPROVED'],
  ])('rejects %s -> %s', (from, to) => {
    expect(() => applyTransition(item(from), to, { publishMode: 'auto', now })).toThrow(TransitionError);
  });

  it('terminal states have no exits', () => {
    for (const s of ['PUBLISHED', 'REJECTED', 'SKIPPED'] as const)
      expect(ALLOWED_TRANSITIONS[s]).toHaveLength(0);
  });

  it('every state has an entry in the table', () => {
    for (const s of QUEUE_STATES) expect(ALLOWED_TRANSITIONS[s]).toBeDefined();
  });

  it('never allows a blind re-publish after a publish request', () => {
    const requested = walk([
      'QA_PASSED',
      'AWAITING_APPROVAL',
      'APPROVED',
      'CONTAINER_CREATED',
      'UPLOADED',
      'READY',
      'PUBLISH_REQUESTED',
    ]);
    const review = applyTransition(requested, 'NEEDS_REVIEW', {
      publishMode: 'approval',
      now,
      error: 'publish unclear',
    });
    expect(review.lastError).toBe('publish unclear');
    expect(canTransition(review, 'APPROVED', { publishMode: 'approval' })).toBe(false);
    expect(canTransition(review, 'PUBLISHED', { publishMode: 'approval' })).toBe(true);
    expect(canTransition(review, 'SKIPPED', { publishMode: 'approval' })).toBe(true);
  });

  it('NEEDS_REVIEW -> PUBLISHED requires a prior publish request', () => {
    const review = applyTransition(item(), 'NEEDS_REVIEW', { publishMode: 'approval', now });
    expect(canTransition(review, 'PUBLISHED', { publishMode: 'approval' })).toBe(false);
  });

  it('expired container can be re-created from APPROVED; failed pre-publish can retry', () => {
    const created = walk([
      'QA_PASSED',
      'AWAITING_APPROVAL',
      'APPROVED',
      'CONTAINER_CREATED',
      'EXPIRED',
      'APPROVED',
      'CONTAINER_CREATED',
      'FAILED',
      'APPROVED',
    ]);
    expect(created.state).toBe('APPROVED');
  });

  it('caption edit after approval returns to AWAITING_APPROVAL', () => {
    const it2 = walk(['QA_PASSED', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_APPROVAL']);
    expect(it2.state).toBe('AWAITING_APPROVAL');
  });

  it('records attempts and resets them on a successful transition', () => {
    let it2 = recordAttemptFailure(item('APPROVED'), 'timeout', now);
    it2 = recordAttemptFailure(it2, 'timeout', now);
    expect(it2.attempts).toBe(2);
    const next = applyTransition(it2, 'CONTAINER_CREATED', {
      publishMode: 'approval',
      now,
      containerId: 'c1',
    });
    expect(next.attempts).toBe(0);
    expect(next.containerId).toBe('c1');
    expect(next.history.at(-1)?.attempt).toBe(2);
  });

  it('does not mutate the input item', () => {
    const a = item();
    applyTransition(a, 'QA_PASSED', { publishMode: 'approval', now });
    expect(a.state).toBe('RENDERED');
    expect(a.history).toHaveLength(0);
  });
});
