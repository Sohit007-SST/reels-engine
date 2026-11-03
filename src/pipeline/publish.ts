/**
 * Publish pipeline (spec 7.8). For every due queue item: kill switch -> mode -> bound approval ->
 * quota (stop at 90%) -> verified artifact -> REELS container (resumable) -> rupload -> status
 * polling -> kill switch re-check -> PUBLISH_REQUESTED -> media_publish -> ledger + PUBLISHED.
 *
 * Crash safety: every side effect is preceded or followed by an atomic queue/ledger write, and an
 * item that ever reached PUBLISH_REQUESTED is only resolved by remote evidence (reconcile) —
 * never by a second media_publish. dry_run performs no Instagram write and no queue transition.
 */
import path from 'node:path';
import { z } from 'zod';
import { applyWritePolicy, loadConfig, type Config } from '../config';
import type { InstagramClient } from '../instagram/client';
import {
  CONTAINER_TTL_MS,
  DOCUMENTED_QUOTA_TOTAL,
  STATUS_POLL_INTERVAL_MS,
  STATUS_POLL_MAX_MS,
} from '../instagram/client';
import { istDate } from '../lib/time';
import { createLogger, type Logger } from '../lib/logger';
import { readJsonOrNull, writeJsonAtomic } from '../lib/store';
import type { QueueItem, QueueState } from '../schemas/queue';
import type { TelegramClient } from '../telegram/index';
import { processTelegramUpdates } from '../telegram/commands';
import { createApproval, findValidPublishApproval, setTelegramMessageId } from '../state/approvals';
import { fetchVerified, type ArtifactStore } from '../state/artifacts';
import { assertNotPaused, PausedError, pauseState } from '../state/control';
import { appendLedger, hasEventSinceContainer, readLedger } from '../state/ledger';
import type { DataPaths } from '../state/paths';
import { listQueueItems, readQueueItem, recordFailure, transitionItem } from '../state/queue';
import { RunSummary } from '../state/schemas';
import { buildRuntime, isEntryPoint } from '../state/runtime';
import { learningApplier } from './learn';

export type PublishMode = 'dry_run' | 'approval' | 'auto';

export interface PublishDeps {
  paths: DataPaths;
  instagram: InstagramClient | null;
  telegram: TelegramClient | null;
  ownerChatId?: string | null;
  artifacts: ArtifactStore;
  publishMode: PublishMode;
  replyMode?: 'off' | 'approval' | 'auto';
  learningMode?: 'propose' | 'bounded_auto';
  configPaused?: boolean;
  runId: string;
  logger?: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollMaxMs?: number;
  /** Stop publishing when quota usage reaches this fraction (spec: 90%). */
  quotaStop?: number;
  /** Approval TTL in hours (default: until 6 h after the slot, min 12 h). */
  approvalTtlHours?: number;
  captionFor?: (item: QueueItem) => Promise<string>;
  thumbOffsetMsFor?: (item: QueueItem) => Promise<number>;
  /** Poll Telegram for approval callbacks / commands at the start of the run (default true). */
  pollTelegram?: boolean;
}

export const OVERDUE_RECHECK_MS = 6 * 3_600_000;
export const QUOTA_STOP = 0.9;
const MAX_STEPS = 10;
export const MAX_ATTEMPTS_PER_STATE = 3;
const ACTIVE: readonly QueueState[] = [
  'QA_PASSED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'CONTAINER_CREATED',
  'UPLOADED',
  'READY',
  'PUBLISH_REQUESTED',
  'EXPIRED',
];

class StopRun extends Error {}

/** Default caption source: data/specs/<reelId>.json (ReelSpec.caption). */
async function defaultCaption(paths: DataPaths, item: QueueItem): Promise<string> {
  const spec = await readJsonOrNull(
    path.join(paths.specsDir, `${item.reelId}.json`),
    z.looseObject({ caption: z.string() }),
  );
  if (!spec) throw new Error(`caption missing: data/specs/${item.reelId}.json not found`);
  return spec.caption;
}

const DryPreviews = z.object({ schemaVersion: z.literal(1), sent: z.record(z.string(), z.string()) });

export async function runPublish(deps: PublishDeps): Promise<RunSummary> {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? createLogger({ runId: deps.runId, stage: 'publish' });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dry = deps.publishMode === 'dry_run';
  const startedAt = now();
  const summary: RunSummary = {
    schemaVersion: 1,
    runId: deps.runId,
    kind: 'publish',
    date: istDate(startedAt),
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    dryRun: dry,
    published: [],
    wouldPublish: [],
    lateStarts: [],
    needsReview: [],
    quota: null,
    repliesPosted: 0,
    errors: [],
    warnings: [],
  };
  const ctx = (extra: Record<string, unknown> = {}) => ({
    publishMode: deps.publishMode,
    runId: deps.runId,
    now: now(),
    ...extra,
  });
  const guard = async (): Promise<void> => {
    try {
      await assertNotPaused(deps.paths, deps.configPaused ?? false);
    } catch (err) {
      if (err instanceof PausedError) throw new StopRun(err.message);
      throw err;
    }
  };
  const alert = async (text: string): Promise<void> => {
    if (!deps.telegram) return;
    try {
      await deps.telegram.notify(text);
    } catch (err) {
      summary.warnings.push(`telegram notify failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const captionFor = deps.captionFor ?? ((i: QueueItem) => defaultCaption(deps.paths, i));
  const thumbFor = deps.thumbOffsetMsFor ?? (async () => 1000);

  // 0. Approvals / commands that arrived since the last run (owner only, replay-safe).
  if (deps.telegram && deps.ownerChatId && deps.pollTelegram !== false) {
    try {
      const r = await processTelegramUpdates({
        paths: deps.paths,
        telegram: deps.telegram,
        ownerChatId: deps.ownerChatId,
        modes: {
          publish: deps.publishMode,
          reply: deps.replyMode ?? 'approval',
          learning: deps.learningMode ?? 'propose',
        },
        configPaused: deps.configPaused ?? false,
        now,
        logger: log,
        applyLearningProposal: learningApplier(deps.paths, undefined, now),
      });
      summary.errors.push(...r.errors);
    } catch (err) {
      summary.warnings.push(`telegram polling failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 1. Kill switch before the job.
  const ps = await pauseState(deps.paths, deps.configPaused ?? false);
  if (ps.paused) {
    summary.warnings.push(`paused: ${ps.reason ?? 'kill switch'}; nothing published`);
    summary.finishedAt = now().toISOString();
    return summary;
  }

  const listed = await listQueueItems(deps.paths);
  for (const e of listed.errors)
    summary.errors.push(`queue file ${path.basename(e.file)} invalid: ${e.error}`);
  const items = listed.items.filter((i) => ACTIVE.includes(i.state));
  items.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  // Quota (read-only GET; allowed in dry_run).
  let quotaUsed = 0;
  let quotaTotal: number | null = null;
  if (deps.instagram) {
    try {
      const q = await deps.instagram.getPublishingLimit();
      quotaUsed = q.quotaUsage;
      quotaTotal = q.quotaTotal ?? DOCUMENTED_QUOTA_TOTAL;
      summary.quota = { used: quotaUsed, limit: quotaTotal };
    } catch (err) {
      summary.warnings.push(
        `publishing limit unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    summary.warnings.push('Instagram client not configured (keys MISSING); live steps skipped');
  }
  const quotaOk = (): boolean =>
    quotaTotal !== null && quotaUsed < (deps.quotaStop ?? QUOTA_STOP) * quotaTotal;

  const pushPublished = (item: QueueItem, permalink: string | null): void => {
    const lateStart = summary.lateStarts.some((l) => l.reelId === item.reelId);
    summary.published.push({
      reelId: item.reelId,
      at: now().toISOString(),
      placement: item.placement,
      permalink,
      lateStart,
    });
  };

  const needsReview = async (item: QueueItem, why: string): Promise<void> => {
    await transitionItem(deps.paths, item.reelId, 'NEEDS_REVIEW', { ...ctx(), error: why });
    await appendLedger(deps.paths, item.reelId, 'needs_review', {
      detail: why,
      runId: deps.runId,
      now: now(),
    });
    summary.needsReview.push(item.reelId);
    await alert(`NEEDS_REVIEW ${item.reelId}: ${why}`);
  };

  /** Remote evidence only. Returns true when resolved (PUBLISHED or NEEDS_REVIEW). */
  const reconcile = async (item: QueueItem): Promise<void> => {
    const ig = deps.instagram;
    const ledger = await readLedger(deps.paths, item.reelId);
    if (ledger?.mediaId) {
      await transitionItem(deps.paths, item.reelId, 'PUBLISHED', {
        ...ctx(),
        note: 'reconciled from ledger mediaId',
      });
      pushPublished(item, ledger.permalink);
      return;
    }
    if (!ig || !item.containerId)
      return needsReview(item, 'publish requested but no client/container to reconcile');
    let status: string;
    try {
      status = (await ig.getContainerStatus(item.containerId)).statusCode;
    } catch (err) {
      return needsReview(
        item,
        `reconcile: container status unavailable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const caption = await captionFor(item).catch(() => null);
    const since = Date.parse(ledger?.publishRequestedAt ?? item.updatedAt) - 10 * 60_000;
    let match: { id: string; permalink: string | null } | null = null;
    try {
      const recent = await ig.getRecentMedia(10);
      match =
        recent.find((m) => caption !== null && m.caption === caption && Date.parse(m.timestamp) >= since) ??
        null;
    } catch {
      /* treated as unclear below */
    }
    if (match) {
      await appendLedger(deps.paths, item.reelId, 'reconciled', {
        detail: `container ${status}; found in recent media`,
        patch: {
          mediaId: match.id,
          permalink: match.permalink,
          publishedAt: now().toISOString(),
          confirmedVia: 'recent_media',
        },
        runId: deps.runId,
        now: now(),
      });
      await transitionItem(deps.paths, item.reelId, 'PUBLISHED', {
        ...ctx(),
        note: 'reconciled via recent media',
      });
      pushPublished(item, match.permalink);
      await alert(`Published (reconciled) ${item.reelId}: ${match.permalink ?? match.id}`);
      return;
    }
    return needsReview(
      item,
      `publish outcome unclear (container ${status}, not in recent media); not retrying`,
    );
  };

  const processItem = async (start: QueueItem): Promise<void> => {
    let item: QueueItem | null = start;
    for (let step = 0; step < MAX_STEPS && item; step++) {
      const t = now();
      const due = Date.parse(item.scheduledAt) <= t.getTime();
      const s: QueueState = item.state;
      if (s === 'PUBLISH_REQUESTED') {
        if (dry) return;
        await reconcile(item);
        return;
      }
      if (s === 'QA_PASSED' || s === 'AWAITING_APPROVAL') {
        if (dry) {
          if (s === 'QA_PASSED') await dryPreview(item);
          if (due) summary.wouldPublish.push(item.reelId);
          return;
        }
        if (s === 'QA_PASSED' && deps.publishMode === 'auto') {
          await guard();
          item = await transitionItem(deps.paths, item.reelId, 'APPROVED', { ...ctx(), note: 'auto mode' });
          continue;
        }
        if (s === 'QA_PASSED') {
          await requestApproval(item);
          return;
        }
        // AWAITING_APPROVAL: decided via Telegram callbacks (processed above); still waiting.
        return;
      }
      if (!due && s === 'APPROVED') return;
      if (dry) {
        // Read-only: verify the artifact hash so the dry run proves it would be publishable.
        const v = await fetchVerified(deps.artifacts, item.artifact, t);
        if (!v.ok) summary.warnings.push(`${item.reelId}: artifact ${v.reason} (${v.detail})`);
        else if (due) summary.wouldPublish.push(item.reelId);
        return;
      }
      if (!deps.instagram) return;
      const ig = deps.instagram;

      // Approval still valid (approval mode) — bound to artifact hash + caption version + expiry.
      if (deps.publishMode === 'approval' && s !== 'EXPIRED') {
        const ok = await findValidPublishApproval(deps.paths, item, t);
        if (!ok) {
          item = await transitionItem(deps.paths, item.reelId, 'EXPIRED', {
            ...ctx(),
            error: 'approval missing or expired',
          });
          continue;
        }
      }

      if (s === 'EXPIRED') {
        await guard();
        const v = await fetchVerified(deps.artifacts, item.artifact, t);
        if (!v.ok) {
          await transitionItem(deps.paths, item.reelId, 'SKIPPED', {
            ...ctx(),
            error: `artifact ${v.reason}: ${v.detail}`,
          });
          await alert(`Skipped ${item.reelId}: artifact ${v.reason}`);
          return;
        }
        const approved =
          deps.publishMode === 'auto' || (await findValidPublishApproval(deps.paths, item, t)) !== null;
        if (!approved) {
          await askApproval(item, v.path, 'approval expired; asking again');
          return;
        }
        item = await transitionItem(deps.paths, item.reelId, 'APPROVED', {
          ...ctx(),
          containerId: null,
          note: 'recreate container from hash-matching artifact',
        });
        continue;
      }

      if (s === 'APPROVED') {
        const late = t.getTime() - Date.parse(item.scheduledAt);
        if (late > 15 * 60_000 && step === 0)
          summary.lateStarts.push({ reelId: item.reelId, minutesLate: Math.round(late / 60_000) });
        if (!quotaOk()) {
          summary.warnings.push(
            `quota guard: ${quotaUsed}/${quotaTotal ?? '?'} >= ${(deps.quotaStop ?? QUOTA_STOP) * 100}%; stopping`,
          );
          await alert(
            `Publishing quota guard hit (${quotaUsed}/${quotaTotal ?? '?'}). Remaining items wait.`,
          );
          throw new StopRun('quota');
        }
        const v = await fetchVerified(deps.artifacts, item.artifact, t);
        if (!v.ok) {
          const to = v.reason === 'hash_mismatch' ? 'FAILED' : 'SKIPPED';
          await transitionItem(deps.paths, item.reelId, to, {
            ...ctx(),
            error: `artifact ${v.reason}: ${v.detail}`,
          });
          await alert(`${to} ${item.reelId}: artifact ${v.reason}`);
          return;
        }
        if (late > OVERDUE_RECHECK_MS)
          summary.warnings.push(`${item.reelId}: >6h overdue; re-checked approval and artifact`);
        const caption = await captionFor(item);
        await guard();
        const c = await ig.createReelContainer({
          caption,
          thumbOffsetMs: await thumbFor(item),
          placement: item.placement,
        });
        await appendLedger(deps.paths, item.reelId, 'container_created', {
          detail: c.containerId,
          patch: {
            containerId: c.containerId,
            containerCreatedAt: now().toISOString(),
            artifactSha256: item.artifact?.sha256 ?? null,
          },
          runId: deps.runId,
          now: now(),
        });
        item = await transitionItem(deps.paths, item.reelId, 'CONTAINER_CREATED', {
          ...ctx(),
          containerId: c.containerId,
        });
        continue;
      }

      const ledger = await readLedger(deps.paths, item.reelId);
      const createdAt = Date.parse(ledger?.containerCreatedAt ?? item.updatedAt);
      if (t.getTime() - createdAt >= CONTAINER_TTL_MS) {
        item = await transitionItem(deps.paths, item.reelId, 'EXPIRED', {
          ...ctx(),
          error: 'container older than 24h',
        });
        continue;
      }
      const containerId = item.containerId;
      if (!containerId) return needsReview(item, `state ${s} without containerId`);

      if (s === 'CONTAINER_CREATED') {
        const v = await fetchVerified(deps.artifacts, item.artifact, t);
        if (!v.ok) {
          item = await transitionItem(deps.paths, item.reelId, 'EXPIRED', {
            ...ctx(),
            error: `artifact ${v.reason}`,
          });
          continue;
        }
        // Reconcile first: an upload that finished before a crash is not repeated.
        const st = await ig.getContainerStatus(containerId);
        if (st.statusCode === 'EXPIRED' || st.statusCode === 'ERROR') {
          item = await transitionItem(
            deps.paths,
            item.reelId,
            st.statusCode === 'EXPIRED' ? 'EXPIRED' : 'FAILED',
            {
              ...ctx(),
              error: `container ${st.statusCode}: ${st.status ?? ''}`,
            },
          );
          continue;
        }
        if (!(st.statusCode === 'FINISHED' || hasEventSinceContainer(ledger, 'upload_finished'))) {
          await guard();
          await appendLedger(deps.paths, item.reelId, 'upload_started', { runId: deps.runId, now: now() });
          await ig.uploadResumable(containerId, v.path);
          await appendLedger(deps.paths, item.reelId, 'upload_finished', {
            patch: { uploadedAt: now().toISOString() },
            runId: deps.runId,
            now: now(),
          });
        }
        item = await transitionItem(deps.paths, item.reelId, 'UPLOADED', ctx());
        continue;
      }

      if (s === 'UPLOADED') {
        const interval = deps.pollIntervalMs ?? STATUS_POLL_INTERVAL_MS;
        const deadline = t.getTime() + (deps.pollMaxMs ?? STATUS_POLL_MAX_MS);
        for (;;) {
          const st = await ig.getContainerStatus(containerId);
          if (st.statusCode === 'FINISHED') {
            item = await transitionItem(deps.paths, item.reelId, 'READY', ctx());
            break;
          }
          if (st.statusCode === 'PUBLISHED') {
            // Should be impossible before a publish request: never publish again, ask the owner.
            return needsReview(item, 'container already PUBLISHED before a publish request');
          }
          if (st.statusCode === 'EXPIRED' || st.statusCode === 'ERROR') {
            item = await transitionItem(
              deps.paths,
              item.reelId,
              st.statusCode === 'EXPIRED' ? 'EXPIRED' : 'FAILED',
              {
                ...ctx(),
                error: `container ${st.statusCode}: ${st.status ?? ''}`,
              },
            );
            if (st.statusCode === 'ERROR') return;
            break;
          }
          if (now().getTime() + interval > deadline) {
            await recordFailure(
              deps.paths,
              item.reelId,
              'container still IN_PROGRESS after polling window',
              now(),
            );
            summary.warnings.push(`${item.reelId}: container not FINISHED yet; will continue next run`);
            return;
          }
          await sleep(interval);
        }
        continue;
      }

      if (s === 'READY') {
        if (hasEventSinceContainer(ledger, 'publish_requested')) {
          // Crash after the ledger write: never publish again; reconcile.
          item = await transitionItem(deps.paths, item.reelId, 'PUBLISH_REQUESTED', {
            ...ctx(),
            note: 'ledger shows earlier publish request',
          });
          continue;
        }
        if (!quotaOk()) throw new StopRun('quota');
        await guard(); // step 6: kill switch re-check right before the publish write
        item = await transitionItem(deps.paths, item.reelId, 'PUBLISH_REQUESTED', {
          ...ctx(),
          expectFrom: ['READY'],
        });
        await appendLedger(deps.paths, item.reelId, 'publish_requested', {
          patch: { publishRequestedAt: now().toISOString() },
          runId: deps.runId,
          now: now(),
        });
        let mediaId: string;
        try {
          mediaId = (await ig.publishContainer(containerId)).mediaId;
        } catch (err) {
          log.warn('media_publish failed; reconciling', {
            reelId: item.reelId,
            error: err instanceof Error ? err.message : String(err),
          });
          await reconcile(item);
          return;
        }
        quotaUsed += 1;
        let permalink: string | null = null;
        try {
          permalink = await ig.getMediaPermalink(mediaId);
        } catch {
          /* permalink is optional evidence */
        }
        await appendLedger(deps.paths, item.reelId, 'publish_confirmed', {
          detail: mediaId,
          patch: {
            mediaId,
            permalink,
            publishedAt: now().toISOString(),
            confirmedVia: 'media_publish_response',
          },
          runId: deps.runId,
          now: now(),
        });
        await transitionItem(deps.paths, item.reelId, 'PUBLISHED', ctx());
        pushPublished(item, permalink);
        await alert(`Published ${item.reelId}: ${permalink ?? mediaId}`);
        return;
      }
      return;
    }
  };

  const askApproval = async (item: QueueItem, videoPath: string, note: string): Promise<void> => {
    if (!deps.telegram) {
      summary.warnings.push(`${item.reelId}: approval needed but Telegram is not configured`);
      return;
    }
    const caption = await captionFor(item);
    const ttl =
      deps.approvalTtlHours ??
      Math.max(12, (Date.parse(item.scheduledAt) + OVERDUE_RECHECK_MS - now().getTime()) / 3_600_000);
    const approval = await createApproval(deps.paths, {
      reelId: item.reelId,
      kind: 'publish',
      artifactSha256: item.artifact?.sha256 ?? null,
      captionVersion: item.captionVersion,
      ttlHours: ttl,
      now: now(),
    });
    await transitionItem(deps.paths, item.reelId, 'AWAITING_APPROVAL', {
      ...ctx(),
      approvalId: approval.id,
      containerId: null,
      note,
    });
    const r = await deps.telegram.sendPreview({ videoPath, caption, reelId: item.reelId, approval });
    await setTelegramMessageId(deps.paths, approval, r.messageId);
  };

  const requestApproval = async (item: QueueItem): Promise<void> => {
    const v = await fetchVerified(deps.artifacts, item.artifact, now());
    if (!v.ok) {
      summary.warnings.push(`${item.reelId}: cannot request approval, artifact ${v.reason}`);
      return;
    }
    await askApproval(item, v.path, 'preview sent for approval');
  };

  const dryPreview = async (item: QueueItem): Promise<void> => {
    if (!deps.telegram) return;
    const file = path.join(deps.paths.telegramDir, 'dry-run-previews.json');
    const sent = (await readJsonOrNull(file, DryPreviews)) ?? { schemaVersion: 1 as const, sent: {} };
    const key = `${item.reelId}:${item.artifact?.sha256 ?? ''}:${item.captionVersion}`;
    if (sent.sent[key]) return;
    const v = await fetchVerified(deps.artifacts, item.artifact, now());
    if (!v.ok) return;
    try {
      // DRY RUN label, no buttons (approval null) — notification-only.
      await deps.telegram.sendPreview({
        videoPath: v.path,
        caption: await captionFor(item),
        reelId: item.reelId,
        approval: null,
      });
      await writeJsonAtomic(
        file,
        { ...sent, sent: { ...sent.sent, [key]: now().toISOString() } },
        DryPreviews,
      );
    } catch (err) {
      summary.warnings.push(`dry-run preview failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  for (const it of items) {
    try {
      const fresh = await readQueueItem(deps.paths, it.reelId);
      if (fresh) await processItem(fresh);
    } catch (err) {
      if (err instanceof StopRun) {
        summary.warnings.push(`run stopped: ${err.message}`);
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push(`${it.reelId}: ${msg}`);
      log.error('publish item failed', { reelId: it.reelId, error: msg });
      try {
        const cur = await readQueueItem(deps.paths, it.reelId);
        if (cur && cur.state !== 'PUBLISH_REQUESTED') {
          const f = await recordFailure(deps.paths, it.reelId, msg, now());
          if (f.attempts >= MAX_ATTEMPTS_PER_STATE) {
            const to: QueueState = f.state === 'APPROVED' ? 'FAILED' : 'NEEDS_REVIEW';
            await transitionItem(deps.paths, it.reelId, to, {
              ...ctx(),
              error: `${f.attempts} failed attempts: ${msg}`.slice(0, 300),
            });
            if (to === 'NEEDS_REVIEW') summary.needsReview.push(it.reelId);
            await alert(`${to} ${it.reelId} after ${f.attempts} failed attempts`);
          }
        }
      } catch {
        /* dead letter is best effort; the batch continues */
      }
    }
  }
  summary.finishedAt = now().toISOString();
  const parsed = RunSummary.parse(summary);
  await writeJsonAtomic(path.join(deps.paths.runsDir, `${deps.runId}.json`), parsed, RunSummary);
  if (summary.needsReview.length || summary.errors.length) {
    log.warn('publish run finished with issues', {
      needsReview: summary.needsReview.length,
      errors: summary.errors.length,
    });
  }
  return parsed;
}

export async function main(cfg: Config = loadConfig()): Promise<number> {
  applyWritePolicy(cfg);
  const rt = buildRuntime(cfg, 'publish');
  const s = await runPublish({
    paths: rt.paths,
    instagram: rt.instagram,
    telegram: rt.telegram,
    ownerChatId: rt.ownerChatId,
    artifacts: rt.artifacts,
    publishMode: cfg.settings.publishMode,
    replyMode: cfg.settings.replyMode,
    learningMode: cfg.settings.learningMode,
    configPaused: cfg.settings.pipelinePaused,
    runId: rt.runId,
    logger: rt.logger,
  });
  s.warnings.push(...rt.skipped);
  rt.logger.info('publish run done', {
    dryRun: s.dryRun,
    published: s.published.length,
    wouldPublish: s.wouldPublish.length,
    needsReview: s.needsReview.length,
    errors: s.errors.length,
  });
  return s.errors.length ? 1 : 0;
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      createLogger({ stage: 'publish' }).error('publish crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    },
  );
}
