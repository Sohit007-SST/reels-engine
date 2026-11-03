import { afterEach, describe, expect, it } from 'vitest';
import {
  httpRequest,
  recordNetwork,
  setFetchImpl,
  setWritePolicy,
  WriteBlockedError,
} from '../../src/lib/http';
import { clearRegisteredSecrets, registerSecret } from '../../src/lib/redact';
import {
  backoffDelay,
  classifyError,
  HttpError,
  PermanentError,
  retry,
  RetryDeadlineError,
  TimeoutError,
} from '../../src/lib/retry';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
  clearRegisteredSecrets();
});

const mockFetch = (fn: (url: string, init?: RequestInit) => Promise<Response>) =>
  restores.push(setFetchImpl(fn));
const blockWrites = () =>
  restores.push(setWritePolicy({ writesAllowed: false, reason: 'PUBLISH_MODE=dry_run' }));
const allowWrites = () => restores.push(setWritePolicy({ writesAllowed: true, reason: 'test' }));
const noSleep = { sleep: async () => undefined, random: () => 0.5 };

describe('retry', () => {
  it('classifies transient vs permanent', () => {
    expect(classifyError(new HttpError('x', 429))).toBe('transient');
    expect(classifyError(new HttpError('x', 503))).toBe('transient');
    expect(classifyError(new HttpError('x', 400))).toBe('permanent');
    expect(classifyError(new HttpError('x', 401))).toBe('permanent');
    expect(classifyError(new HttpError('x', 403))).toBe('permanent');
    expect(classifyError(new HttpError('x', 404))).toBe('permanent');
    expect(classifyError(new HttpError('x', 501))).toBe('permanent');
    expect(classifyError(new TimeoutError())).toBe('transient');
    expect(classifyError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe('transient');
    expect(classifyError(new PermanentError('schema'))).toBe('permanent');
    expect(classifyError(new Error('validation failed'))).toBe('permanent');
  });

  it('retries transient errors at most 3 attempts total', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new HttpError('busy', 503);
        },
        { maxAttempts: 10, ...noSleep },
      ),
    ).rejects.toThrow('busy');
    expect(calls).toBe(3);
  });

  it('does not retry permanent errors', async () => {
    let calls = 0;
    await expect(
      retry(async () => {
        calls++;
        throw new HttpError('denied', 403);
      }, noSleep),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('succeeds after a transient failure', async () => {
    let calls = 0;
    const v = await retry(async () => {
      if (++calls < 2) throw new TimeoutError();
      return 'ok';
    }, noSleep);
    expect(v).toBe('ok');
  });

  it('respects the overall deadline', async () => {
    let t = 0;
    await expect(
      retry(
        async () => {
          throw new HttpError('busy', 500);
        },
        {
          deadlineMs: 100,
          baseDelayMs: 1000,
          random: () => 1,
          now: () => t,
          sleep: async (ms) => {
            t += ms;
          },
        },
      ),
    ).rejects.toThrow(RetryDeadlineError);
  });

  it('backoff has jitter bounded by exponential ceiling', () => {
    expect(backoffDelay(1, 500, 8000, () => 1)).toBe(500);
    expect(backoffDelay(3, 500, 8000, () => 1)).toBe(2000);
    expect(backoffDelay(10, 500, 8000, () => 1)).toBe(8000);
    expect(backoffDelay(3, 500, 8000, () => 0)).toBe(0);
  });
});

describe('http wrapper + network spy', () => {
  it('blocks writes in dry_run before any network call, and the spy sees it', async () => {
    blockWrites();
    let fetched = 0;
    mockFetch(async () => {
      fetched++;
      return new Response('{}');
    });
    const rec = recordNetwork();
    restores.push(rec.stop);
    await expect(
      httpRequest('https://graph.facebook.com/v1/123/media', {
        method: 'POST',
        provider: 'instagram',
        body: { a: 1 },
      }),
    ).rejects.toThrow(WriteBlockedError);
    expect(fetched).toBe(0);
    expect(rec.writes()).toHaveLength(1);
    expect(rec.sentWrites()).toHaveLength(0);
  });

  it('allows reads in dry_run and notification-only previews marked allowInDryRun', async () => {
    blockWrites();
    mockFetch(async () => new Response('{"ok":true}', { status: 200 }));
    const rec = recordNetwork();
    restores.push(rec.stop);
    const r = await httpRequest('https://example.com/x', { provider: 'test' });
    expect(await r.json()).toEqual({ ok: true });
    await httpRequest('https://api.telegram.org/botX/sendMessage', {
      method: 'POST',
      provider: 'telegram',
      allowInDryRun: true,
      body: { text: 'DRY RUN' },
    });
    expect(rec.events).toHaveLength(2);
    expect(rec.writes()).toHaveLength(0);
  });

  it('read-only POST can be marked isWrite:false', async () => {
    blockWrites();
    mockFetch(async () => new Response('{}'));
    await expect(
      httpRequest('https://api.cloudflare.com/run', {
        method: 'POST',
        provider: 'cloudflare',
        isWrite: false,
      }),
    ).resolves.toBeDefined();
  });

  it('times out and retries transient failures (bounded)', async () => {
    let calls = 0;
    mockFetch((_u, init) => {
      calls++;
      return new Promise((_res, rej) =>
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))),
      );
    });
    await expect(
      httpRequest('https://example.com/slow', { provider: 'test', timeoutMs: 20, retry: { baseDelayMs: 1 } }),
    ).rejects.toThrow(TimeoutError);
    expect(calls).toBe(3);
  });

  it('does not retry 4xx and redacts token in error message', async () => {
    const token = 'EAAsecretTokenValue1234567890abcdef';
    registerSecret(token);
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return new Response(`{"error":"bad token ${token}"}`, { status: 400 });
    });
    const err = await httpRequest(`https://graph.facebook.com/me?access_token=${token}`, {
      provider: 'instagram',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
    expect(String(err.message)).not.toContain(token.slice(-6));
    expect(String(err.message)).not.toContain(token);
  });

  it('retries 429 then succeeds', async () => {
    let calls = 0;
    mockFetch(async () =>
      ++calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
        : new Response('{}'),
    );
    await httpRequest('https://example.com/r', { provider: 'test', retry: { baseDelayMs: 1 } });
    expect(calls).toBe(2);
  });

  it('writes go through when allowed (non-dry-run), with retries disabled on request', async () => {
    allowWrites();
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return new Response('err', { status: 503 });
    });
    await expect(
      httpRequest('https://x.test/w', { method: 'POST', provider: 'test', retry: false }),
    ).rejects.toThrow(HttpError);
    expect(calls).toBe(1);
  });

  it('spy URLs are redacted', async () => {
    blockWrites();
    mockFetch(async () => new Response('{}'));
    const rec = recordNetwork();
    restores.push(rec.stop);
    await httpRequest('https://graph.facebook.com/me?access_token=EAAabcdefghijklmnopqrstuvwxyz123', {
      provider: 'instagram',
    });
    expect(rec.events[0]?.url).not.toContain('EAAabcdefghij');
  });
});
