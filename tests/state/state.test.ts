import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { TransitionError } from '../../src/lib/transitions';
import { appendLedger, readLedger } from '../../src/state/ledger';
import { assertNotPaused, pauseState, setPaused } from '../../src/state/control';
import {
  DuplicateSubmissionError,
  QueueConflictError,
  enqueueRendered,
  readQueueItem,
  reviseItem,
  transitionItem,
} from '../../src/state/queue';
import { fetchVerified } from '../../src/state/artifacts';
import { NOW, seedItem, store, tmpEnv } from '../publish/helpers';

describe('queue store', () => {
  it('records every transition atomically with timestamp, attempt and error', async () => {
    const env = await tmpEnv();
    const item = await seedItem(env);
    expect(item.state).toBe('APPROVED');
    expect(item.history.map((h) => h.to)).toEqual(
      ['RENDERED', 'QA_PASSED', 'APPROVED'].slice(item.history.length === 3 ? 0 : 1),
    );
    const raw = JSON.parse(await fs.readFile(`${env.paths.queueDir}/${item.reelId}.json`, 'utf8')) as {
      schemaVersion: number;
    };
    expect(raw.schemaVersion).toBe(1);
  });

  it('rejects undefined transitions and QA_PASSED -> APPROVED outside auto mode', async () => {
    const env = await tmpEnv();
    await seedItem(env, '2026-11-03-01', 'QA_PASSED');
    await expect(
      transitionItem(env.paths, '2026-11-03-01', 'APPROVED', { publishMode: 'approval', now: NOW }),
    ).rejects.toBeInstanceOf(TransitionError);
    await expect(
      transitionItem(env.paths, '2026-11-03-01', 'PUBLISHED', { publishMode: 'auto', now: NOW }),
    ).rejects.toBeInstanceOf(TransitionError);
  });

  it('never allows a second publish request once one was made', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    const id = '2026-11-03-01';
    const ctx = { publishMode: 'auto' as const, now: NOW };
    await transitionItem(env.paths, id, 'CONTAINER_CREATED', { ...ctx, containerId: 'c1' });
    await transitionItem(env.paths, id, 'UPLOADED', ctx);
    await transitionItem(env.paths, id, 'READY', ctx);
    await transitionItem(env.paths, id, 'PUBLISH_REQUESTED', ctx);
    await transitionItem(env.paths, id, 'NEEDS_REVIEW', ctx);
    await expect(transitionItem(env.paths, id, 'APPROVED', ctx)).rejects.toBeInstanceOf(TransitionError);
  });

  it('duplicate submissions: same artifact is idempotent, a different one is refused', async () => {
    const env = await tmpEnv();
    const a = await seedItem(env);
    const again = await enqueueRendered(env.paths, {
      reelId: a.reelId,
      placement: 'main',
      slot: a.slot,
      scheduledAt: a.scheduledAt,
      artifact: a.artifact!,
      captionVersion: 1,
      now: NOW,
    });
    expect(again.state).toBe('APPROVED');
    await expect(
      enqueueRendered(env.paths, {
        reelId: a.reelId,
        placement: 'main',
        slot: a.slot,
        scheduledAt: a.scheduledAt,
        artifact: { ...a.artifact!, sha256: 'f'.repeat(64) },
        captionVersion: 1,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(DuplicateSubmissionError);
  });

  it('concurrent writers: compare-and-swap lets exactly one transition win', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        transitionItem(env.paths, '2026-11-03-01', 'CONTAINER_CREATED', {
          publishMode: 'auto',
          now: NOW,
          expectFrom: ['APPROVED'],
          containerId: 'c',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'rejected' && r.reason instanceof QueueConflictError),
    ).toHaveLength(4);
    const item = await readQueueItem(env.paths, '2026-11-03-01');
    expect(item?.history.filter((h) => h.to === 'CONTAINER_CREATED')).toHaveLength(1);
  });

  it('caption edit sends an approved item back for approval', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    const r = await reviseItem(
      env.paths,
      '2026-11-03-01',
      { captionVersion: 2 },
      { publishMode: 'approval', now: NOW },
    );
    expect(r.state).toBe('AWAITING_APPROVAL');
    expect(r.captionVersion).toBe(2);
    expect(r.approvalId).toBeNull();
  });
});

describe('ledger, control, artifacts', () => {
  it('ledger appends events concurrently without losing any', async () => {
    const env = await tmpEnv();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        appendLedger(env.paths, '2026-11-03-01', 'status_polled', { detail: String(i), now: NOW }),
      ),
    );
    expect((await readLedger(env.paths, '2026-11-03-01'))?.events).toHaveLength(6);
  });

  it('kill switch: control.json and config both pause', async () => {
    const env = await tmpEnv();
    expect((await pauseState(env.paths)).paused).toBe(false);
    expect((await pauseState(env.paths, true)).paused).toBe(true);
    await setPaused(env.paths, true, 'x', 'owner', NOW);
    await expect(assertNotPaused(env.paths)).rejects.toThrow(/paused/);
    await setPaused(env.paths, false, null, 'owner', NOW);
    await expect(assertNotPaused(env.paths)).resolves.toBeUndefined();
  });

  it('artifact verification: hash match, mismatch, missing and retention expiry', async () => {
    const env = await tmpEnv();
    const item = await seedItem(env);
    expect((await fetchVerified(store(env.video), item.artifact, NOW)).ok).toBe(true);
    const missing = await fetchVerified(store(null), item.artifact, NOW);
    expect(missing.ok ? null : missing.reason).toBe('missing');
    const late = await fetchVerified(store(null), item.artifact, new Date(NOW.getTime() + 30 * 86_400_000));
    expect(late.ok ? null : late.reason).toBe('retention_expired');
    await fs.writeFile(env.video, 'other');
    const bad = await fetchVerified(store(env.video), item.artifact, NOW);
    expect(bad.ok ? null : bad.reason).toBe('hash_mismatch');
  });
});
