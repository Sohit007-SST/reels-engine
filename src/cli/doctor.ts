/**
 * `npm run doctor` (T1.2): reports every key as MISSING / PRESENT / VALID / INVALID / EXPIRING.
 * Never prints a value (not even a fragment). Writes progress/KEYS_STATUS.md.
 *
 *   npm run doctor                 # offline: MISSING / PRESENT only (no network)
 *   npm run doctor -- --live       # + read-only validation calls (GET only) per provider
 *   npm run doctor -- --github     # + "In GitHub" column via `gh secret list` (read-only)
 *   npm run doctor -- --no-write   # do not update progress/KEYS_STATUS.md
 *
 * Live checks are read-only GET requests through src/lib/http.ts (timeouts + bounded retries).
 * A check that fails for network reasons leaves the key PRESENT ("check failed"), never VALID.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import {
  ConfigError,
  GITHUB_SECRET_ALLOWLIST,
  OPTIONAL_SECRETS,
  PROJECT_ROOT,
  SECRET_KEYS,
  loadConfig,
  type Config,
  type SecretKey,
} from '../config';
import { getJson } from '../lib/http';
import { createLogger } from '../lib/logger';
import { redact } from '../lib/redact';
import { HttpError } from '../lib/retry';
import { writeFileAtomic } from '../lib/store';
import { formatIst } from '../lib/time';
import { isMainModule, parseArgs } from './ops-shared';

export type KeyStatus = 'MISSING' | 'PRESENT' | 'VALID' | 'INVALID' | 'EXPIRING';

export interface ValidationResult {
  status: 'VALID' | 'INVALID' | 'UNKNOWN';
  /** ISO timestamp; null = provider reports no expiry; undefined = not reported. */
  expiresAt?: string | null;
  /** Short, value-free note (e.g. "@username", "token not active"). */
  note?: string;
}

export type ValidationMap = Partial<Record<SecretKey, ValidationResult>>;
export type Validator = (cfg: Config) => Promise<ValidationMap>;

export interface DoctorRow {
  key: SecretKey;
  inEnvFile: 'yes' | 'no';
  inGithub: 'yes' | 'no' | 'never' | 'not checked';
  status: KeyStatus;
  expires: string;
  note: string;
}

export const EXPIRING_WITHIN_DAYS = 14;
/** Keys that must never be uploaded to GitHub (02 section 4). */
const NEVER_ON_GITHUB = new Set<SecretKey>(['META_APP_ID', 'META_APP_SECRET', 'ANTHROPIC_API_KEY']);

const TIMEOUT_MS = 10_000;
const RETRY = { maxAttempts: 2, deadlineMs: 20_000 } as const;

// ------------------------------------------------------------------ validators (read-only GETs)

function httpStatusOf(err: unknown): number | null {
  return err instanceof HttpError ? err.status : null;
}

/** 4xx auth-style failures => INVALID; anything else (network, 5xx, 429) => UNKNOWN. */
function failureResult(err: unknown, invalidStatuses = [400, 401, 403, 404]): ValidationResult {
  const status = httpStatusOf(err);
  if (status !== null && invalidStatuses.includes(status)) {
    return { status: 'INVALID', note: `HTTP ${status}` };
  }
  return {
    status: 'UNKNOWN',
    note: status !== null ? `check failed (HTTP ${status})` : 'check failed (network)',
  };
}

function epochToIso(sec: unknown): string | null | undefined {
  if (typeof sec !== 'number') return undefined;
  if (sec === 0) return null; // Meta: 0 = never expires
  return new Date(sec * 1000).toISOString();
}

export const validateMeta: Validator = async (cfg) => {
  const out: ValidationMap = {};
  const s = cfg.secrets;
  const ver = cfg.settings.metaGraphVersion;
  if (!ver) {
    const note = 'not checked: set META_GRAPH_VERSION (T1.6)';
    for (const k of [
      'META_APP_ID',
      'META_APP_SECRET',
      'META_PAGE_ACCESS_TOKEN',
      'FB_PAGE_ID',
      'IG_USER_ID',
    ] as const) {
      if (s[k]) out[k] = { status: 'UNKNOWN', note };
    }
    return out;
  }
  const base = `https://graph.facebook.com/${ver}`;
  const appToken = s.META_APP_ID && s.META_APP_SECRET ? `${s.META_APP_ID}|${s.META_APP_SECRET}` : null;
  const opts = { provider: 'meta', timeoutMs: TIMEOUT_MS, retry: RETRY };

  if (appToken && s.META_APP_ID) {
    try {
      const app = await getJson<{ id?: string }>(
        `${base}/${encodeURIComponent(s.META_APP_ID)}?fields=id&access_token=${encodeURIComponent(appToken)}`,
        { ...opts, purpose: 'doctor_app' },
      );
      const ok = app.id === s.META_APP_ID;
      out.META_APP_ID = { status: ok ? 'VALID' : 'INVALID' };
      out.META_APP_SECRET = { status: ok ? 'VALID' : 'INVALID' };
    } catch (err) {
      const r = failureResult(err);
      out.META_APP_ID = r;
      out.META_APP_SECRET = { ...r, note: `${r.note ?? ''} (app id or secret wrong)`.trim() };
    }
  }

  const page = s.META_PAGE_ACCESS_TOKEN;
  if (!page) return out;
  const auth = { authorization: `Bearer ${page}` };
  try {
    const me = await getJson<{ id?: string }>(`${base}/me?fields=id`, {
      ...opts,
      headers: auth,
      purpose: 'doctor_me',
    });
    out.META_PAGE_ACCESS_TOKEN = { status: me.id ? 'VALID' : 'INVALID' };
    if (s.FB_PAGE_ID) {
      out.FB_PAGE_ID =
        me.id === s.FB_PAGE_ID
          ? { status: 'VALID' }
          : { status: 'INVALID', note: 'token is not a Page token for this FB_PAGE_ID (redo M6)' };
    }
  } catch (err) {
    const r = failureResult(err);
    out.META_PAGE_ACCESS_TOKEN = { ...r, note: r.status === 'INVALID' ? `${r.note}; redo M6` : r.note };
    return out;
  }

  if (appToken) {
    try {
      const dbg = await getJson<{ data?: { is_valid?: boolean; expires_at?: number; type?: string } }>(
        `${base}/debug_token?input_token=${encodeURIComponent(page)}&access_token=${encodeURIComponent(appToken)}`,
        { ...opts, purpose: 'doctor_debug_token' },
      );
      if (dbg.data?.is_valid === false) {
        out.META_PAGE_ACCESS_TOKEN = { status: 'INVALID', note: 'debug_token says not valid; redo M6' };
      } else {
        const exp = epochToIso(dbg.data?.expires_at);
        out.META_PAGE_ACCESS_TOKEN = {
          status: 'VALID',
          ...(exp !== undefined ? { expiresAt: exp } : {}),
          ...(dbg.data?.type && dbg.data.type !== 'PAGE'
            ? { note: `token type ${dbg.data.type}, expected PAGE` }
            : {}),
        };
      }
    } catch {
      /* expiry unknown; keep VALID from /me */
    }
  }

  if (s.IG_USER_ID) {
    try {
      const ig = await getJson<{ id?: string; username?: string }>(
        `${base}/${encodeURIComponent(s.IG_USER_ID)}?fields=id,username`,
        { ...opts, headers: auth, purpose: 'doctor_ig_user' },
      );
      out.IG_USER_ID = ig.id
        ? { status: 'VALID', ...(ig.username ? { note: `@${ig.username}` } : {}) }
        : { status: 'INVALID' };
    } catch (err) {
      out.IG_USER_ID = failureResult(err);
    }
  }
  return out;
};

export const validateCloudflare: Validator = async (cfg) => {
  const out: ValidationMap = {};
  const token = cfg.secrets.CLOUDFLARE_API_TOKEN;
  const account = cfg.secrets.CLOUDFLARE_ACCOUNT_ID;
  if (!token) return out;
  const opts = {
    provider: 'cloudflare',
    timeoutMs: TIMEOUT_MS,
    retry: RETRY,
    headers: { authorization: `Bearer ${token}` },
  };
  type Verify = { success?: boolean; result?: { status?: string; expires_on?: string } };
  const urls = [
    'https://api.cloudflare.com/client/v4/user/tokens/verify',
    ...(account
      ? [`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/tokens/verify`]
      : []),
  ];
  let verified: ValidationResult = { status: 'UNKNOWN', note: 'check failed' };
  for (const url of urls) {
    try {
      const v = await getJson<Verify>(url, { ...opts, purpose: 'doctor_token_verify' });
      const active = v.success === true && v.result?.status === 'active';
      verified = {
        status: active ? 'VALID' : 'INVALID',
        ...(v.result?.expires_on ? { expiresAt: new Date(v.result.expires_on).toISOString() } : {}),
        ...(!active ? { note: `token status ${v.result?.status ?? 'unknown'}` } : {}),
      };
      break;
    } catch (err) {
      verified = failureResult(err);
      // A user-endpoint 401 may just mean this is an account-owned token: try the next URL.
    }
  }
  out.CLOUDFLARE_API_TOKEN = verified;
  if (account && verified.status === 'VALID') {
    try {
      await getJson(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/models/search?per_page=1`,
        { ...opts, purpose: 'doctor_ai_models' },
      );
      out.CLOUDFLARE_ACCOUNT_ID = { status: 'VALID' };
    } catch (err) {
      out.CLOUDFLARE_ACCOUNT_ID = {
        ...failureResult(err),
        note: 'Workers AI not reachable with this account id + token (check M7 permissions)',
      };
    }
  }
  return out;
};

export const validateTelegram: Validator = async (cfg) => {
  const out: ValidationMap = {};
  const token = cfg.secrets.TELEGRAM_BOT_TOKEN;
  if (!token) return out;
  const base = `https://api.telegram.org/bot${token}`;
  const opts = { provider: 'telegram', timeoutMs: TIMEOUT_MS, retry: RETRY };
  try {
    const me = await getJson<{ ok?: boolean; result?: { username?: string } }>(`${base}/getMe`, {
      ...opts,
      purpose: 'doctor_getMe',
    });
    out.TELEGRAM_BOT_TOKEN = me.ok
      ? { status: 'VALID', ...(me.result?.username ? { note: `@${me.result.username}` } : {}) }
      : { status: 'INVALID' };
  } catch (err) {
    out.TELEGRAM_BOT_TOKEN = failureResult(err);
    return out;
  }
  const chat = cfg.secrets.TELEGRAM_CHAT_ID;
  if (chat && out.TELEGRAM_BOT_TOKEN.status === 'VALID') {
    try {
      const c = await getJson<{ ok?: boolean }>(`${base}/getChat?chat_id=${encodeURIComponent(chat)}`, {
        ...opts,
        purpose: 'doctor_getChat',
      });
      out.TELEGRAM_CHAT_ID = { status: c.ok ? 'VALID' : 'INVALID' };
    } catch (err) {
      out.TELEGRAM_CHAT_ID = { ...failureResult(err), note: 'bot cannot see this chat (redo M8 step 4-5)' };
    }
  }
  return out;
};

export const validateYoutube: Validator = async (cfg) => {
  const key = cfg.secrets.YOUTUBE_API_KEY;
  if (!key) return {};
  try {
    await getJson(
      `https://www.googleapis.com/youtube/v3/videoCategories?part=snippet&regionCode=IN&key=${encodeURIComponent(key)}`,
      { provider: 'youtube', timeoutMs: TIMEOUT_MS, retry: RETRY, purpose: 'doctor_categories' },
    );
    return { YOUTUBE_API_KEY: { status: 'VALID' } };
  } catch (err) {
    if (err instanceof HttpError && err.status === 403 && /quota/i.test(err.message)) {
      return { YOUTUBE_API_KEY: { status: 'UNKNOWN', note: 'daily quota used up; key not judged' } };
    }
    return { YOUTUBE_API_KEY: failureResult(err) };
  }
};

export const validateHuggingFace: Validator = async (cfg) => {
  const token = cfg.secrets.HF_TOKEN;
  if (!token) return {};
  try {
    const who = await getJson<{ name?: string }>('https://huggingface.co/api/whoami-v2', {
      provider: 'huggingface',
      timeoutMs: TIMEOUT_MS,
      retry: RETRY,
      headers: { authorization: `Bearer ${token}` },
      purpose: 'doctor_whoami',
    });
    return { HF_TOKEN: who.name ? { status: 'VALID' } : { status: 'INVALID' } };
  } catch (err) {
    return { HF_TOKEN: failureResult(err) };
  }
};

/** Claude's token has no free read-only check; it is proven by ci-spike.yml (T1.7). */
export const validateClaude: Validator = async (cfg) =>
  cfg.secrets.CLAUDE_CODE_OAUTH_TOKEN
    ? {
        CLAUDE_CODE_OAUTH_TOKEN: {
          status: 'UNKNOWN',
          note: 'no read-only check; proven by ci-spike (T1.7); renew yearly (M2)',
        },
      }
    : {};

export const DEFAULT_VALIDATORS: Record<string, Validator> = {
  meta: validateMeta,
  cloudflare: validateCloudflare,
  telegram: validateTelegram,
  youtube: validateYoutube,
  huggingface: validateHuggingFace,
  claude: validateClaude,
};

// ------------------------------------------------------------------ status assembly

export function finalStatus(
  present: boolean,
  v: ValidationResult | undefined,
  now: Date,
): { status: KeyStatus; expires: string; note: string } {
  if (!present) return { status: 'MISSING', expires: '—', note: '' };
  if (!v || v.status === 'UNKNOWN') return { status: 'PRESENT', expires: '—', note: v?.note ?? '' };
  if (v.status === 'INVALID') return { status: 'INVALID', expires: '—', note: v.note ?? '' };
  let expires = '—';
  let status: KeyStatus = 'VALID';
  if (v.expiresAt === null) expires = 'no expiry reported';
  else if (v.expiresAt) {
    const t = Date.parse(v.expiresAt);
    expires = v.expiresAt.slice(0, 10);
    if (Number.isFinite(t)) {
      if (t <= now.getTime()) status = 'INVALID';
      else if (t - now.getTime() <= EXPIRING_WITHIN_DAYS * 86_400_000) status = 'EXPIRING';
    }
  }
  return { status, expires, note: v.note ?? '' };
}

/** Names of keys present in the env file (values are parsed in memory and discarded). */
export function keysInEnvFile(envFile: string): Set<string> {
  if (!existsSync(envFile)) return new Set();
  const parsed = parseDotenv(readFileSync(envFile));
  return new Set(
    Object.entries(parsed)
      .filter(([, v]) => v.trim() !== '')
      .map(([k]) => k),
  );
}

/** `gh secret list` names only (read-only). Returns null if gh is unavailable or not logged in. */
export function ghSecretNames(): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['secret', 'list', '--json', 'name', '--jq', '.[].name'],
      { timeout: 20_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(
          new Set(
            stdout
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        );
      },
    );
  });
}

export interface DoctorOptions {
  cfg: Config;
  live: boolean;
  validators?: Record<string, Validator>;
  githubNames?: Set<string> | null;
  envFileKeys?: Set<string>;
  now?: Date;
}

export async function collectRows(opts: DoctorOptions): Promise<DoctorRow[]> {
  const now = opts.now ?? new Date();
  const results: ValidationMap = {};
  if (opts.live) {
    const log = createLogger({ stage: 'doctor' });
    for (const [name, fn] of Object.entries(opts.validators ?? DEFAULT_VALIDATORS)) {
      try {
        Object.assign(results, await fn(opts.cfg));
      } catch (err) {
        // A broken validator must never mark keys VALID; they stay PRESENT.
        log.warn(`validator ${name} failed`, { err });
      }
    }
  }
  const envKeys = opts.envFileKeys ?? new Set<string>();
  return SECRET_KEYS.map((key) => {
    const present = Boolean(opts.cfg.secrets[key]);
    const fin = finalStatus(present, results[key], now);
    let inGithub: DoctorRow['inGithub'];
    if (NEVER_ON_GITHUB.has(key)) inGithub = 'never';
    else if (!opts.githubNames) inGithub = 'not checked';
    else inGithub = opts.githubNames.has(key) ? 'yes' : 'no';
    let note = fin.note;
    if (fin.status === 'MISSING' && OPTIONAL_SECRETS.includes(key))
      note = key === 'ANTHROPIC_API_KEY' ? 'optional, paid (M18): keep unset' : 'optional';
    if (!note && fin.status === 'PRESENT' && !opts.live) note = 'run with --live to validate';
    return {
      key,
      inEnvFile: envKeys.has(key) ? 'yes' : 'no',
      inGithub,
      status: fin.status,
      expires: fin.expires,
      note: redact(note),
    };
  });
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

export function renderKeysStatus(rows: DoctorRow[], opts: { now: Date; live: boolean; cfg: Config }): string {
  const header = `# Keys status — last checked ${formatIst(opts.now)} IST\n\n`;
  const mode = opts.live
    ? 'Live read-only checks were run (`npm run doctor -- --live`).'
    : 'Offline check only: PRESENT means "set but not tested". Run `npm run doctor -- --live` to validate.';
  const intro = `Written by \`npm run doctor\`. Values are never shown here. ${mode}\n\n`;
  const w = [23, 7, 11, 8, 18];
  const lines = [
    `| ${pad('Variable', w[0]!)} | ${pad('In .env', w[1]!)} | ${pad('In GitHub', w[2]!)} | ${pad('Status', w[3]!)} | ${pad('Expires / renew by', w[4]!)} | Note |`,
    `|${'-'.repeat(w[0]! + 2)}|${'-'.repeat(w[1]! + 2)}|${'-'.repeat(w[2]! + 2)}|${'-'.repeat(w[3]! + 2)}|${'-'.repeat(w[4]! + 2)}|------|`,
    ...rows.map(
      (r) =>
        `| ${pad(r.key, w[0]!)} | ${pad(r.inEnvFile, w[1]!)} | ${pad(r.inGithub, w[2]!)} | ${pad(r.status, w[3]!)} | ${pad(r.expires, w[4]!)} | ${r.note.replace(/\|/g, '/')} |`,
    ),
  ];
  const s = opts.cfg.settings;
  const settings = [
    '',
    '## Settings (not secret)',
    '',
    `- PUBLISH_MODE: ${s.publishMode} · REPLY_MODE: ${s.replyMode} · LEARNING_MODE: ${s.learningMode}`,
    `- PIPELINE_PAUSED: ${s.pipelinePaused} · REELS_PER_DAY: ${s.reelsPerDay} · META_GRAPH_VERSION: ${s.metaGraphVersion ?? '(not set)'}`,
    `- IMAGE_PROVIDER: ${s.imageProvider} · VIDEO_PROVIDER: ${s.videoProvider} · TTS_PROVIDER: ${s.ttsProvider} · MAX_DAILY_SPEND_USD: ${s.maxDailySpendUsd}`,
    `- GitHub secret allowlist: ${GITHUB_SECRET_ALLOWLIST.join(', ')}`,
    '',
  ];
  // Final defense: the whole document passes through the redactor.
  return redact(header + intro + lines.join('\n') + '\n' + settings.join('\n'));
}

export function renderConsole(rows: DoctorRow[]): string {
  const width = Math.max(...rows.map((r) => r.key.length));
  return (
    rows
      .map((r) =>
        `${r.key.padEnd(width)}  ${r.status.padEnd(8)}  ${r.expires === '—' ? '' : `expires ${r.expires}  `}${r.note}`.trimEnd(),
      )
      .join('\n') + '\n'
  );
}

export const KEYS_STATUS_FILE = path.join(PROJECT_ROOT, 'progress', 'KEYS_STATUS.md');

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { flags, values } = parseArgs(argv);
  const live = flags.has('live');
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(
        `Config problems (fix in api_keys/.env, values not shown):\n- ${err.issues.join('\n- ')}\n`,
      );
      return 1;
    }
    throw err;
  }
  const now = new Date();
  const githubNames = flags.has('github') ? await ghSecretNames() : null;
  const rows = await collectRows({ cfg, live, githubNames, envFileKeys: keysInEnvFile(cfg.envFile), now });
  process.stdout.write(
    `Env file: ${path.relative(PROJECT_ROOT, cfg.envFile)} (${cfg.envFileFound ? 'found' : 'NOT FOUND — copy api_keys/.env.example'})\n`,
  );
  process.stdout.write(renderConsole(rows));
  if (!flags.has('no-write')) {
    const out = values.get('out') ?? KEYS_STATUS_FILE;
    await writeFileAtomic(out, renderKeysStatus(rows, { now, live, cfg }));
    process.stdout.write(`Wrote ${path.relative(PROJECT_ROOT, out)}\n`);
  }
  return rows.some((r) => r.status === 'INVALID') ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`doctor failed: ${redact(err instanceof Error ? err.message : String(err))}\n`);
      process.exitCode = 1;
    },
  );
}
