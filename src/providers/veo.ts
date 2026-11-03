/**
 * Tier D paid clips: Google Veo (OFF). Interface + budget guard only (T3.7).
 * Price from the spec: Veo 3.1 Lite ~ $0.05/second (Sept 2026) — UNVERIFIED; re-check before M18.
 */
import type { Config } from '../config';
import { createPaidStub, type PaidOptions, type PaidProviderInfo } from './paid';
import type { VideoClipProvider } from './types';

export const VEO_INFO: PaidProviderInfo = {
  name: 'veo',
  approxUsdPerSecond: 0.05,
  docsUrl: 'https://ai.google.dev/gemini-api/docs/video (UNVERIFIED)',
};

export function createVeoProvider(cfg: Config, opts: PaidOptions = {}): VideoClipProvider {
  return createPaidStub(cfg, VEO_INFO, opts);
}
