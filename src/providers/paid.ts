/**
 * Shared guard for PAID providers (Tier D: Veo, Kling). T3.7: interfaces only, OFF by default.
 *
 * A paid provider can only be constructed when ALL of these hold:
 *  1. VIDEO_PROVIDER names exactly that provider (never picked as a fallback or default),
 *  2. MAX_DAILY_SPEND_USD > 0 (assertPaidProviderAllowed; loadConfig() also rejects the combo),
 *  3. the caller passes `{ ownerApprovedPaid: true }` explicitly (documented in UPGRADE_TO_PAID.md).
 * Even then generateClip() re-checks the budget and refuses, because the API integration is not
 * built yet (it needs the owner's paid account, M18).
 */
import { assertPaidProviderAllowed, type Config } from '../config';
import type { ClipRequest, ClipResult, VideoClipProvider } from './types';

export class PaidProviderRefusedError extends Error {
  constructor(provider: string, reason: string) {
    super(`paid provider "${provider}" refused: ${reason}`);
    this.name = 'PaidProviderRefusedError';
  }
}

export interface PaidProviderInfo {
  name: 'veo' | 'kling';
  /** Approximate list price from the spec (Sept 2026); re-verify before enabling. */
  approxUsdPerSecond: number;
  docsUrl: string;
}

export interface PaidOptions {
  /** Must be literally true; a typo or missing flag refuses. */
  ownerApprovedPaid?: boolean;
}

export function assertPaidSelectable(cfg: Config, info: PaidProviderInfo, opts: PaidOptions): void {
  if (cfg.settings.videoProvider !== info.name) {
    throw new PaidProviderRefusedError(
      info.name,
      `VIDEO_PROVIDER is "${cfg.settings.videoProvider}", not "${info.name}"`,
    );
  }
  try {
    assertPaidProviderAllowed(cfg, info.name);
  } catch {
    throw new PaidProviderRefusedError(info.name, 'MAX_DAILY_SPEND_USD is 0 (budget $0)');
  }
  if (opts.ownerApprovedPaid !== true) {
    throw new PaidProviderRefusedError(
      info.name,
      'owner approval flag not set (see docs/UPGRADE_TO_PAID.md)',
    );
  }
}

export function estimateUsd(info: PaidProviderInfo, seconds: number): number {
  return Math.round(info.approxUsdPerSecond * Math.max(0, seconds) * 1000) / 1000;
}

/** Build the OFF stub for a paid provider (refuses at construction and again at call time). */
export function createPaidStub(
  cfg: Config,
  info: PaidProviderInfo,
  opts: PaidOptions = {},
): VideoClipProvider {
  assertPaidSelectable(cfg, info, opts);
  return {
    name: info.name,
    paid: true,
    async generateClip(req: ClipRequest): Promise<ClipResult> {
      assertPaidSelectable(cfg, info, opts);
      const est = estimateUsd(info, req.seconds);
      if (est > cfg.settings.maxDailySpendUsd) {
        throw new PaidProviderRefusedError(info.name, `estimated $${est} exceeds MAX_DAILY_SPEND_USD`);
      }
      throw new PaidProviderRefusedError(
        info.name,
        'interface only: the paid API integration is not built (see docs/UPGRADE_TO_PAID.md, M18)',
      );
    },
  };
}
