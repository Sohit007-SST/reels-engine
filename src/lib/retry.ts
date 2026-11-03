/**
 * Bounded retry with exponential backoff, full jitter and an overall deadline.
 *
 * Only TRANSIENT errors are retried: timeouts, network resets, HTTP 429 and 5xx.
 * Validation, permission, unsupported-endpoint and other 4xx errors are PERMANENT
 * and are thrown immediately. Max attempts is capped at 3 (spec 7.12).
 */
import { redact } from './redact';

export const MAX_ATTEMPTS_CAP = 3;

export type ErrorClass = 'transient' | 'permanent';

/** HTTP error with a status code; message/body are already redacted. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly options: { url?: string; body?: string; retryAfterMs?: number; provider?: string } = {},
  ) {
    super(redact(message));
    this.name = 'HttpError';
  }
  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
}

export class TimeoutError extends Error {
  constructor(message = 'request timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Mark any error explicitly permanent (e.g. a schema validation failure). */
export class PermanentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(redact(message), options);
    this.name = 'PermanentError';
  }
}

/** Mark any error explicitly transient. */
export class TransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(redact(message), options);
    this.name = 'TransientError';
  }
}

export class RetryDeadlineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(redact(message), options);
    this.name = 'RetryDeadlineError';
  }
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof PermanentError) return 'permanent';
  if (err instanceof TransientError || err instanceof TimeoutError) return 'transient';
  if (err instanceof HttpError) {
    if (err.status === 429 || err.status === 408) return 'transient';
    if (err.status >= 500 && err.status <= 599) return err.status === 501 ? 'permanent' : 'transient';
    return 'permanent';
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'transient';
    const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return 'transient';
    // fetch() network failures surface as TypeError("fetch failed") with a cause.
    if (err.name === 'TypeError' && /fetch failed/i.test(err.message)) return 'transient';
  }
  return 'permanent';
}

export interface RetryOptions {
  /** Attempts including the first; capped at 3. Default 3. */
  maxAttempts?: number;
  /** Base backoff delay (default 500 ms). */
  baseDelayMs?: number;
  /** Max single backoff (default 8 s). */
  maxDelayMs?: number;
  /** Overall deadline from the first attempt (default 60 s). No retry starts after it. */
  deadlineMs?: number;
  classify?: (err: unknown) => ErrorClass;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Delay for attempt n (1-based count of failures so far): full jitter in [0, min(max, base*2^(n-1))]. */
export function backoffDelay(failures: number, base: number, max: number, random: () => number): number {
  const ceiling = Math.min(max, base * 2 ** Math.max(0, failures - 1));
  return Math.round(random() * ceiling);
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(MAX_ATTEMPTS_CAP, opts.maxAttempts ?? MAX_ATTEMPTS_CAP));
  const base = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 8_000;
  const deadlineMs = opts.deadlineMs ?? 60_000;
  const classify = opts.classify ?? classifyError;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const start = now();

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (classify(err) === 'permanent' || attempt === maxAttempts) throw err;
      let delay = backoffDelay(attempt, base, maxDelay, random);
      if (err instanceof HttpError && err.retryAfterMs !== undefined) {
        delay = Math.min(Math.max(delay, err.retryAfterMs), maxDelay);
      }
      if (now() - start + delay > deadlineMs) {
        throw new RetryDeadlineError(
          `retry deadline of ${deadlineMs} ms exceeded after ${attempt} attempt(s)`,
          {
            cause: err,
          },
        );
      }
      opts.onRetry?.({ attempt, delayMs: delay, error: err });
      await sleep(delay);
    }
  }
  throw lastErr;
}
