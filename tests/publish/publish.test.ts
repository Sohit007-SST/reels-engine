import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createInstagramClient } from '../../src/instagram/client';
import { recordNetwork, setFetchImpl, setWritePolicy } from '../../src/lib/http';
import { runPublish, type PublishDeps } from '../../src/pipeline/publish';
import { encodeCallback } from '../../src/state/approvals';
import { setPaused } from '../../src/state/control';
import { readLedger } from '../../src/state/ledger';
import { readQueueItem } from '../../src/state/queue';
import { createTelegramClient } from '../../src/telegram/index';
import {
  CAPTION,
  NOW,
  fakeInstagram,
  fakeTelegram,
  newRemote,
  seedItem,
  store,
  tmpEnv,
  type Remote,
} from './helpers';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function deps(
  env: Awaited<ReturnType<typeof tmpEnv>>,
  remote: Remote,
  over: Partial<PublishDeps> = {},
  crashAt: string | null = null,
): PublishDeps {
  return {
    paths: env.paths,
    instagram: fakeInstagram(remote, crashAt),
    telegram: null,
    artifacts: store(env.video),
    publishMode: 'auto',
    runId: 'publish-20261103-080000-abcdef',
    now: () => NOW,
    sleep: async () => {},
    pollIntervalMs: 1,
    pollMaxMs: 10,
    captionFor: async () => CAPTION,
    ...over,
  };
}

describe('publish pipeline (MOCKED Instagram)', () => {
  it('publishes a due approved item end to end and records remote evidence', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    const remote = newRemote();
    const tg = fakeTelegram();
    const s = await runPublish(deps(env, remote, { telegram: tg, ownerChatId: '1' }));
    expect(s.errors).toEqual([]);
    expect(s.published).toHaveLength(1);
    const item = await readQueueItem(env.paths, '2026-11-03-01');
    expect(item?.state).toBe('PUBLISHED');
    const ledger = await readLedger(env.paths, '2026-11-03-01');
    expect(ledger?.mediaId).toMatch(/^m/);
    expect(ledger?.confirmedVia).toBe('media_publish_response');
    expect(ledger?.events.map((e) => e.type)).toEqual([
      'container_created',
      'upload_started',
      'upload_finished',
      'publish_requested',
      'publish_confirmed',
    ]);
    expect(remote.publishCount).toBe(1);
    expect(tg.sent.some((t) => t.startsWith('Published'))).toBe(true);
  });

  it('does not publish items whose slot is not due yet', async () => {
    const env = await tmpEnv();
    await seedItem(env, '2026-11-03-02', 'APPROVED', new Date(NOW.getTime() + 3_600_000).toISOString());
    const remote = newRemote();
    await runPublish(deps(env, remote));
    expect(remote.calls).not.toContain('createReelContainer');
  });

  const CRASH_POINTS = [
    'createReelContainer:before',
    'createReelContainer:after',
    'uploadResumable:before',
    'uploadResumable:after',
    'publishContainer:before',
    'publishContainer:after',
  ];
  for (const point of CRASH_POINTS) {
    it(`crash at ${point} -> recovers or NEEDS_REVIEW, never a duplicate publish`, async () => {
      const env = await tmpEnv();
      await seedItem(env);
      const remote = newRemote();
      await runPublish(deps(env, remote, {}, point));
      await runPublish(deps(env, remote));
      await runPublish(deps(env, remote));
      const item = await readQueueItem(env.paths, '2026-11-03-01');
      expect(['PUBLISHED', 'NEEDS_REVIEW']).toContain(item?.state);
      expect(remote.publishCount).toBeLessThanOrEqual(1);
      if (point === 'publishContainer:before') expect(item?.state).toBe('NEEDS_REVIEW');
      if (point === 'publishContainer:after') {
        expect(item?.state).toBe('PUBLISHED');
        expect((await readLedger(env.paths, '2026-11-03-01'))?.confirmedVia).toBe('recent_media');
      }
      if (point.startsWith('create') || point.startsWith('upload')) expect(item?.state).toBe('PUBLISHED');
      if (point === 'uploadResumable:after')
        expect(remote.calls.filter((c) => c === 'uploadResumable')).toHaveLength(1);
    });
  }

  it('crash after PUBLISH_REQUESTED was written but before media_publish -> NEEDS_REVIEW, no publish', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    const remote = newRemote();
    // Run until READY by making publish crash "before"; then verify reconcile never re-publishes.
    await runPublish(deps(env, remote, {}, 'publishContainer:before'));
    const again = await runPublish(deps(env, remote));
    expect(remote.publishCount).toBe(0);
    expect((await readQueueItem(env.paths, '2026-11-03-01'))?.state).toBe('NEEDS_REVIEW');
    expect(again.published).toHaveLength(0);
  });

  it('crash after publish confirmed / ledger written -> reconciles from the ledger without calling Instagram writes', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    const remote = newRemote();
    await runPublish(deps(env, remote));
    // Simulate: ledger has mediaId but the queue write PUBLISHED was lost.
    const file = `${env.paths.queueDir}/2026-11-03-01.json`;
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { state: string; history: unknown[] };
    raw.state = 'PUBLISH_REQUESTED';
    raw.history = raw.history.slice(0, -1);
    await fs.writeFile(file, JSON.stringify(raw));
    remote.calls.length = 0;
    await runPublish(deps(env, remote));
    expect((await readQueueItem(env.paths, '2026-11-03-01'))?.state).toBe('PUBLISHED');
    expect(remote.calls).not.toContain('publishContainer');
    expect(remote.publishCount).toBe(1);
  });

  it('kill switch: paused before the job -> nothing happens', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    await setPaused(env.paths, true, 'test', 'owner', NOW);
    const remote = newRemote();
    const s = await runPublish(deps(env, remote));
    expect(remote.calls).toEqual([]);
    expect(s.warnings.join()).toMatch(/paused/);
  });

  it('kill switch re-checked before media_publish (paused mid-run)', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    const remote = newRemote();
    const ig = fakeInstagram(remote);
    const orig = ig.getContainerStatus.bind(ig);
    ig.getContainerStatus = async (id) => {
      const r = await orig(id);
      if (r.statusCode === 'FINISHED') await setPaused(env.paths, true, 'owner /pause', 'owner', NOW);
      return r;
    };
    await runPublish(deps(env, remote, { instagram: ig }));
    expect(remote.publishCount).toBe(0);
    expect((await readQueueItem(env.paths, '2026-11-03-01'))?.state).toBe('READY');
  });

  it('quota guard stops at 90% of the publishing limit', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    const remote = newRemote();
    remote.quotaUsage = 45;
    const s = await runPublish(deps(env, remote));
    expect(remote.calls).not.toContain('createReelContainer');
    expect(s.warnings.join()).toMatch(/quota/);
  });

  it('missing artifact -> SKIPPED with reason; hash mismatch -> FAILED; batch continues', async () => {
    const env = await tmpEnv();
    await seedItem(env, '2026-11-03-01');
    await seedItem(env, '2026-11-03-02');
    const remote = newRemote();
    const s = await runPublish(deps(env, remote, { artifacts: store(null) }));
    expect((await readQueueItem(env.paths, '2026-11-03-01'))?.state).toBe('SKIPPED');
    expect((await readQueueItem(env.paths, '2026-11-03-02'))?.state).toBe('SKIPPED');
    expect(s.errors).toEqual([]);
    const env2 = await tmpEnv();
    await seedItem(env2);
    await fs.writeFile(env2.video, 'tampered');
    await runPublish(deps(env2, newRemote()));
    expect((await readQueueItem(env2.paths, '2026-11-03-01'))?.state).toBe('FAILED');
  });

  it('expired container is re-created only from the hash-matching artifact', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    const remote = newRemote();
    await runPublish(deps(env, remote, {}, 'uploadResumable:before'));
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    await runPublish(deps(env, remote, { now: () => later }));
    const item = await readQueueItem(env.paths, '2026-11-03-01');
    expect(item?.state).toBe('PUBLISHED');
    expect(remote.calls.filter((c) => c === 'createReelContainer')).toHaveLength(2);
    expect(item?.history.some((h) => h.to === 'EXPIRED')).toBe(true);
  });

  it('duplicate submissions / concurrent runs never publish twice', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    const remote = newRemote();
    await Promise.allSettled([
      runPublish(deps(env, remote)),
      runPublish(deps(env, remote)),
      runPublish(deps(env, remote)),
    ]);
    await runPublish(deps(env, remote));
    expect(remote.publishCount).toBe(1);
    expect((await readQueueItem(env.paths, '2026-11-03-01'))?.state).toBe('PUBLISHED');
  });

  it('approval mode: preview with bound buttons, owner approves via callback, then publishes', async () => {
    const env = await tmpEnv();
    await seedItem(env, '2026-11-03-01', 'QA_PASSED');
    const remote = newRemote();
    const tg = fakeTelegram();
    const d = deps(env, remote, { publishMode: 'approval', telegram: tg, ownerChatId: '42' });
    await runPublish(d);
    expect((await readQueueItem(env.paths, '2026-11-03-01'))?.state).toBe('AWAITING_APPROVAL');
    const approval = tg.previews[0]?.approval;
    expect(approval).toBeTruthy();
    const data = encodeCallback(approval!, 'approve');
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    tg.updates.push({
      updateId: 1,
      chatId: '42',
      kind: 'callback',
      text: null,
      callbackData: data,
      callbackQueryId: 'q1',
    });
    await runPublish(d);
    expect((await readQueueItem(env.paths, '2026-11-03-01'))?.state).toBe('PUBLISHED');
    expect(remote.publishCount).toBe(1);
  });

  it('approval mode: an unapproved APPROVED-state item (approval missing) is not published', async () => {
    const env = await tmpEnv();
    await seedItem(env);
    const remote = newRemote();
    await runPublish(deps(env, remote, { publishMode: 'approval' }));
    expect(remote.publishCount).toBe(0);
    expect(remote.calls).not.toContain('createReelContainer');
  });
});

describe('dry_run network spy (real clients, mocked transport)', () => {
  it('dry_run performs zero external writes and no queue transitions', async () => {
    const env = await tmpEnv();
    await seedItem(env, '2026-11-03-01');
    await seedItem(env, '2026-11-03-02', 'QA_PASSED');
    cleanups.push(setWritePolicy({ writesAllowed: false, reason: 'PUBLISH_MODE=dry_run' }));
    cleanups.push(
      setFetchImpl(async (url) => {
        const body = String(url).includes('content_publishing_limit')
          ? { data: [{ quota_usage: 0, config: { quota_total: 50 } }] }
          : String(url).includes('getUpdates')
            ? { ok: true, result: [] }
            : { ok: true, result: { message_id: 7 } };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const net = recordNetwork();
    cleanups.push(net.stop);
    const ig = createInstagramClient({
      graphVersion: 'v26.0',
      igUserId: '1784',
      pageAccessToken: 'test-token',
    });
    const tg = createTelegramClient({
      botToken: '123:abc',
      ownerChatId: '42',
      dryRun: true,
      compress: async (p) => p,
    });
    const s = await runPublish({
      ...deps(env, newRemote()),
      instagram: ig,
      telegram: tg,
      ownerChatId: '42',
      publishMode: 'dry_run',
    });
    expect(net.writes()).toEqual([]);
    expect(net.events.some((e) => e.url.includes('graph.facebook.com') && e.isWrite)).toBe(false);
    expect(s.dryRun).toBe(true);
    expect(s.wouldPublish).toContain('2026-11-03-01');
    expect((await readQueueItem(env.paths, '2026-11-03-01'))?.state).toBe('APPROVED');
    expect((await readQueueItem(env.paths, '2026-11-03-02'))?.state).toBe('QA_PASSED');
  });
});
