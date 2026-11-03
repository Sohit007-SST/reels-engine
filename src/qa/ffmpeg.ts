/**
 * Thin, bounded wrappers around the local ffmpeg / ffprobe binaries used by QA.
 *
 *  - every process has a hard timeout (SIGKILL after it) and a capped output buffer
 *  - arguments are passed as an array (no shell), so paths with spaces are safe
 *  - parsers are pure functions so they can be unit-tested on captured output
 */
import { spawn } from 'node:child_process';
import { rename } from 'node:fs/promises';

export const FFMPEG_BIN = process.env.FFMPEG_BIN ?? 'ffmpeg';
export const FFPROBE_BIN = process.env.FFPROBE_BIN ?? 'ffprobe';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'ProcessError';
  }
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a binary with a timeout; rejects on non-zero exit (unless allowNonZero) or timeout. */
export function runProcess(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; allowNonZero?: boolean } = {},
): Promise<ProcessResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const append = (cur: string, chunk: Buffer): string => {
      const next = cur + chunk.toString('utf8');
      // Keep the tail: summaries (ebur128, silencedetect) are printed at the end.
      return next.length > MAX_CAPTURE_BYTES ? next.slice(next.length - MAX_CAPTURE_BYTES) : next;
    };
    child.stdout.on('data', (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = append(stderr, c)));
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ProcessError(`${bin} could not start: ${err.message}`, null, ''));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new ProcessError(`${bin} timed out after ${timeoutMs} ms`, code, stderr.slice(-2000)));
        return;
      }
      const exit = code ?? -1;
      if (exit !== 0 && !opts.allowNonZero) {
        const lastLine = stderr.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? '';
        reject(
          new ProcessError(
            `${bin} exited with code ${exit}${lastLine ? `: ${lastLine}` : ''}`,
            exit,
            stderr.slice(-2000),
          ),
        );
        return;
      }
      resolve({ code: exit, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------- ffprobe

export interface ProbeResult {
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  pixFmt: string | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  durationSec: number | null;
  sizeBytes: number | null;
  frameCount: number | null;
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  nb_frames?: string;
  duration?: string;
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split('/').map(Number);
  if (n === undefined || !Number.isFinite(n)) return null;
  if (d === undefined) return n;
  if (!Number.isFinite(d) || d === 0) return null;
  return n / d;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Parse `ffprobe -print_format json -show_format -show_streams` output. */
export function parseProbeJson(json: string): ProbeResult {
  const data = JSON.parse(json) as { streams?: RawStream[]; format?: { duration?: string; size?: string } };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  return {
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: parseRate(v?.avg_frame_rate) ?? parseRate(v?.r_frame_rate),
    videoCodec: v?.codec_name ?? null,
    pixFmt: v?.pix_fmt ?? null,
    audioCodec: a?.codec_name ?? null,
    audioSampleRate: num(a?.sample_rate),
    audioChannels: a?.channels ?? null,
    durationSec: num(data.format?.duration) ?? num(v?.duration),
    sizeBytes: num(data.format?.size),
    frameCount: num(v?.nb_frames),
  };
}

export async function probe(filePath: string, timeoutMs = 30_000): Promise<ProbeResult> {
  const res = await runProcess(
    FFPROBE_BIN,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { timeoutMs },
  );
  return parseProbeJson(res.stdout);
}

// ---------------------------------------------------------------- analysis filters

export interface Interval {
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface AnalysisResult {
  black: Interval[];
  freeze: Interval[];
  silence: Interval[];
  /** Integrated loudness (LUFS) from ebur128, null when there is no audio. */
  integratedLufs: number | null;
  /** True peak (dBTP) from ebur128 peak=true, null when unknown. */
  truePeakDb: number | null;
}

const NUM = '(-?(?:\\d+(?:\\.\\d+)?|inf))';

function toNum(s: string | undefined): number {
  if (s === undefined) return NaN;
  if (s === '-inf') return -Infinity;
  if (s === 'inf') return Infinity;
  return Number(s);
}

/** Parse blackdetect / freezedetect / silencedetect / ebur128 lines from ffmpeg stderr. */
export function parseAnalysis(stderr: string, totalDurationSec: number | null): AnalysisResult {
  const black: Interval[] = [];
  for (const m of stderr.matchAll(
    new RegExp(`black_start:${NUM}\\s+black_end:${NUM}\\s+black_duration:${NUM}`, 'g'),
  )) {
    black.push({ startSec: toNum(m[1]), endSec: toNum(m[2]), durationSec: toNum(m[3]) });
  }

  const pairs = (startRe: RegExp, endRe: RegExp): Interval[] => {
    const events: Array<{ at: number; kind: 's' | 'e'; pos: number }> = [];
    for (const m of stderr.matchAll(startRe)) events.push({ at: toNum(m[1]), kind: 's', pos: m.index ?? 0 });
    for (const m of stderr.matchAll(endRe)) events.push({ at: toNum(m[1]), kind: 'e', pos: m.index ?? 0 });
    events.sort((x, y) => x.pos - y.pos);
    const out: Interval[] = [];
    let open: number | null = null;
    for (const e of events) {
      if (e.kind === 's') open = e.at;
      else if (open !== null) {
        out.push({ startSec: open, endSec: e.at, durationSec: e.at - open });
        open = null;
      }
    }
    // An interval still open at EOF lasts until the end of the file.
    if (open !== null && totalDurationSec !== null) {
      out.push({ startSec: open, endSec: totalDurationSec, durationSec: totalDurationSec - open });
    }
    return out;
  };

  const freeze = pairs(
    new RegExp(`freezedetect\\.freeze_start:\\s*${NUM}`, 'g'),
    new RegExp(`freezedetect\\.freeze_end:\\s*${NUM}`, 'g'),
  );
  const silence = pairs(
    new RegExp(`silence_start:\\s*${NUM}`, 'g'),
    new RegExp(`silence_end:\\s*${NUM}`, 'g'),
  );

  let integratedLufs: number | null = null;
  let truePeakDb: number | null = null;
  const summaryAt = stderr.lastIndexOf('Summary:');
  if (summaryAt >= 0) {
    const summary = stderr.slice(summaryAt);
    const i = new RegExp(`I:\\s+${NUM}\\s+LUFS`).exec(summary);
    if (i) integratedLufs = toNum(i[1]);
    const p = new RegExp(`Peak:\\s+${NUM}\\s+dBFS`).exec(summary);
    if (p) truePeakDb = toNum(p[1]);
  }
  return { black, freeze, silence, integratedLufs, truePeakDb };
}

export interface AnalysisOptions {
  /** blackdetect min duration (s). Default 0.1 (3 frames at 30 fps). */
  blackMinSec?: number;
  /** blackdetect pixel threshold. Default 0.10. */
  blackPixelThreshold?: number;
  /** freezedetect min duration (s). Default 2. */
  freezeMinSec?: number;
  /** silencedetect noise floor (dB). Default -50. */
  silenceNoiseDb?: number;
  /** silencedetect min duration (s). Default 1. */
  silenceMinSec?: number;
  timeoutMs?: number;
}

/** One decode pass: blackdetect + freezedetect on video, silencedetect + ebur128 on audio. */
export async function analyzeMedia(
  filePath: string,
  hasAudio: boolean,
  durationSec: number | null,
  opts: AnalysisOptions = {},
): Promise<AnalysisResult> {
  const vf = [
    `blackdetect=d=${opts.blackMinSec ?? 0.1}:pix_th=${opts.blackPixelThreshold ?? 0.1}`,
    `freezedetect=n=-60dB:d=${opts.freezeMinSec ?? 2}`,
  ].join(',');
  const args = ['-hide_banner', '-nostats', '-i', filePath, '-vf', vf];
  if (hasAudio) {
    args.push(
      '-af',
      `silencedetect=n=${opts.silenceNoiseDb ?? -50}dB:d=${opts.silenceMinSec ?? 1},ebur128=peak=true:framelog=quiet`,
    );
  } else {
    args.push('-an');
  }
  args.push('-f', 'null', '-');
  const res = await runProcess(FFMPEG_BIN, args, { timeoutMs: opts.timeoutMs ?? 180_000 });
  return parseAnalysis(res.stderr, durationSec);
}

/** Audio-only pass (used for caption drift: speech onsets on the voice track). */
export async function detectSilences(
  audioPath: string,
  opts: { noiseDb?: number; minSec?: number; timeoutMs?: number } = {},
): Promise<{ silences: Interval[]; durationSec: number | null }> {
  const p = await probe(audioPath);
  const res = await runProcess(
    FFMPEG_BIN,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      audioPath,
      '-vn',
      '-af',
      `silencedetect=n=${opts.noiseDb ?? -40}dB:d=${opts.minSec ?? 0.08}`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: opts.timeoutMs ?? 60_000 },
  );
  return { silences: parseAnalysis(res.stderr, p.durationSec).silence, durationSec: p.durationSec };
}

/** Speech onsets (s) = starts of non-silent regions, derived from silence intervals. */
export function speechOnsets(silences: Interval[], durationSec: number | null): number[] {
  const sorted = [...silences].sort((a, b) => a.startSec - b.startSec);
  const onsets: number[] = [];
  const first = sorted[0];
  if (!first || first.startSec > 0.001) onsets.push(0);
  for (const s of sorted) {
    if (durationSec !== null && s.endSec >= durationSec - 0.001) continue;
    onsets.push(s.endSec);
  }
  return onsets;
}

// ---------------------------------------------------------------- frame extraction

export interface FrameStat {
  frame: number;
  /** 10th / 90th percentile luma; a tiny spread means a flat (blank) frame. */
  yLow: number | null;
  yHigh: number | null;
}

/** Parse metadata=print output for signalstats YLOW / YHIGH, keyed by pts_time. */
export function parseFrameStats(stderr: string, fps: number): FrameStat[] {
  const byFrame = new Map<number, FrameStat>();
  let current: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const head = /pts_time:(-?[\d.]+)/.exec(line);
    if (head) {
      current = Math.round(Number(head[1]) * fps);
      if (!byFrame.has(current)) byFrame.set(current, { frame: current, yLow: null, yHigh: null });
      continue;
    }
    const kv = /lavfi\.signalstats\.(YLOW|YHIGH)=(-?[\d.]+)/.exec(line);
    if (kv && current !== null) {
      const st = byFrame.get(current);
      if (!st) continue;
      if (kv[1] === 'YLOW') st.yLow = Number(kv[2]);
      else st.yHigh = Number(kv[2]);
    }
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/**
 * Extract exact frames (by index) in ONE decode pass with the select filter.
 * Writes <outDir>/frame_<NNNNN>.png per requested frame and returns per-frame luma stats.
 */
export async function extractFramesExact(
  videoPath: string,
  frames: number[],
  outDir: string,
  fps: number,
  timeoutMs = 120_000,
): Promise<{ paths: Map<number, string>; stats: FrameStat[] }> {
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  if (sorted.length === 0) return { paths: new Map(), stats: [] };
  const select = sorted.map((f) => `eq(n\\,${f})`).join('+');
  const vf = [
    `select='${select}'`,
    'signalstats',
    'metadata=print:key=lavfi.signalstats.YLOW',
    'metadata=print:key=lavfi.signalstats.YHIGH',
  ].join(',');
  const pattern = `${outDir}/sample_%04d.png`;
  const res = await runProcess(
    FFMPEG_BIN,
    [
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      videoPath,
      '-an',
      '-vf',
      vf,
      '-fps_mode',
      'passthrough',
      pattern,
    ],
    { timeoutMs },
  );
  const stats = parseFrameStats(res.stderr, fps);
  const paths = new Map<number, string>();
  // select emits frames in order, so output N corresponds to the N-th requested frame that exists.
  const emitted = stats.map((s) => s.frame);
  for (let i = 0; i < emitted.length; i++) {
    const frame = emitted[i];
    if (frame === undefined) continue;
    const from = `${outDir}/sample_${String(i + 1).padStart(4, '0')}.png`;
    const to = `${outDir}/frame_${String(frame).padStart(5, '0')}.png`;
    try {
      await rename(from, to);
      paths.set(frame, to);
    } catch {
      /* frame not written (beyond end of stream) */
    }
  }
  return { paths, stats };
}
