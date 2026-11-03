import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  externalWritesAllowed,
  loadConfig,
  requireSecret,
  sanitizedAgentEnv,
  secretStatuses,
  SECRET_KEYS,
  SETTING_KEYS,
} from '../../src/config';
import { getWritePolicy, setWritePolicy } from '../../src/lib/http';
import { clearRegisteredSecrets, redact } from '../../src/lib/redact';

const tmpEnv = (content: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const f = path.join(dir, '.env');
  writeFileSync(f, content);
  return f;
};

afterEach(() => {
  clearRegisteredSecrets();
  setWritePolicy({ writesAllowed: false, reason: 'test reset' });
});

describe('config', () => {
  it('loads the .env.example template with spec defaults and all secrets MISSING', () => {
    const cfg = loadConfig({ envFile: 'api_keys/.env.example', env: {} });
    expect(cfg.envFileFound).toBe(true);
    expect(cfg.settings).toMatchObject({
      publishMode: 'dry_run',
      replyMode: 'approval',
      learningMode: 'propose',
      reelsPerDay: 3,
      pipelinePaused: false,
      timezone: 'Asia/Kolkata',
      imageProvider: 'cloudflare',
      videoProvider: 'hf_free',
      ttsProvider: 'kokoro',
      maxDailySpendUsd: 0,
      artifactRetentionDays: 3,
      metaGraphVersion: null,
      claudeModel: null,
    });
    expect(Object.values(secretStatuses(cfg)).every((s) => s === 'MISSING')).toBe(true);
    expect(externalWritesAllowed(cfg)).toBe(false);
    expect(getWritePolicy().writesAllowed).toBe(false);
  });

  it('every key in .env.example is known to the config', async () => {
    const { readFileSync } = await import('node:fs');
    const keys = readFileSync('api_keys/.env.example', 'utf8')
      .split('\n')
      .map((l) => l.replace(/^#\s*/, '').match(/^([A-Z0-9_]+)=/)?.[1])
      .filter(Boolean);
    const known = new Set<string>([...SECRET_KEYS, ...SETTING_KEYS]);
    for (const k of keys) expect(known.has(k as string), k).toBe(true);
    for (const k of known) expect(keys).toContain(k);
  });

  it('works with no env file at all (defaults)', () => {
    const cfg = loadConfig({ envFile: '/nonexistent/.env', env: {} });
    expect(cfg.envFileFound).toBe(false);
    expect(cfg.settings.publishMode).toBe('dry_run');
  });

  it('process env overrides the file', () => {
    const f = tmpEnv('PUBLISH_MODE=approval\nREELS_PER_DAY=5\n');
    const cfg = loadConfig({ envFile: f, env: { REELS_PER_DAY: '4' } });
    expect(cfg.settings.publishMode).toBe('approval');
    expect(cfg.settings.reelsPerDay).toBe(4);
    expect(externalWritesAllowed(cfg)).toBe(true);
  });

  it('paused pipeline blocks writes even in approval mode', () => {
    const cfg = loadConfig({ envFile: '/none', env: { PUBLISH_MODE: 'auto', PIPELINE_PAUSED: 'true' } });
    expect(cfg.settings.pipelinePaused).toBe(true);
    expect(externalWritesAllowed(cfg)).toBe(false);
    expect(getWritePolicy().reason).toContain('PIPELINE_PAUSED');
  });

  it.each([
    [{ PUBLISH_MODE: 'yolo' }, 'PUBLISH_MODE'],
    [{ REPLY_MODE: 'always' }, 'REPLY_MODE'],
    [{ REELS_PER_DAY: 'three' }, 'REELS_PER_DAY'],
    [{ REELS_PER_DAY: '0' }, 'REELS_PER_DAY'],
    [{ PIPELINE_PAUSED: 'maybe' }, 'PIPELINE_PAUSED'],
    [{ TIMEZONE: 'UTC' }, 'TIMEZONE'],
    [{ MAX_DAILY_SPEND_USD: '-1' }, 'MAX_DAILY_SPEND_USD'],
    [{ TELEGRAM_CHAT_ID: 'not-a-number' }, 'TELEGRAM_CHAT_ID'],
    [{ META_GRAPH_VERSION: '23' }, 'META_GRAPH_VERSION'],
    [{ VIDEO_PROVIDER: 'veo' }, 'MAX_DAILY_SPEND_USD'],
    [{ TTS_PROVIDER: 'elevenlabs' }, 'MAX_DAILY_SPEND_USD'],
  ])('rejects invalid value %o', (env, key) => {
    expect(() => loadConfig({ envFile: '/none', env })).toThrow(ConfigError);
    try {
      loadConfig({ envFile: '/none', env });
    } catch (e) {
      expect((e as ConfigError).issues.join(' ')).toContain(key);
    }
  });

  it('allows a paid provider only with a spend ceiling above 0', () => {
    const cfg = loadConfig({ envFile: '/none', env: { VIDEO_PROVIDER: 'kling', MAX_DAILY_SPEND_USD: '2' } });
    expect(cfg.settings.videoProvider).toBe('kling');
  });

  it('secrets are PRESENT, registered for redaction, and never serialized', () => {
    const token = 'EAAtestTOKENvalue1234567890abcdefXYZ';
    const f = tmpEnv(`META_PAGE_ACCESS_TOKEN=${token}\nTELEGRAM_CHAT_ID=12345\n`);
    const cfg = loadConfig({ envFile: f, env: {} });
    expect(secretStatuses(cfg).META_PAGE_ACCESS_TOKEN).toBe('PRESENT');
    expect(requireSecret(cfg, 'META_PAGE_ACCESS_TOKEN')).toBe(token);
    expect(JSON.stringify(cfg)).not.toContain(token);
    expect(JSON.stringify(cfg)).not.toContain(token.slice(-4));
    expect(redact(`calling with ${token}`)).not.toContain(token.slice(-6));
    expect(() => requireSecret(cfg, 'HF_TOKEN')).toThrow(/HF_TOKEN is MISSING/);
  });

  it('config errors name the key but never echo a secret value', () => {
    const secretish = 'abc-SECRET-not-a-number-987654';
    try {
      loadConfig({ envFile: '/none', env: { TELEGRAM_CHAT_ID: secretish } });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('TELEGRAM_CHAT_ID');
      expect((e as Error).message).not.toContain(secretish);
      expect((e as Error).message).not.toContain('987654');
    }
  });

  it('sanitizedAgentEnv keeps only Claude auth + basics', () => {
    const env = sanitizedAgentEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-token-123456',
      META_PAGE_ACCESS_TOKEN: 'meta',
      TELEGRAM_BOT_TOKEN: 'tg',
      CLOUDFLARE_API_TOKEN: 'cf',
      HF_TOKEN: 'hf',
      AWS_SECRET_ACCESS_KEY: 'aws',
    });
    expect(Object.keys(env).sort()).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']);
    expect(() => sanitizedAgentEnv({}, { META_APP_SECRET: 'x' })).toThrow(/refusing/);
  });
});
