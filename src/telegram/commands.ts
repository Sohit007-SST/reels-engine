/**
 * Telegram update processing: owner-only commands (/status /pause /resume /report) and
 * approval callbacks (publish, reply, learning). Run by every scheduled job that polls
 * (at least once a day — Telegram keeps unread updates only 24 h).
 *
 * Security: anything not from TELEGRAM_CHAT_ID is ignored and logged (sender id hashed).
 * Text from Telegram is data: only the exact command words are recognized.
 * Crash safety: the cursor is saved after processing; re-processing an update is harmless
 * because approvals are replay-safe and commands are idempotent.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { shortHash } from '../lib/ids';
import { createLogger, type Logger } from '../lib/logger';
import { readJsonOrNull, writeJsonAtomic } from '../lib/store';
import type { Approval } from '../schemas';
import { decideFromCallback, itemVersionHash, type DecisionResult } from '../state/approvals';
import { pauseState, readUsage, setPaused } from '../state/control';
import type { DataPaths } from '../state/paths';
import { listQueueItems, readQueueItem, transitionItem } from '../state/queue';
import {
  proposalPayloadHash,
  readProposal,
  readReplyIndex,
  replyPayloadHash,
  updateReplyIndex,
} from '../state/replies';
import { TelegramCursor } from '../state/schemas';
import type { TelegramClient, TelegramUpdate } from './index';

const execFileAsync = promisify(execFile);

export type SetRepoVariable = (name: 'PIPELINE_PAUSED', value: string) => Promise<void>;

/** `gh variable set` (a GitHub write: never called in dry_run). */
export const ghSetRepoVariable: SetRepoVariable = async (name, value) => {
  await execFileAsync('gh', ['variable', 'set', name, '--body', value], { timeout: 30_000 });
};

export interface CommandDeps {
  paths: DataPaths;
  telegram: TelegramClient;
  ownerChatId: string;
  modes: {
    publish: 'dry_run' | 'approval' | 'auto';
    reply: 'off' | 'approval' | 'auto';
    learning: 'propose' | 'bounded_auto';
  };
  configPaused: boolean;
  /** Called only outside dry_run. */
  setRepoVariable?: SetRepoVariable | null;
  /** Apply an approved learning proposal (wired by learn.ts / the pipelines). */
  applyLearningProposal?: (week: string, approval: Approval) => Promise<string>;
  now?: () => Date;
  logger?: Logger;
}

export interface ProcessResult {
  processed: number;
  ignoredUnauthorized: number;
  decisions: Array<{
    outcome: DecisionResult['outcome'];
    reelId: string | null;
    kind: Approval['kind'] | null;
  }>;
  commands: string[];
  errors: string[];
}

function cursorFile(paths: DataPaths): string {
  return path.join(paths.telegramDir, 'cursor.json');
}

export async function processTelegramUpdates(deps: CommandDeps): Promise<ProcessResult> {
  const now = deps.now ?? (() => new Date());
  const log = (deps.logger ?? createLogger({})).child({ stage: 'telegram', provider: 'telegram' });
  const result: ProcessResult = {
    processed: 0,
    ignoredUnauthorized: 0,
    decisions: [],
    commands: [],
    errors: [],
  };

  const cursor = await readJsonOrNull(cursorFile(deps.paths), TelegramCursor).catch(() => null);
  const updates = await deps.telegram.getUpdates(cursor?.offset);
  let maxId = cursor ? cursor.offset - 1 : -1;

  for (const u of updates) {
    maxId = Math.max(maxId, u.updateId);
    result.processed++;
    try {
      if (u.chatId !== deps.ownerChatId) {
        result.ignoredUnauthorized++;
        log.warn('ignored telegram update from a non-owner chat', {
          sender: shortHash(u.chatId, 8),
          kind: u.kind,
        });
        continue;
      }
      if (u.kind === 'callback') {
        const d = await handleCallback(deps, u, now());
        result.decisions.push({
          outcome: d.outcome,
          reelId: d.approval?.reelId ?? null,
          kind: d.approval?.kind ?? null,
        });
      } else if (u.text) {
        const cmd = await handleCommand(deps, u.text, now());
        if (cmd) result.commands.push(cmd);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`update ${u.updateId}: ${msg}`);
      log.error('telegram update failed', { err, updateId: u.updateId });
    }
  }
  if (maxId >= 0 && (!cursor || maxId + 1 > cursor.offset)) {
    await writeJsonAtomic(
      cursorFile(deps.paths),
      { schemaVersion: 1, offset: maxId + 1, updatedAt: now().toISOString() },
      TelegramCursor,
    );
  }
  return result;
}

async function currentVersionHash(paths: DataPaths, a: Approval): Promise<string | null> {
  if (a.kind === 'publish' || a.kind === 'live_test') {
    const item = await readQueueItem(paths, a.reelId);
    if (!item || item.state !== 'AWAITING_APPROVAL') return null;
    if (item.approvalId && item.approvalId !== a.id) return null;
    return itemVersionHash(item);
  }
  if (a.kind === 'reply') {
    const idx = await readReplyIndex(paths);
    const rec = Object.values(idx.records).find((r) => r.approvalId === a.id);
    if (!rec || rec.status !== 'awaiting_approval') return null;
    return replyPayloadHash(rec);
  }
  // learning: approval.note holds the week label
  const week = a.note ?? '';
  const p = /^\d{4}-\d{2}$/.test(week) ? await readProposal(paths, week) : null;
  if (!p || p.status !== 'proposed' || p.approvalId !== a.id) return null;
  return proposalPayloadHash(p);
}

async function handleCallback(deps: CommandDeps, u: TelegramUpdate, now: Date): Promise<DecisionResult> {
  const d = await decideFromCallback(deps.paths, {
    chatId: u.chatId,
    ownerChatId: deps.ownerChatId,
    callbackData: u.callbackData,
    now,
    currentVersionHash: (a) => currentVersionHash(deps.paths, a),
  });
  let reply = d.message;
  const a = d.approval;
  if (a && (d.outcome === 'approved' || d.outcome === 'rejected')) {
    if (a.kind === 'publish' || a.kind === 'live_test') {
      const to = d.outcome === 'approved' ? 'APPROVED' : 'REJECTED';
      await transitionItem(deps.paths, a.reelId, to, {
        publishMode: deps.modes.publish,
        expectFrom: ['AWAITING_APPROVAL'],
        approvalId: a.id,
        note: `owner ${d.outcome} via Telegram`,
        now,
      });
      reply =
        d.outcome === 'approved'
          ? `Approved ${a.reelId}. It will publish at its slot.`
          : `Rejected ${a.reelId}.`;
    } else if (a.kind === 'reply') {
      await updateReplyIndex(deps.paths, (idx) => {
        const entry = Object.entries(idx.records).find(([, r]) => r.approvalId === a.id);
        if (!entry) return idx;
        const [key, rec] = entry;
        return {
          ...idx,
          records: {
            ...idx.records,
            [key]: {
              ...rec,
              status: d.outcome === 'approved' ? 'approved' : 'rejected',
              updatedAt: now.toISOString(),
            },
          },
        };
      });
      reply = d.outcome === 'approved' ? 'Reply approved; it posts on the next run.' : 'Reply discarded.';
    } else if (a.kind === 'learning') {
      if (d.outcome === 'approved' && deps.applyLearningProposal && a.note) {
        reply = await deps.applyLearningProposal(a.note, a);
      } else {
        reply = d.outcome === 'approved' ? 'Learning proposal approved.' : 'Learning proposal rejected.';
      }
    }
  }
  if (u.callbackQueryId) {
    try {
      await deps.telegram.answerCallback(u.callbackQueryId, reply);
    } catch {
      /* acknowledging is best effort */
    }
  }
  return d;
}

async function handleCommand(deps: CommandDeps, text: string, now: Date): Promise<string | null> {
  const word = text.trim().split(/\s+/)[0]?.toLowerCase().replace(/@.*$/, '') ?? '';
  const dryRun = deps.modes.publish === 'dry_run';
  switch (word) {
    case '/status': {
      await deps.telegram.notify(await statusText(deps));
      return '/status';
    }
    case '/pause': {
      await setPaused(deps.paths, true, 'owner /pause via Telegram', 'owner', now);
      let extra = '';
      if (!dryRun && deps.setRepoVariable) {
        try {
          await deps.setRepoVariable('PIPELINE_PAUSED', 'true');
          extra = ' Repo variable PIPELINE_PAUSED=true set.';
        } catch {
          extra = ' (Could not set the repo variable; control.json is paused.)';
        }
      }
      await deps.telegram.notify(`Paused. No publishing or replies until /resume.${extra}`);
      return '/pause';
    }
    case '/resume': {
      await setPaused(deps.paths, false, 'owner /resume via Telegram', 'owner', now);
      let extra = '';
      if (!dryRun && deps.setRepoVariable) {
        try {
          await deps.setRepoVariable('PIPELINE_PAUSED', 'false');
          extra = ' Repo variable PIPELINE_PAUSED=false set.';
        } catch {
          extra = ' (Could not clear the repo variable PIPELINE_PAUSED; check it in GitHub.)';
        }
      } else if (deps.configPaused) {
        extra = ' Note: PIPELINE_PAUSED is still true in config.';
      }
      await deps.telegram.notify(`Resumed.${extra}`);
      return '/resume';
    }
    case '/report': {
      await deps.telegram.notify(await latestReportText(deps.paths));
      return '/report';
    }
    default:
      if (word.startsWith('/')) {
        await deps.telegram.notify('Commands: /status, /pause, /resume, /report');
        return 'help';
      }
      return null;
  }
}

export async function statusText(
  deps: Pick<CommandDeps, 'paths' | 'modes' | 'configPaused'>,
): Promise<string> {
  const { items } = await listQueueItems(deps.paths);
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.state, (counts.get(it.state) ?? 0) + 1);
  const pause = await pauseState(deps.paths, deps.configPaused);
  const usage = await readUsage(deps.paths);
  const quota = usage?.providers.instagram_publish;
  const lines = [
    `Status: ${pause.paused ? `PAUSED (${pause.reason ?? ''})` : 'running'}`,
    `Modes: publish=${deps.modes.publish}, replies=${deps.modes.reply}, learning=${deps.modes.learning}`,
    `Queue: ${[...counts.entries()].map(([k, v]) => `${k} ${v}`).join(', ') || 'empty'}`,
    `Instagram publish quota: ${quota ? `${quota.used} / ${quota.limit ?? 'unknown'}` : 'not measured'}`,
  ];
  const review = items.filter((i) => i.state === 'NEEDS_REVIEW').map((i) => i.reelId);
  if (review.length) lines.push(`NEEDS_REVIEW: ${review.join(', ')}`);
  return lines.join('\n');
}

export async function latestReportText(paths: DataPaths): Promise<string> {
  try {
    const names = (await fs.readdir(paths.reportsDir))
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .sort();
    const last = names.at(-1);
    if (!last) return 'No daily report yet.';
    const md = await fs.readFile(path.join(paths.reportsDir, last), 'utf8');
    return md.length > 3500 ? `${md.slice(0, 3500)}\n…(truncated)` : md;
  } catch {
    return 'No daily report yet.';
  }
}
