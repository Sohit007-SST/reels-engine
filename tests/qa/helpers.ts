/** Shared helpers for QA tests. */
import { spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { FFMPEG_BIN, FFPROBE_BIN } from '../../src/qa/ffmpeg';
import { DEFAULT_FIXTURE_DIR } from '../fixtures/qa/generate';

function works(bin: string): boolean {
  try {
    return spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

/** Media tests need local ffmpeg + ffprobe; they are skipped (not faked) when missing. */
export const HAS_FFMPEG = works(FFMPEG_BIN) && works(FFPROBE_BIN);

/** Fresh scratch dir under out/ (gitignored). */
export async function scratchDir(prefix: string): Promise<string> {
  const base = path.join(path.dirname(DEFAULT_FIXTURE_DIR), 'qa-test-tmp');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, `${prefix}-`));
}

/** Generous timeout for tests that generate/decode media on first run. */
export const MEDIA_TIMEOUT = 300_000;
