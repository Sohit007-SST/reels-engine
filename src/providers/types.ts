/** Shared provider interfaces for generated visuals (spec 7.5 tiers B/C/D). */
import type { AssetProvenance } from '../schemas';

export interface ImageRequest {
  /** Final prompt (caller appends brand styleSuffix). 1..2048 chars. */
  prompt: string;
  /** Diffusion steps (FLUX schnell: 1..8, default 4). */
  steps?: number;
  seed?: number;
  reelId?: string | null;
}

export interface ClipRequest {
  prompt: string;
  /** Desired clip length in seconds (providers may return shorter). */
  seconds: number;
  reelId?: string | null;
}

export type GeneratedAsset = {
  status: 'ok';
  path: string;
  provenance: AssetProvenance;
  /** True when served from the prompt-hash cache (no quota used). */
  cached: boolean;
};

/** Image result: skipped = quota guard / provider off; failed = provider error (caller uses Tier A). */
export type ImageResult =
  GeneratedAsset | { status: 'skipped'; reason: string } | { status: 'failed'; reason: string };

/** Clip result: any problem => silent fallback to Tier B (animated AI images). */
export type ClipResult = GeneratedAsset | { status: 'fallback'; reason: string };

export interface ImageProvider {
  readonly name: string;
  readonly paid: boolean;
  generateImage(req: ImageRequest): Promise<ImageResult>;
}

export interface VideoClipProvider {
  readonly name: string;
  readonly paid: boolean;
  generateClip(req: ClipRequest): Promise<ClipResult>;
}
