/**
 * T2.5 Audio mix (spec 7.4): voice + procedural music ducked under speech + SFX on cuts,
 * normalized to brand.audio.targetLufs (≈ −14 LUFS integrated) with true peak ≤ brand.audio.truePeakDb.
 *
 * ffmpeg graph: voice → (split) → sidechain key for the music compressor; music gain is set
 * relative to the MEASURED voice loudness (bed sits at voice + musicDuckDb + 6 dB, and the
 * sidechain compressor pulls it down further while speech is present). Then two-pass loudnorm
 * (measure, then linear apply), a bounded single gain/limiter correction if still off target,
 * and a final ebur128 measurement that is returned (never assumed).
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../lib/logger';
import { VoiceTrack, type Brand } from '../schemas';
import { SFX_DIR, SFX_END_ANCHORED, generateSfx } from './music';
import { FFMPEG_BIN, runProcess } from './proc';
import type { LoudnessResult, MixOptions, SfxName } from './types';
import { durationMs, readWav } from './wav';

const FFMPEG_TIMEOUT_MS = 3 * 60_000;
const SAMPLE_RATE = 48_000;
/** Extra headroom under the brand true-peak ceiling (AAC encoding can add a little peak). */
const TP_MARGIN_DB = 0.5;
const TAIL_MS = 600;
const SFX_GAIN_DB: Record<SfxName, number> = {
  hit: -5,
  whoosh: -8,
  pop: -9,
  riser: -10,
  ding: -10,
  click: -10,
};
export const LUFS_TOLERANCE = 1;

export class LoudnessParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoudnessParseError';
  }
}

/** Parse ffmpeg ebur128 summary (stderr) into integrated loudness and true peak. */
export function parseEbur128Summary(stderr: string): LoudnessResult {
  const idx = stderr.lastIndexOf('Summary:');
  if (idx < 0) throw new LoudnessParseError('ebur128 summary not found');
  const tail = stderr.slice(idx);
  const i = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(tail);
  const tp = /True peak:\s*\n\s*Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(tail);
  if (!i || !tp) throw new LoudnessParseError('could not read integrated loudness / true peak');
  const num = (s: string) => (s === '-inf' ? Number.NEGATIVE_INFINITY : Number(s));
  return { integratedLufs: num(i[1]!), truePeakDb: num(tp[1]!) };
}

/** Measure integrated loudness (EBU R128) and true peak with ffmpeg. */
export async function measureLoudness(audioPath: string): Promise<LoudnessResult> {
  const res = await runProcess(
    FFMPEG_BIN,
    [
      '-hide_banner',
      '-nostats',
      '-i',
      audioPath,
      '-filter_complex',
      'ebur128=peak=true:framelog=quiet',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: FFMPEG_TIMEOUT_MS },
  );
  return parseEbur128Summary(res.stderr);
}

/** Problems if a measured mix is outside the brand target (−14 ±1 LUFS, TP ≤ −1 dBTP). */
export function loudnessProblems(
  m: LoudnessResult,
  brand: Pick<Brand, 'audio'>,
  tolerance = LUFS_TOLERANCE,
): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(m.integratedLufs) || Math.abs(m.integratedLufs - brand.audio.targetLufs) > tolerance) {
    problems.push(
      `integrated loudness ${m.integratedLufs} LUFS outside ${brand.audio.targetLufs} ±${tolerance}`,
    );
  }
  if (!(m.truePeakDb <= brand.audio.truePeakDb)) {
    problems.push(`true peak ${m.truePeakDb} dBTP above ${brand.audio.truePeakDb}`);
  }
  return problems;
}

interface LoudnormMeasure {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

function parseLoudnormJson(stderr: string): LoudnormMeasure {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) throw new LoudnessParseError('loudnorm JSON not found');
  const obj = JSON.parse(stderr.slice(start, end + 1)) as Partial<LoudnormMeasure>;
  for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const) {
    if (typeof obj[k] !== 'string' || !Number.isFinite(Number(obj[k])))
      throw new LoudnessParseError(`loudnorm ${k} missing`);
  }
  return obj as LoudnormMeasure;
}

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();
const STEREO = `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;

export interface MixPlan {
  inputs: string[][];
  graph: string;
}

/** Build the ffmpeg inputs + filter graph (pure; unit tested). */
export function buildMixGraph(p: {
  voicePath: string;
  totalMs: number;
  music: { path: string; gainDb: number } | null;
  sfx: Array<{ path: string; delayMs: number; gainDb: number }>;
}): MixPlan {
  const T = (p.totalMs + TAIL_MS) / 1000;
  const inputs: string[][] = [['-i', p.voicePath]];
  const parts: string[] = [];
  const mixIn: string[] = ['[v]'];
  if (p.music) {
    parts.push(`[0:a]${STEREO},apad=whole_dur=${fmt(T)},asplit=2[v][sc]`);
    inputs.push(['-stream_loop', '-1', '-i', p.music.path]);
    const fadeOut = Math.max(0, T - 1.5);
    parts.push(
      `[1:a]${STEREO},atrim=0:${fmt(T)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.8,afade=t=out:st=${fmt(fadeOut)}:d=1.5,volume=${fmt(p.music.gainDb)}dB[mraw]`,
    );
    parts.push(`[mraw][sc]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=400:makeup=1[m]`);
    mixIn.push('[m]');
  } else {
    parts.push(`[0:a]${STEREO},apad=whole_dur=${fmt(T)}[v]`);
  }
  p.sfx.forEach((s, k) => {
    const idx = inputs.length;
    inputs.push(['-i', s.path]);
    const d = Math.max(0, Math.round(s.delayMs));
    parts.push(`[${idx}:a]${STEREO},adelay=delays=${d}:all=1,volume=${fmt(s.gainDb)}dB[s${k}]`);
    mixIn.push(`[s${k}]`);
  });
  if (mixIn.length === 1) parts.push(`[v]anull[pre]`);
  else
    parts.push(
      `${mixIn.join('')}amix=inputs=${mixIn.length}:duration=first:normalize=0:dropout_transition=0[pre]`,
    );
  return { inputs, graph: parts.join(';') };
}

export async function mixAudioImpl(track: VoiceTrack, opts: MixOptions): Promise<VoiceTrack> {
  const log = createLogger({ reelId: track.reelId, stage: 'mix', provider: 'ffmpeg' });
  const { targetLufs, truePeakDb, musicDuckDb } = opts.brand.audio;
  const tpTarget = truePeakDb - TP_MARGIN_DB;
  await mkdir(path.dirname(path.resolve(opts.outPath)), { recursive: true });

  const voice = await measureLoudness(track.voicePath);
  if (!Number.isFinite(voice.integratedLufs) || voice.integratedLufs < -60) {
    throw new Error(`voice track is silent or too quiet (${voice.integratedLufs} LUFS)`);
  }

  let music: { path: string; gainDb: number } | null = null;
  if (opts.musicPath) {
    const m = await measureLoudness(opts.musicPath);
    if (Number.isFinite(m.integratedLufs)) {
      music = { path: opts.musicPath, gainDb: voice.integratedLufs + musicDuckDb + 6 - m.integratedLufs };
    } else {
      log.warn('music bed is silent; mixing without music');
    }
  }

  const sfxDir = opts.sfxDir ?? SFX_DIR;
  const sfx: Array<{ path: string; delayMs: number; gainDb: number }> = [];
  for (const cue of opts.sfx) {
    const p = await generateSfx(cue.name, sfxDir);
    const len = durationMs(await readWav(p));
    const delayMs = SFX_END_ANCHORED.includes(cue.name) ? cue.atMs - len : cue.atMs;
    if (cue.atMs < 0 || cue.atMs > track.totalMs + TAIL_MS) {
      log.warn('sfx cue outside the track; skipped', { name: cue.name, atMs: cue.atMs });
      continue;
    }
    sfx.push({ path: p, delayMs: Math.max(0, delayMs), gainDb: SFX_GAIN_DB[cue.name] });
  }

  const outPath = path.resolve(opts.outPath);
  const premix = `${outPath}.premix.wav`;
  const pass2 = `${outPath}.norm.wav`;
  try {
    const plan = buildMixGraph({ voicePath: track.voicePath, totalMs: track.totalMs, music, sfx });
    await runProcess(
      FFMPEG_BIN,
      [
        '-y',
        '-hide_banner',
        '-nostats',
        ...plan.inputs.flat(),
        '-filter_complex',
        plan.graph,
        '-map',
        '[pre]',
        '-c:a',
        'pcm_f32le',
        '-ar',
        String(SAMPLE_RATE),
        premix,
      ],
      { timeoutMs: FFMPEG_TIMEOUT_MS },
    );

    const ln = `loudnorm=I=${targetLufs}:TP=${fmt(tpTarget)}:LRA=11`;
    const m1 = await runProcess(
      FFMPEG_BIN,
      ['-hide_banner', '-nostats', '-i', premix, '-af', `${ln}:print_format=json`, '-f', 'null', '-'],
      { timeoutMs: FFMPEG_TIMEOUT_MS },
    );
    const meas = parseLoudnormJson(m1.stderr);
    await runProcess(
      FFMPEG_BIN,
      [
        '-y',
        '-hide_banner',
        '-nostats',
        '-i',
        premix,
        '-af',
        `${ln}:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true:print_format=none,aresample=${SAMPLE_RATE}`,
        '-c:a',
        'pcm_s16le',
        '-ar',
        String(SAMPLE_RATE),
        pass2,
      ],
      { timeoutMs: FFMPEG_TIMEOUT_MS },
    );

    let result = await measureLoudness(pass2);
    let corrected = false;
    if (Math.abs(result.integratedLufs - targetLufs) > 0.5 || result.truePeakDb > tpTarget) {
      // One bounded correction: exact gain, then a limiter below the ceiling.
      const gain = targetLufs - result.integratedLufs;
      const limit = 10 ** ((tpTarget - 0.3) / 20);
      const fixed = `${outPath}.fix.wav`;
      await runProcess(
        FFMPEG_BIN,
        [
          '-y',
          '-hide_banner',
          '-nostats',
          '-i',
          pass2,
          '-af',
          `volume=${fmt(gain)}dB,alimiter=limit=${fmt(limit)}:level=false:attack=5:release=60,aresample=${SAMPLE_RATE}`,
          '-c:a',
          'pcm_s16le',
          '-ar',
          String(SAMPLE_RATE),
          fixed,
        ],
        { timeoutMs: FFMPEG_TIMEOUT_MS },
      );
      await rename(fixed, pass2);
      result = await measureLoudness(pass2);
      corrected = true;
    }
    await rename(pass2, outPath);

    const problems = loudnessProblems(result, opts.brand);
    log.info('mix ready', {
      integratedLufs: result.integratedLufs,
      truePeakDb: result.truePeakDb,
      voiceLufs: voice.integratedLufs,
      musicGainDb: music ? Math.round(music.gainDb * 10) / 10 : null,
      sfx: sfx.length,
      corrected,
      problems,
    });
    const mood =
      opts.musicMood !== undefined
        ? opts.musicMood
        : opts.musicPath
          ? path.basename(opts.musicPath).replace(/\.[^.]+$/, '')
          : null;
    return VoiceTrack.parse({
      ...track,
      mix: {
        path: outPath,
        integratedLufs: result.integratedLufs,
        truePeakDb: result.truePeakDb,
        musicMood: mood,
      },
    });
  } finally {
    await rm(premix, { force: true });
    await rm(pass2, { force: true });
  }
}
