/**
 * Tier B AI stills: Cloudflare Workers AI `@cf/black-forest-labs/flux-1-schnell` (T3.4).
 *
 * Docs checked 2026-11-03 (DOCS_VERIFIED, not yet LIVE_VERIFIED — needs M7):
 *  - Model + input schema: https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
 *      POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/black-forest-labs/flux-1-schnell
 *      input  { prompt: string (1..2048, required), steps?: integer (max 8, default 4), seed?: integer }
 *      output { image: string }  (base64 JPEG), wrapped in { result, success, errors } over REST.
 *      No negative-prompt or size parameter is documented; output resolution is not documented.
 *  - Pricing / free tier: https://developers.cloudflare.com/workers-ai/platform/pricing/
 *      10,000 free neurons per day, reset 00:00 UTC. FLUX schnell: 4.80 neurons per 512x512 tile
 *      + 9.60 neurons per step. No documented usage API => we keep our own counter.
 *  - License: FLUX.1 [schnell] weights are Apache-2.0 (huggingface.co/black-forest-labs/FLUX.1-schnell,
 *    checked 2026-11-03); Cloudflare links BFL terms at bfl.ai/legal/terms-of-service.
 *
 * Behavior: cache by prompt hash (no quota used on a hit), provenance JSON next to each image,
 * quota reserved before every attempt (stop at 85%; unknown usage => skip), read-only inference
 * request (isWrite:false) with timeout + bounded retry. Never throws for provider problems.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, type Config } from '../config';
import { httpRequest } from '../lib/http';
import { sha256 } from '../lib/ids';
import { createLogger } from '../lib/logger';
import { serializeError } from '../lib/redact';
import { PermanentError, retry } from '../lib/retry';
import { readJsonOrNull, writeFileAtomic, writeJsonAtomic } from '../lib/store';
import { AssetProvenance, isAssetUsable } from '../schemas';
import { DEFAULT_USAGE_FILE, reserveQuota, type QuotaSpec } from './quota';
import type { ImageProvider, ImageRequest, ImageResult } from './types';

export const CF_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const CF_DOCS_URL = 'https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/';
export const CF_PRICING_URL = 'https://developers.cloudflare.com/workers-ai/platform/pricing/';
export const CF_DAILY_FREE_NEURONS = 10_000;
export const CF_LICENSE = 'apache-2.0 (FLUX.1 [schnell]); BFL terms via Cloudflare';
export const CF_TERMS_CHECKED_AT = '2026-11-03';
export const NEURONS_PER_TILE = 4.8;
export const NEURONS_PER_STEP = 9.6;
/** Output size is undocumented; assume 1024x1024 (4 tiles) to stay conservative. */
export const ASSUMED_OUTPUT_PX = 1024;
export const MAX_PROMPT_CHARS = 2048;
export const MAX_STEPS = 8;
export const DEFAULT_STEPS = 4;

export const CLOUDFLARE_QUOTA: QuotaSpec = {
  provider: 'cloudflare',
  limit: CF_DAILY_FREE_NEURONS,
  unit: 'neurons',
};

/** Conservative neuron estimate for one FLUX schnell image. */
export function estimateNeurons(steps: number, px = ASSUMED_OUTPUT_PX): number {
  const tiles = Math.ceil(px / 512) ** 2;
  return Math.round((tiles * NEURONS_PER_TILE + steps * NEURONS_PER_STEP) * 100) / 100;
}

export function imageCacheKey(prompt: string, steps: number, seed: number | undefined): string {
  return sha256(JSON.stringify({ model: CF_MODEL, prompt, steps, seed: seed ?? null }));
}

function sniffImage(bytes: Uint8Array): 'jpg' | 'png' | 'webp' | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'png';
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'webp';
  return null;
}

export interface CloudflareImageOptions {
  accountId: string;
  apiToken: string;
  cacheDir?: string;
  usageFile?: string;
  timeoutMs?: number;
  now?: () => Date;
}

export class CloudflareImageProvider implements ImageProvider {
  readonly name = 'cloudflare';
  readonly paid = false;
  private readonly cacheDir: string;
  private readonly usageFile: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly log = createLogger({ provider: 'cloudflare', stage: 'images' });

  constructor(private readonly opts: CloudflareImageOptions) {
    this.cacheDir = opts.cacheDir ?? path.join(PROJECT_ROOT, 'out', 'cache', 'images');
    this.usageFile = opts.usageFile ?? DEFAULT_USAGE_FILE;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.now = opts.now ?? (() => new Date());
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const prompt = req.prompt.trim();
    if (prompt.length < 1 || prompt.length > MAX_PROMPT_CHARS) {
      throw new PermanentError(`prompt must be 1..${MAX_PROMPT_CHARS} characters`);
    }
    const steps = req.steps ?? DEFAULT_STEPS;
    if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) {
      throw new PermanentError(`steps must be an integer 1..${MAX_STEPS}`);
    }
    const key = imageCacheKey(prompt, steps, req.seed);
    const metaPath = path.join(this.cacheDir, `${key}.json`);

    // 1) cache hit => no quota, no network
    const cachedProv = await readJsonOrNull(metaPath, AssetProvenance).catch(() => null);
    if (cachedProv && isAssetUsable(cachedProv)) {
      try {
        await fs.access(cachedProv.path);
        return { status: 'ok', path: cachedProv.path, provenance: cachedProv, cached: true };
      } catch {
        /* file vanished: regenerate */
      }
    }

    const cost = estimateNeurons(steps);
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.opts.accountId)}/ai/run/${CF_MODEL}`;
    let bytes: Uint8Array;
    try {
      bytes = await retry(
        async () => {
          // Reserve before EVERY attempt: a failed request may still be billed in neurons.
          const q = await reserveQuota(this.usageFile, CLOUDFLARE_QUOTA, cost, this.now());
          if (!q.allowed) throw new QuotaSkip(q.reason, q.detail);
          if (q.ratioAfter >= 0.85)
            this.log.warn('cloudflare quota at reserve margin', { ratio: q.ratioAfter });
          const res = await httpRequest(url, {
            method: 'POST',
            provider: 'cloudflare',
            purpose: 'flux_schnell',
            isWrite: false, // inference only; nothing is published
            headers: { authorization: `Bearer ${this.opts.apiToken}` },
            body: { prompt, steps, ...(req.seed !== undefined ? { seed: req.seed } : {}) },
            timeoutMs: this.timeoutMs,
            retry: false,
          });
          const ctype = res.headers.get('content-type') ?? '';
          if (ctype.startsWith('image/')) return new Uint8Array(await res.arrayBuffer());
          const json = await res.json<{
            success?: boolean;
            result?: { image?: string };
            errors?: unknown[];
          }>();
          const b64 = json.result?.image;
          if (json.success === false || typeof b64 !== 'string' || b64.length === 0) {
            throw new PermanentError('cloudflare returned no image');
          }
          return new Uint8Array(Buffer.from(b64, 'base64'));
        },
        { maxAttempts: 2, deadlineMs: this.timeoutMs * 2 + 5_000 },
      );
    } catch (err) {
      if (err instanceof QuotaSkip) {
        this.log.info('cloudflare skipped by quota guard', { reason: err.reason, detail: err.detail });
        return { status: 'skipped', reason: `${err.reason}: ${err.detail}` };
      }
      const s = serializeError(err);
      this.log.warn('cloudflare image failed', { err });
      return { status: 'failed', reason: s.message };
    }

    const ext = sniffImage(bytes);
    if (!ext) return { status: 'failed', reason: 'response is not a JPEG/PNG/WebP image' };
    const imgPath = path.join(this.cacheDir, `${key}.${ext}`);
    await writeFileAtomic(imgPath, bytes);
    const provenance: AssetProvenance = {
      schemaVersion: 1,
      assetId: `img-${key.slice(0, 16)}`,
      kind: 'image',
      path: imgPath,
      sha256: sha256(bytes),
      provider: 'cloudflare-workers-ai',
      model: CF_MODEL,
      modelVersion: null,
      license: CF_LICENSE,
      commercialUse: 'allowed',
      termsCheckedAt: CF_TERMS_CHECKED_AT,
      prompt,
      promptHash: key,
      createdAt: this.now().toISOString(),
      reelId: req.reelId ?? null,
    };
    await writeJsonAtomic(metaPath, provenance, AssetProvenance);
    return { status: 'ok', path: imgPath, provenance, cached: false };
  }
}

class QuotaSkip extends PermanentError {
  constructor(
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`quota: ${reason}`);
    this.name = 'QuotaSkip';
  }
}

/** Provider that always skips (IMAGE_PROVIDER=none or missing keys). */
export function disabledImageProvider(reason: string): ImageProvider {
  return {
    name: 'none',
    paid: false,
    generateImage: async () => ({ status: 'skipped', reason }),
  };
}

export function createCloudflareImageProvider(
  cfg: Config,
  opts: Partial<Omit<CloudflareImageOptions, 'accountId' | 'apiToken'>> = {},
): ImageProvider {
  if (cfg.settings.imageProvider !== 'cloudflare') return disabledImageProvider('IMAGE_PROVIDER=none');
  const accountId = cfg.secrets.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = cfg.secrets.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken)
    return disabledImageProvider('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN MISSING (M7)');
  return new CloudflareImageProvider({ accountId, apiToken, ...opts });
}
