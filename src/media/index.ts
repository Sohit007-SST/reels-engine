/**
 * Media module contract (owner: audio builder). Implementations live in tts.ts, timings.ts,
 * music.ts and mix.ts; these signatures are stable (render and QA depend on them).
 * Python helpers live in python/ and run with .venv/bin/python (see PYTHON_BIN).
 *
 * Typical flow (see src/media/cli.ts `voice`):
 *   track = await synthesizeBeats(spec, ttsOptionsFor(spec, brand, outDir))
 *   track = await alignWordTimings(spec, track)
 *   music = await generateMusic({ mood, durationMs: track.totalMs + 1000, outPath })
 *   track = await mixAudio(track, { outPath, brand, musicPath: music, sfx: sfxCuesFromSpec(spec, track) })
 *   await writeVoiceTrack(path.join(outDir, 'voice.json'), track)
 */
import type { ReelSpec } from '../schemas';
import { VoiceTrack } from '../schemas';
import { writeJsonAtomic } from '../lib/store';
import { mixAudioImpl } from './mix';
import { alignWordTimingsWith, type AlignOptions } from './timings';
import { synthesizeBeatsWith } from './tts';
import type { MixOptions, TtsOptions } from './types';

export { PYTHON_BIN } from './proc';
export type { LoudnessResult, MixOptions, MusicOptions, SfxName, TtsOptions } from './types';
export {
  generateMusic,
  generateSfx,
  ensureSfxPack,
  sfxCuesFromSpec,
  MUSIC_MOODS,
  MUSIC_DIR,
  SFX_DIR,
  SFX_NAMES,
} from './music';
export { measureLoudness, loudnessProblems, LUFS_TOLERANCE } from './mix';
export { ttsOptionsFor, ttsCacheKey, TTS_CACHE_DIR } from './tts';
export {
  CAPTION_TOLERANCE_MS,
  alignWords,
  captionDriftProblems,
  captionTimingProblems,
  normalizeToken,
  splitScriptWords,
  verifyCaptionTiming,
  type RecognizedWord,
  type TimingCheck,
} from './timings';

/** Synthesize every beat separately and measure durations (spec 7.4). Returns a VoiceTrack without words/mix. */
export async function synthesizeBeats(spec: ReelSpec, opts: TtsOptions): Promise<VoiceTrack> {
  return synthesizeBeatsWith(spec, opts);
}

/** Transcribe the voice track for timestamps only and align to canonical script words (±150 ms). */
export async function alignWordTimings(
  spec: ReelSpec,
  track: VoiceTrack,
  opts?: AlignOptions,
): Promise<VoiceTrack> {
  return alignWordTimingsWith(spec, track, opts);
}

/** Voice + ducked music + SFX, normalized to brand.audio.targetLufs / truePeakDb. Returns updated track (mix filled). */
export async function mixAudio(track: VoiceTrack, opts: MixOptions): Promise<VoiceTrack> {
  return mixAudioImpl(track, opts);
}

/** Persist the audio → render → QA handoff (out/<reelId>/voice.json), schema-validated. */
export async function writeVoiceTrack(filePath: string, track: VoiceTrack): Promise<void> {
  await writeJsonAtomic(filePath, track, VoiceTrack);
}
