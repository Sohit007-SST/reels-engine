/**
 * The owner's own best reels as a trend source. The Instagram insights reader belongs to the
 * publish module (src/instagram/client.ts); this source takes it as an injected function so the
 * trends module never holds tokens. Disabled until C08 (Reels insights) is LIVE_VERIFIED and a
 * reader is supplied — with no keys yet, `npm run trends` reports it as skipped.
 */
import type { Trend } from '../schemas';
import { capabilityStatus, type CapabilityStatus } from './capabilities';
import { scoreAccountPosts, type RawPost } from './score';
import type { TrendSource, TrendSourceContext } from './index';

export const OWN_INSIGHTS_CAPABILITY_ID = 'C08';

export interface OwnReelMetrics {
  mediaId: string;
  permalink: string | null;
  postedAt: string | null;
  caption: string | null;
  /** null = metric not available for this account (never 0). */
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export type OwnInsightsReader = (ctx: TrendSourceContext) => Promise<OwnReelMetrics[]>;

export function ownInsightsSource(opts: {
  reader: OwnInsightsReader | null;
  handle?: string | null;
  capability?: () => CapabilityStatus;
}): TrendSource {
  const capability = opts.capability ?? (() => capabilityStatus(OWN_INSIGHTS_CAPABILITY_ID));
  return {
    name: 'own_insights',
    enabled: () => opts.reader !== null && capability() === 'LIVE_VERIFIED',
    async fetch(ctx) {
      if (!opts.reader) return [];
      const account = `own:${opts.handle ?? 'self'}`;
      const posts: RawPost[] = (await opts.reader(ctx)).map((m) => ({
        externalId: m.mediaId,
        account,
        permalink: m.permalink,
        postedAt: m.postedAt,
        caption: m.caption,
        views: m.views,
        likes: m.likes,
        comments: m.comments,
        followers: null,
      }));
      return scoreAccountPosts('own_insights', posts, ctx.now) satisfies Trend[];
    },
  };
}
