/**
 * Google Trends "Daily Search Trends" RSS (no key). URL checked 2026-11-03:
 *   https://trends.google.com/trending/rss?geo=IN  (RSS 2.0 + ht: namespace;
 *   items: title, ht:approx_traffic, pubDate, link, ht:news_item{_title,_url,_source})
 * Search terms are general (not reels), so metrics stay null and no viral score is computed.
 * Titles are untrusted text; they reach agents only inside <untrusted_data> blocks.
 */
import { XMLParser } from 'fast-xml-parser';
import { httpRequest } from '../lib/http';
import { shortHash } from '../lib/ids';
import type { Trend } from '../schemas';
import type { TrendSource, TrendSourceContext } from './index';

export const GOOGLE_TRENDS_RSS = 'https://trends.google.com/trending/rss';
export const MAX_GOOGLE_ITEMS = 20;

interface RssItem {
  title?: unknown;
  pubDate?: unknown;
  link?: unknown;
  'ht:approx_traffic'?: unknown;
  'ht:news_item'?: unknown;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

function toIso(d: string | null): string | null {
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Parse the RSS document into trends. Throws on a document that is not this feed. */
export function parseGoogleTrendsRss(xml: string, geo: string, capturedAt: string): Trend[] {
  const parser = new XMLParser({ ignoreAttributes: true, processEntities: true, htmlEntities: true });
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: RssItem | RssItem[] } } };
  const channel = doc.rss?.channel;
  if (!channel) throw new Error('google trends: response is not an RSS feed');
  const items = channel.item === undefined ? [] : Array.isArray(channel.item) ? channel.item : [channel.item];
  const out: Trend[] = [];
  for (const it of items.slice(0, MAX_GOOGLE_ITEMS)) {
    const title = str(it.title);
    if (!title) continue;
    const news = it['ht:news_item'];
    const firstNews = (Array.isArray(news) ? news[0] : news) as Record<string, unknown> | undefined;
    const newsTitle = firstNews ? str(firstNews['ht:news_item_title']) : null;
    out.push({
      schemaVersion: 1,
      id: `google_trends:${shortHash(`${geo}:${title.toLowerCase()}`)}`,
      source: 'google_trends',
      sourceRef: `geo:${geo}`,
      permalink: str(it.link),
      capturedAt,
      postedAt: toIso(str(it.pubDate)),
      captionText: newsTitle ? `${title} | ${newsTitle}` : title,
      metrics: { views: null, likes: null, comments: null, followers: null },
      viralScore: null,
      viralScoreIsProxy: false,
      sampleSize: 0,
      confidence: 'low',
      analysis: null,
    });
  }
  return out;
}

export function googleTrendsSource(opts: { geo?: string; enabled?: boolean } = {}): TrendSource {
  const geo = (opts.geo ?? 'IN').toUpperCase();
  if (!/^[A-Z]{2}$/.test(geo)) throw new Error('google trends geo must be a 2-letter country code');
  return {
    name: 'google_trends',
    enabled: () => opts.enabled !== false,
    async fetch(ctx: TrendSourceContext): Promise<Trend[]> {
      const res = await httpRequest(`${GOOGLE_TRENDS_RSS}?geo=${geo}`, {
        provider: 'google_trends',
        purpose: 'daily_trends_rss',
        timeoutMs: 15_000,
        retry: { maxAttempts: 2 },
        headers: { accept: 'application/rss+xml, application/xml;q=0.9' },
      });
      return parseGoogleTrendsRss(await res.text(), geo, ctx.now.toISOString());
    },
  };
}
