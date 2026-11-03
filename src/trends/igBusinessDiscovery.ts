/**
 * Instagram Business Discovery (C07). DISABLED unless progress/CAPABILITIES.md shows C07
 * LIVE_VERIFIED (T1.6 / T6.1), the watchlist is owner-confirmed (M12), and the page token +
 * IG user id are present. Read-only GETs through the shared http wrapper; calls are spaced out
 * and each account fails in isolation (non-business, age-gated, erroring => skipped + reported).
 * Missing metrics (hidden likes, absent view_count) stay null, never 0. media_url is never
 * requested or downloaded.
 *
 * Request shape (Graph API, to re-verify against docs when C07 is checked):
 *   GET https://graph.facebook.com/<ver>/<IG_USER_ID>?fields=business_discovery.username(<u>)
 *       {followers_count,media_count,media.limit(25){id,caption,like_count,comments_count,
 *        view_count,timestamp,permalink,media_product_type,media_type}}&access_token=...
 */
import { getJson } from '../lib/http';
import type { Trend, Watchlist } from '../schemas';
import { capabilityStatus, type CapabilityStatus } from './capabilities';
import { scoreAccountPosts, type RawPost } from './score';
import type { TrendSource, TrendSourceContext } from './index';

export const BD_CAPABILITY_ID = 'C07';
export const BD_MEDIA_FIELDS =
  'id,caption,like_count,comments_count,view_count,timestamp,permalink,media_product_type,media_type';

interface BdMedia {
  id?: string;
  caption?: string;
  like_count?: number;
  comments_count?: number;
  view_count?: number;
  timestamp?: string;
  permalink?: string;
  media_product_type?: string;
  media_type?: string;
}
interface BdResponse {
  business_discovery?: {
    followers_count?: number;
    media_count?: number;
    media?: { data?: BdMedia[] };
  };
}

export interface BusinessDiscoveryOptions {
  watchlist: Watchlist;
  igUserId: string | undefined;
  accessToken: string | undefined;
  graphVersion: string | null;
  /** Injectable for tests; default reads progress/CAPABILITIES.md. */
  capability?: () => CapabilityStatus;
  /** Delay between accounts (default 1500 ms). */
  spacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxAccounts?: number;
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function mapBusinessDiscovery(username: string, body: BdResponse): RawPost[] {
  const bd = body.business_discovery;
  if (!bd) throw new Error('no business_discovery in response (not a business/creator account?)');
  const followers = n(bd.followers_count);
  return (bd.media?.data ?? [])
    .filter((m) => m.id && (m.media_product_type === 'REELS' || m.media_type === 'VIDEO'))
    .map((m) => ({
      externalId: m.id as string,
      account: username,
      permalink: m.permalink ?? null,
      postedAt: m.timestamp ? new Date(m.timestamp).toISOString() : null,
      caption: m.caption ?? null,
      views: n(m.view_count),
      likes: n(m.like_count),
      comments: n(m.comments_count),
      followers,
    }));
}

export function businessDiscoverySource(opts: BusinessDiscoveryOptions): TrendSource & { skipped: string[] } {
  const capability = opts.capability ?? (() => capabilityStatus(BD_CAPABILITY_ID));
  const accounts = () => opts.watchlist.accounts.filter((a) => a.confirmedByOwner);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const src = {
    name: 'ig_business_discovery' as const,
    skipped: [] as string[],
    enabled: () =>
      capability() === 'LIVE_VERIFIED' &&
      !!opts.igUserId &&
      !!opts.accessToken &&
      !!opts.graphVersion &&
      accounts().length > 0,
    async fetch(ctx: TrendSourceContext): Promise<Trend[]> {
      src.skipped = [];
      if (!src.enabled()) return [];
      const out: Trend[] = [];
      const list = accounts().slice(0, opts.maxAccounts ?? 20);
      for (const [i, acc] of list.entries()) {
        if (i > 0) await sleep(opts.spacingMs ?? 1500);
        const fields = `business_discovery.username(${acc.username}){followers_count,media_count,media.limit(25){${BD_MEDIA_FIELDS}}}`;
        const url = `https://graph.facebook.com/${opts.graphVersion}/${opts.igUserId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(opts.accessToken ?? '')}`;
        try {
          const body = await getJson<BdResponse>(url, {
            provider: 'instagram',
            purpose: 'business_discovery',
            retry: { maxAttempts: 2, baseDelayMs: 2000 },
          });
          out.push(
            ...scoreAccountPosts('ig_business_discovery', mapBusinessDiscovery(acc.username, body), ctx.now),
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          src.skipped.push(`${acc.username}: ${msg.slice(0, 160)}`);
          ctx.logger.warn('business discovery account skipped', { account: acc.username });
        }
      }
      return out;
    },
  };
  return src;
}
