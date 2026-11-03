/**
 * Child-process helpers for the media module (ffmpeg, ffprobe, the Python scripts).
 *
 * - Every call has a hard timeout (SIGKILL after it) and bounded output capture.
 * - Children get a MINIMAL environment (no API keys): PATH/HOME/locale/tmp plus model knobs.
 * - stderr tails in errors are redacted.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { PROJECT_ROOT } from '../config';
import { redact } from '../lib/redact';

export const PYTHON_BIN = process.env.PYTHON_BIN ?? path.join(PROJECT_ROOT, '.venv', 'bin', 'python');
export const PYTHON_DIR = path.join(PROJECT_ROOT, 'python');
export const FFMPEG_BIN = process.env.FFMPEG_BIN ?? 'ffmpeg';
export const FFPROBE_BIN = process.env.FFPROBE_BIN ?? 'ffprobe';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

/** Env vars children may see. Never includes secrets. */
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'MODELS_DIR',
  'KOKORO_VARIANT',
  'WHISPER_MODEL',
  'HF_HOME',
  'HF_HUB_OFFLINE',
  'ESPEAK_DATA_PATH',
  'PHONEMIZER_ESPEAK_LIBRARY',
] as const;

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.HF_HUB_DISABLE_TELEMETRY = '1';
  env.PYTHONUNBUFFERED = '1';
  return { ...env, ...extra };
}

export class MediaProcessError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
    readonly timedOut = false,
  ) {
    super(redact(message));
    this.name = 'MediaProcessError';
  }
}

export interface ProcResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface ProcOptions {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Accept these non-zero exit codes without throwing. */
  okExitCodes?: number[];
}

export function runProcess(cmd: string, args: string[], opts: ProcOptions): Promise<ProcResult> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? PROJECT_ROOT,
      env: opts.env ?? childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (buf: string, chunk: Buffer) =>
      buf.length + chunk.length > MAX_CAPTURE_BYTES
        ? (buf + chunk.toString('utf8')).slice(-MAX_CAPTURE_BYTES)
        : buf + chunk.toString('utf8');
    child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const name = path.basename(cmd) + (args[0]?.endsWith('.py') ? ` ${path.basename(args[0])}` : '');
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new MediaProcessError(`${name} could not start: ${err.message}`, name, null, ''));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = redact(stderr.slice(-2000));
      const exitCode = code ?? -1;
      if (timedOut) {
        reject(new MediaProcessError(`${name} timed out after ${opts.timeoutMs} ms`, name, code, tail, true));
        return;
      }
      if (exitCode !== 0 && !(opts.okExitCodes ?? []).includes(exitCode)) {
        reject(
          new MediaProcessError(`${name} exited with code ${exitCode}: ${lastLine(tail)}`, name, code, tail),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode, durationMs: Date.now() - start });
    });
  });
}

function lastLine(s: string): string {
  const lines = s.trim().split('\n');
  return (lines[lines.length - 1] ?? '').slice(0, 400);
}

/** Run one of the python/ scripts and parse the single JSON object it prints on stdout. */
export async function runPythonJson<T = Record<string, unknown>>(
  script: string,
  args: string[],
  opts: { timeoutMs: number; env?: Record<string, string> },
): Promise<T & { ok: true }> {
  const scriptPath = path.join(PYTHON_DIR, script);
  // -E: ignore PYTHON* env vars; -s: no user site-packages. The scripts exit 1-4 with a
  // JSON {ok:false,error} on stdout, so those codes are parsed rather than thrown here.
  const res = await runProcess(PYTHON_BIN, ['-E', '-s', scriptPath, ...args], {
    timeoutMs: opts.timeoutMs,
    env: childEnv(opts.env),
    okExitCodes: [1, 2, 3, 4],
  });
  const parsed = parseLastJson(res.stdout);
  if (!parsed || typeof parsed !== 'object') {
    throw new MediaProcessError(
      `${script} printed no JSON result`,
      script,
      res.exitCode,
      redact(res.stderr.slice(-2000)),
    );
  }
  const obj = parsed as { ok?: unknown; error?: unknown };
  if (obj.ok !== true) {
    throw new MediaProcessError(
      `${script} failed: ${typeof obj.error === 'string' ? obj.error : 'unknown error'}`,
      script,
      res.exitCode,
      redact(res.stderr.slice(-2000)),
    );
  }
  return parsed as T & { ok: true };
}

function parseLastJson(text: string): unknown {
  const lines = text.trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      return JSON.parse(t) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}
