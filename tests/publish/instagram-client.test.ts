/** MOCKED contract tests for the Instagram Graph client (no real Meta calls). */
import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyGraphError, createInstagramClient } from '../../src/instagram/client';
import { WriteBlockedError, recordNetwork, setFetchImpl, setWritePolicy } from '../../src/lib/http';
import { HttpError } from '../../src/lib/retry';
import { tmpEnv } from './helpers';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

type Call = { url: string; method: string; body: string; headers: Record<string, string> };
function mock(respond: (c: Call) => unknown): Call[] {
  const calls: Call[] = [];
  cleanups.push(
    setFetchImpl(async (url, init) => {
      const b = init?.body;
      const body = typeof b === 'string' ? b : b instanceof URLSearchParams ? b.toString() : '';
      const c = {
        url: String(url),
        method: init?.method ?? 'GET',
        body,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      };
      calls.push(c);
      return new Response(JSON.stringify(respond(c)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

const client = () =>
  createInstagramClient({ graphVersion: 'v26.0', igUserId: '1784', pageAccessToken: 'tok-test' });

describe('instagram client contract', () => {
  it('creates a REELS container with upload_type=resumable, thumb_offset and trial_params', async () => {
    cleanups.push(setWritePolicy({ writesAllowed: true, reason: 'test' }));
    const calls = mock(() => ({ id: 'c1', uri: 'https://rupload.facebook.com/x' }));
    const r = await client().createReelContainer({ caption: 'cap', thumbOffsetMs: 1500, placement: 'trial' });
    expect(r.containerId).toBe('c1');
    const c = calls[0]!;
    expect(c.url).toContain('/v26.0/1784/media');
    const all = decodeURIComponent(c.url + ' ' + c.body);
    expect(all).toContain('media_type=REELS');
    expect(all).toContain('upload_type=resumable');
    expect(all).toContain('thumb_offset=1500');
    expect(all).toContain('SS_PERFORMANCE');
  });

  it('uploads bytes to rupload with OAuth header, offset and file_size', async () => {
    cleanups.push(setWritePolicy({ writesAllowed: true, reason: 'test' }));
    const env = await tmpEnv();
    const calls = mock(() => ({ success: true }));
    await client().uploadResumable('c1', env.video);
    const c = calls[0]!;
    expect(c.url).toMatch(/rupload\.facebook\.com\/ig-api-upload\/v26\.0\/c1$/);
    expect(c.headers.authorization).toBe('OAuth tok-test');
    expect(c.headers.offset).toBe('0');
    expect(c.headers.file_size).toBe(String((await fs.stat(env.video)).size));
  });

  it('reads status_code and publishing limit (reads allowed in dry_run)', async () => {
    cleanups.push(setWritePolicy({ writesAllowed: false, reason: 'dry_run' }));
    const net = recordNetwork();
    cleanups.push(net.stop);
    mock((c) =>
      c.url.includes('content_publishing_limit')
        ? { data: [{ quota_usage: 3, config: { quota_total: 50 } }] }
        : { status_code: 'FINISHED', status: 'Finished' },
    );
    expect((await client().getContainerStatus('c1')).statusCode).toBe('FINISHED');
    expect(await client().getPublishingLimit()).toMatchObject({ quotaUsage: 3, quotaTotal: 50 });
    expect(net.writes()).toEqual([]);
  });

  it('dry_run blocks every write endpoint before it reaches the network', async () => {
    cleanups.push(setWritePolicy({ writesAllowed: false, reason: 'dry_run' }));
    const calls = mock(() => ({ id: 'x' }));
    await expect(client().publishContainer('c1')).rejects.toBeInstanceOf(WriteBlockedError);
    await expect(
      client().createReelContainer({ caption: 'c', thumbOffsetMs: 0, placement: 'main' }),
    ).rejects.toBeInstanceOf(WriteBlockedError);
    await expect(client().replyToComment('cm', 'hi')).rejects.toBeInstanceOf(WriteBlockedError);
    expect(calls).toEqual([]);
  });

  it('never puts the access token in logs-facing error text', async () => {
    cleanups.push(setWritePolicy({ writesAllowed: false, reason: 'dry_run' }));
    mock(() => ({}));
    const err = await client()
      .publishContainer('c1')
      .catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain('tok-test');
  });
});

describe('graph error classification', () => {
  const he = (status: number, error: Record<string, unknown>) =>
    new HttpError('graph error', status, {
      url: 'https://graph.facebook.com/x',
      body: JSON.stringify({ error }),
    });
  it.each([
    [429, { code: 4 }, 'transient'],
    [500, { code: 1 }, 'transient'],
    [400, { code: 9007, is_transient: true }, 'transient'],
    [400, { code: 190 }, 'permanent'],
    [403, { code: 10 }, 'permanent'],
    [400, { code: 100 }, 'permanent'],
  ])('status %s %j -> %s', (status, error, cls) => {
    expect(classifyGraphError(he(status, error)).errorClass).toBe(cls);
  });
});
