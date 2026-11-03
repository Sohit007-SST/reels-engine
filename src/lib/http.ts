/**
 * The ONLY way this project talks to the network.
 *
 *  - timeout on every request (default 15 s) via AbortSignal
 *  - bounded retry (transient only, max 3, jitter, deadline) via retry()
 *  - every request is reported to registered network spies BEFORE it is sent
 *  - write guard: when writes are blocked (dry_run is the default), any request
 *    classified as a write throws WriteBlockedError before touching the network,
 *    unless the call is explicitly marked `allowInDryRun` (only notification-only
 *    Telegram previews labeled DRY RUN qualify — spec 2.6)
 *  - URLs and error bodies are redacted before being logged or thrown
 *
 * Tests: use setFetchImpl() to mock the transport and addNetworkSpy() to assert
 * that zero write calls happened.
 */
import { redact, redactUrl } from './redact';
import { classifyError as defaultClassify, HttpError, retry, TimeoutError, type RetryOptions } from './retry';

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface NetworkEvent {
  method: HttpMethod;
  /** Redacted URL (never contains tokens). */
  url: string;
  host: string;
  isWrite: boolean;
  provider: string;
  purpose?: string;
  attempt: number;
  blocked: boolean;
  allowInDryRun: boolean;
  at: string;
}

export type NetworkSpy = (event: NetworkEvent) => void;

const spies = new Set<NetworkSpy>();

/** Register a spy that sees every outbound request (including blocked ones). Returns an unregister fn. */
export function addNetworkSpy(spy: NetworkSpy): () => void {
  spies.add(spy);
  return () => spies.delete(spy);
}

/** Convenience for tests: record all events; `writes()` returns attempted writes that were not dry-run-allowed. */
export function recordNetwork(): {
  events: NetworkEvent[];
  writes: () => NetworkEvent[];
  sentWrites: () => NetworkEvent[];
  stop: () => void;
} {
  const events: NetworkEvent[] = [];
  const stop = addNetworkSpy((e) => events.push(e));
  return {
    events,
    writes: () => events.filter((e) => e.isWrite && !e.allowInDryRun),
    sentWrites: () => events.filter((e) => e.isWrite && !e.blocked && !e.allowInDryRun),
    stop,
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init);

/** Swap the transport (tests). Returns a restore function. */
export function setFetchImpl(next: FetchLike): () => void {
  const prev = fetchImpl;
  fetchImpl = next;
  return () => {
    fetchImpl = prev;
  };
}

export interface WritePolicy {
  /** When false, every write (except allowInDryRun) throws WriteBlockedError. Default false (safe). */
  writesAllowed: boolean;
  /** Human-readable reason, e.g. "PUBLISH_MODE=dry_run" or "PIPELINE_PAUSED". */
  reason: string;
}

let writePolicy: WritePolicy = { writesAllowed: false, reason: 'default: writes blocked until configured' };

/** Set the global write policy (pipelines derive it from config: dry_run / paused => blocked). */
export function setWritePolicy(policy: WritePolicy): () => void {
  const prev = writePolicy;
  writePolicy = { ...policy };
  return () => {
    writePolicy = prev;
  };
}

export function getWritePolicy(): Readonly<WritePolicy> {
  return writePolicy;
}

export class WriteBlockedError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly reason: string,
  ) {
    super(`external write blocked (${reason}): ${method} ${url}`);
    this.name = 'WriteBlockedError';
  }
}

export interface HttpRequestOptions {
  method?: HttpMethod;
  headers?: Record<string, string>;
  /** Object => JSON body; string/Uint8Array/FormData/URLSearchParams sent as-is. */
  body?: unknown;
  /** Per-attempt timeout (default 15 s). */
  timeoutMs?: number;
  /** Retry options; `false` disables retries (use for non-idempotent writes). */
  retry?: RetryOptions | false;
  /** Provider label for logs/spies, e.g. "instagram", "telegram", "cloudflare". Required. */
  provider: string;
  /** Short description, e.g. "media_publish". */
  purpose?: string;
  /**
   * Override write classification. Default: GET/HEAD/OPTIONS are reads, everything else writes.
   * Mark read-only POSTs (e.g. Cloudflare inference, Telegram getUpdates) as `isWrite: false`.
   */
  isWrite?: boolean;
  /** Permit this write while writes are blocked (notification-only DRY RUN previews). */
  allowInDryRun?: boolean;
  /** Throw HttpError on non-2xx (default true). */
  expectOk?: boolean;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

const READ_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'OPTIONS']);

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

export async function httpRequest(url: string, opts: HttpRequestOptions): Promise<HttpResponse> {
  const method: HttpMethod = opts.method ?? 'GET';
  const isWrite = opts.isWrite ?? !READ_METHODS.has(method);
  const allowInDryRun = opts.allowInDryRun === true;
  const safeUrl = redactUrl(url);
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    if (
      typeof opts.body === 'string' ||
      opts.body instanceof Uint8Array ||
      opts.body instanceof ArrayBuffer ||
      opts.body instanceof URLSearchParams ||
      opts.body instanceof FormData ||
      opts.body instanceof Blob
    ) {
      body = opts.body as BodyInit;
    } else {
      body = JSON.stringify(opts.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }
  }

  const doAttempt = async (attempt: number): Promise<HttpResponse> => {
    const blocked = isWrite && !allowInDryRun && !writePolicy.writesAllowed;
    const event: NetworkEvent = {
      method,
      url: safeUrl,
      host: hostOf(url),
      isWrite,
      provider: opts.provider,
      ...(opts.purpose !== undefined ? { purpose: opts.purpose } : {}),
      attempt,
      blocked,
      allowInDryRun,
      at: new Date().toISOString(),
    };
    for (const spy of spies) {
      try {
        spy(event);
      } catch {
        /* spies must never break requests */
      }
    }
    if (blocked) throw new WriteBlockedError(method, safeUrl, writePolicy.reason);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new TimeoutError(`timeout after ${timeoutMs} ms`)),
      timeoutMs,
    );
    const onOuterAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    let res: Response;
    try {
      res = await fetchImpl(url, { method, headers, body: body ?? null, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason instanceof TimeoutError) {
        throw new TimeoutError(`${opts.provider} ${method} ${safeUrl} timed out after ${timeoutMs} ms`);
      }
      const e = err instanceof Error ? err : new Error(String(err));
      // Preserve name/code for classification, but redact the message.
      const clean = new Error(redact(`${opts.provider} ${method} ${safeUrl} failed: ${e.message}`), {
        cause: (e as { cause?: unknown }).cause,
      });
      clean.name = e.name;
      (clean as { code?: unknown }).code = (e as { code?: unknown }).code;
      throw clean;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (opts.expectOk !== false && !res.ok) {
      let text = '';
      try {
        text = (await res.text()).slice(0, 2000);
      } catch {
        /* ignore */
      }
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      throw new HttpError(
        `${opts.provider} ${method} ${safeUrl} -> HTTP ${res.status}: ${redact(text)}`,
        res.status,
        {
          url: safeUrl,
          body: redact(text),
          provider: opts.provider,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        },
      );
    }
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      text: () => res.text(),
      json: <T>() => res.json() as Promise<T>,
      arrayBuffer: () => res.arrayBuffer(),
    };
  };

  if (opts.retry === false) return doAttempt(1);
  return retry(doAttempt, {
    ...opts.retry,
    classify: (err) => {
      if (err instanceof WriteBlockedError) return 'permanent';
      return (
        (opts.retry && opts.retry.classify ? opts.retry.classify(err) : undefined) ?? defaultClassify(err)
      );
    },
  });
}

/** GET + JSON parse helper. */
export async function getJson<T = unknown>(
  url: string,
  opts: Omit<HttpRequestOptions, 'method'>,
): Promise<T> {
  const res = await httpRequest(url, { ...opts, method: 'GET' });
  return res.json<T>();
}

/** POST JSON helper (a write unless isWrite:false). Retries are OFF by default for writes. */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  opts: Omit<HttpRequestOptions, 'method' | 'body'>,
): Promise<T> {
  const res = await httpRequest(url, {
    retry: opts.isWrite === false ? undefined : false,
    ...opts,
    method: 'POST',
    body,
  } as HttpRequestOptions);
  return res.json<T>();
}
