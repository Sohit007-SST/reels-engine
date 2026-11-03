/**
 * Trend sources (T4.4). Each source is optional and isolated: a failure becomes a
 * TrendSourceStatus { status: 'error' } and never stops the run. Missing metrics stay null
 * (never 0). Business Discovery only after C07 is LIVE_VERIFIED.
 */
import path from 'node:path';
import { runAgent, type ClaudeRunner } from '../claude/runAgent';
import { TrendScoutOutput } from '../claude/outputs';
import type { Logger } from '../lib/logger';
import { serializeError } from '../lib/redact';
import { writeJsonAtomic } from '../lib/store';
import { Trend, TrendFile, type TrendSourceName, type TrendSourceStatus } from '../schemas';
import { selectTop, viralScore as scoreFn } from './score';

export interface TrendSourceContext {
  runId: string;
  date: string;
  niche: string;
  now: Date;
  logger: Logger;
}

export interface TrendSource {
  name: TrendSourceName;
  /** false => skipped (e.g. key missing or capability not verified). */
  enabled(): boolean;
  fetch(ctx: TrendSourceContext): Promise<Trend[]>;
  /** Optional per-item problems (e.g. skipped accounts) reported in the status line. */
  skipped?: string[];
}

export interface CollectResult {
  trends: Trend[];
  sources: TrendSourceStatus[];
}

/** Run every source with isolation, score, keep top 20 overall + top 3 per account. */
export async function collectTrends(sources: TrendSource[], ctx: TrendSourceContext): Promise<CollectResult> {
  const statuses: TrendSourceStatus[] = [];
  const all: Trend[] = [];
  for (const src of sources) {
    let enabled: boolean;
    try {
      enabled = src.enabled();
    } catch {
      enabled = false;
    }
    if (!enabled) {
      statuses.push({ source: src.name, status: 'skipped', itemCount: 0, error: null, durationMs: null });
      continue;
    }
    const t0 = Date.now();
    try {
      const items = await src.fetch(ctx);
      if (!Array.isArray(items)) throw new Error('source returned a non-array');
      const valid: Trend[] = [];
      for (const it of items) {
        const parsed = Trend.safeParse(it);
        if (parsed.success) valid.push(parsed.data);
        else ctx.logger.warn('dropping invalid trend item', { source: src.name });
      }
      all.push(...valid);
      const skipped = src.skipped?.length ? `skipped: ${src.skipped.join('; ')}`.slice(0, 1000) : null;
      statuses.push({
        source: src.name,
        status: valid.length ? 'ok' : 'empty',
        itemCount: valid.length,
        error: skipped,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      const msg = serializeError(err).message.slice(0, 500);
      ctx.logger.warn('trend source failed', { source: src.name, err });
      statuses.push({
        source: src.name,
        status: 'error',
        itemCount: 0,
        error: msg,
        durationMs: Date.now() - t0,
      });
    }
  }
  // Same item from two runs/sources => keep the first.
  const seen = new Set<string>();
  const unique = all.filter((t) => !seen.has(t.id) && seen.add(t.id));
  return { trends: selectTop(unique, ctx.now), sources: statuses };
}

/** Viral score per 7.1: views (or likes + 3 x comments, flagged proxy) per hour / account median (>= 5 posts). */
export function viralScore(input: {
  views: number | null;
  likes: number | null;
  comments: number | null;
  hoursSincePost: number;
  accountMedianPerHour: number | null;
}): { score: number | null; isProxy: boolean } {
  return scoreFn(input);
}

export async function buildTrendFile(ctx: TrendSourceContext, sources: TrendSource[]): Promise<TrendFile> {
  const { trends, sources: statuses } = await collectTrends(sources, ctx);
  return TrendFile.parse({
    schemaVersion: 1,
    date: ctx.date,
    runId: ctx.runId,
    generatedAt: new Date().toISOString(),
    sources: statuses,
    trends,
  });
}

export interface AnalyzeOptions {
  runId: string;
  niche: string;
  model?: string;
  runner?: ClaudeRunner;
  maxItems?: number;
  recordPath?: string;
}

/**
 * trend-scout explains why the top trends work. Numbers and captions go in as untrusted data
 * (never media). A rejected run leaves analysis null; it never fails the trends run.
 */
export async function analyzeTrends(
  trends: Trend[],
  opts: AnalyzeOptions,
  logger: Logger,
): Promise<{ trends: Trend[]; ok: boolean; error: string | null }> {
  const pending = trends.filter((t) => t.analysis === null).slice(0, opts.maxItems ?? 10);
  if (pending.length === 0) return { trends, ok: true, error: null };
  const ids = new Set(pending.map((t) => t.id));
  const res = await runAgent({
    agent: 'trend-scout',
    runId: opts.runId,
    instruction: `Brand niche: ${opts.niche}. Analyse each trend in the data (by trendId). Only use the listed ids.`,
    data: [
      {
        label: 'trends',
        content: pending.map((t) => ({
          trendId: t.id,
          source: t.source,
          metrics: t.metrics,
          viralScore: t.viralScore,
          viralScoreIsProxy: t.viralScoreIsProxy,
          sampleSize: t.sampleSize,
          confidence: t.confidence,
          caption: t.captionText ? t.captionText.slice(0, 600) : null,
        })),
      },
    ],
    schema: TrendScoutOutput,
    validate: (out) =>
      out.analyses.filter((a) => !ids.has(a.trendId)).map((a) => `unknown trendId ${a.trendId}`),
    inputRefs: pending.map((t) => t.id),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.runner ? { runner: opts.runner } : {}),
    ...(opts.recordPath ? { recordPath: opts.recordPath } : {}),
  });
  if (!res.ok || !res.output) {
    logger.warn('trend analysis rejected; keeping trends without analysis', { error: res.record.error });
    return { trends, ok: false, error: res.record.error };
  }
  const byId = new Map(res.output.analyses.map((a) => [a.trendId, a.analysis]));
  return {
    trends: trends.map((t) =>
      t.analysis === null && byId.has(t.id) ? { ...t, analysis: byId.get(t.id) ?? null } : t,
    ),
    ok: true,
    error: null,
  };
}

export interface RunTrendsOptions {
  ctx: TrendSourceContext;
  sources: TrendSource[];
  dataDir: string;
  analyze?: Omit<AnalyzeOptions, 'runId' | 'niche'> | false;
}

/** Collect, analyse and write data/trends/<date>.json. */
export async function runTrends(opts: RunTrendsOptions): Promise<{ file: TrendFile; path: string }> {
  let file = await buildTrendFile(opts.ctx, opts.sources);
  if (opts.analyze !== false) {
    const analyzed = await analyzeTrends(
      file.trends,
      { ...(opts.analyze ?? {}), runId: opts.ctx.runId, niche: opts.ctx.niche },
      opts.ctx.logger,
    );
    file = TrendFile.parse({ ...file, trends: analyzed.trends });
  }
  const out = path.join(opts.dataDir, 'trends', `${opts.ctx.date}.json`);
  await writeJsonAtomic(out, file, TrendFile);
  return { file, path: out };
}

export { googleTrendsSource } from './googleTrends';
export { youtubeSource } from './youtube';
export { businessDiscoverySource } from './igBusinessDiscovery';
export { ownInsightsSource } from './ownInsights';
export { webSearchSource } from './webSearch';
