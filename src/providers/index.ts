/**
 * Provider selection (spec 7.5). Free providers only by default; paid providers (veo, kling)
 * are never chosen as a default or fallback and need VIDEO_PROVIDER + budget + explicit flag.
 */
import type { Config } from '../config';
import { createCloudflareImageProvider, type CloudflareImageOptions } from './cloudflare';
import { createHuggingFaceClipProvider, type HfSpaceSettings, type HuggingFaceOptions } from './huggingface';
import { createKlingProvider } from './kling';
import type { PaidOptions } from './paid';
import type { ImageProvider, VideoClipProvider } from './types';
import { createVeoProvider } from './veo';

export * from './types';
export {
  CloudflareImageProvider,
  createCloudflareImageProvider,
  estimateNeurons,
  CLOUDFLARE_QUOTA,
} from './cloudflare';
export {
  HuggingFaceClipProvider,
  createHuggingFaceClipProvider,
  HF_QUOTA,
  COMMERCIAL_LICENSES,
} from './huggingface';
export { PaidProviderRefusedError } from './paid';
export { createVeoProvider } from './veo';
export { createKlingProvider } from './kling';
export { reserveQuota, adjustUsage, DEFAULT_USAGE_FILE, RESERVE_RATIO } from './quota';

export function selectImageProvider(
  cfg: Config,
  opts: Partial<Omit<CloudflareImageOptions, 'accountId' | 'apiToken'>> = {},
): ImageProvider {
  return createCloudflareImageProvider(cfg, opts);
}

/**
 * Returns the configured clip provider, or null => use Tier B (animated AI images).
 * Throws PaidProviderRefusedError if a paid provider is configured without budget + approval.
 */
export function selectVideoProvider(
  cfg: Config,
  deps: {
    hfSpace?: HfSpaceSettings | null;
    hfOptions?: Partial<Omit<HuggingFaceOptions, 'token' | keyof HfSpaceSettings>>;
    paid?: PaidOptions;
  } = {},
): VideoClipProvider | null {
  switch (cfg.settings.videoProvider) {
    case 'none':
      return null;
    case 'hf_free':
      return createHuggingFaceClipProvider(cfg, deps.hfSpace ?? null, deps.hfOptions ?? {});
    case 'veo':
      return createVeoProvider(cfg, deps.paid ?? {});
    case 'kling':
      return createKlingProvider(cfg, deps.paid ?? {});
    default:
      return null;
  }
}
