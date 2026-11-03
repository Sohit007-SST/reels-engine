import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { setFetchImpl } from '../../src/lib/http';
import {
  CloudflareImageProvider,
  CLOUDFLARE_QUOTA,
  HuggingFaceClipProvider,
  PaidProviderRefusedError,
  createVeoProvider,
  createKlingProvider,
  estimateNeurons,
  reserveQuota,
  selectImageProvider,
  selectVideoProvider,
} from '../../src/providers';
import { findFileUrl, parseGradioSse } from '../../src/providers/huggingface';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
});
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ops-prov-'));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const now = () => new Date('2026-11-03T06:00:00Z');

describe('quota guard', () => {
  it('stops at 85% of the daily limit', async () => {
    const f = path.join(tmp(), 'usage.json');
    const spec = { provider: 'x', limit: 100, unit: 'n' };
    expect((await reserveQuota(f, spec, 80, now())).allowed).toBe(true);
    const d = await reserveQuota(f, spec, 10, now());
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('reserve_reached');
  });
  it('unknown limit or unreadable usage file => skip', async () => {
    const f = path.join(tmp(), 'usage.json');
    const a = await reserveQuota(f, { provider: 'x', limit: null, unit: 'n' }, 1, now());
    expect(a.allowed).toBe(false);
    writeFileSync(f, '{not json');
    const b = await reserveQuota(f, CLOUDFLARE_QUOTA, 1, now());
    expect(b.allowed).toBe(false);
    if (!b.allowed) expect(b.reason).toBe('unknown_usage');
  });
});

describe('cloudflare FLUX schnell (mocked)', () => {
  it('generates once, then serves from the prompt-hash cache with provenance', async () => {
    let calls = 0;
    restores.push(
      setFetchImpl(async (url, init) => {
        calls++;
        expect(url).toContain('/ai/run/@cf/black-forest-labs/flux-1-schnell');
        expect(JSON.parse(String(init?.body))).toMatchObject({ prompt: 'a cat', steps: 4 });
        return new Response(
          JSON.stringify({ success: true, result: { image: Buffer.from(PNG).toString('base64') } }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const dir = tmp();
    const p = new CloudflareImageProvider({
      accountId: 'acc',
      apiToken: 'fake-token',
      cacheDir: path.join(dir, 'cache'),
      usageFile: path.join(dir, 'usage.json'),
      now,
    });
    const a = await p.generateImage({ prompt: 'a cat' });
    expect(a.status).toBe('ok');
    if (a.status === 'ok') {
      expect(a.cached).toBe(false);
      expect(a.provenance.promptHash).toBeTruthy();
      expect(existsSync(a.path)).toBe(true);
    }
    const b = await p.generateImage({ prompt: 'a cat' });
    expect(b.status === 'ok' && b.cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('skips without a network call when the quota is exhausted', async () => {
    let calls = 0;
    restores.push(
      setFetchImpl(async () => {
        calls++;
        return new Response('');
      }),
    );
    const dir = tmp();
    const usageFile = path.join(dir, 'usage.json');
    await reserveQuota(usageFile, CLOUDFLARE_QUOTA, 8490, now());
    const p = new CloudflareImageProvider({ accountId: 'a', apiToken: 't', cacheDir: dir, usageFile, now });
    const r = await p.generateImage({ prompt: 'a dog' });
    expect(r.status).toBe('skipped');
    expect(calls).toBe(0);
    expect(estimateNeurons(4)).toBeGreaterThan(0);
  });

  it('is disabled when keys are missing', async () => {
    const cfg = loadConfig({ envFile: '/none', env: { IMAGE_PROVIDER: 'cloudflare' } });
    expect((await selectImageProvider(cfg).generateImage({ prompt: 'x' })).status).toBe('skipped');
  });
});

describe('huggingface (mocked)', () => {
  it('parses gradio SSE and finds file urls', () => {
    const sse =
      'event: generating\ndata: null\n\nevent: complete\ndata: [{"url":"https://x.hf.space/file=a.mp4"}]\n\n';
    const r = parseGradioSse(sse);
    expect(r?.event).toBe('complete');
    expect(findFileUrl(r?.data)).toBe('https://x.hf.space/file=a.mp4');
  });
  it('falls back silently when the license is not commercial-safe', async () => {
    restores.push(
      setFetchImpl(
        async () =>
          new Response(
            JSON.stringify({
              host: 'https://a-b.hf.space',
              cardData: { license: 'cc-by-nc-4.0' },
              models: ['m/x'],
            }),
            {
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    );
    const dir = tmp();
    const p = new HuggingFaceClipProvider({
      token: 'hf_fake',
      spaceId: 'owner/space',
      apiName: 'generate',
      cacheDir: dir,
      usageFile: path.join(dir, 'u.json'),
    });
    const r = await p.generateClip({ prompt: 'x', seconds: 3 });
    expect(r.status).toBe('fallback');
  });
  it('falls back on network errors', async () => {
    restores.push(
      setFetchImpl(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const dir = tmp();
    const p = new HuggingFaceClipProvider({
      token: 't',
      spaceId: 'o/s',
      apiName: 'g',
      cacheDir: dir,
      usageFile: path.join(dir, 'u.json'),
    });
    expect((await p.generateClip({ prompt: 'x', seconds: 3 })).status).toBe('fallback');
  });
});

describe('paid providers (veo, kling) are never selectable by accident', () => {
  it('refuse while MAX_DAILY_SPEND_USD is 0, even if VIDEO_PROVIDER names them', () => {
    for (const name of ['veo', 'kling'] as const) {
      // Layer 1: config refuses to load at all.
      expect(() =>
        loadConfig({ envFile: '/none', env: { VIDEO_PROVIDER: name, MAX_DAILY_SPEND_USD: '0' } }),
      ).toThrow(/MAX_DAILY_SPEND_USD/);
      // Layer 2: even a hand-built config is refused by the provider factory.
      const base = loadConfig({ envFile: '/none', env: {} });
      const cfg = { ...base, settings: { ...base.settings, videoProvider: name, maxDailySpendUsd: 0 } };
      expect(() => selectVideoProvider(cfg, { paid: { ownerApprovedPaid: true } })).toThrow(
        PaidProviderRefusedError,
      );
    }
  });
  it('refuse without the explicit owner approval flag even with budget', () => {
    const cfg = loadConfig({ envFile: '/none', env: { VIDEO_PROVIDER: 'veo', MAX_DAILY_SPEND_USD: '5' } });
    expect(() => createVeoProvider(cfg)).toThrow(PaidProviderRefusedError);
  });
  it('refuse when VIDEO_PROVIDER is a different provider', () => {
    const cfg = loadConfig({ envFile: '/none', env: { VIDEO_PROVIDER: 'veo', MAX_DAILY_SPEND_USD: '5' } });
    expect(() => createKlingProvider(cfg, { ownerApprovedPaid: true })).toThrow(PaidProviderRefusedError);
  });
  it('default config selects no paid provider', () => {
    const cfg = loadConfig({ envFile: '/none', env: {} });
    const p = selectVideoProvider(cfg);
    expect(p === null || p.paid === false).toBe(true);
  });
});
