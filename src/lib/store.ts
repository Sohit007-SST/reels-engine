/**
 * Atomic JSON state store.
 *
 * - writeJsonAtomic: write to a unique temp file in the same directory, fsync, then rename()
 *   over the target. A crash leaves either the old file or the new file, never a partial one.
 * - readJson / readJsonOrNull: parse + optional zod validation.
 * - withFileLock: simple cross-process lock (mkdir-based) with a bounded wait, for the rare
 *   read-modify-write cases (e.g. queue transitions). One writer per file is still the rule.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';

export class StoreError extends Error {
  constructor(
    message: string,
    readonly filePath: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StoreError';
  }
}

export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, 'wx', 0o644);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, filePath);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new StoreError(`atomic write failed: ${filePath}`, filePath, { cause: err });
  }
}

/**
 * Validate (if a schema is given) then atomically write pretty JSON with a trailing newline.
 * Invalid data is never written.
 */
export async function writeJsonAtomic<S extends z.ZodType>(
  filePath: string,
  data: z.input<S> | unknown,
  schema?: S,
): Promise<void> {
  let value: unknown = data;
  if (schema) {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new StoreError(
        `refusing to write invalid data to ${filePath}: ${parsed.error.message}`,
        filePath,
      );
    }
    value = parsed.data;
  }
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2) + '\n');
}

export async function readJson<S extends z.ZodType>(filePath: string, schema: S): Promise<z.output<S>>;
export async function readJson(filePath: string): Promise<unknown>;
export async function readJson(filePath: string, schema?: z.ZodType): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new StoreError(`cannot read ${filePath}`, filePath, { cause: err });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new StoreError(`invalid JSON in ${filePath}`, filePath, { cause: err });
  }
  if (!schema) return json;
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new StoreError(`schema validation failed for ${filePath}: ${parsed.error.message}`, filePath);
  return parsed.data;
}

/** Like readJson but returns null when the file does not exist. */
export async function readJsonOrNull<S extends z.ZodType>(
  filePath: string,
  schema: S,
): Promise<z.output<S> | null> {
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  return readJson(filePath, schema);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface LockOptions {
  /** Max time to wait for the lock (default 10 s). */
  timeoutMs?: number;
  /** Poll interval (default 50 ms). */
  pollMs?: number;
  /** A lock older than this is considered stale and broken (default 5 min). */
  staleMs?: number;
}

/** Run fn while holding `<filePath>.lock` (a directory). Bounded wait; never waits forever. */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const lockDir = `${filePath}.lock`;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 50;
  const staleMs = opts.staleMs ?? 5 * 60_000;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const st = await fs.stat(lockDir);
        if (Date.now() - st.mtimeMs > staleMs) {
          await fs.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new StoreError(`lock timeout for ${filePath}`, filePath);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Locked read-modify-write of one JSON file. `update` receives null when the file is missing. */
export async function updateJsonAtomic<S extends z.ZodType>(
  filePath: string,
  schema: S,
  update: (current: z.output<S> | null) => z.input<S> | Promise<z.input<S>>,
  lock?: LockOptions,
): Promise<z.output<S>> {
  return withFileLock(
    filePath,
    async () => {
      const current = await readJsonOrNull(filePath, schema);
      const next = await update(current);
      const parsed = schema.parse(next) as z.output<S>;
      await writeJsonAtomic(filePath, parsed);
      return parsed;
    },
    lock,
  );
}
