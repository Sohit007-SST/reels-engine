import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// T9.1 guard rails: secrets allowlist (api_keys/02 section 4), .env deny rules, .gitignore.
const root = join(import.meta.dirname, '..', '..');
const SECRET_ALLOWLIST = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'META_PAGE_ACCESS_TOKEN',
  'FB_PAGE_ID',
  'IG_USER_ID',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'YOUTUBE_API_KEY',
  'HF_TOKEN',
  'GITHUB_TOKEN',
]);
const VAR_ALLOWLIST = new Set([
  'PUBLISH_MODE',
  'REPLY_MODE',
  'LEARNING_MODE',
  'REELS_PER_DAY',
  'PIPELINE_PAUSED',
  'TIMEZONE',
  'META_GRAPH_VERSION',
  'IMAGE_PROVIDER',
  'VIDEO_PROVIDER',
  'TTS_PROVIDER',
  'CLAUDE_MODEL',
  'MAX_DAILY_SPEND_USD',
  'ARTIFACT_RETENTION_DAYS',
]);

const wfDir = join(root, '.github', 'workflows');
const workflows = readdirSync(wfDir).filter((f) => f.endsWith('.yml'));

describe('security guard rails (T9.1)', () => {
  it('workflows reference only allowlisted secrets and variables', () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const f of workflows) {
      const text = readFileSync(join(wfDir, f), 'utf8');
      for (const m of text.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
        expect(SECRET_ALLOWLIST.has(m[1] ?? ''), `${f}: secrets.${m[1]}`).toBe(true);
      }
      for (const m of text.matchAll(/vars\.([A-Z0-9_]+)/g)) {
        expect(VAR_ALLOWLIST.has(m[1] ?? ''), `${f}: vars.${m[1]}`).toBe(true);
      }
      expect(text).not.toMatch(/META_APP_SECRET|META_APP_ID/);
      expect(text, `${f} declares permissions`).toMatch(/^permissions:/m);
    }
  });

  it('.claude/settings.json denies reading and editing .env files', () => {
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as {
      permissions: { deny: string[] };
    };
    const deny = settings.permissions.deny;
    for (const rule of ['Read(./api_keys/.env)', 'Read(./.env)', 'Read(**/.env)', 'Edit(./api_keys/.env)']) {
      expect(deny).toContain(rule);
    }
  });

  it('.gitignore keeps keys and media out of git', () => {
    const gi = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
    for (const line of ['.env', 'api_keys/.env', '!api_keys/.env.example']) {
      expect(gi).toContain(line);
    }
    const text = gi.join('\n');
    expect(text).toMatch(/^out\/?$/m);
    expect(text).toMatch(/\*\.mp4/);
    expect(text).toMatch(/\*\.wav/);
  });
});
