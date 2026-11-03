/**
 * Comment-reply bookkeeping (data/engage/replies.json) and comment requests (data/requests.json).
 * The index holds one record per comment ever seen, which is what guarantees
 * "never two replies to the same comment".
 */
import path from 'node:path';
import { readJsonOrNull, updateJsonAtomic } from '../lib/store';
import { payloadHash } from './approvals';
import type { DataPaths } from './paths';
import { ProposalFile, ReplyIndex, RequestsFile, type ReplyRecord } from './schemas';

export function replyIndexFile(paths: DataPaths): string {
  return path.join(paths.engageDir, 'replies.json');
}

export async function readReplyIndex(paths: DataPaths): Promise<ReplyIndex> {
  return (await readJsonOrNull(replyIndexFile(paths), ReplyIndex)) ?? { schemaVersion: 1, records: {} };
}

export async function updateReplyIndex(
  paths: DataPaths,
  fn: (idx: ReplyIndex) => ReplyIndex | Promise<ReplyIndex>,
): Promise<ReplyIndex> {
  return updateJsonAtomic(replyIndexFile(paths), ReplyIndex, async (cur) =>
    fn(cur ?? { schemaVersion: 1, records: {} }),
  );
}

/** Hash that binds a reply approval to the exact comment + draft text. */
export function replyPayloadHash(rec: Pick<ReplyRecord, 'commentId' | 'draft'>): string {
  return payloadHash(`${rec.commentId}\n${rec.draft ?? ''}`);
}

export async function readRequests(paths: DataPaths): Promise<RequestsFile> {
  return (await readJsonOrNull(paths.requestsFile, RequestsFile)) ?? { schemaVersion: 1, requests: [] };
}

export async function updateRequests(
  paths: DataPaths,
  fn: (r: RequestsFile) => RequestsFile,
): Promise<RequestsFile> {
  return updateJsonAtomic(paths.requestsFile, RequestsFile, (cur) =>
    fn(cur ?? { schemaVersion: 1, requests: [] }),
  );
}

// ----------------------------------------------------------------- proposals

export function proposalFile(paths: DataPaths, week: string): string {
  return path.join(paths.proposalsDir, `week-${week}.json`);
}

export async function readProposal(paths: DataPaths, week: string): Promise<ProposalFile | null> {
  return readJsonOrNull(proposalFile(paths, week), ProposalFile);
}

/** Hash that binds a learning approval to the exact list of proposed changes. */
export function proposalPayloadHash(p: Pick<ProposalFile, 'week' | 'changes'>): string {
  return payloadHash(`${p.week}\n${JSON.stringify(p.changes)}`);
}
