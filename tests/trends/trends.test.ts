import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/lib/logger';
import { setFetchImpl } from '../../src/lib/http';
import {
  businessDiscoverySource,
  collectTrends,
  googleTrendsSource,
  youtubeSource,
} from '../../src/trends/index';
import { parseGoogleTrendsRss } from '../../src/trends/googleTrends';
import {
  accountMedian,
  confidenceFor,
  scoreAccountPosts,
  viralScore,
  type RawPost,
} from '../../src/trends/score';
import type { TrendSource } from '../../src/trends/index';

const now = new Date('2026-11-03T06:00:00Z');
const ctx = {
  runId: 'r',
  date: '2026-11-03',
  niche: 'what if science',
  now,
  logger: createLogger({ stage: 'test' }),
};
const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss"><channel><title>Daily Search Trends</title>
<item><title>solar eclipse</title><ht:approx_traffic>200000+</ht:approx_traffic><link>https://trends.google.com/trending/rss?geo=IN</link><pubDate>Mon, 2 Nov 2026 20:00:00 -0800</pubDate></item>
<item><title>chandrayaan</title><ht:approx_traffic>50000+</ht:approx_traffic><pubDate>Mon, 2 Nov 2026 19:00:00 -0800</pubDate></item>
</channel></rss>`;

const post = (i: number, over: Partial<RawPost> = {}): RawPost => ({
  externalId: `m${i}`,
  account: 'acct',
  permalink: null,
  postedAt: new Date(now.getTime() - (i + 1) * 86_400_000).toISOString(),
  caption: `post ${i}`,
  views: 1000 * (i + 1),
  likes: 100,
  comments: 10,
  followers: 5000,
  ...over,
});

describe('viral score (7.1)', () => {
  it('median only with >= 5 posts; missing metrics stay null, never 0', () => {
    expect(accountMedian([1, 2, 3, 4])).toBeNull();
    expect(accountMedian([1, 2, 3, 4, 5])).toBe(3);
    expect(
      viralScore({ views: null, likes: null, comments: null, hoursSincePost: 5, accountMedianPerHour: 1 })
        .score,
    ).toBeNull();
    expect(
      viralScore({ views: 100, likes: 1, comments: 1, hoursSincePost: 5, accountMedianPerHour: null }).score,
    ).toBeNull();
  });

  it('few posts -> no score and low confidence; enough posts -> score with sampleSize', () => {
    const few = scoreAccountPosts('ig_business_discovery', [post(0), post(1)], now);
    expect(few.every((t) => t.viralScore === null && t.confidence === 'low')).toBe(true);
    const many = scoreAccountPosts(
      'ig_business_discovery',
      Array.from({ length: 8 }, (_, i) => post(i)),
      now,
    );
    expect(many.length).toBeGreaterThan(0);
    expect(many.some((t) => typeof t.viralScore === 'number')).toBe(true);
    expect(many.every((t) => t.sampleSize === 8)).toBe(true);
    expect(confidenceFor(3, false, true)).toBe('low');
  });
});

describe('sources', () => {
  it('parses the Google Trends RSS feed and rejects other documents', () => {
    const t = parseGoogleTrendsRss(RSS, 'IN', now.toISOString());
    expect(t.map((x) => x.captionText)).toEqual(['solar eclipse', 'chandrayaan']);
    expect(t[0]!.metrics.views).toBeNull();
    expect(() => parseGoogleTrendsRss('<html>nope</html>', 'IN', now.toISOString())).toThrow();
  });

  it('one failing source is isolated; disabled sources are skipped (no key / capability not LIVE_VERIFIED)', async () => {
    const urls: string[] = [];
    const restore = setFetchImpl(async (input) => {
      urls.push(String(input));
      return new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    });
    try {
      const boom: TrendSource = {
        name: 'web_search',
        enabled: () => true,
        fetch: async () => {
          throw new Error('boom');
        },
      };
      const bd = businessDiscoverySource({
        watchlist: { schemaVersion: 1, accounts: [{ username: 'someone', confirmedByOwner: true }] } as never,
        igUserId: '1',
        accessToken: 'x',
        graphVersion: 'v99.0',
        capability: () => 'UNVERIFIED',
      });
      const res = await collectTrends(
        [googleTrendsSource(), boom, youtubeSource({ apiKey: undefined }), bd],
        ctx,
      );
      const st = Object.fromEntries(res.sources.map((s) => [s.source, s.status]));
      expect(st.google_trends).toBe('ok');
      expect(st.web_search).toBe('error');
      expect(st.youtube).toBe('skipped');
      expect(st.ig_business_discovery).toBe('skipped');
      expect(res.trends.length).toBe(2);
      expect(urls.every((u) => u.startsWith('https://trends.google.com/trending/rss?geo='))).toBe(true);
    } finally {
      restore();
    }
  });
});
