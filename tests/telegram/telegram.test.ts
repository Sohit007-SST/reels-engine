import { afterEach, describe, expect, it } from 'vitest';
import { recordNetwork, setFetchImpl, setWritePolicy } from '../../src/lib/http';
import {
  createApproval,
  decideFromCallback,
  encodeCallback,
  itemVersionHash,
} from '../../src/state/approvals';
import { readControl } from '../../src/state/control';
import { readQueueItem, transitionItem } from '../../src/state/queue';
import { processTelegramUpdates } from '../../src/telegram/commands';
import { createTelegramClient } from '../../src/telegram/index';
import { NOW, fakeTelegram, seedItem, tmpEnv } from '../publish/helpers';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function pending() {
  const env = await tmpEnv();
  const item = await seedItem(env, '2026-11-03-01', 'QA_PASSED');
  const a = await createApproval(env.paths, {
    reelId: item.reelId,
    kind: 'publish',
    artifactSha256: env.sha,
    captionVersion: 1,
    ttlHours: 12,
    now: NOW,
  });
  await transitionItem(env.paths, item.reelId, 'AWAITING_APPROVAL', {
    publishMode: 'approval',
    approvalId: a.id,
    now: NOW,
  });
  const current = async () => itemVersionHash((await readQueueItem(env.paths, item.reelId))!);
  return { env, a, current };
}

describe('approval callbacks', () => {
  it('callback data fits in 64 bytes and approves once (replay-safe)', async () => {
    const { env, a, current } = await pending();
    const data = encodeCallback(a, 'approve');
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    const first = await decideFromCallback(env.paths, {
      chatId: '42',
      ownerChatId: '42',
      callbackData: data,
      now: NOW,
      currentVersionHash: current,
    });
    expect(first.outcome).toBe('approved');
    const second = await decideFromCallback(env.paths, {
      chatId: '42',
      ownerChatId: '42',
      callbackData: data,
      now: NOW,
      currentVersionHash: current,
    });
    expect(second.outcome).toBe('duplicate');
  });

  it('ignores unauthorized chats', async () => {
    const { env, a, current } = await pending();
    const r = await decideFromCallback(env.paths, {
      chatId: '999',
      ownerChatId: '42',
      callbackData: encodeCallback(a, 'approve'),
      now: NOW,
      currentVersionHash: current,
    });
    expect(r.outcome).toBe('unauthorized');
  });

  it('rejects stale (expired) and mismatched-version callbacks, and malformed data', async () => {
    const { env, a, current } = await pending();
    const later = new Date(NOW.getTime() + 13 * 3_600_000);
    const exp = await decideFromCallback(env.paths, {
      chatId: '42',
      ownerChatId: '42',
      callbackData: encodeCallback(a, 'approve'),
      now: later,
      currentVersionHash: current,
    });
    expect(exp.outcome).toBe('expired');

    const p2 = await pending();
    const p3 = await pending();
    const tampered = encodeCallback(p3.a, 'approve').replace(
      p3.a.versionHash,
      'abcdef0123'.slice(0, p3.a.versionHash.length),
    );
    const t = await decideFromCallback(p3.env.paths, {
      chatId: '42',
      ownerChatId: '42',
      callbackData: tampered,
      now: NOW,
      currentVersionHash: p3.current,
    });
    expect(['stale', 'unknown']).toContain(t.outcome);
    const mism = await decideFromCallback(p2.env.paths, {
      chatId: '42',
      ownerChatId: '42',
      callbackData: encodeCallback(p2.a, 'approve'),
      now: NOW,
      currentVersionHash: async () => 'deadbeef00',
    });
    expect(mism.outcome).toBe('stale');
    const mal = await decideFromCallback(p2.env.paths, {
      chatId: '42',
      ownerChatId: '42',
      callbackData: 'garbage',
      now: NOW,
      currentVersionHash: p2.current,
    });
    expect(mal.outcome).toBe('malformed');
  });

  it('processTelegramUpdates: non-owner ignored, owner approves, duplicate update replay is harmless', async () => {
    const { env, a } = await pending();
    const tg = fakeTelegram();
    const data = encodeCallback(a, 'approve');
    tg.updates.push(
      { updateId: 5, chatId: '7', kind: 'callback', text: null, callbackData: data, callbackQueryId: 'x' },
      { updateId: 6, chatId: '42', kind: 'callback', text: null, callbackData: data, callbackQueryId: 'y' },
      { updateId: 7, chatId: '42', kind: 'callback', text: null, callbackData: data, callbackQueryId: 'z' },
    );
    const deps = {
      paths: env.paths,
      telegram: tg,
      ownerChatId: '42',
      modes: { publish: 'approval' as const, reply: 'approval' as const, learning: 'propose' as const },
      configPaused: false,
      now: () => NOW,
    };
    const r = await processTelegramUpdates(deps);
    expect(r.ignoredUnauthorized).toBe(1);
    expect(r.decisions.map((d) => d.outcome)).toEqual(['approved', 'duplicate']);
    expect((await readQueueItem(env.paths, '2026-11-03-01'))?.state).toBe('APPROVED');
    // Cursor advanced: the same updates are not processed again.
    const r2 = await processTelegramUpdates(deps);
    expect(r2.processed).toBe(0);
  });

  it('/pause sets the kill switch, /resume clears it', async () => {
    const env = await tmpEnv();
    const tg = fakeTelegram();
    tg.updates.push({
      updateId: 1,
      chatId: '42',
      kind: 'message',
      text: '/pause',
      callbackData: null,
      callbackQueryId: null,
    });
    const deps = {
      paths: env.paths,
      telegram: tg,
      ownerChatId: '42',
      modes: { publish: 'dry_run' as const, reply: 'off' as const, learning: 'propose' as const },
      configPaused: false,
      now: () => NOW,
    };
    await processTelegramUpdates(deps);
    expect((await readControl(env.paths))?.paused).toBe(true);
    tg.updates.push({
      updateId: 2,
      chatId: '42',
      kind: 'message',
      text: '/resume',
      callbackData: null,
      callbackQueryId: null,
    });
    await processTelegramUpdates(deps);
    expect((await readControl(env.paths))?.paused).toBe(false);
  });
});

describe('telegram client (mocked transport)', () => {
  it('dry_run preview is labeled DRY RUN, has no buttons and counts as no external write', async () => {
    const env = await tmpEnv();
    const { a } = await pending();
    cleanups.push(setWritePolicy({ writesAllowed: false, reason: 'dry_run' }));
    const bodies: string[] = [];
    cleanups.push(
      setFetchImpl(async (_url, init) => {
        const b = init?.body;
        if (b instanceof FormData)
          bodies.push(JSON.stringify([...b.entries()].filter(([k]) => k !== 'video')));
        else if (typeof b === 'string') bodies.push(b);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 3 } }), { status: 200 });
      }),
    );
    const net = recordNetwork();
    cleanups.push(net.stop);
    const tg = createTelegramClient({
      botToken: '1:x',
      ownerChatId: '42',
      dryRun: true,
      compress: async (p) => p,
    });
    await tg.sendPreview({ videoPath: env.video, caption: 'hi', reelId: '2026-11-03-01', approval: a });
    await tg.sendApprovalRequest!('reply draft', a);
    expect(net.writes()).toEqual([]);
    expect(bodies.join()).toContain('DRY RUN');
    expect(bodies.join()).not.toContain('inline_keyboard');
  });

  it('live mode preview carries Approve/Reject buttons (write policy allows)', async () => {
    const env = await tmpEnv();
    const { a } = await pending();
    cleanups.push(setWritePolicy({ writesAllowed: true, reason: 'test' }));
    const bodies: string[] = [];
    cleanups.push(
      setFetchImpl(async (_url, init) => {
        const b = init?.body;
        if (b instanceof FormData) bodies.push(String(b.get('reply_markup')));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 3 } }), { status: 200 });
      }),
    );
    const tg = createTelegramClient({
      botToken: '1:x',
      ownerChatId: '42',
      dryRun: false,
      compress: async (p) => p,
    });
    await tg.sendPreview({ videoPath: env.video, caption: 'hi', reelId: '2026-11-03-01', approval: a });
    expect(bodies[0]).toContain('inline_keyboard');
  });
});
