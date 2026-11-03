/**
 * Instagram Graph API client (T6.2) — Instagram API with Facebook Login only.
 *
 * Docs read 2026-11-03 (see progress/CAPABILITIES.md, C03–C11):
 *  - https://developers.facebook.com/docs/instagram-platform/content-publishing
 *      POST /{ig-user-id}/media (media_type=REELS, upload_type=resumable, caption, trial_params)
 *      POST https://rupload.facebook.com/ig-api-upload/{version}/{container-id}
 *           headers: Authorization: OAuth <token>, offset, file_size; body = bytes
 *      GET /{container-id}?fields=status_code  (IN_PROGRESS|FINISHED|PUBLISHED|ERROR|EXPIRED)
 *           poll about once per minute for no more than 5 minutes
 *      POST /{ig-user-id}/media_publish (creation_id); containers expire after 24 h
 *      is_ai_generated=true (AI self-disclosure on the container)
 *  - .../reference/ig-user/media: thumb_offset (ms), share_to_feed, trial_params.graduation_strategy
 *      MANUAL | SS_PERFORMANCE
 *  - .../reference/ig-user/content_publishing_limit: fields quota_usage, config{quota_total,quota_duration}
 *  - .../reference/instagram-media/insights: Reels metrics; unavailable data => empty set (not 0)
 *  - .../reference/ig-media/comments (top-level only, max 50 per query) and ig-comment/replies (message)
 *  - Graph API changelog: latest version v26.0 (2026-07-29)
 *  - Re-verified 2026-11-03 by build-publish: content_publishing_limit config.quota_total=50 per
 *    quota_duration=86400; ig-comment/replies POST message (top-level comments only).
 *
 * Every call goes through src/lib/http.ts. Reads retry transient errors (bounded); writes
 * (container, upload, publish, reply) use retry:false — callers reconcile remote state instead.
 */
import { promises as fs } from 'node:fs';
import { httpRequest, type HttpRequestOptions } from '../lib/http';
import { classifyError, HttpError, type ErrorClass } from '../lib/retry';
import { METRIC_NAMES, type MetricValues } from '../schemas';

export interface InstagramClientConfig {
  graphVersion: string;
  igUserId: string;
  pageAccessToken: string;
  /** Override for tests. */
  baseUrl?: string;
  /** Override for tests. */
  ruploadBaseUrl?: string;
  timeoutMs?: number;
}

export type ContainerStatusCode = 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';

export interface CreateReelContainerInput {
  caption: string;
  thumbOffsetMs: number;
  placement: 'main' | 'trial';
  /** Any AI-disclosure field the docs offer (capability C10), e.g. { is_ai_generated: true }. */
  aiDisclosure?: Record<string, unknown>;
}

export interface PublishingLimit {
  quotaUsage: number;
  quotaTotal: number | null;
}

export interface IgComment {
  id: string;
  text: string;
  username: string | null;
  timestamp: string;
  parentId: string | null;
}

export interface DiscoveredMedia {
  id: string;
  caption: string | null;
  likeCount: number | null;
  commentsCount: number | null;
  viewCount: number | null;
  timestamp: string;
  permalink: string | null;
  mediaProductType: string | null;
  mediaType: string | null;
}

export interface BusinessDiscoveryResult {
  username: string;
  followersCount: number | null;
  mediaCount: number | null;
  media: DiscoveredMedia[];
}

export interface InstagramClient {
  createReelContainer(
    input: CreateReelContainerInput,
  ): Promise<{ containerId: string; uploadUri: string | null }>;
  uploadResumable(containerId: string, filePath: string): Promise<void>;
  getContainerStatus(
    containerId: string,
  ): Promise<{ statusCode: ContainerStatusCode; status: string | null }>;
  publishContainer(containerId: string): Promise<{ mediaId: string }>;
  getMediaPermalink(mediaId: string): Promise<string | null>;
  getPublishingLimit(): Promise<PublishingLimit>;
  getRecentMedia(
    limit: number,
  ): Promise<Array<{ id: string; timestamp: string; permalink: string | null; caption: string | null }>>;
  getReelInsights(mediaId: string): Promise<{ values: MetricValues; unavailable: string[] }>;
  getComments(mediaId: string, since?: string): Promise<IgComment[]>;
  replyToComment(commentId: string, message: string): Promise<{ replyId: string }>;
  businessDiscovery(username: string, mediaLimit: number): Promise<BusinessDiscoveryResult>;
  getAccountInfo(): Promise<{ id: string; username: string | null; followersCount: number | null }>;
}

// ----------------------------------------------------------------- error classification

/** rupload answered 200 without success; `retriable` comes from debug_info. */
export class UploadFailedError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
    this.name = 'UploadFailedError';
  }
}

/** Documented default (content_publishing_limit config.quota_total, read 2026-11-03). */
export const DOCUMENTED_QUOTA_TOTAL = 50;
/** Docs: query container status once per minute, for no more than 5 minutes. */
export const STATUS_POLL_INTERVAL_MS = 60_000;
export const STATUS_POLL_MAX_MS = 5 * 60_000;
/** Docs: containers not published within 24 hours expire. */
export const CONTAINER_TTL_MS = 24 * 3_600_000;

export type GraphErrorCategory =
  'auth' | 'permission' | 'rate_limit' | 'transient' | 'invalid' | 'unsupported' | 'not_found' | 'unknown';

export interface GraphErrorInfo {
  category: GraphErrorCategory;
  errorClass: ErrorClass;
  code: number | null;
  subcode: number | null;
  status: number | null;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002]);
const AUTH_CODES = new Set([102, 190, 463, 467]);
const PERMISSION_CODES = new Set([10, 200, 299]);

/** Classify a Graph API failure. Rate limits and is_transient errors are transient; the rest permanent. */
export function classifyGraphError(err: unknown): GraphErrorInfo {
  if (!(err instanceof HttpError)) {
    const cls = classifyError(err);
    return {
      category: cls === 'transient' ? 'transient' : 'unknown',
      errorClass: cls,
      code: null,
      subcode: null,
      status: null,
    };
  }
  let code: number | null = null;
  let subcode: number | null = null;
  let isTransient = false;
  try {
    const body = JSON.parse(err.options.body ?? '') as {
      error?: { code?: number; error_subcode?: number; is_transient?: boolean };
    };
    code = typeof body.error?.code === 'number' ? body.error.code : null;
    subcode = typeof body.error?.error_subcode === 'number' ? body.error.error_subcode : null;
    isTransient = body.error?.is_transient === true;
  } catch {
    /* non-JSON body */
  }
  const base = { code, subcode, status: err.status };
  if (code !== null && RATE_LIMIT_CODES.has(code))
    return { ...base, category: 'rate_limit', errorClass: 'transient' };
  if (err.status === 429) return { ...base, category: 'rate_limit', errorClass: 'transient' };
  if (isTransient || code === 1 || code === 2)
    return { ...base, category: 'transient', errorClass: 'transient' };
  if ((code !== null && AUTH_CODES.has(code)) || err.status === 401)
    return { ...base, category: 'auth', errorClass: 'permanent' };
  if ((code !== null && PERMISSION_CODES.has(code)) || err.status === 403)
    return { ...base, category: 'permission', errorClass: 'permanent' };
  if (err.status === 404 || code === 803) return { ...base, category: 'not_found', errorClass: 'permanent' };
  if (err.status === 501 || code === 3) return { ...base, category: 'unsupported', errorClass: 'permanent' };
  if (err.status >= 500) return { ...base, category: 'transient', errorClass: 'transient' };
  if (code === 100 || err.status === 400) return { ...base, category: 'invalid', errorClass: 'permanent' };
  return { ...base, category: 'unknown', errorClass: 'permanent' };
}

// ----------------------------------------------------------------- implementation

const STATUS_CODES: readonly ContainerStatusCode[] = [
  'EXPIRED',
  'ERROR',
  'FINISHED',
  'IN_PROGRESS',
  'PUBLISHED',
];

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function createInstagramClient(cfg: InstagramClientConfig): InstagramClient {
  if (!/^v\d+\.\d+$/.test(cfg.graphVersion)) throw new Error('invalid Graph API version');
  if (!cfg.igUserId || !cfg.pageAccessToken)
    throw new Error('Instagram client needs IG_USER_ID and a page token');
  const base = `${cfg.baseUrl ?? 'https://graph.facebook.com'}/${cfg.graphVersion}`;
  const rupload = `${cfg.ruploadBaseUrl ?? 'https://rupload.facebook.com'}/ig-api-upload/${cfg.graphVersion}`;
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const token = cfg.pageAccessToken;
  const ig = encodeURIComponent(cfg.igUserId);

  const readOpts = (purpose: string): HttpRequestOptions => ({
    provider: 'instagram',
    purpose,
    timeoutMs,
    retry: { maxAttempts: 3, deadlineMs: 60_000, classify: (e) => classifyGraphError(e).errorClass },
  });

  async function get<T>(
    pathAndQuery: string,
    purpose: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const qs = new URLSearchParams({ ...params, access_token: token });
    const res = await httpRequest(`${base}/${pathAndQuery}?${qs.toString()}`, {
      ...readOpts(purpose),
      method: 'GET',
    });
    return res.json<T>();
  }

  /** Non-idempotent write: one attempt only; callers reconcile on failure. */
  async function post<T>(pathName: string, purpose: string, params: Record<string, string>): Promise<T> {
    const body = new URLSearchParams({ ...params, access_token: token });
    const res = await httpRequest(`${base}/${pathName}`, {
      method: 'POST',
      provider: 'instagram',
      purpose,
      timeoutMs,
      retry: false,
      body,
    });
    return res.json<T>();
  }

  return {
    async createReelContainer(input) {
      const params: Record<string, string> = {
        media_type: 'REELS',
        upload_type: 'resumable',
        caption: input.caption,
        thumb_offset: String(Math.max(0, Math.round(input.thumbOffsetMs))),
      };
      if (input.placement === 'trial') {
        params.trial_params = JSON.stringify({ graduation_strategy: 'SS_PERFORMANCE' });
      } else {
        params.share_to_feed = 'true';
      }
      for (const [k, v] of Object.entries(input.aiDisclosure ?? {})) {
        if (!/^[a-z_]{1,40}$/.test(k)) continue;
        params[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      const r = await post<{ id?: unknown; uri?: unknown }>(`${ig}/media`, 'create_container', params);
      const id = str(r.id);
      if (!id) throw new Error('create container: response had no id');
      return { containerId: id, uploadUri: str(r.uri) };
    },

    async uploadResumable(containerId, filePath) {
      const bytes = new Uint8Array(await fs.readFile(filePath));
      const res = await httpRequest(`${rupload}/${encodeURIComponent(containerId)}`, {
        method: 'POST',
        provider: 'instagram',
        purpose: 'rupload',
        timeoutMs: Math.max(timeoutMs, 180_000),
        retry: false,
        headers: {
          Authorization: `OAuth ${token}`,
          offset: '0',
          file_size: String(bytes.byteLength),
        },
        body: bytes,
      });
      const j = await res.json<{
        success?: unknown;
        message?: unknown;
        debug_info?: { retriable?: unknown; type?: unknown };
      }>();
      if (j.success !== true) {
        const t = str(j.debug_info?.type) ?? 'unknown';
        throw new UploadFailedError(
          `rupload did not report success (${t})`,
          j.debug_info?.retriable === true,
        );
      }
    },

    async getContainerStatus(containerId) {
      const r = await get<{ status_code?: unknown; status?: unknown }>(
        encodeURIComponent(containerId),
        'container_status',
        { fields: 'status_code,status' },
      );
      const sc = str(r.status_code);
      if (!sc || !STATUS_CODES.includes(sc as ContainerStatusCode)) {
        throw new Error(`unexpected container status_code: ${sc ?? 'missing'}`);
      }
      return { statusCode: sc as ContainerStatusCode, status: str(r.status) };
    },

    async publishContainer(containerId) {
      const r = await post<{ id?: unknown }>(`${ig}/media_publish`, 'media_publish', {
        creation_id: containerId,
      });
      const id = str(r.id);
      if (!id) throw new Error('media_publish: response had no id');
      return { mediaId: id };
    },

    async getMediaPermalink(mediaId) {
      const r = await get<{ permalink?: unknown }>(encodeURIComponent(mediaId), 'permalink', {
        fields: 'permalink',
      });
      return str(r.permalink);
    },

    async getPublishingLimit() {
      const r = await get<{ data?: Array<{ quota_usage?: unknown; config?: { quota_total?: unknown } }> }>(
        `${ig}/content_publishing_limit`,
        'publishing_limit',
        { fields: 'quota_usage,config' },
      );
      const row = r.data?.[0];
      const usage = num(row?.quota_usage);
      if (usage === null) throw new Error('content_publishing_limit: quota_usage missing');
      return { quotaUsage: usage, quotaTotal: num(row?.config?.quota_total) };
    },

    async getRecentMedia(limit) {
      const r = await get<{ data?: Array<Record<string, unknown>> }>(`${ig}/media`, 'recent_media', {
        fields: 'id,timestamp,permalink,caption,media_product_type',
        limit: String(Math.min(Math.max(1, limit), 50)),
      });
      return (r.data ?? [])
        .filter((m) => typeof m.id === 'string')
        .map((m) => ({
          id: m.id as string,
          timestamp: str(m.timestamp) ?? '',
          permalink: str(m.permalink),
          caption: str(m.caption),
        }));
    },

    async getReelInsights(mediaId) {
      type Row = { name?: unknown; values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } };
      const values = Object.fromEntries(METRIC_NAMES.map((m) => [m, null])) as MetricValues;
      const parse = (rows: Row[]) => {
        for (const row of rows) {
          const name = str(row.name);
          if (!name || !(METRIC_NAMES as readonly string[]).includes(name)) continue;
          const v = num(row.values?.[0]?.value) ?? num(row.total_value?.value);
          (values as Record<string, number | null>)[name] = v !== null && v >= 0 ? v : null;
        }
      };
      const path = `${encodeURIComponent(mediaId)}/insights`;
      try {
        const r = await get<{ data?: Row[] }>(path, 'insights', { metric: METRIC_NAMES.join(',') });
        parse(r.data ?? []);
      } catch (err) {
        // One unsupported metric fails the whole request: fall back to one metric per call.
        if (classifyGraphError(err).category !== 'invalid') throw err;
        for (const m of METRIC_NAMES) {
          try {
            const r = await get<{ data?: Row[] }>(path, `insights:${m}`, { metric: m });
            parse(r.data ?? []);
          } catch (inner) {
            if (classifyGraphError(inner).category !== 'invalid') throw inner;
          }
        }
      }
      const unavailable = METRIC_NAMES.filter((m) => values[m] === null);
      return { values, unavailable };
    },

    async getComments(mediaId, since) {
      const r = await get<{ data?: Array<Record<string, unknown>> }>(
        `${encodeURIComponent(mediaId)}/comments`,
        'comments',
        // Docs: top-level comments only, max 50 per query, newest first; `from` expands to id+username.
        { fields: 'id,text,timestamp,from{id,username}' },
      );
      const sinceMs = since ? Date.parse(since) : null;
      return (r.data ?? [])
        .filter((c) => typeof c.id === 'string' && typeof c.text === 'string')
        .map((c) => ({
          id: c.id as string,
          text: c.text as string,
          username: str((c.from as Record<string, unknown> | undefined)?.username),
          timestamp: str(c.timestamp) ?? '',
          parentId: null,
        }))
        .filter((c) => sinceMs === null || Date.parse(c.timestamp) > sinceMs);
    },

    async replyToComment(commentId, message) {
      const r = await post<{ id?: unknown }>(`${encodeURIComponent(commentId)}/replies`, 'comment_reply', {
        message,
      });
      const id = str(r.id);
      if (!id) throw new Error('reply: response had no id');
      return { replyId: id };
    },

    async businessDiscovery(username, mediaLimit) {
      if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) throw new Error('invalid username');
      const n = Math.min(Math.max(1, mediaLimit), 50);
      const fields = `business_discovery.username(${username}){username,followers_count,media_count,media.limit(${n}){id,caption,like_count,comments_count,timestamp,permalink,media_product_type,media_type}}`;
      const r = await get<{ business_discovery?: Record<string, unknown> }>(ig, 'business_discovery', {
        fields,
      });
      const bd = r.business_discovery ?? {};
      const media = ((bd.media as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? []).map(
        (m) => ({
          id: String(m.id),
          caption: str(m.caption),
          likeCount: num(m.like_count),
          commentsCount: num(m.comments_count),
          viewCount: num(m.view_count),
          timestamp: str(m.timestamp) ?? '',
          permalink: str(m.permalink),
          mediaProductType: str(m.media_product_type),
          mediaType: str(m.media_type),
        }),
      );
      return {
        username: str(bd.username) ?? username,
        followersCount: num(bd.followers_count),
        mediaCount: num(bd.media_count),
        media,
      };
    },

    async getAccountInfo() {
      const r = await get<{ id?: unknown; username?: unknown; followers_count?: unknown }>(
        ig,
        'account_info',
        {
          fields: 'id,username,followers_count',
        },
      );
      return {
        id: str(r.id) ?? cfg.igUserId,
        username: str(r.username),
        followersCount: num(r.followers_count),
      };
    },
  };
}
