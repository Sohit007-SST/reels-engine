/**
 * Zod-validated environment config + brand config loaders.
 *
 * Keys live in api_keys/.env (gitignored; ENV_FILE overrides the path). Process
 * environment variables (e.g. GitHub Actions secrets/variables) take precedence over the file.
 * Every secret value is registered with the redactor on load, so it can never appear in logs.
 *
 * Never print a Config object's `secrets`; use secretStatuses() for MISSING/PRESENT.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import { z } from 'zod';
import { setWritePolicy } from './lib/http';
import { registerSecret } from './lib/redact';
import { readJson } from './lib/store';
import { Blocklist, Brand, HookLibrary, LearningMode, PublishMode, ReplyMode, Watchlist } from './schemas';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_ENV_FILE = path.join(PROJECT_ROOT, 'api_keys', '.env');

/** Secret variables (values never shown anywhere). Order matches .env.example. */
export const SECRET_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_PAGE_ACCESS_TOKEN',
  'FB_PAGE_ID',
  'IG_USER_ID',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'YOUTUBE_API_KEY',
  'HF_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

/** Non-secret settings (also GitHub repository variables). */
export const SETTING_KEYS = [
  'CLAUDE_MODEL',
  'META_GRAPH_VERSION',
  'PUBLISH_MODE',
  'REPLY_MODE',
  'LEARNING_MODE',
  'REELS_PER_DAY',
  'PIPELINE_PAUSED',
  'TIMEZONE',
  'IMAGE_PROVIDER',
  'VIDEO_PROVIDER',
  'TTS_PROVIDER',
  'MAX_DAILY_SPEND_USD',
  'ARTIFACT_RETENTION_DAYS',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Exact GitHub allowlists (02 section 4). META_APP_ID / META_APP_SECRET are never uploaded. */
export const GITHUB_SECRET_ALLOWLIST = [
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
] as const satisfies readonly SecretKey[];
export const GITHUB_SECRET_OPTIONAL: readonly SecretKey[] = ['YOUTUBE_API_KEY', 'HF_TOKEN'];
export const GITHUB_VARIABLE_ALLOWLIST = [
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
] as const satisfies readonly SettingKey[];

/** Optional keys: doctor reports MISSING for these as "optional". */
export const OPTIONAL_SECRETS: readonly SecretKey[] = ['YOUTUBE_API_KEY', 'HF_TOKEN', 'ANTHROPIC_API_KEY'];

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const boolString = z.preprocess(
  emptyToUndefined,
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default('false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes'),
);
const withDefault = <T extends z.ZodType>(schema: T, def: z.input<T>) =>
  z.preprocess(emptyToUndefined, schema.default(def as never));

export const EnvSchema = z
  .object({
    // ---- secrets ----
    CLAUDE_CODE_OAUTH_TOKEN: optionalString,
    META_APP_ID: optionalString,
    META_APP_SECRET: optionalString,
    META_PAGE_ACCESS_TOKEN: optionalString,
    FB_PAGE_ID: optionalString,
    IG_USER_ID: optionalString,
    CLOUDFLARE_ACCOUNT_ID: optionalString,
    CLOUDFLARE_API_TOKEN: optionalString,
    TELEGRAM_BOT_TOKEN: optionalString,
    TELEGRAM_CHAT_ID: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^-?\d+$/, 'must be a numeric chat id')
        .optional(),
    ),
    YOUTUBE_API_KEY: optionalString,
    HF_TOKEN: optionalString,
    ANTHROPIC_API_KEY: optionalString,
    // ---- settings ----
    CLAUDE_MODEL: optionalString,
    META_GRAPH_VERSION: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^v\d+\.\d+$/, 'expected like v23.0')
        .optional(),
    ),
    PUBLISH_MODE: withDefault(PublishMode, 'dry_run'),
    REPLY_MODE: withDefault(ReplyMode, 'approval'),
    LEARNING_MODE: withDefault(LearningMode, 'propose'),
    REELS_PER_DAY: withDefault(z.coerce.number().int().min(1).max(10), 3),
    PIPELINE_PAUSED: boolString,
    TIMEZONE: withDefault(z.literal('Asia/Kolkata'), 'Asia/Kolkata'),
    IMAGE_PROVIDER: withDefault(z.enum(['cloudflare', 'none']), 'cloudflare'),
    VIDEO_PROVIDER: withDefault(z.enum(['none', 'hf_free', 'veo', 'kling']), 'hf_free'),
    TTS_PROVIDER: withDefault(z.enum(['kokoro', 'elevenlabs']), 'kokoro'),
    MAX_DAILY_SPEND_USD: withDefault(z.coerce.number().min(0).max(1000), 0),
    ARTIFACT_RETENTION_DAYS: withDefault(z.coerce.number().int().min(1).max(90), 3),
  })
  .superRefine((env, ctx) => {
    // Paid providers must never be selectable by accident (spec 5, T3.7).
    const paid: string[] = [];
    if (env.VIDEO_PROVIDER === 'veo' || env.VIDEO_PROVIDER === 'kling')
      paid.push(`VIDEO_PROVIDER=${env.VIDEO_PROVIDER}`);
    if (env.TTS_PROVIDER === 'elevenlabs') paid.push('TTS_PROVIDER=elevenlabs');
    if (paid.length > 0 && env.MAX_DAILY_SPEND_USD <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAX_DAILY_SPEND_USD'],
        message: `paid provider selected (${paid.join(', ')}) but MAX_DAILY_SPEND_USD is 0; budget is $0`,
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export interface Settings {
  publishMode: z.infer<typeof PublishMode>;
  replyMode: z.infer<typeof ReplyMode>;
  learningMode: z.infer<typeof LearningMode>;
  reelsPerDay: number;
  pipelinePaused: boolean;
  timezone: 'Asia/Kolkata';
  metaGraphVersion: string | null;
  imageProvider: 'cloudflare' | 'none';
  videoProvider: 'none' | 'hf_free' | 'veo' | 'kling';
  ttsProvider: 'kokoro' | 'elevenlabs';
  claudeModel: string | null;
  maxDailySpendUsd: number;
  artifactRetentionDays: number;
}

export interface Config {
  settings: Readonly<Settings>;
  /** Secret values. Pass to adapters directly; never log, print or persist. */
  secrets: Readonly<Partial<Record<SecretKey, string>>>;
  envFile: string;
  envFileFound: boolean;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class MissingSecretError extends Error {
  constructor(readonly key: SecretKey) {
    super(`${key} is MISSING (set it in api_keys/.env or GitHub secrets; see 03_YOUR_MANUAL_STEPS.md)`);
    this.name = 'MissingSecretError';
  }
}

export interface LoadConfigOptions {
  /** Path to the env file (default: $ENV_FILE or api_keys/.env). */
  envFile?: string;
  /** Environment overriding the file (default process.env). Pass {} in tests for isolation. */
  env?: Record<string, string | undefined>;
  /** Apply the derived write policy to the http layer (default true). */
  applyWritePolicy?: boolean;
}

const KNOWN_KEYS = new Set<string>([...SECRET_KEYS, ...SETTING_KEYS]);

/** Load, validate and freeze the config. Throws ConfigError listing problems by key (never values). */
export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const envFileRaw = opts.envFile ?? env.ENV_FILE ?? DEFAULT_ENV_FILE;
  const envFile = path.isAbsolute(envFileRaw) ? envFileRaw : path.join(PROJECT_ROOT, envFileRaw);
  const envFileFound = existsSync(envFile);
  const fromFile = envFileFound ? parseDotenv(readFileSync(envFile)) : {};

  const merged: Record<string, string | undefined> = {};
  for (const key of KNOWN_KEYS) {
    const fromEnv = env[key];
    merged[key] = fromEnv !== undefined && fromEnv !== '' ? fromEnv : fromFile[key];
  }
  // Register secrets BEFORE validation so even error paths cannot leak them.
  for (const key of SECRET_KEYS) registerSecret(merged[key]);

  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`invalid configuration: ${issues.join('; ')}`, issues);
  }
  const e = parsed.data;
  const secrets: Partial<Record<SecretKey, string>> = {};
  for (const key of SECRET_KEYS) {
    const v = e[key];
    if (v !== undefined) secrets[key] = v;
  }
  const settings: Settings = {
    publishMode: e.PUBLISH_MODE,
    replyMode: e.REPLY_MODE,
    learningMode: e.LEARNING_MODE,
    reelsPerDay: e.REELS_PER_DAY,
    pipelinePaused: e.PIPELINE_PAUSED,
    timezone: e.TIMEZONE,
    metaGraphVersion: e.META_GRAPH_VERSION ?? null,
    imageProvider: e.IMAGE_PROVIDER,
    videoProvider: e.VIDEO_PROVIDER,
    ttsProvider: e.TTS_PROVIDER,
    claudeModel: e.CLAUDE_MODEL ?? null,
    maxDailySpendUsd: e.MAX_DAILY_SPEND_USD,
    artifactRetentionDays: e.ARTIFACT_RETENTION_DAYS,
  };
  // Non-enumerable guards: serializing or inspecting a Config never includes secret values.
  Object.defineProperty(secrets, 'toJSON', { value: () => '[REDACTED SECRETS]', enumerable: false });
  Object.defineProperty(secrets, Symbol.for('nodejs.util.inspect.custom'), {
    value: () => '[REDACTED SECRETS]',
    enumerable: false,
  });
  const cfg: Config = Object.freeze({
    settings: Object.freeze(settings),
    secrets: Object.freeze(secrets),
    envFile,
    envFileFound,
  });
  if (opts.applyWritePolicy !== false) applyWritePolicy(cfg);
  return cfg;
}

/** Throws MissingSecretError if the key is not set. */
export function requireSecret(cfg: Config, key: SecretKey): string {
  const v = cfg.secrets[key];
  if (!v) throw new MissingSecretError(key);
  return v;
}

export type SecretPresence = 'MISSING' | 'PRESENT';

/** MISSING / PRESENT per secret — the only view of secrets that may be printed. */
export function secretStatuses(cfg: Config): Record<SecretKey, SecretPresence> {
  const out = {} as Record<SecretKey, SecretPresence>;
  for (const key of SECRET_KEYS) out[key] = cfg.secrets[key] ? 'PRESENT' : 'MISSING';
  return out;
}

/** External writes allowed only outside dry_run and while not paused. */
export function externalWritesAllowed(cfg: Config): boolean {
  return cfg.settings.publishMode !== 'dry_run' && !cfg.settings.pipelinePaused;
}

/** Push the config-derived write policy into the http layer. */
export function applyWritePolicy(cfg: Config): void {
  setWritePolicy({
    writesAllowed: externalWritesAllowed(cfg),
    reason: cfg.settings.pipelinePaused ? 'PIPELINE_PAUSED=true' : `PUBLISH_MODE=${cfg.settings.publishMode}`,
  });
}

/** Paid providers refuse to run unless a spend ceiling above 0 is configured. */
export function assertPaidProviderAllowed(cfg: Config, provider: string): void {
  if (cfg.settings.maxDailySpendUsd <= 0) {
    throw new Error(`paid provider "${provider}" refused: MAX_DAILY_SPEND_USD is 0 (budget $0)`);
  }
}

/** Environment variables an agent subprocess may see: Claude auth + basic process vars only. */
export const AGENT_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TZ',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
] as const;

/** Build a minimal env for `claude -p` (never Meta, Cloudflare, Telegram, HF, YouTube keys). */
export function sanitizedAgentEnv(
  base: Record<string, string | undefined> = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of AGENT_ENV_ALLOWLIST) {
    const v = base[k];
    if (v !== undefined) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if ((SECRET_KEYS as readonly string[]).includes(k) && k !== 'CLAUDE_CODE_OAUTH_TOKEN') {
      throw new Error(`refusing to pass ${k} to an agent environment`);
    }
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- brand config

export const BRAND_DIR = path.join(PROJECT_ROOT, 'brand');

export function loadBrand(file = path.join(BRAND_DIR, 'brand.json')): Promise<Brand> {
  return readJson(file, Brand);
}
export function loadHookLibrary(file = path.join(BRAND_DIR, 'hooks.json')): Promise<HookLibrary> {
  return readJson(file, HookLibrary);
}
export function loadBlocklist(file = path.join(BRAND_DIR, 'blocklist.json')): Promise<Blocklist> {
  return readJson(file, Blocklist);
}
export function loadWatchlist(file = path.join(BRAND_DIR, 'watchlist.json')): Promise<Watchlist> {
  return readJson(file, Watchlist);
}

/**
 * Owner inspiration & feedback (brand/inspiration.json). Owner-written, but links/notes are still
 * passed to agents as data only. A missing file means "no inspiration yet".
 */
export const OwnerInspiration = z.object({
  schemaVersion: z.literal(1),
  feedback: z.array(z.object({ date: z.string(), note: z.string().max(1000) })).default([]),
  inspiration: z
    .array(
      z.object({
        link: z.string().max(500).optional(),
        whatILike: z.string().max(1000),
        useFor: z
          .enum(['hook', 'format', 'pacing', 'visual_style', 'topic', 'voice', 'other'])
          .default('other'),
      }),
    )
    .default([]),
  topicIdeas: z.array(z.string().max(300)).default([]),
  avoid: z.array(z.string().max(300)).default([]),
});
export type OwnerInspiration = z.infer<typeof OwnerInspiration>;

export async function loadInspiration(
  file = path.join(BRAND_DIR, 'inspiration.json'),
): Promise<OwnerInspiration | null> {
  try {
    return await readJson(file, OwnerInspiration);
  } catch (err) {
    const code =
      (err as NodeJS.ErrnoException)?.code ??
      ((err as { cause?: NodeJS.ErrnoException })?.cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

/** Slots (IST "HH:MM") for a reels-per-day count; falls back to the first N of the largest list. */
export function slotsFor(brand: Brand, reelsPerDay: number): string[] {
  const exact = brand.slots[String(reelsPerDay)];
  if (exact) return exact;
  const largest = Object.values(brand.slots).sort((a, b) => b.length - a.length)[0] ?? [];
  return largest.slice(0, reelsPerDay);
}

export { Brand, HookLibrary, Blocklist, Watchlist };
