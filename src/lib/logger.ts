/**
 * Structured, redacting JSON-lines logger.
 *
 * Every entry passes through redactDeep(), so registered secret values, tokens,
 * Authorization headers and signed URLs never reach the output. Errors are serialized
 * with redacted message/stack. Use child() to bind runId / reelId / taskId / provider / stage.
 */
import { redact, redactDeep, serializeError } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  runId?: string;
  reelId?: string;
  taskId?: string;
  provider?: string;
  stage?: string;
  [key: string]: unknown;
}

export interface LogEntry extends LogContext {
  ts: string;
  level: LogLevel;
  msg: string;
  durationMs?: number;
  status?: string;
  error?: ReturnType<typeof serializeError>;
}

export type LogSink = (line: string, entry: LogEntry) => void;

const defaultSink: LogSink = (line, entry) => {
  // stderr keeps stdout free for machine output (e.g. JSON results of CLIs).
  if (entry.level === 'debug' && process.env.LOG_LEVEL !== 'debug') return;
  process.stderr.write(line + '\n');
};

let sink: LogSink = defaultSink;
let minLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) in LEVEL_ORDER ? (process.env.LOG_LEVEL as LogLevel) : 'info';

/** Replace the output sink (tests capture lines with this). Returns a restore function. */
export function setLogSink(next: LogSink): () => void {
  const prev = sink;
  sink = next;
  return () => {
    sink = prev;
  };
}

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown> & { err?: unknown }): void;
  child(ctx: LogContext): Logger;
  /** Time an async step; logs status ok/error with durationMs. Rethrows a sanitized error. */
  time<T>(stage: string, fn: () => Promise<T>, fields?: Record<string, unknown>): Promise<T>;
  readonly context: Readonly<LogContext>;
}

export function createLogger(ctx: LogContext = {}): Logger {
  const context = { ...ctx };

  function emit(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const { err, ...rest } = fields as { err?: unknown } & Record<string, unknown>;
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg: redact(msg),
      ...(redactDeep(context) as LogContext),
      ...(redactDeep(rest) as Record<string, unknown>),
    };
    if (err !== undefined) entry.error = serializeError(err);
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ ts: entry.ts, level, msg: entry.msg, note: 'unserializable fields dropped' });
    }
    // Final pass over the serialized line (defense in depth).
    sink(redact(line), entry);
  }

  const logger: Logger = {
    context,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (more) => createLogger({ ...context, ...more }),
    async time(stage, fn, fields = {}) {
      const start = Date.now();
      try {
        const out = await fn();
        emit('info', `${stage} ok`, { ...fields, stage, status: 'ok', durationMs: Date.now() - start });
        return out;
      } catch (err) {
        emit('error', `${stage} failed`, {
          ...fields,
          stage,
          status: 'error',
          durationMs: Date.now() - start,
          err,
        });
        throw err;
      }
    },
  };
  return logger;
}

/** Process-wide default logger (no run context). Prefer createLogger({ runId }) in pipelines. */
export const log = createLogger();
