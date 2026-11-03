/**
 * Artifact retention and download abstraction (T5.3).
 *
 * The rendered MP4 waits as a GitHub Actions artifact (Actions runtime) or in out/ (Mac runtime).
 * fetchVerified() returns a local path ONLY when the file's sha256 matches the queue item's
 * ArtifactRef; containers are (re-)created only from such a file. Cleanup only ever deletes
 * files inside out/.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { sha256File } from '../lib/ids';
import type { ArtifactRef, QueueItem } from '../schemas/queue';

const execFileAsync = promisify(execFile);

export interface ArtifactStore {
  readonly kind: 'local' | 'github';
  /** Make the artifact available locally; returns the path or null if it is gone. */
  fetch(ref: ArtifactRef): Promise<string | null>;
}

export type VerifyResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'missing' | 'hash_mismatch' | 'retention_expired'; detail: string };

/** Fetch + hash-verify. Never returns a path whose bytes differ from the approved artifact. */
export async function fetchVerified(
  store: ArtifactStore,
  ref: ArtifactRef | null,
  now: Date = new Date(),
): Promise<VerifyResult> {
  if (!ref) return { ok: false, reason: 'missing', detail: 'queue item has no artifact' };
  let p: string | null;
  try {
    p = await store.fetch(ref);
  } catch (err) {
    return {
      ok: false,
      reason: 'missing',
      detail: `download failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!p) {
    const expired = Date.parse(ref.retainedUntil) <= now.getTime();
    return expired
      ? {
          ok: false,
          reason: 'retention_expired',
          detail: `artifact ${ref.name} retention ended ${ref.retainedUntil}`,
        }
      : { ok: false, reason: 'missing', detail: `artifact ${ref.name} not found` };
  }
  let actual: string;
  try {
    actual = await sha256File(p);
  } catch {
    return { ok: false, reason: 'missing', detail: `artifact file unreadable` };
  }
  if (actual !== ref.sha256) {
    return { ok: false, reason: 'hash_mismatch', detail: `sha256 mismatch for ${ref.name}` };
  }
  return { ok: true, path: p };
}

/** Mac runtime: the MP4 lives at ref.localPath or out/artifacts/<name>/<name>.mp4. */
export class LocalArtifactStore implements ArtifactStore {
  readonly kind = 'local' as const;
  constructor(private readonly outDir: string) {}
  async fetch(ref: ArtifactRef): Promise<string | null> {
    const candidates = [
      ...(ref.localPath ? [ref.localPath] : []),
      path.join(this.outDir, 'artifacts', ref.name, `${ref.name}.mp4`),
      path.join(this.outDir, 'artifacts', `${ref.name}.mp4`),
    ];
    for (const c of candidates) {
      try {
        const st = await fs.stat(c);
        if (st.isFile()) return c;
      } catch {
        /* try next */
      }
    }
    return null;
  }
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number; cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFn = async (file, args, opts) => {
  const r = await execFileAsync(file, args, {
    timeout: opts.timeout,
    cwd: opts.cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
};

/**
 * Actions runtime: `gh run download --name <artifact> --dir out/artifacts/<artifact>` (a read).
 * Requires GH_TOKEN with actions:read in the workflow. Timeout 3 min, no retries here
 * (the next publish run tries again).
 */
export class GithubArtifactStore implements ArtifactStore {
  readonly kind = 'github' as const;
  constructor(
    private readonly outDir: string,
    private readonly exec: ExecFn = defaultExec,
    private readonly timeoutMs = 180_000,
  ) {}
  async fetch(ref: ArtifactRef): Promise<string | null> {
    const local = await new LocalArtifactStore(this.outDir).fetch({ ...ref, localPath: null });
    if (local) return local;
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(ref.name)) throw new Error('invalid artifact name');
    const dir = path.join(this.outDir, 'artifacts', ref.name);
    await fs.mkdir(dir, { recursive: true });
    try {
      await this.exec('gh', ['run', 'download', '--name', ref.name, '--dir', dir], {
        timeout: this.timeoutMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no artifact|not found|no valid artifacts/i.test(msg)) return null;
      throw new Error(`gh run download failed for ${ref.name}`, { cause: err });
    }
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.mp4'));
    return files[0] ? path.join(dir, files[0]) : null;
  }
}

/** Pick the store: GitHub on Actions (GITHUB_ACTIONS=true), local otherwise. */
export function defaultArtifactStore(
  outDir: string,
  env: Record<string, string | undefined> = process.env,
): ArtifactStore {
  return env.GITHUB_ACTIONS === 'true' ? new GithubArtifactStore(outDir) : new LocalArtifactStore(outDir);
}

/**
 * Delete local copies under out/artifacts for items that are PUBLISHED/REJECTED/SKIPPED or
 * past retention. Never touches anything outside out/. Returns deleted paths.
 */
export async function cleanupLocalArtifacts(
  outDir: string,
  items: QueueItem[],
  now: Date = new Date(),
): Promise<string[]> {
  const base = path.resolve(outDir, 'artifacts');
  const deleted: string[] = [];
  for (const it of items) {
    if (!it.artifact) continue;
    const done = it.state === 'PUBLISHED' || it.state === 'REJECTED' || it.state === 'SKIPPED';
    const expired = Date.parse(it.artifact.retainedUntil) <= now.getTime();
    if (!done && !expired) continue;
    const target = path.resolve(base, it.artifact.name);
    if (!target.startsWith(base + path.sep)) continue; // never escape out/artifacts
    try {
      await fs.rm(target, { recursive: true, force: false });
      deleted.push(target);
    } catch {
      /* nothing to delete */
    }
  }
  return deleted;
}
