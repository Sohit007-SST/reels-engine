/**
 * Per-provider daily quota guard backed by data/usage.json (Usage schema).
 *
 * - The cost is RESERVED before each call (so a crash or a charged failure still counts).
 * - Stop at the reserve margin (85% of the daily allowance) — quotaAllows() from schemas.
 * - Unknown usage => skip: an unreadable/invalid usage file, or a null limit, refuses the call.
 * - Counters roll over on the UTC date (Cloudflare's free allocation resets at 00:00 UTC).
 * - A missing file is the first-ever run: it is created with zero usage.
 */
import path from 'node:path';
import { PROJECT_ROOT } from '../config';
import { readJsonOrNull, withFileLock, writeJsonAtomic } from '../lib/store';
import { Usage, quotaAllows, type ProviderUsage } from '../schemas';

export const DEFAULT_USAGE_FILE = path.join(PROJECT_ROOT, 'data', 'usage.json');
export const RESERVE_RATIO = 0.85;

export interface QuotaSpec {
  provider: string;
  /** Daily allowance; null = unknown (calls are refused). */
  limit: number | null;
  unit: string;
  reserve?: number;
}

export type QuotaDecision =
  | { allowed: true; usedBefore: number; usedAfter: number; limit: number; ratioAfter: number }
  | { allowed: false; reason: 'unknown_usage' | 'reserve_reached'; detail: string; ratio: number | null };

export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function loadUsage(file: string, now: Date): Promise<Usage | 'unknown'> {
  let u: Usage | null;
  try {
    u = await readJsonOrNull(file, Usage);
  } catch {
    return 'unknown';
  }
  const today = utcDate(now);
  if (!u || u.date !== today) return { schemaVersion: 1, date: today, providers: {} };
  return u;
}

/** Atomically check the guard and, if allowed, add `cost` to today's counter. */
export async function reserveQuota(
  file: string,
  spec: QuotaSpec,
  cost: number,
  now: Date = new Date(),
): Promise<QuotaDecision> {
  if (!(cost >= 0) || !Number.isFinite(cost)) throw new Error(`invalid quota cost: ${cost}`);
  return withFileLock(file, async () => {
    const usage = await loadUsage(file, now);
    if (usage === 'unknown') {
      return {
        allowed: false,
        reason: 'unknown_usage',
        detail: 'usage file unreadable or invalid',
        ratio: null,
      };
    }
    const existing = usage.providers[spec.provider];
    const entry: ProviderUsage = existing ?? {
      used: 0,
      limit: spec.limit,
      unit: spec.unit,
      updatedAt: now.toISOString(),
    };
    // The stricter of the recorded and the coded limit wins; any null means unknown.
    const limit = entry.limit === null || spec.limit === null ? null : Math.min(entry.limit, spec.limit);
    const effective: ProviderUsage = { ...entry, limit };
    const reserve = spec.reserve ?? RESERVE_RATIO;
    if (limit === null) {
      return {
        allowed: false,
        reason: 'unknown_usage',
        detail: `${spec.provider} daily limit unknown`,
        ratio: null,
      };
    }
    if (!quotaAllows(effective, cost, reserve)) {
      return {
        allowed: false,
        reason: 'reserve_reached',
        detail: `${spec.provider}: ${entry.used}+${cost} ${spec.unit} would pass ${Math.round(reserve * 100)}% of ${limit}`,
        ratio: entry.used / limit,
      };
    }
    const next: Usage = {
      ...usage,
      providers: {
        ...usage.providers,
        [spec.provider]: { used: entry.used + cost, limit, unit: spec.unit, updatedAt: now.toISOString() },
      },
    };
    await writeJsonAtomic(file, next, Usage);
    return {
      allowed: true,
      usedBefore: entry.used,
      usedAfter: entry.used + cost,
      limit,
      ratioAfter: (entry.used + cost) / limit,
    };
  });
}

/** Correct today's counter after the real cost is known (never below 0). Best effort. */
export async function adjustUsage(
  file: string,
  provider: string,
  delta: number,
  now: Date = new Date(),
): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  await withFileLock(file, async () => {
    const usage = await loadUsage(file, now);
    if (usage === 'unknown') return;
    const entry = usage.providers[provider];
    if (!entry) return;
    const next: Usage = {
      ...usage,
      providers: {
        ...usage.providers,
        [provider]: { ...entry, used: Math.max(0, entry.used + delta), updatedAt: now.toISOString() },
      },
    };
    await writeJsonAtomic(file, next, Usage);
  });
}
