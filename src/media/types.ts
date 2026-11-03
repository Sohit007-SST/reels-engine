/** Option/result types of the media module (re-exported from src/media/index.ts). */
import type { Brand } from '../schemas';

export interface TtsOptions {
  outDir: string;
  voiceId: string;
  lang: string;
  speed: number;
  gapMs: number;
  /** Reuse cached per-beat audio keyed by text+voice+speed hash. */
  cache?: boolean;
}

export interface MusicOptions {
  mood: string;
  durationMs: number;
  outPath: string;
  seed?: number;
}

export type SfxName = 'hit' | 'whoosh' | 'pop' | 'riser' | 'ding' | 'click';

export interface MixOptions {
  outPath: string;
  brand: Brand;
  musicPath: string | null;
  /** Cue points (ms) and sfx names, typically at beat starts. */
  sfx: Array<{ atMs: number; name: SfxName }>;
  /** Mood label recorded in track.mix.musicMood (default: derived from the music file name). */
  musicMood?: string | null;
  /** Directory holding the SFX WAVs (default assets/sfx; missing files are generated). */
  sfxDir?: string;
}

export interface LoudnessResult {
  integratedLufs: number;
  truePeakDb: number;
}
