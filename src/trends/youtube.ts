/**
 * YouTube Data API v3 (optional, M9). Docs checked 2026-11-03:
 *   GET https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoDuration=short
 *       &order=viewCount&publishedAfter=<RFC3339>&maxResults<=50&q=...&key=...   (100 quota units)
 *   GET https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=a,b,c&key=... (1 unit)
 * Skipped (enabled() = false) when YOUTUBE_API_KEY is not set. Read-only GETs only.
 * Per channel a median is computed only with >= 5 videos in the result; otherwise score = null.
 */
import { getJson } from '../lib/http';
import type { Trend } from '../schemas';
import { scoreAccountPosts, type RawPost } from './score';
import type { TrendSource, TrendSourceContext } from './index';

const API = 'https://www.googleapis.com/youtube/v3';

interface SearchResponse {
  items?: Array<{ id?: { videoId?: string } }>;
}
interface VideosResponse {
  items?: Array<{
    id?: string;
    snippet?: { channelTitle?: string; channelId?: string; title?: string; publishedAt?: string };
    statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  }>;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null; // hidden / not returned => unknown, never 0
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Turn the niche description into a short search query. */
export function nicheQuery(niche: string): string {
  const stop = new Set(['the', 'and', 'of', 'a', 'an', 'in', 'on', 'for', 'to', 'with', 'what', 'if']);
  const words = niche
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
  return ['what if', ...new Set(words)].slice(0, 5).join(' ') + ' AI';
}

export function youtubeSource(opts: {
  apiKey: string | undefined;
  query?: string;
  regionCode?: string;
}): TrendSource {
  return {
    name: 'youtube',
    enabled: () => typeof opts.apiKey === 'string' && opts.apiKey.length > 0,
    async fetch(ctx: TrendSourceContext): Promise<Trend[]> {
      const key = opts.apiKey;
      if (!key) return [];
      const publishedAfter = new Date(ctx.now.getTime() - 7 * 86_400_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z');
      const q = new URLSearchParams({
        part: 'snippet',
        type: 'video',
        videoDuration: 'short',
        order: 'viewCount',
        publishedAfter,
        maxResults: '25',
        q: opts.query ?? nicheQuery(ctx.niche),
        key,
      });
      if (opts.regionCode) q.set('regionCode', opts.regionCode);
      const search = await getJson<SearchResponse>(`${API}/search?${q}`, {
        provider: 'youtube',
        purpose: 'search.list',
        retry: { maxAttempts: 2 },
      });
      const ids = (search.items ?? []).map((i) => i.id?.videoId).filter((x): x is string => !!x);
      if (ids.length === 0) return [];
      const v = new URLSearchParams({ part: 'statistics,snippet', id: ids.join(','), key });
      const videos = await getJson<VideosResponse>(`${API}/videos?${v}`, {
        provider: 'youtube',
        purpose: 'videos.list',
        retry: { maxAttempts: 2 },
      });
      const byChannel = new Map<string, RawPost[]>();
      for (const item of videos.items ?? []) {
        if (!item.id) continue;
        const channel = item.snippet?.channelId ?? item.snippet?.channelTitle ?? 'unknown';
        const post: RawPost = {
          externalId: item.id,
          account: `youtube:${channel}`,
          permalink: `https://www.youtube.com/shorts/${item.id}`,
          postedAt: item.snippet?.publishedAt ?? null,
          caption: item.snippet?.title ?? null,
          views: num(item.statistics?.viewCount),
          likes: num(item.statistics?.likeCount),
          comments: num(item.statistics?.commentCount),
          followers: null,
        };
        byChannel.set(channel, [...(byChannel.get(channel) ?? []), post]);
      }
      return [...byChannel.values()].flatMap((posts) => scoreAccountPosts('youtube', posts, ctx.now));
    },
  };
}
