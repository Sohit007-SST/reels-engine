/**
 * Viral score (spec 7.1):
 *   rate  = view_count per hour since posting
 *           (or likes + 3 x comments per hour when views are missing, flagged as a proxy)
 *   score = rate / account median rate over its recent posts
 * The median is computed only when the account has >= 5 recent posts with a usable rate;
 * otherwise the score is null (unknown), never 0. Missing metrics stay null.
 */
import { shortHash } from '../lib/ids';
import { hoursBetween } from '../lib/time';
import type { Trend, TrendSourceName } from '../schemas';

export const MIN_POSTS_FOR_MEDIAN = 5;
export const RECENT_DAYS = 7;
export const TOP_OVERALL = 20;
export const TOP_PER_ACCOUNT = 3;

export interface EngagementInput {
  views: number | null;
  likes: number | null;
  comments: number | null;
  hoursSincePost: number;
}

/** Engagement per hour; null when the needed numbers are missing (never assumed 0). */
export function engagementRate(input: EngagementInput): { rate: number | null; isProxy: boolean } {
  const hours = Math.max(1, input.hoursSincePost);
  if (input.views !== null && Number.isFinite(input.views))
    return { rate: input.views / hours, isProxy: false };
  if (input.likes !== null && input.comments !== null) {
    return { rate: (input.likes + 3 * input.comments) / hours, isProxy: true };
  }
  return { rate: null, isProxy: true };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Median only with >= MIN_POSTS_FOR_MEDIAN usable rates. */
export function accountMedian(rates: Array<number | null>): number | null {
  const usable = rates.filter((r): r is number => r !== null && Number.isFinite(r));
  return usable.length >= MIN_POSTS_FOR_MEDIAN ? median(usable) : null;
}

export function viralScore(input: {
  views: number | null;
  likes: number | null;
  comments: number | null;
  hoursSincePost: number;
  accountMedianPerHour: number | null;
}): { score: number | null; isProxy: boolean } {
  const { rate, isProxy } = engagementRate(input);
  if (rate === null || input.accountMedianPerHour === null || input.accountMedianPerHour <= 0) {
    return { score: null, isProxy };
  }
  return { score: Math.round((rate / input.accountMedianPerHour) * 1000) / 1000, isProxy };
}

/** low < 5 posts behind the score, medium 5-9, high >= 10; a proxy score drops one level. */
export function confidenceFor(sampleSize: number, isProxy: boolean, hasScore: boolean): Trend['confidence'] {
  if (!hasScore || sampleSize < MIN_POSTS_FOR_MEDIAN) return 'low';
  const base = sampleSize >= 10 ? 'high' : 'medium';
  if (!isProxy) return base;
  return base === 'high' ? 'medium' : 'low';
}

export interface RawPost {
  /** Stable external id (media id, video id). */
  externalId: string;
  account: string;
  permalink: string | null;
  postedAt: string | null;
  caption: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  followers: number | null;
}

/**
 * Score one account's recent posts against that account's own median and return trends for
 * posts from the last RECENT_DAYS days. All posts (including older ones) form the median sample.
 */
export function scoreAccountPosts(
  source: TrendSourceName,
  posts: RawPost[],
  now: Date,
  capturedAt = now.toISOString(),
): Trend[] {
  const withRates = posts.map((p) => {
    const hours = p.postedAt ? hoursBetween(new Date(p.postedAt), now) : null;
    const er =
      hours === null || hours < 0
        ? { rate: null, isProxy: p.views === null }
        : engagementRate({ views: p.views, likes: p.likes, comments: p.comments, hoursSincePost: hours });
    return { p, hours, ...er };
  });
  const med = accountMedian(withRates.map((r) => r.rate));
  const sampleSize = withRates.filter((r) => r.rate !== null).length;
  return withRates
    .filter((r) => r.hours !== null && r.hours >= 0 && r.hours <= RECENT_DAYS * 24)
    .map(({ p, rate, isProxy }) => {
      const score = rate !== null && med !== null && med > 0 ? Math.round((rate / med) * 1000) / 1000 : null;
      return {
        schemaVersion: 1 as const,
        id: `${source}:${shortHash(`${p.account}:${p.externalId}`)}`,
        source,
        sourceRef: p.account,
        permalink: p.permalink,
        capturedAt,
        postedAt: p.postedAt,
        captionText: p.caption,
        metrics: { views: p.views, likes: p.likes, comments: p.comments, followers: p.followers },
        viralScore: score,
        viralScoreIsProxy: isProxy,
        sampleSize,
        confidence: confidenceFor(sampleSize, isProxy, score !== null),
        analysis: null,
      };
    });
}

function rateOf(t: Trend, now: Date): number {
  if (!t.postedAt) return -1;
  const r = engagementRate({
    views: t.metrics.views,
    likes: t.metrics.likes,
    comments: t.metrics.comments,
    hoursSincePost: hoursBetween(new Date(t.postedAt), now),
  }).rate;
  return r ?? -1;
}

/** Rank: viral score desc (null last), then raw engagement rate desc. */
export function rankTrends(trends: Trend[], now: Date): Trend[] {
  return [...trends].sort((a, b) => {
    const sa = a.viralScore ?? -1;
    const sb = b.viralScore ?? -1;
    if (sa !== sb) return sb - sa;
    return rateOf(b, now) - rateOf(a, now);
  });
}

/** Keep the top N overall plus the top K per account (sourceRef), preserving rank order. */
export function selectTop(
  trends: Trend[],
  now: Date,
  overall = TOP_OVERALL,
  perAccount = TOP_PER_ACCOUNT,
): Trend[] {
  const ranked = rankTrends(trends, now);
  const keep = new Set<string>(ranked.slice(0, overall).map((t) => t.id));
  const perAcc = new Map<string, number>();
  for (const t of ranked) {
    const key = `${t.source}:${t.sourceRef}`;
    const n = perAcc.get(key) ?? 0;
    if (n < perAccount) {
      keep.add(t.id);
      perAcc.set(key, n + 1);
    }
  }
  const seen = new Set<string>();
  return ranked.filter((t) => keep.has(t.id) && !seen.has(t.id) && seen.add(t.id));
}
