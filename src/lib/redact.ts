/**
 * Secret redaction. Every log line, error message and report must pass through here.
 *
 * Two layers:
 *  1. Exact values registered at runtime (all secret env values from config) are replaced in full.
 *  2. Pattern rules catch credential-shaped strings even when not registered
 *     (Bearer tokens, Authorization headers, access_token= params, signed-URL params,
 *     Telegram bot tokens, Meta-style tokens, Cloudflare/HF/GitHub tokens).
 *
 * Replacement is always the fixed marker below: no prefix, no suffix, no length hint.
 */

export const REDACTED = '[REDACTED]';

const registered = new Set<string>();

/** Minimum length for a value to be registered (avoids redacting "1", "true" etc.). */
const MIN_SECRET_LENGTH = 6;

/** Register a secret value so it is redacted anywhere it appears. Empty/short values are ignored. */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (v.length < MIN_SECRET_LENGTH) return;
  registered.add(v);
  // Also register common encodings of the value.
  const enc = encodeURIComponent(v);
  if (enc !== v) registered.add(enc);
}

/** For tests only. */
export function clearRegisteredSecrets(): void {
  registered.clear();
}

export function registeredSecretCount(): number {
  return registered.size;
}

const SENSITIVE_PARAM_NAMES = [
  'access_token',
  'input_token',
  'fb_exchange_token',
  'client_secret',
  'app_secret',
  'appsecret_proof',
  'token',
  'api_key',
  'apikey',
  'key',
  'sig',
  'signature',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'x-goog-signature',
  'x-goog-credential',
  'password',
  'secret',
];

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization / Cookie headers in text form
  [
    /(authorization|proxy-authorization|cookie|set-cookie|x-api-key)(["']?\s*[:=]\s*["']?)([^"'\r\n,}]+)/gi,
    `$1$2${REDACTED}`,
  ],
  // Bearer / Basic / OAuth credentials
  [/\b(Bearer|Basic|OAuth)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // Sensitive query/body params: name=value
  [new RegExp(`([?&#\\s"']|^)(${SENSITIVE_PARAM_NAMES.join('|')})=([^&#\\s"']+)`, 'gi'), `$1$2=${REDACTED}`],
  // OAuth authorization codes in URLs (only as a query param, so "error code=190" stays readable)
  [/([?&])(code)=([^&#\s"']+)/gi, `$1$2=${REDACTED}`],
  // JSON-ish "access_token": "value"
  [
    /("(?:access_token|token|api_key|apiKey|client_secret|app_secret|password|secret|authorization|bot_token)"\s*:\s*")([^"]+)(")/gi,
    `$1${REDACTED}$3`,
  ],
  // Telegram bot token (in URLs like /bot<token>/ or bare)
  [/\bbot\d{5,}:[A-Za-z0-9_-]{20,}/g, `bot${REDACTED}`],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, REDACTED],
  // Meta (Facebook/Instagram) access tokens
  [/\bEAA[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bIG[A-Z]{1,3}[A-Za-z0-9]{40,}/g, REDACTED],
  // Hugging Face, GitHub, Claude OAuth / Anthropic-style keys
  [/\bhf_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  // Google API keys
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Redact a string. Safe on any input; non-strings are stringified. */
export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : String(input);
  // Longest first so a registered value containing another is fully removed.
  const secrets = [...registered].sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    if (s.includes(secret)) s = s.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
  }
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

const SENSITIVE_KEY_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|access_?token|refresh_?token|api_?key|apikey|client_?secret|app_?secret|password|secret|token|bot_?token|.*_token|.*_secret|.*_key)$/i;

/** Keys that look sensitive but are not (ids, counts). */
const SAFE_KEYS = new Set(['tokenCount', 'tokens', 'inputTokens', 'outputTokens', 'promptVersion']);

/** Deep-redact any JSON-like value (objects, arrays, Errors). Never mutates the input. */
export function redactDeep<T = unknown>(value: T, depth = 0): T {
  if (depth > 12) return '[TRUNCATED]' as unknown as T;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (typeof value !== 'object') return value;
  if (value instanceof Error) return serializeError(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!SAFE_KEYS.has(k) && SENSITIVE_KEY_RE.test(k) && v !== null && v !== undefined && v !== '') {
      out[k] = REDACTED;
    } else {
      out[k] = redactDeep(v, depth + 1);
    }
  }
  return out as T;
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string | number;
  status?: number;
  stack?: string;
  cause?: SerializedError | string;
}

/** Serialize an error with every string field redacted (message, stack, cause chain). */
export function serializeError(err: unknown, depth = 0): SerializedError {
  if (!(err instanceof Error)) return { name: 'NonError', message: redact(String(err)) };
  const e = err as Error & { code?: string | number; status?: number; cause?: unknown };
  const out: SerializedError = { name: e.name, message: redact(e.message) };
  if (e.code !== undefined) out.code = typeof e.code === 'string' ? redact(e.code) : e.code;
  if (typeof e.status === 'number') out.status = e.status;
  if (e.stack) out.stack = redact(e.stack);
  if (e.cause !== undefined && depth < 4) {
    out.cause = e.cause instanceof Error ? serializeError(e.cause, depth + 1) : redact(String(e.cause));
  }
  return out;
}

/** Return a new Error whose message/stack are redacted; safe to rethrow or print. */
export function sanitizeError(err: unknown): Error {
  const s = serializeError(err);
  const clean = new Error(s.message);
  clean.name = s.name;
  clean.stack = s.stack ?? `${s.name}: ${s.message}`;
  return clean;
}

/** Redact a URL for logging: strips sensitive params and Telegram token paths. */
export function redactUrl(url: string): string {
  return redact(url);
}
