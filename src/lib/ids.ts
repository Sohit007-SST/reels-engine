/** Run IDs, reel IDs and content hashes. */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import { toIstParts } from './time';

export type RunIdKind =
  | 'produce'
  | 'publish'
  | 'analyze'
  | 'learn'
  | 'engage'
  | 'trends'
  | 'render'
  | 'qa'
  | 'doctor'
  | 'setup'
  | 'agent'
  | 'dummy';

/** e.g. "produce-20261105-051700-a1b2c3" (IST wall clock + random suffix). */
export function newRunId(kind: RunIdKind, now: Date = new Date()): string {
  const p = toIstParts(now);
  const stamp = `${p.date.replaceAll('-', '')}-${String(p.hour).padStart(2, '0')}${String(p.minute).padStart(2, '0')}${String(p.second).padStart(2, '0')}`;
  return `${kind}-${stamp}-${randomBytes(3).toString('hex')}`;
}

export const RUN_ID_RE = /^[a-z]+-\d{8}-\d{6}-[0-9a-f]{6}$/;

/** Reel ID "YYYY-MM-DD-NN" (NN = 01..99), matching the ReelSpec example. */
export function reelId(istDate: string, index: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(istDate)) throw new Error(`invalid date: ${istDate}`);
  if (!Number.isInteger(index) || index < 1 || index > 99) throw new Error(`invalid reel index: ${index}`);
  return `${istDate}-${String(index).padStart(2, '0')}`;
}

export const REEL_ID_RE = /^\d{4}-\d{2}-\d{2}-\d{2}$/;

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  await fs.access(filePath);
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(filePath)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Short stable hash (hex) for callback data / cache keys. */
export function shortHash(data: string, length = 10): string {
  return sha256(data).slice(0, length);
}
