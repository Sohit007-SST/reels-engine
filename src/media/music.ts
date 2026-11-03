/**
 * T3.3 Procedural music (3 moods) and SFX pack (python/music_gen.py, python/sfx_gen.py).
 * No samples, no licensing risk. Same seed => same file.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT } from '../config';
import { fileExists } from '../lib/store';
import type { ReelSpec, VoiceTrack } from '../schemas';
import { runPythonJson } from './proc';
import type { MusicOptions, SfxName } from './types';

export const MUSIC_DIR = path.join(PROJECT_ROOT, 'assets', 'music');
export const SFX_DIR = path.join(PROJECT_ROOT, 'assets', 'sfx');
export const MUSIC_MOODS = ['wonder', 'tension', 'upbeat'] as const;
export type MusicMood = (typeof MUSIC_MOODS)[number];
export const SFX_NAMES: readonly SfxName[] = ['whoosh', 'pop', 'hit', 'riser', 'ding', 'click'];
/** SFX that build up to their end are placed so they END at the cue. */
export const SFX_END_ANCHORED: readonly SfxName[] = ['riser'];
const GEN_TIMEOUT_MS = 2 * 60_000;

export function isMusicMood(m: string): m is MusicMood {
  return (MUSIC_MOODS as readonly string[]).includes(m);
}

/** Write a procedural music bed of exactly `durationMs` (faded, -20 LUFS). Returns the written path. */
export async function generateMusic(opts: MusicOptions): Promise<string> {
  if (!isMusicMood(opts.mood))
    throw new Error(`unknown music mood "${opts.mood}" (expected ${MUSIC_MOODS.join(', ')})`);
  await mkdir(path.dirname(opts.outPath), { recursive: true });
  const res = await runPythonJson<{ path: string }>(
    'music_gen.py',
    [
      '--mood',
      opts.mood,
      '--duration-ms',
      String(Math.max(1000, Math.round(opts.durationMs))),
      '--out',
      path.resolve(opts.outPath),
      '--seed',
      String(opts.seed ?? 7),
    ],
    { timeoutMs: GEN_TIMEOUT_MS },
  );
  return res.path;
}

/** Path of a cached SFX WAV in `outDir`, generating it on first use. */
export async function generateSfx(name: SfxName, outDir: string): Promise<string> {
  if (!SFX_NAMES.includes(name)) throw new Error(`unknown sfx "${name}"`);
  const out = path.resolve(outDir, `${name}.wav`);
  if (await fileExists(out)) return out;
  await mkdir(path.dirname(out), { recursive: true });
  const res = await runPythonJson<{ path: string }>('sfx_gen.py', ['--name', name, '--out', out], {
    timeoutMs: GEN_TIMEOUT_MS,
  });
  return res.path;
}

/** Make sure the whole SFX pack exists (assets/sfx by default). */
export async function ensureSfxPack(outDir = SFX_DIR): Promise<Record<SfxName, string>> {
  const out = {} as Record<SfxName, string>;
  for (const n of SFX_NAMES) out[n] = await generateSfx(n, outDir);
  return out;
}

/** SFX cues at cut times: each beat's start in the voice track, for beats whose sfx is not 'none'. */
export function sfxCuesFromSpec(spec: ReelSpec, track: VoiceTrack): Array<{ atMs: number; name: SfxName }> {
  const cues: Array<{ atMs: number; name: SfxName }> = [];
  for (const b of track.beats) {
    const cue = spec.beats[b.index]?.sfx ?? 'none';
    if (cue !== 'none') cues.push({ atMs: b.startMs, name: cue });
  }
  return cues;
}
