/**
 * T2.3 Text-to-speech: Kokoro per beat, cached by text hash, MEASURED durations (spec 7.4).
 *
 * Each beat is synthesized separately; its measured duration becomes its scene duration.
 * Beats are joined with `gapMs` of silence into out/<reel>/voice.wav.
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from '../config';
import { sha256 } from '../lib/ids';
import { createLogger } from '../lib/logger';
import { fileExists, writeFileAtomic } from '../lib/store';
import { VoiceTrack, type Brand, type ReelSpec } from '../schemas';
import { runPythonJson } from './proc';
import type { TtsOptions } from './types';
import { concatWithGaps, durationMs, readWav, writeWav, type Pcm16Audio } from './wav';

export const TTS_CACHE_DIR = process.env.TTS_CACHE_DIR ?? path.join(PROJECT_ROOT, 'out', 'cache', 'tts');
/** Bump when synthesis changes in a way that should invalidate cached audio. */
export const TTS_CACHE_VERSION = 1;
const TTS_TIMEOUT_MS = 10 * 60_000;

const DEVANAGARI = /[ऀ-ॿ]/;
const HINDI_VOICES = ['hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi'];

export interface TtsJobBeat {
  index: number;
  text: string;
  outPath: string;
}
export interface TtsJob {
  voice: string;
  speed: number;
  lang: string;
  beats: TtsJobBeat[];
}
export interface TtsRunResult {
  model?: string;
  beats: Array<{ index: number; path: string; durationMs: number }>;
}
export type TtsRunner = (job: TtsJob) => Promise<TtsRunResult>;

/** Default runner: python/tts_kokoro.py (kokoro-onnx). */
export const kokoroRunner: TtsRunner = async (job) => {
  const jobPath = path.join(TTS_CACHE_DIR, `job-${process.pid}-${Date.now()}.json`);
  await mkdir(TTS_CACHE_DIR, { recursive: true });
  await writeFileAtomic(jobPath, JSON.stringify(job));
  try {
    return await runPythonJson<TtsRunResult>('tts_kokoro.py', ['--job', jobPath], {
      timeoutMs: TTS_TIMEOUT_MS,
    });
  } finally {
    await rm(jobPath, { force: true });
  }
};

export function kokoroVariant(): string {
  return process.env.KOKORO_VARIANT ?? 'fp32';
}

/** Cache key: same text + voice + speed + lang + model variant => same audio. */
export function ttsCacheKey(text: string, o: { voiceId: string; speed: number; lang: string }): string {
  return sha256(
    JSON.stringify({
      v: TTS_CACHE_VERSION,
      text: text.trim(),
      voice: o.voiceId,
      speed: o.speed,
      lang: o.lang,
      model: kokoroVariant(),
    }),
  );
}

/** TTS options from brand.json (+ Hindi handling: Devanagari text, a Hindi voice). */
export function ttsOptionsFor(spec: ReelSpec, brand: Brand, outDir: string): TtsOptions {
  const base: TtsOptions = {
    outDir,
    voiceId: brand.voice.voiceId,
    lang: brand.voice.lang,
    speed: brand.voice.speed,
    gapMs: brand.voice.beatGapMs,
    cache: true,
  };
  if (spec.language === 'hi') {
    const bad = spec.beats.findIndex((b) => !DEVANAGARI.test(b.voiceover));
    if (bad >= 0) throw new Error(`Hindi spec: beat ${bad} voiceover must be Devanagari text`);
    return { ...base, lang: 'hi', voiceId: HINDI_VOICES.includes(base.voiceId) ? base.voiceId : 'hf_alpha' };
  }
  return base;
}

export interface SynthesizeDeps {
  runner?: TtsRunner;
  cacheDir?: string;
  now?: () => Date;
}

async function validCached(p: string): Promise<Pcm16Audio | null> {
  if (!(await fileExists(p))) return null;
  try {
    const a = await readWav(p);
    return durationMs(a) > 0 ? a : null;
  } catch {
    return null;
  }
}

export async function synthesizeBeatsWith(
  spec: ReelSpec,
  opts: TtsOptions,
  deps: SynthesizeDeps = {},
): Promise<VoiceTrack> {
  const log = createLogger({ reelId: spec.id, stage: 'tts', provider: 'kokoro' });
  const runner = deps.runner ?? kokoroRunner;
  const cacheDir = deps.cacheDir ?? TTS_CACHE_DIR;
  const useCache = opts.cache !== false;
  await mkdir(cacheDir, { recursive: true });
  await mkdir(opts.outDir, { recursive: true });

  const plan = spec.beats.map((b, index) => {
    const key = ttsCacheKey(b.voiceover, opts);
    return { index, text: b.voiceover.trim(), cachePath: path.join(cacheDir, `${key}.wav`) };
  });

  const missing: TtsJobBeat[] = [];
  for (const p of plan) {
    if (!useCache || !(await validCached(p.cachePath))) {
      if (!missing.some((m) => m.outPath === p.cachePath))
        missing.push({ index: p.index, text: p.text, outPath: p.cachePath });
    }
  }
  log.info('tts plan', {
    beats: plan.length,
    toSynthesize: missing.length,
    cached: plan.length - missing.length,
  });
  if (missing.length > 0) {
    await log.time('kokoro synth', () =>
      runner({ voice: opts.voiceId, speed: opts.speed, lang: opts.lang, beats: missing }),
    );
  }

  const clips: Pcm16Audio[] = [];
  const beatPaths: string[] = [];
  for (const p of plan) {
    const audio = await validCached(p.cachePath);
    if (!audio) throw new Error(`TTS produced no usable audio for beat ${p.index}`);
    const beatPath = path.join(opts.outDir, `beat-${String(p.index).padStart(2, '0')}.wav`);
    await copyFile(p.cachePath, beatPath);
    clips.push(audio);
    beatPaths.push(beatPath);
  }

  const { audio: voice, startsMs } = concatWithGaps(clips, opts.gapMs);
  const voicePath = path.join(opts.outDir, 'voice.wav');
  await writeWav(voicePath, voice);

  const beats = plan.map((p, i) => ({
    index: p.index,
    audioPath: beatPaths[i] ?? '',
    durationMs: round3(durationMs(clips[i] as Pcm16Audio)),
    startMs: round3(startsMs[i] ?? 0),
    text: p.text,
  }));
  const track = VoiceTrack.parse({
    schemaVersion: 1,
    reelId: spec.id,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    voiceId: opts.voiceId,
    speed: opts.speed,
    gapMs: opts.gapMs,
    beats,
    voicePath,
    totalMs: round3(durationMs(voice)),
    words: [],
    unmatchedWordCount: 0,
    timingSource: 'proportional',
    mix: null,
  });
  log.info('voice track ready', { totalMs: Math.round(track.totalMs), beats: beats.length });
  return track;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
