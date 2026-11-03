/**
 * Tier C free AI clips via a Hugging Face ZeroGPU Space, called over Gradio's HTTP API (T3.6).
 * Best effort: ANY problem returns { status: 'fallback' } so the pipeline silently uses Tier B.
 *
 * Docs checked 2026-11-03 (DOCS_VERIFIED; LIVE needs M10 + an owner-chosen Space):
 *  - Gradio HTTP API: https://www.gradio.app/guides/querying-gradio-apps-with-curl
 *      POST {host}/gradio_api/call/{api_name}  body {"data":[...inputs]} -> {"event_id"}
 *      GET  {host}/gradio_api/call/{api_name}/{event_id} -> SSE: event: generating|complete|error|heartbeat
 *      File outputs are { path, url, orig_name, meta: { _type: "gradio.FileData" } }.
 *      Auth: Authorization: Bearer $HF_TOKEN on both requests.
 *  - Space + model metadata (license check): GET https://huggingface.co/api/spaces/{id}
 *      -> { host, cardData.license, models: [...] }; GET https://huggingface.co/api/models/{id}
 *      -> { cardData.license, tags: ["license:..."] }.
 *  - Free ZeroGPU allowance (~5 GPU-minutes/day for a free account) is from the spec and is
 *    UNVERIFIED; the guard uses our own counter with that limit.
 *
 * License rule: the Space AND every model it lists must carry a license on COMMERCIAL_LICENSES.
 * Unknown or missing license => blocked (spec 7.5: unknown commercial-use status is blocked).
 */
import path from 'node:path';
import { PROJECT_ROOT, type Config } from '../config';
import { getJson, httpRequest } from '../lib/http';
import { sha256 } from '../lib/ids';
import { createLogger } from '../lib/logger';
import { serializeError } from '../lib/redact';
import { writeFileAtomic, writeJsonAtomic } from '../lib/store';
import { AssetProvenance } from '../schemas';
import { DEFAULT_USAGE_FILE, adjustUsage, reserveQuota, type QuotaSpec } from './quota';
import type { ClipRequest, ClipResult, VideoClipProvider } from './types';

export const HF_TIMEOUT_MS = 4 * 60_000;
export const HF_GRADIO_DOCS_URL = 'https://www.gradio.app/guides/querying-gradio-apps-with-curl';
export const HF_LICENSE_CHECKED_AT = '2026-11-03';
/** Licenses that allow commercial use of outputs (conservative list; lowercase HF ids). */
export const COMMERCIAL_LICENSES = new Set([
  'apache-2.0',
  'mit',
  'bsd-2-clause',
  'bsd-3-clause',
  'cc-by-4.0',
  'cc0-1.0',
]);
export const HF_QUOTA: QuotaSpec = { provider: 'hf_zerogpu', limit: 300, unit: 'gpu_seconds' };
/** Reserved per clip before the call; corrected to the measured wall time afterwards. */
export const HF_ESTIMATED_SECONDS = 60;
const MAX_CLIP_BYTES = 50 * 1024 * 1024;

export interface HfSpaceSettings {
  /** e.g. "owner/space-name" — chosen by the owner after a license review (M10). */
  spaceId: string;
  /** Gradio endpoint name without slash, e.g. "generate". */
  apiName: string;
  /** Map the request to the Space's input list (default: [prompt]). */
  buildInputs?: (req: ClipRequest) => unknown[];
}

export interface HuggingFaceOptions extends HfSpaceSettings {
  token: string;
  cacheDir?: string;
  usageFile?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export type LicenseCheck =
  { ok: true; license: string; host: string; models: string[] } | { ok: false; reason: string };

function licenseOf(meta: { cardData?: { license?: unknown }; tags?: unknown }): string | null {
  const l = meta.cardData?.license;
  if (typeof l === 'string' && l.trim()) return l.trim().toLowerCase();
  if (Array.isArray(meta.tags)) {
    const tag = meta.tags.find((t): t is string => typeof t === 'string' && t.startsWith('license:'));
    if (tag) return tag.slice('license:'.length).toLowerCase();
  }
  return null;
}

/** Parse a Gradio SSE stream body; returns the data of the final complete/error event. */
export function parseGradioSse(body: string): { event: 'complete' | 'error'; data: unknown } | null {
  let current: string | null = null;
  let last: { event: 'complete' | 'error'; data: unknown } | null = null;
  for (const raw of body.split(/\r?\n/)) {
    if (raw.startsWith('event:')) current = raw.slice(6).trim();
    else if (raw.startsWith('data:') && (current === 'complete' || current === 'error')) {
      const text = raw.slice(5).trim();
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* keep text */
      }
      last = { event: current, data };
    }
  }
  return last;
}

/** First gradio FileData-like object with a URL, searched depth-first. */
export function findFileUrl(data: unknown, depth = 0): string | null {
  if (depth > 6 || data === null || typeof data !== 'object') return null;
  if (Array.isArray(data)) {
    for (const d of data) {
      const u = findFileUrl(d, depth + 1);
      if (u) return u;
    }
    return null;
  }
  const o = data as Record<string, unknown>;
  if (typeof o.url === 'string' && /^https:\/\//.test(o.url)) return o.url;
  for (const v of Object.values(o)) {
    const u = findFileUrl(v, depth + 1);
    if (u) return u;
  }
  return null;
}

function sniffVideo(b: Uint8Array): 'mp4' | 'webm' | null {
  if (b.length > 12 && String.fromCharCode(...b.slice(4, 8)) === 'ftyp') return 'mp4';
  if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  return null;
}

function isHfHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'huggingface.co' || h.endsWith('.hf.space') || h.endsWith('.huggingface.co');
  } catch {
    return false;
  }
}

export class HuggingFaceClipProvider implements VideoClipProvider {
  readonly name = 'hf_free';
  readonly paid = false;
  private readonly log = createLogger({ provider: 'huggingface', stage: 'clips' });
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HuggingFaceOptions) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(opts.spaceId)) throw new Error('spaceId must look like "owner/space"');
    if (!/^[\w-]+$/.test(opts.apiName)) throw new Error('apiName must be a plain gradio endpoint name');
    this.now = opts.now ?? (() => new Date());
    this.timeoutMs = Math.min(opts.timeoutMs ?? HF_TIMEOUT_MS, HF_TIMEOUT_MS);
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}` };
  }

  async checkLicense(signal?: AbortSignal): Promise<LicenseCheck> {
    const base = 'https://huggingface.co/api';
    const common = {
      provider: 'huggingface',
      timeoutMs: 15_000,
      retry: { maxAttempts: 2, deadlineMs: 30_000 },
      headers: this.auth(),
      ...(signal ? { signal } : {}),
    };
    const space = await getJson<{
      host?: string;
      cardData?: { license?: unknown };
      tags?: unknown;
      models?: unknown;
    }>(`${base}/spaces/${this.opts.spaceId}`, { ...common, purpose: 'space_info' });
    const spaceLicense = licenseOf(space);
    if (!spaceLicense || !COMMERCIAL_LICENSES.has(spaceLicense)) {
      return { ok: false, reason: `space license ${spaceLicense ?? 'unknown'} not on commercial allowlist` };
    }
    const models = Array.isArray(space.models)
      ? space.models.filter((m): m is string => typeof m === 'string')
      : [];
    if (models.length === 0) return { ok: false, reason: 'space lists no models: model license unknown' };
    for (const m of models) {
      const info = await getJson<{ cardData?: { license?: unknown }; tags?: unknown }>(
        `${base}/models/${m}`,
        {
          ...common,
          purpose: 'model_info',
        },
      );
      const ml = licenseOf(info);
      if (!ml || !COMMERCIAL_LICENSES.has(ml)) {
        return { ok: false, reason: `model ${m} license ${ml ?? 'unknown'} not on commercial allowlist` };
      }
    }
    if (typeof space.host !== 'string' || !/^https:\/\/[a-z0-9-]+\.hf\.space$/.test(space.host)) {
      return { ok: false, reason: 'space host missing or unexpected' };
    }
    return {
      ok: true,
      license: `space:${spaceLicense}; models:${models.join(',')}`,
      host: space.host,
      models,
    };
  }

  async generateClip(req: ClipRequest): Promise<ClipResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('hf 4-minute budget exceeded')),
      this.timeoutMs,
    );
    let reserved = false;
    try {
      const lic = await this.checkLicense(controller.signal);
      if (!lic.ok) return this.fallback(`license: ${lic.reason}`);

      const q = await reserveQuota(
        this.opts.usageFile ?? DEFAULT_USAGE_FILE,
        HF_QUOTA,
        HF_ESTIMATED_SECONDS,
        this.now(),
      );
      if (!q.allowed) return this.fallback(`quota: ${q.reason} ${q.detail}`);
      reserved = true;

      const remaining = () => Math.max(1_000, this.timeoutMs - (Date.now() - started));
      const inputs = (this.opts.buildInputs ?? ((r: ClipRequest) => [r.prompt]))(req);
      const callUrl = `${lic.host}/gradio_api/call/${encodeURIComponent(this.opts.apiName)}`;
      const submit = await httpRequest(callUrl, {
        method: 'POST',
        provider: 'huggingface',
        purpose: 'gradio_submit',
        isWrite: false, // inference only
        headers: this.auth(),
        body: { data: inputs },
        timeoutMs: Math.min(30_000, remaining()),
        retry: false,
        signal: controller.signal,
      });
      const { event_id } = await submit.json<{ event_id?: string }>();
      if (!event_id) return this.fallback('no event_id from space');

      const stream = await httpRequest(`${callUrl}/${encodeURIComponent(event_id)}`, {
        provider: 'huggingface',
        purpose: 'gradio_result',
        headers: this.auth(),
        timeoutMs: remaining(),
        retry: false,
        signal: controller.signal,
      });
      const result = parseGradioSse(await stream.text());
      if (!result) return this.fallback('space returned no result');
      if (result.event === 'error')
        return this.fallback('space reported an error (often: GPU quota or queue)');
      const fileUrl = findFileUrl(result.data);
      if (!fileUrl) return this.fallback('no file in space output');

      const dl = await httpRequest(fileUrl, {
        provider: 'huggingface',
        purpose: 'download_clip',
        ...(isHfHost(fileUrl) ? { headers: this.auth() } : {}),
        timeoutMs: remaining(),
        retry: { maxAttempts: 2, deadlineMs: remaining() },
        signal: controller.signal,
      });
      const bytes = new Uint8Array(await dl.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_CLIP_BYTES)
        return this.fallback('clip empty or too large');
      const ext = sniffVideo(bytes);
      if (!ext) return this.fallback('downloaded file is not a video');

      const hash = sha256(bytes);
      const promptHash = sha256(JSON.stringify({ space: this.opts.spaceId, api: this.opts.apiName, inputs }));
      const dir = this.opts.cacheDir ?? path.join(PROJECT_ROOT, 'out', 'cache', 'clips');
      const clipPath = path.join(dir, `${promptHash}.${ext}`);
      await writeFileAtomic(clipPath, bytes);
      const provenance: AssetProvenance = {
        schemaVersion: 1,
        assetId: `clip-${promptHash.slice(0, 16)}`,
        kind: 'clip',
        path: clipPath,
        sha256: hash,
        provider: `huggingface-space:${this.opts.spaceId}`,
        model: lic.models.join(','),
        modelVersion: null,
        license: lic.license,
        commercialUse: 'allowed',
        termsCheckedAt: this.now().toISOString().slice(0, 10),
        prompt: req.prompt,
        promptHash,
        createdAt: this.now().toISOString(),
        reelId: req.reelId ?? null,
      };
      await writeJsonAtomic(path.join(dir, `${promptHash}.json`), provenance, AssetProvenance);
      return { status: 'ok', path: clipPath, provenance, cached: false };
    } catch (err) {
      return this.fallback(serializeError(err).message);
    } finally {
      clearTimeout(timer);
      if (reserved) {
        const elapsed = Math.ceil((Date.now() - started) / 1000);
        await adjustUsage(
          this.opts.usageFile ?? DEFAULT_USAGE_FILE,
          HF_QUOTA.provider,
          elapsed - HF_ESTIMATED_SECONDS,
          this.now(),
        ).catch(() => undefined);
      }
    }
  }

  private fallback(reason: string): ClipResult {
    // Silent fallback: info-level log only, no alert; the pipeline uses Tier B instead.
    this.log.info('hf clip fallback to tier B', { reason });
    return { status: 'fallback', reason };
  }
}

/** Factory: returns null (=> use Tier B) when VIDEO_PROVIDER is not hf_free, or the token/Space is missing. */
export function createHuggingFaceClipProvider(
  cfg: Config,
  space: HfSpaceSettings | null,
  opts: Partial<Omit<HuggingFaceOptions, 'token' | keyof HfSpaceSettings>> = {},
): VideoClipProvider | null {
  if (cfg.settings.videoProvider !== 'hf_free') return null;
  const token = cfg.secrets.HF_TOKEN;
  if (!token || !space) return null;
  return new HuggingFaceClipProvider({ token, ...space, ...opts });
}
