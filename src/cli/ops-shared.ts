/**
 * Helpers shared by the ops CLIs (doctor, setup:meta, setup:telegram, gen-publish-cron).
 *
 * - upsertEnvValues(): writes KEY=value lines into api_keys/.env WITHOUT echoing values,
 *   atomically, with file mode 600. Values are never logged.
 * - promptHidden(): reads a line from the terminal with echo turned off (paste a token safely).
 * - isMainModule(): lets a CLI file be imported by tests without running main().
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { registerSecret } from '../lib/redact';

export const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvFileError';
  }
}

function formatValue(key: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new EnvFileError(`${key}: value must be a single line`);
  if (value.includes('"') && value.includes("'"))
    throw new EnvFileError(`${key}: value contains both quote characters`);
  // Quote when dotenv could misread the value (spaces, #, quotes, leading/trailing whitespace).
  if (/[\s#'"`]/.test(value) || value !== value.trim()) {
    return value.includes('"') ? `'${value}'` : `"${value}"`;
  }
  return value;
}

/** Return the trailing inline comment of an env line ("  # ..."), if any. */
function inlineComment(rest: string): string {
  const m = /\s+#.*$/.exec(rest);
  return m ? m[0].trimStart() : '';
}

/**
 * Pure function: apply KEY=value updates to env-file text. Existing lines are replaced in place
 * (keeping their inline comment); missing keys are appended. Commented-out lines are not touched.
 */
export function applyEnvUpdates(text: string, updates: Record<string, string>): string {
  const lines = text.length > 0 ? text.replace(/\r\n/g, '\n').split('\n') : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const pending = new Map(Object.entries(updates));
  for (const key of pending.keys()) {
    if (!ENV_KEY_RE.test(key)) throw new EnvFileError(`invalid env key: ${key}`);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const value = pending.get(key);
    if (value === undefined) continue;
    const comment = inlineComment(m[2] ?? '');
    const padded = `${key}=${formatValue(key, value)}`;
    lines[i] = comment ? `${padded.padEnd(32)}${comment.startsWith('#') ? comment : `# ${comment}`}` : padded;
    pending.delete(key);
  }
  for (const [key, value] of pending) lines.push(`${key}=${formatValue(key, value)}`);
  return lines.join('\n') + '\n';
}

/**
 * Atomically upsert values into an env file (mode 600). If the file does not exist it is
 * created from `templateFile` (api_keys/.env.example) when given. Values are registered with
 * the redactor first and are never printed. Returns the list of keys written.
 */
export async function upsertEnvValues(
  envFile: string,
  updates: Record<string, string>,
  opts: { templateFile?: string } = {},
): Promise<string[]> {
  for (const v of Object.values(updates)) registerSecret(v);
  let text = '';
  try {
    text = await fs.readFile(envFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    if (opts.templateFile) {
      try {
        text = await fs.readFile(opts.templateFile, 'utf8');
      } catch {
        text = '';
      }
    }
  }
  const next = applyEnvUpdates(text, updates);
  const dir = path.dirname(envFile);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(envFile)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(next);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, envFile);
    await fs.chmod(envFile, 0o600);
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw new EnvFileError(`could not write ${path.basename(envFile)}: ${(err as Error).name}`);
  }
  return Object.keys(updates);
}

export type PromptFn = (question: string, opts?: { hidden?: boolean }) => Promise<string>;

/**
 * Ask a question on the terminal. With hidden=true nothing typed or pasted is echoed.
 * When stdin is not a TTY (piped input), one line is read from stdin.
 */
export const promptTerminal: PromptFn = (question, opts = {}) =>
  new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    if (!stdin.isTTY) {
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          stdin.off('data', onData);
          stdin.pause();
          process.stderr.write('\n');
          resolve(buf.slice(0, nl).replace(/\r$/, '').trim());
        }
      };
      stdin.on('data', onData);
      stdin.once('end', () => resolve(buf.trim()));
      stdin.resume();
      return;
    }
    const hidden = opts.hidden === true;
    let answer = '';
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(answer.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') {
          answer = answer.slice(0, -1);
          if (!hidden) process.stderr.write('\b \b');
          continue;
        }
        answer += ch;
        if (!hidden) process.stderr.write(ch);
      }
    };
    stdin.on('data', onData);
  });

/** True when this module file is the process entry point (so tests can import CLIs safely). */
export function isMainModule(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(fileURLToPath(importMetaUrl)) === path.resolve(entry);
  } catch {
    return false;
  }
}

/** Parse "--flag" and "--key value" / "--key=value" CLI arguments. */
export function parseArgs(argv: string[]): { flags: Set<string>; values: Map<string, string> } {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) {
      values.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(a.slice(2), next);
      flags.add(a.slice(2));
      i++;
    } else {
      flags.add(a.slice(2));
    }
  }
  return { flags, values };
}
