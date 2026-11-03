/**
 * Tier D paid clips: Kling (OFF). Interface + budget guard only (T3.7).
 * Price from the spec: Kling 3.0 ~ $0.084-0.126/second (Sept 2026) — UNVERIFIED; the guard uses
 * the upper bound.
 */
import type { Config } from '../config';
import { createPaidStub, type PaidOptions, type PaidProviderInfo } from './paid';
import type { VideoClipProvider } from './types';

export const KLING_INFO: PaidProviderInfo = {
  name: 'kling',
  approxUsdPerSecond: 0.126,
  docsUrl: 'https://app.klingai.com/global/dev/document-api (UNVERIFIED)',
};

export function createKlingProvider(cfg: Config, opts: PaidOptions = {}): VideoClipProvider {
  return createPaidStub(cfg, KLING_INFO, opts);
}
