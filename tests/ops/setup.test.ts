import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { setFetchImpl } from '../../src/lib/http';
import { setupMeta } from '../../src/cli/setup-meta';
import { privateChats, setupTelegram } from '../../src/cli/setup-telegram';
import { applyEnvUpdates } from '../../src/cli/ops-shared';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function tmpEnv(initial: string): { envFile: string; templateFile: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ops-setup-'));
  const envFile = path.join(dir, '.env');
  const templateFile = path.join(dir, '.env.example');
  writeFileSync(envFile, initial);
  writeFileSync(templateFile, '# template\n');
  return { envFile, templateFile };
}

describe('applyEnvUpdates', () => {
  it('replaces existing keys, appends new ones, keeps comments', () => {
    const out = applyEnvUpdates('# c\nA=1\nB=\n', { B: 'two', C: 'three' });
    expect(out).toContain('# c');
    expect(out).toContain('A=1');
    expect(out).toMatch(/^B=.*two/m);
    expect(out).toMatch(/^C=.*three/m);
  });
});

describe('setup:meta (mocked Graph API)', () => {
  it('exchanges the token, finds Page + IG ids and writes them without echoing values', async () => {
    const SHORT = 'EAAshortlivedFAKEtoken000000000001';
    const LONG = 'EAAlonglivedFAKEtoken0000000000002';
    const PAGE = 'EAApageFAKEtoken00000000000000003';
    const calls: string[] = [];
    restores.push(
      setFetchImpl(async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        if (url.includes('/oauth/access_token')) return json({ access_token: LONG, expires_in: 5_000_000 });
        if (url.includes('/me/accounts'))
          return json({
            data: [
              { id: '111', name: 'Fake Page', access_token: PAGE, instagram_business_account: { id: '222' } },
            ],
          });
        if (url.includes('/debug_token')) return json({ data: { expires_at: 0 } });
        if (url.includes('/222')) return json({ username: 'fakeig' });
        return json({ error: 'unexpected' }, 404);
      }),
    );
    const files = tmpEnv('META_APP_ID=999\nMETA_APP_SECRET=fakesecret\n');
    const cfg = loadConfig({
      envFile: '/nonexistent',
      env: { META_APP_ID: '999', META_APP_SECRET: 'fakesecretvalue123', META_GRAPH_VERSION: 'v23.0' },
    });
    const lines: string[] = [];
    const res = await setupMeta({ cfg, prompt: async () => SHORT, out: (l) => lines.push(l), ...files });
    expect(res.keysWritten.sort()).toEqual(['FB_PAGE_ID', 'IG_USER_ID', 'META_PAGE_ACCESS_TOKEN']);
    expect(res.pageTokenExpires).toBe('never');
    expect(calls.every((c) => c.startsWith('GET '))).toBe(true); // read-only
    const env = readFileSync(files.envFile, 'utf8');
    expect(env).toContain(PAGE);
    expect(env).toMatch(/^FB_PAGE_ID=.*111/m);
    expect(env).toContain('META_APP_ID=999');
    const printed = lines.join('\n');
    for (const s of [SHORT, LONG, PAGE, 'fakesecretvalue123']) expect(printed).not.toContain(s);
  });

  it('refuses without META_GRAPH_VERSION and without network', async () => {
    let fetched = false;
    restores.push(
      setFetchImpl(async () => {
        fetched = true;
        return json({});
      }),
    );
    const cfg = loadConfig({ envFile: '/nonexistent', env: { META_APP_ID: '1', META_APP_SECRET: 'x' } });
    await expect(setupMeta({ cfg, prompt: async () => 'x', out: () => {}, ...tmpEnv('') })).rejects.toThrow(
      /META_GRAPH_VERSION/,
    );
    expect(fetched).toBe(false);
  });
});

describe('setup:telegram (mocked Bot API)', () => {
  it('picks the private chat, writes TELEGRAM_CHAT_ID, sends one test message', async () => {
    const TOKEN = '123456:FAKEbottoken-abcdefghijklmnop';
    const calls: string[] = [];
    restores.push(
      setFetchImpl(async (url, init) => {
        calls.push(`${init?.method ?? 'GET'} ${url.split('/').pop()}`);
        if (url.endsWith('/getUpdates'))
          return json({
            ok: true,
            result: [
              { message: { chat: { id: -100, type: 'group' } } },
              { message: { chat: { id: 4242, type: 'private', first_name: 'Owner' } } },
            ],
          });
        if (url.endsWith('/sendMessage')) return json({ ok: true, result: {} });
        return json({}, 404);
      }),
    );
    const files = tmpEnv(`TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
    const cfg = loadConfig({ envFile: '/nonexistent', env: { TELEGRAM_BOT_TOKEN: TOKEN } });
    const lines: string[] = [];
    const res = await setupTelegram({ cfg, prompt: async () => '1', out: (l) => lines.push(l), ...files });
    expect(res.testSent).toBe(true);
    expect(calls).toEqual(['GET getUpdates', 'POST sendMessage']);
    expect(readFileSync(files.envFile, 'utf8')).toMatch(/^TELEGRAM_CHAT_ID=.*4242/m);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain('4242');
  });

  it('privateChats ignores groups and dedupes', () => {
    const chats = privateChats([
      { message: { chat: { id: 1, type: 'private' } } },
      { message: { chat: { id: 2, type: 'group' } } },
      { message: { chat: { id: 1, type: 'private' } } },
    ]);
    expect(chats.map((c) => c.id)).toEqual([1]);
  });
});
