/**
 * Analytics (spec 7.11). Pull Reels insights at ~24 h, 72 h and 7 days after posting into a
 * time series (data/metrics/<reelId>.json). Missing metrics stay null — never 0.
 *
 * Scoring (documented, configurable via brand.json scoringWeights; defaults):
 *   watch time 35%, shares 25%, saves 20%, comments 10%, skip rate 10%.
 * Each component is normalized per 1,000 views (watch time: avg watch time; skip rate: lower is
 * better, so the ratio is inverted). A reel's component ratio = value / 14-day median of the same
 * window over reels published in the 14 days before it. scoreVsMedian = weighted mean of the
 * available ratios (weights renormalized over non-null components; null if none). 1.0 = median.
 *
 * Suppression alert: reach > 50% below the 14-day median for 3 days running -> pause trial reels
 * (data/trial-control.json) and notify the owner.
 */
import path from 'node:path';
import { z } from 'zod';
import { applyWritePolicy, loadBrand, loadConfig, type Config } from '../config';
import type { InstagramClient } from '../instagram/client';
import { createLogger, type Logger } from '../lib/logger';
import { readJsonOrNull, writeJsonAtomic, updateJsonAtomic } from '../lib/store';
import { istDate } from '../lib/time';
import { Metrics, type MetricsSnapshot } from '../schemas/metrics';
import type { TelegramClient } from '../telegram/index';
import { setTrialPaused, trialPaused } from '../state/control';
import { readLedger } from '../state/ledger';
import type { DataPaths } from '../state/paths';
import { listQueueItems } from '../state/queue';
import { ScoresFile, type ScoreEntry } from '../state/schemas';
import { buildRuntime, isEntryPoint } from '../state/runtime';

export type Weights = ScoresFile['weights'];
export const DEFAULT_WEIGHTS: Weights = {
  watchTime: 0.35,
  shares: 0.25,
  saves: 0.2,
  comments: 0.1,
  skipRate: 0.1,
};
export const WINDOWS = [
  { window: '24h', ms: 24 * 3_600_000 },
  { window: '72h', ms: 72 * 3_600_000 },
  { window: '7d', ms: 7 * 86_400_000 },
] as const;
export type Window = (typeof WINDOWS)[number]['window'];
export const MEDIAN_DAYS = 14;
export const SUPPRESSION_RATIO = 0.5;
export const SUPPRESSION_DAYS = 3;

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

const per1k = (x: number | null, views: number | null): number | null =>
  x === null || views === null || views <= 0 ? null : (x / views) * 1000;

export function toEntry(
  reelId: string,
  publishedAt: string | null,
  snap: MetricsSnapshot & { window: Window },
  meta: {
    format: string | null;
    hookFormula: string | null;
    slot: string | null;
    placement: 'main' | 'trial' | null;
  },
): ScoreEntry {
  const v = snap.values;
  return {
    reelId,
    publishedAt,
    window: snap.window,
    views: v.views,
    reach: v.reach,
    avgWatchTime: v.ig_reels_avg_watch_time,
    sharesPer1k: per1k(v.shares, v.views),
    savesPer1k: per1k(v.saved, v.views),
    commentsPer1k: per1k(v.comments, v.views),
    skipRate: v.reels_skip_rate,
    scoreVsMedian: null,
    ...meta,
  };
}

/** Fill scoreVsMedian for every entry against the 14-day median of earlier reels (same window). */
export function scoreEntries(entries: ScoreEntry[], weights: Weights): ScoreEntry[] {
  const comps: Array<{ key: keyof Weights; get: (e: ScoreEntry) => number | null; invert: boolean }> = [
    { key: 'watchTime', get: (e) => e.avgWatchTime, invert: false },
    { key: 'shares', get: (e) => e.sharesPer1k, invert: false },
    { key: 'saves', get: (e) => e.savesPer1k, invert: false },
    { key: 'comments', get: (e) => e.commentsPer1k, invert: false },
    { key: 'skipRate', get: (e) => e.skipRate, invert: true },
  ];
  return entries.map((e) => {
    if (!e.publishedAt) return { ...e, scoreVsMedian: null };
    const t = Date.parse(e.publishedAt);
    const peers = entries.filter(
      (p) =>
        p.window === e.window &&
        p.reelId !== e.reelId &&
        p.publishedAt &&
        Date.parse(p.publishedAt) < t &&
        t - Date.parse(p.publishedAt) <= MEDIAN_DAYS * 86_400_000,
    );
    let sum = 0;
    let wsum = 0;
    for (const c of comps) {
      const val = c.get(e);
      const med = median(peers.map(c.get).filter((x): x is number => x !== null));
      if (val === null || med === null || med <= 0 || (c.invert && val <= 0)) continue;
      const ratio = c.invert ? med / val : val / med;
      sum += weights[c.key] * ratio;
      wsum += weights[c.key];
    }
    return { ...e, scoreVsMedian: wsum > 0 ? Math.round((sum / wsum) * 1000) / 1000 : null };
  });
}

/**
 * Suppression: each of the last `days` IST days (by publish date) has reels, and each day's median
 * 24h reach is below ratio x the median 24h reach of reels published in the 14 days before that
 * window (baseline needs >= 3 reels).
 */
export function suppressed(
  entries: ScoreEntry[],
  now: Date,
  days = SUPPRESSION_DAYS,
  ratio = SUPPRESSION_RATIO,
): boolean {
  const e24 = entries.filter((e) => e.window === '24h' && e.reach !== null && e.publishedAt);
  const dayOf = (e: ScoreEntry): string => istDate(new Date(e.publishedAt!));
  const recentDays = Array.from({ length: days }, (_, i) =>
    istDate(new Date(now.getTime() - (i + 1) * 86_400_000)),
  );
  const windowStart = Date.parse(`${recentDays[days - 1]}T00:00:00+05:30`);
  const base = e24
    .filter((e) => {
      const t = Date.parse(e.publishedAt!);
      return t < windowStart && windowStart - t <= MEDIAN_DAYS * 86_400_000;
    })
    .map((e) => e.reach!);
  const m = median(base);
  if (m === null || base.length < 3) return false;
  return recentDays.every((d) => {
    const dm = median(e24.filter((e) => dayOf(e) === d).map((e) => e.reach!));
    return dm !== null && dm < m * ratio;
  });
}

export interface AnalyzeDeps {
  paths: DataPaths;
  instagram: InstagramClient | null;
  telegram: TelegramClient | null;
  runId: string;
  weights?: Weights;
  now?: () => Date;
  logger?: Logger;
}

export interface AnalyzeResult {
  captured: Array<{ reelId: string; window: Window }>;
  scored: number;
  suppression: boolean;
  errors: string[];
}

const SpecMeta = z.looseObject({
  format: z.string().optional(),
  hook: z.looseObject({ hookFormula: z.string().optional() }).optional(),
});

export async function runAnalyze(deps: AnalyzeDeps): Promise<AnalyzeResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? createLogger({ runId: deps.runId, stage: 'analyze' });
  const res: AnalyzeResult = { captured: [], scored: 0, suppression: false, errors: [] };
  const { items } = await listQueueItems(deps.paths);
  const entries: ScoreEntry[] = [];
  for (const item of items.filter((i) => i.state === 'PUBLISHED')) {
    const ledger = await readLedger(deps.paths, item.reelId);
    if (!ledger?.mediaId) continue;
    const file = path.join(deps.paths.metricsDir, `${item.reelId}.json`);
    let metrics = (await readJsonOrNull(file, Metrics)) ?? {
      schemaVersion: 1 as const,
      reelId: item.reelId,
      mediaId: ledger.mediaId,
      publishedAt: ledger.publishedAt,
      snapshots: [],
    };
    const age = ledger.publishedAt ? now().getTime() - Date.parse(ledger.publishedAt) : -1;
    const dueWin = [...WINDOWS].reverse().find((w) => age >= w.ms);
    if (deps.instagram && dueWin && !metrics.snapshots.some((s) => s.window === dueWin.window)) {
      try {
        const r = await deps.instagram.getReelInsights(ledger.mediaId); // read-only GET
        const snap: MetricsSnapshot = {
          window: dueWin.window,
          capturedAt: now().toISOString(),
          values: r.values,
          unavailable: r.unavailable,
        };
        metrics = await updateJsonAtomic(file, Metrics, (cur) => {
          const base = cur ?? metrics;
          if (base.snapshots.some((s) => s.window === dueWin.window)) return base;
          return { ...base, snapshots: [...base.snapshots, snap] };
        });
        res.captured.push({ reelId: item.reelId, window: dueWin.window });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.errors.push(`${item.reelId}: ${msg}`);
        log.warn('insights failed', { reelId: item.reelId, error: msg });
      }
    }
    const spec = await readJsonOrNull(path.join(deps.paths.specsDir, `${item.reelId}.json`), SpecMeta).catch(
      () => null,
    );
    const meta = {
      format: spec?.format ?? null,
      hookFormula: spec?.hook?.hookFormula ?? null,
      slot: item.slot.time,
      placement: item.placement,
    };
    for (const s of metrics.snapshots) {
      if (s.window === 'adhoc') continue;
      entries.push(toEntry(item.reelId, ledger.publishedAt, s as MetricsSnapshot & { window: Window }, meta));
    }
  }
  const weights = deps.weights ?? DEFAULT_WEIGHTS;
  const scored = scoreEntries(entries, weights);
  res.scored = scored.length;
  await writeJsonAtomic(
    path.join(deps.paths.metricsDir, 'scores.json'),
    { schemaVersion: 1, updatedAt: now().toISOString(), weights, entries: scored },
    ScoresFile,
  );
  if (suppressed(scored, now())) {
    res.suppression = true;
    if (!(await trialPaused(deps.paths))) {
      await setTrialPaused(deps.paths, true, 'suppression: reach >50% below 14-day median for 3 days', now());
      try {
        await deps.telegram?.notify(
          'Reach has been more than 50% below the 14-day median for 3 days. Trial reels are paused.',
        );
      } catch {
        res.errors.push('suppression alert could not be sent');
      }
    }
  }
  return res;
}

export async function main(cfg: Config = loadConfig()): Promise<number> {
  applyWritePolicy(cfg);
  const rt = buildRuntime(cfg, 'analyze');
  const brand = await loadBrand().catch(() => null);
  const r = await runAnalyze({
    paths: rt.paths,
    instagram: rt.instagram,
    telegram: rt.telegram,
    runId: rt.runId,
    weights: brand?.scoringWeights ?? DEFAULT_WEIGHTS,
    logger: rt.logger,
  });
  rt.logger.info('analyze done', {
    captured: r.captured.length,
    scored: r.scored,
    suppression: r.suppression,
    errors: r.errors.length,
  });
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (err: unknown) => {
      createLogger({ stage: 'analyze' }).error('analyze crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    },
  );
}
