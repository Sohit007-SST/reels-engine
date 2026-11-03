/**
 * Engage (spec 7.10). Fetch new comments on reels published in the last 7 days, let the
 * community-manager draft replies (comments are UNTRUSTED data), and post at most 15 replies
 * per run — never two to the same comment. REPLY_MODE: off | approval (Telegram) | auto.
 * Only replying is allowed: no hiding, deleting, DMs or likes. dry_run never posts.
 *
 * Never-twice guarantee: a record is set to "posting" (atomic write) BEFORE the reply call.
 * A crash after that leaves it "posting", which is never retried (marked failed for review).
 */
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { applyWritePolicy, loadConfig, type Config } from '../config';
import type { IgComment, InstagramClient } from '../instagram/client';
import { createLogger, type Logger } from '../lib/logger';
import { updateJsonAtomic } from '../lib/store';
import { istDate } from '../lib/time';
import type { TelegramClient } from '../telegram/index';
import { createApproval, setTelegramMessageId } from '../state/approvals';
import { pauseState } from '../state/control';
import { readLedger } from '../state/ledger';
import type { DataPaths } from '../state/paths';
import { listQueueItems } from '../state/queue';
import { readReplyIndex, replyPayloadHash, updateReplyIndex, updateRequests } from '../state/replies';
import { EngageDay, type ReplyRecord } from '../state/schemas';
import { buildRuntime, isEntryPoint } from '../state/runtime';

export const MAX_REPLIES_PER_RUN = 15;
export const ENGAGE_WINDOW_DAYS = 7;
export const MAX_REPLY_CHARS = 300;

export const DraftedReply = z.object({
  commentId: z.string().min(1),
  action: z.enum(['reply', 'skip', 'flag']),
  reply: z.string().nullable(),
  topicRequest: z.string().nullable(),
});
export type DraftedReply = z.infer<typeof DraftedReply>;

export type ReplyDrafter = (input: {
  reelId: string;
  caption: string | null;
  comments: IgComment[];
}) => Promise<DraftedReply[]>;

export interface EngageDeps {
  paths: DataPaths;
  instagram: InstagramClient | null;
  telegram: TelegramClient | null;
  replyMode: 'off' | 'approval' | 'auto';
  publishMode: 'dry_run' | 'approval' | 'auto';
  configPaused?: boolean;
  runId: string;
  drafter: ReplyDrafter;
  now?: () => Date;
  logger?: Logger;
  maxReplies?: number;
}

export interface EngageResult {
  fetched: number;
  drafted: number;
  posted: number;
  skipped: number;
  requestsAdded: number;
  errors: string[];
}

const LINK_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|ly|me|in)\b)/i;
const PART2_RE = /\bpart\s*(2|two|ii)\b/i;

/** Last-line safety filter on drafts (the drafter is a model; never trust it blindly). */
export function replyProblem(text: string | null): string | null {
  if (!text || !text.trim()) return 'empty draft';
  if (text.length > MAX_REPLY_CHARS) return 'draft too long';
  if (LINK_RE.test(text)) return 'draft contains a link';
  if (/@[a-z0-9._]{2,}/i.test(text)) return 'draft mentions an account';
  return null;
}

export async function runEngage(deps: EngageDeps): Promise<EngageResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? createLogger({ runId: deps.runId, stage: 'engage' });
  const res: EngageResult = { fetched: 0, drafted: 0, posted: 0, skipped: 0, requestsAdded: 0, errors: [] };
  const max = Math.min(deps.maxReplies ?? MAX_REPLIES_PER_RUN, MAX_REPLIES_PER_RUN);
  const dry = deps.publishMode === 'dry_run';

  if (deps.replyMode !== 'off' && deps.instagram) {
    const ig = deps.instagram;
    const cutoff = now().getTime() - ENGAGE_WINDOW_DAYS * 86_400_000;
    const { items } = await listQueueItems(deps.paths);
    const index = await readReplyIndex(deps.paths);
    for (const item of items.filter((i) => i.state === 'PUBLISHED')) {
      const ledger = await readLedger(deps.paths, item.reelId);
      if (!ledger?.mediaId || !ledger.publishedAt || Date.parse(ledger.publishedAt) < cutoff) continue;
      try {
        const comments = (await ig.getComments(ledger.mediaId)).filter(
          (c) => c.parentId === null && !index.records[c.id],
        );
        res.fetched += comments.length;
        if (!comments.length) continue;
        const drafts = await deps.drafter({ reelId: item.reelId, caption: null, comments });
        const byId = new Map(drafts.map((d) => [d.commentId, d]));
        const at = now().toISOString();
        const newRecs: Record<string, ReplyRecord> = {};
        const reqs: Array<{ text: string; kind: 'part2' | 'topic'; commentId: string }> = [];
        for (const c of comments) {
          const d = byId.get(c.id);
          let status: ReplyRecord['status'] = 'skipped';
          let reason: string | null = d ? (d.action === 'reply' ? null : d.action) : 'no draft';
          if (d?.action === 'reply') {
            const p = replyProblem(d.reply);
            if (p) reason = p;
            else status = 'drafted';
          }
          if (status === 'drafted') res.drafted++;
          else res.skipped++;
          if (d?.topicRequest) {
            reqs.push({
              text: d.topicRequest.slice(0, 200),
              kind: PART2_RE.test(c.text) || PART2_RE.test(d.topicRequest) ? 'part2' : 'topic',
              commentId: c.id,
            });
          }
          newRecs[c.id] = {
            commentId: c.id,
            reelId: item.reelId,
            mediaId: ledger.mediaId,
            status,
            reason,
            draft: status === 'drafted' ? d!.reply : null,
            replyId: null,
            approvalId: null,
            seenAt: at,
            updatedAt: at,
          };
        }
        // Merge: a record that already exists (concurrent run) is never overwritten.
        await updateReplyIndex(deps.paths, (idx) => ({ ...idx, records: { ...newRecs, ...idx.records } }));
        Object.assign(index.records, newRecs);
        if (reqs.length) {
          await updateRequests(deps.paths, (r) => {
            const known = new Set(r.requests.map((x) => x.commentId));
            const add = reqs
              .filter((x) => !known.has(x.commentId))
              .map((x) => ({
                id: `req-${randomBytes(4).toString('hex')}`,
                text: x.text,
                kind: x.kind,
                reelId: item.reelId,
                commentId: x.commentId,
                at,
                used: false,
              }));
            res.requestsAdded += add.length;
            return { ...r, requests: [...r.requests, ...add] };
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.errors.push(`${item.reelId}: ${msg}`);
        log.warn('engage: comments failed', { reelId: item.reelId, error: msg });
      }
    }

    // Approval requests for fresh drafts (approval mode).
    const idx = await readReplyIndex(deps.paths);
    if (deps.replyMode === 'approval' && deps.telegram?.sendApprovalRequest) {
      for (const rec of Object.values(idx.records).filter((r) => r.status === 'drafted')) {
        try {
          const a = await createApproval(deps.paths, {
            reelId: rec.reelId,
            kind: 'reply',
            versionHash: replyPayloadHash(rec),
            ttlHours: 48,
            note: rec.commentId,
            now: now(),
          });
          await updateReplyIndex(deps.paths, (i) => {
            const cur = i.records[rec.commentId];
            if (!cur || cur.status !== 'drafted') return i;
            return {
              ...i,
              records: {
                ...i.records,
                [rec.commentId]: {
                  ...cur,
                  status: 'awaiting_approval',
                  approvalId: a.id,
                  updatedAt: now().toISOString(),
                },
              },
            };
          });
          const m = await deps.telegram.sendApprovalRequest(
            `Reply draft for ${rec.reelId}:\n\n${rec.draft ?? ''}`,
            a,
          );
          await setTelegramMessageId(deps.paths, a, m.messageId);
        } catch (err) {
          res.errors.push(
            `approval request ${rec.commentId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Post: approved (approval mode) or drafted (auto mode). Never in dry_run, never when paused.
    const postable = Object.values((await readReplyIndex(deps.paths)).records).filter((r) =>
      deps.replyMode === 'auto' ? r.status === 'drafted' || r.status === 'approved' : r.status === 'approved',
    );
    // Stale "posting" records from a crashed run: outcome unknown -> never retried.
    for (const r of Object.values((await readReplyIndex(deps.paths)).records).filter(
      (x) => x.status === 'posting',
    )) {
      await setStatus(
        deps.paths,
        r.commentId,
        'posting',
        { status: 'failed', reason: 'crash during posting; not retried (check manually)' },
        now(),
      );
    }
    if (!dry) {
      for (const r of postable) {
        if (res.posted >= max) break;
        if ((await pauseState(deps.paths, deps.configPaused ?? false)).paused) {
          res.errors.push('paused: replies stopped');
          break;
        }
        const claimed = await setStatus(deps.paths, r.commentId, r.status, { status: 'posting' }, now());
        if (!claimed) continue; // another run took it
        try {
          const { replyId } = await ig.replyToComment(r.commentId, r.draft ?? '');
          await setStatus(deps.paths, r.commentId, 'posting', { status: 'posted', replyId }, now());
          res.posted++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await setStatus(
            deps.paths,
            r.commentId,
            'posting',
            { status: 'failed', reason: msg.slice(0, 200) },
            now(),
          );
          res.errors.push(`reply ${r.commentId}: ${msg}`);
        }
      }
    }
  }

  const day = istDate(now());
  await updateJsonAtomic(path.join(deps.paths.engageDir, `${day}.json`), EngageDay, (cur) => {
    const base = cur ?? { schemaVersion: 1 as const, date: day, runs: [] };
    return {
      ...base,
      runs: [
        ...base.runs,
        {
          runId: deps.runId,
          at: now().toISOString(),
          replyMode: deps.replyMode,
          ...res,
          errors: res.errors.slice(0, 20),
        },
      ],
    };
  });
  return res;
}

/** Compare-and-swap on one reply record. Returns false when the record was not in `from`. */
async function setStatus(
  paths: DataPaths,
  commentId: string,
  from: ReplyRecord['status'],
  patch: Partial<ReplyRecord>,
  now: Date,
): Promise<boolean> {
  let ok = false;
  await updateReplyIndex(paths, (idx) => {
    const cur = idx.records[commentId];
    if (!cur || cur.status !== from) return idx;
    ok = true;
    return {
      ...idx,
      records: { ...idx.records, [commentId]: { ...cur, ...patch, updatedAt: now.toISOString() } },
    };
  });
  return ok;
}

/** Production drafter: the community-manager agent; comments go in as untrusted data. */
export function agentDrafter(runId: string): ReplyDrafter {
  return async ({ reelId, caption, comments }) => {
    const { runAgent } = await import('../claude/runAgent');
    const r = await runAgent({
      agent: 'community-manager',
      runId,
      instruction: `Draft replies for new comments on reel ${reelId}. Follow your output contract exactly.`,
      data: [
        { label: 'reel_caption', content: caption ?? '' },
        { label: 'comments', content: comments.map((c) => ({ commentId: c.id, text: c.text })) },
      ],
      schema: z.object({ replies: z.array(DraftedReply) }),
    });
    return r.ok && r.output ? r.output.replies : [];
  };
}

export async function main(cfg: Config = loadConfig()): Promise<number> {
  applyWritePolicy(cfg);
  const rt = buildRuntime(cfg, 'engage');
  const r = await runEngage({
    paths: rt.paths,
    instagram: rt.instagram,
    telegram: rt.telegram,
    replyMode: cfg.settings.replyMode,
    publishMode: cfg.settings.publishMode,
    configPaused: cfg.settings.pipelinePaused,
    runId: rt.runId,
    drafter: agentDrafter(rt.runId),
    logger: rt.logger,
  });
  rt.logger.info('engage done', {
    fetched: r.fetched,
    drafted: r.drafted,
    posted: r.posted,
    errors: r.errors.length,
  });
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (err: unknown) => {
      createLogger({ stage: 'engage' }).error('engage crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    },
  );
}
