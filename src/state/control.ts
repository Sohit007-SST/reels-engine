/**
 * Kill switch (data/control.json) + trial-reel pause + provider usage counters.
 *
 * Fail-safe: an unreadable or invalid control.json counts as PAUSED. The config flag
 * PIPELINE_PAUSED (GitHub repository variable) also pauses. Checked before every publishing
 * job and again immediately before every external write (spec 2.6).
 */
import path from 'node:path';
import { readJsonOrNull, updateJsonAtomic, writeJsonAtomic } from '../lib/store';
import { Control, Usage, type ProviderUsage } from '../schemas/control';
import type { DataPaths } from './paths';
import { TrialControl } from './schemas';
import { istDate } from '../lib/time';

export interface PauseState {
  paused: boolean;
  reason: string | null;
}

export class PausedError extends Error {
  constructor(readonly reason: string) {
    super(`pipeline paused: ${reason}`);
    this.name = 'PausedError';
  }
}

export async function readControl(paths: DataPaths): Promise<Control | null> {
  return readJsonOrNull(paths.controlFile, Control);
}

/** Current pause state. `configPaused` = settings.pipelinePaused. */
export async function pauseState(paths: DataPaths, configPaused = false): Promise<PauseState> {
  if (configPaused) return { paused: true, reason: 'PIPELINE_PAUSED=true' };
  try {
    const c = await readControl(paths);
    if (c?.paused) return { paused: true, reason: c.reason ?? 'paused via control.json' };
    return { paused: false, reason: null };
  } catch {
    return { paused: true, reason: 'control.json unreadable (fail-safe pause)' };
  }
}

/** Throws PausedError when paused. */
export async function assertNotPaused(paths: DataPaths, configPaused = false): Promise<void> {
  const s = await pauseState(paths, configPaused);
  if (s.paused) throw new PausedError(s.reason ?? 'paused');
}

export async function setPaused(
  paths: DataPaths,
  paused: boolean,
  reason: string | null,
  by: Control['updatedBy'],
  now: Date = new Date(),
): Promise<Control> {
  const c: Control = { schemaVersion: 1, paused, reason, updatedAt: now.toISOString(), updatedBy: by };
  await writeJsonAtomic(paths.controlFile, c, Control);
  return c;
}

// ------------------------------------------------------------------ trial pause

export function trialControlFile(paths: DataPaths): string {
  return path.join(paths.root, 'trial_control.json');
}

export async function trialPaused(paths: DataPaths): Promise<boolean> {
  try {
    const t = await readJsonOrNull(trialControlFile(paths), TrialControl);
    return t?.trialPaused ?? false;
  } catch {
    return true;
  }
}

export async function setTrialPaused(
  paths: DataPaths,
  trialPausedFlag: boolean,
  reason: string | null,
  now: Date = new Date(),
): Promise<void> {
  await writeJsonAtomic(
    trialControlFile(paths),
    { schemaVersion: 1, trialPaused: trialPausedFlag, reason, updatedAt: now.toISOString() },
    TrialControl,
  );
}

// ------------------------------------------------------------------ usage

export async function readUsage(paths: DataPaths): Promise<Usage | null> {
  try {
    return await readJsonOrNull(paths.usageFile, Usage);
  } catch {
    return null;
  }
}

/** Set one provider's counter for today (IST); a new day resets the other providers. */
export async function setProviderUsage(
  paths: DataPaths,
  provider: string,
  value: Omit<ProviderUsage, 'updatedAt'>,
  now: Date = new Date(),
): Promise<Usage> {
  const date = istDate(now);
  return updateJsonAtomic(paths.usageFile, Usage, (cur) => {
    const base: Usage = cur && cur.date === date ? cur : { schemaVersion: 1, date, providers: {} };
    return {
      ...base,
      providers: { ...base.providers, [provider]: { ...value, updatedAt: now.toISOString() } },
    };
  });
}
