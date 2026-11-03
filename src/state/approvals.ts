/**
 * Bound, expiring, replay-safe approvals (spec 7.9, T7.3).
 *
 * - Each approval is bound to reelId + versionHash (short hash of artifact sha256 + caption
 *   version) + expiry, and carries a one-time nonce.
 * - Callback data: "<a|r>:<reelId>:<versionHash>:<nonce>:<expiryEpochMin>" (<= 64 bytes).
 * - A decision is accepted ONCE (the approval file is updated under its lock), only from the
 *   owner chat, only before expiry and only if it still matches the current queue item.
 * - Creating a new approval for the same reel + kind cancels earlier pending ones.
 * Files: data/approvals/<reelId>-<nonce>.json.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { shortHash } from '../lib/ids';
import { readJsonOrNull, updateJsonAtomic, writeJsonAtomic } from '../lib/store';
import { Approval } from '../schemas/approval';
import type { QueueItem } from '../schemas/queue';
import type { DataPaths } from './paths';

export const CALLBACK_MAX_BYTES = 64;
const VERSION_HASH_LEN = 10;

export type ApprovalKind = Approval['kind'];

/** Short hash binding an approval to an exact artifact + caption version. */
export function versionHashFor(artifactSha256: string | null, captionVersion: number | null): string {
  return shortHash(`${artifactSha256 ?? 'none'}:${captionVersion ?? 'none'}`, VERSION_HASH_LEN);
}

/** Version hash for a free-form payload (reply drafts, learning proposals). */
export function payloadHash(payload: string): string {
  return shortHash(`payload:${payload}`, VERSION_HASH_LEN);
}

export function itemVersionHash(item: Pick<QueueItem, 'artifact' | 'captionVersion'>): string {
  return versionHashFor(item.artifact?.sha256 ?? null, item.captionVersion);
}

export function approvalFile(paths: DataPaths, reelId: string, nonce: string): string {
  return path.join(paths.approvalsDir, `${reelId}-${nonce}.json`);
}

export async function listApprovals(paths: DataPaths, reelId?: string): Promise<Approval[]> {
  let names: string[];
  try {
    names = await fs.readdir(paths.approvalsDir);
  } catch {
    return [];
  }
  const out: Approval[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    if (reelId && !n.startsWith(`${reelId}-`)) continue;
    try {
      const a = await readJsonOrNull(path.join(paths.approvalsDir, n), Approval);
      if (a) out.push(a);
    } catch {
      /* unreadable approval files are ignored (and never count as approval) */
    }
  }
  return out;
}

export async function readApproval(
  paths: DataPaths,
  reelId: string,
  nonce: string,
): Promise<Approval | null> {
  try {
    return await readJsonOrNull(approvalFile(paths, reelId, nonce), Approval);
  } catch {
    return null;
  }
}

export interface CreateApprovalInput {
  reelId: string;
  kind: ApprovalKind;
  artifactSha256?: string | null;
  captionVersion?: number | null;
  /** For reply/learning approvals: hash of the exact payload being approved. */
  versionHash?: string;
  ttlHours: number;
  note?: string | null;
  now?: Date;
}

/** Create a pending approval; cancels earlier pending approvals of the same reel + kind. */
export async function createApproval(paths: DataPaths, input: CreateApprovalInput): Promise<Approval> {
  const now = input.now ?? new Date();
  await cancelPending(paths, input.reelId, input.kind, 'superseded by a newer approval request', now);
  const nonce = randomBytes(4).toString('hex');
  const approval: Approval = Approval.parse({
    schemaVersion: 1,
    id: `${input.reelId}-${nonce}`,
    reelId: input.reelId,
    kind: input.kind,
    artifactSha256: input.artifactSha256 ?? null,
    captionVersion: input.captionVersion ?? null,
    versionHash:
      input.versionHash ?? versionHashFor(input.artifactSha256 ?? null, input.captionVersion ?? null),
    nonce,
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlHours * 3_600_000).toISOString(),
    decision: 'pending',
    decidedAt: null,
    decidedBy: null,
    consumed: false,
    telegramMessageId: null,
    note: input.note ?? null,
  });
  await writeJsonAtomic(approvalFile(paths, input.reelId, nonce), approval, Approval);
  return approval;
}

/** Cancel every pending approval for a reel + kind (caption edited, reel regenerated, superseded). */
export async function cancelPending(
  paths: DataPaths,
  reelId: string,
  kind: ApprovalKind,
  note: string,
  now: Date = new Date(),
): Promise<number> {
  let n = 0;
  for (const a of await listApprovals(paths, reelId)) {
    if (a.kind !== kind || a.decision !== 'pending' || a.consumed) continue;
    await updateJsonAtomic(approvalFile(paths, reelId, a.nonce), Approval, (cur) => {
      if (!cur || cur.decision !== 'pending' || cur.consumed) return cur ?? a;
      const next: Approval = {
        ...cur,
        decision: 'cancelled',
        decidedAt: now.toISOString(),
        decidedBy: 'system',
        note,
      };
      return next;
    });
    n++;
  }
  return n;
}

export async function setTelegramMessageId(
  paths: DataPaths,
  approval: Approval,
  messageId: number,
): Promise<void> {
  await updateJsonAtomic(approvalFile(paths, approval.reelId, approval.nonce), Approval, (cur) => ({
    ...(cur ?? approval),
    telegramMessageId: messageId,
  }));
}

// ----------------------------------------------------------------- callback data

export interface ApprovalCallback {
  action: 'approve' | 'reject';
  reelId: string;
  versionHash: string;
  nonce: string;
  expiryEpochMin: number;
}

export function encodeCallback(approval: Approval, action: 'approve' | 'reject'): string {
  const expiryMin = Math.floor(Date.parse(approval.expiresAt) / 60_000);
  const data = `${action === 'approve' ? 'a' : 'r'}:${approval.reelId}:${approval.versionHash}:${approval.nonce}:${expiryMin}`;
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_MAX_BYTES) {
    throw new Error(`callback data exceeds ${CALLBACK_MAX_BYTES} bytes`);
  }
  return data;
}

const CALLBACK_RE = /^([ar]):(\d{4}-\d{2}-\d{2}-\d{2}):([0-9a-f]{6,16}):([0-9a-f]{6,16}):(\d{1,12})$/;

/** Strict parse; anything malformed or oversized returns null. */
export function decodeCallback(data: string | null | undefined): ApprovalCallback | null {
  if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > CALLBACK_MAX_BYTES) return null;
  const m = CALLBACK_RE.exec(data);
  if (!m) return null;
  return {
    action: m[1] === 'a' ? 'approve' : 'reject',
    reelId: m[2]!,
    versionHash: m[3]!,
    nonce: m[4]!,
    expiryEpochMin: Number(m[5]),
  };
}

// ----------------------------------------------------------------- decisions

export type DecisionOutcome =
  'approved' | 'rejected' | 'unauthorized' | 'malformed' | 'unknown' | 'expired' | 'stale' | 'duplicate';

export interface DecisionResult {
  outcome: DecisionOutcome;
  approval: Approval | null;
  message: string;
}

export interface DecideInput {
  chatId: string;
  ownerChatId: string;
  callbackData: string | null;
  now?: Date;
  /**
   * Current version hash of the thing being approved (queue item for publish approvals,
   * draft for replies, proposal for learning). null = item gone => stale.
   */
  currentVersionHash: (approval: Approval) => Promise<string | null>;
}

/**
 * Apply an owner decision from a Telegram callback. Order of checks: owner chat ->
 * format -> known approval -> replay (consumed) -> expiry -> version match. The
 * approval file is updated under its lock, so concurrent/duplicate callbacks are accepted once.
 */
export async function decideFromCallback(paths: DataPaths, input: DecideInput): Promise<DecisionResult> {
  const now = input.now ?? new Date();
  if (String(input.chatId) !== String(input.ownerChatId)) {
    return { outcome: 'unauthorized', approval: null, message: 'ignored: not the owner chat' };
  }
  const cb = decodeCallback(input.callbackData);
  if (!cb) return { outcome: 'malformed', approval: null, message: 'ignored: malformed callback' };
  const existing = await readApproval(paths, cb.reelId, cb.nonce);
  if (!existing) return { outcome: 'unknown', approval: null, message: 'unknown approval' };

  // Precompute the current version outside the lock (it may read other files).
  const current = await input.currentVersionHash(existing);

  let result: DecisionResult = { outcome: 'unknown', approval: null, message: '' };
  await updateJsonAtomic(approvalFile(paths, cb.reelId, cb.nonce), Approval, (cur) => {
    if (!cur) {
      result = { outcome: 'unknown', approval: null, message: 'unknown approval' };
      return existing;
    }
    if (cur.consumed || cur.decision !== 'pending') {
      result = { outcome: 'duplicate', approval: cur, message: `already ${cur.decision}` };
      return cur;
    }
    const cbExpiry = cb.expiryEpochMin * 60_000;
    const expired = now.getTime() >= Date.parse(cur.expiresAt) || now.getTime() >= cbExpiry;
    if (expired) {
      const next = {
        ...cur,
        decision: 'expired' as const,
        decidedAt: now.toISOString(),
        decidedBy: 'system' as const,
        consumed: true,
      };
      result = { outcome: 'expired', approval: next, message: 'approval expired' };
      return next;
    }
    if (cb.versionHash !== cur.versionHash || current === null || current !== cur.versionHash) {
      const next = {
        ...cur,
        decision: 'cancelled' as const,
        decidedAt: now.toISOString(),
        decidedBy: 'system' as const,
        consumed: true,
        note: 'stale: content changed since this preview',
      };
      result = {
        outcome: 'stale',
        approval: next,
        message: 'stale: the reel or caption changed; a fresh preview is needed',
      };
      return next;
    }
    const decision = cb.action === 'approve' ? ('approved' as const) : ('rejected' as const);
    const next = {
      ...cur,
      decision,
      decidedAt: now.toISOString(),
      decidedBy: 'owner' as const,
      consumed: true,
    };
    result = { outcome: decision, approval: next, message: decision };
    return next;
  });
  return result;
}

/** Is there an approved, unexpired approval that matches this queue item exactly? */
export async function findValidPublishApproval(
  paths: DataPaths,
  item: QueueItem,
  now: Date = new Date(),
): Promise<Approval | null> {
  if (!item.artifact) return null;
  const want = itemVersionHash(item);
  const all = await listApprovals(paths, item.reelId);
  const candidates = all.filter(
    (a) =>
      (a.kind === 'publish' || a.kind === 'live_test') &&
      a.decision === 'approved' &&
      a.decidedBy === 'owner' &&
      a.versionHash === want &&
      a.artifactSha256 === item.artifact!.sha256 &&
      a.captionVersion === item.captionVersion &&
      Date.parse(a.expiresAt) > now.getTime(),
  );
  if (item.approvalId) {
    const bound = candidates.find((a) => a.id === item.approvalId);
    if (bound) return bound;
  }
  return candidates[0] ?? null;
}
