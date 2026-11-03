import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../src/config';
import {
  buildMixGraph,
  loudnessProblems,
  measureLoudness,
  mixAudioImpl,
  parseEbur128Summary,
} from '../../src/media/mix';
import { generateMusic } from '../../src/media/music';
import { writeWav } from '../../src/media/wav';
import type { Brand, VoiceTrack } from '../../src/schemas';

const brand = {
  audio: { targetLufs: -14, truePeakDb: -1, musicDuckDb: -14, defaultMood: 'wonder' },
} as unknown as Brand;

const EBUR_SAMPLE = `[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.5 LUFS

  Loudness range:
    LRA:         4.1 LU

  True peak:
    Peak:       -1.6 dBFS
`;

describe('parseEbur128Summary', () => {
  it('reads integrated loudness and true peak', () => {
    expect(parseEbur128Summary(EBUR_SAMPLE)).toEqual({ integratedLufs: -14.2, truePeakDb: -1.6 });
  });
  it('handles -inf (silence) and rejects missing summaries', () => {
    const silent = EBUR_SAMPLE.replace('-14.2', '-inf').replace('-1.6', '-inf');
    expect(parseEbur128Summary(silent).integratedLufs).toBe(Number.NEGATIVE_INFINITY);
    expect(() => parseEbur128Summary('no summary here')).toThrow(/summary/);
  });
});

describe('loudnessProblems', () => {
  it('accepts -14 ±1 LUFS with TP <= -1', () => {
    expect(loudnessProblems({ integratedLufs: -14.9, truePeakDb: -1 }, brand)).toEqual([]);
    expect(loudnessProblems({ integratedLufs: -13.1, truePeakDb: -2 }, brand)).toEqual([]);
  });
  it('flags loudness out of range, hot peaks and non-finite values', () => {
    expect(loudnessProblems({ integratedLufs: -16, truePeakDb: -2 }, brand)).toHaveLength(1);
    expect(loudnessProblems({ integratedLufs: -14, truePeakDb: -0.5 }, brand)).toHaveLength(1);
    expect(
      loudnessProblems({ integratedLufs: Number.NEGATIVE_INFINITY, truePeakDb: Number.NaN }, brand),
    ).toHaveLength(2);
  });
});

describe('buildMixGraph', () => {
  it('ducks music with a sidechain keyed by the voice and delays sfx to cut times', () => {
    const plan = buildMixGraph({
      voicePath: '/v.wav',
      totalMs: 10_000,
      music: { path: '/m.wav', gainDb: -8 },
      sfx: [
        { path: '/hit.wav', delayMs: 0, gainDb: -5 },
        { path: '/whoosh.wav', delayMs: 2500.4, gainDb: -8 },
      ],
    });
    expect(plan.inputs).toHaveLength(4);
    expect(plan.inputs[1]).toContain('-stream_loop');
    expect(plan.graph).toContain('asplit=2[v][sc]');
    expect(plan.graph).toContain('[mraw][sc]sidechaincompress');
    expect(plan.graph).toContain('adelay=delays=2500:all=1');
    expect(plan.graph).toContain('amix=inputs=4');
    expect(plan.graph.endsWith('[pre]')).toBe(true);
  });
  it('works with voice only', () => {
    const plan = buildMixGraph({ voicePath: '/v.wav', totalMs: 1000, music: null, sfx: [] });
    expect(plan.inputs).toHaveLength(1);
    expect(plan.graph).toContain('[v]anull[pre]');
  });
});

/** Speech-like test voice: harmonic syllables with gaps, deliberately quiet (~-30 dBFS). */
function fakeVoice(ms: number, sampleRate = 24_000): Int16Array {
  const n = Math.round((ms / 1000) * sampleRate);
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const syl = (t * 4) % 1; // 4 syllables per second
    const env = syl < 0.7 ? Math.sin((Math.PI * syl) / 0.7) : 0;
    const f0 = 140 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    let s = 0;
    for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h;
    data[i] = Math.round(env * s * 0.03 * 32767);
  }
  return data;
}

async function voiceTrack(dir: string, ms: number): Promise<VoiceTrack> {
  const voicePath = path.join(dir, 'voice.wav');
  await writeWav(voicePath, { sampleRate: 24_000, channels: 1, data: fakeVoice(ms) });
  return {
    schemaVersion: 1,
    reelId: '2026-11-03-01',
    createdAt: new Date().toISOString(),
    voiceId: 'af_heart',
    speed: 1,
    gapMs: 120,
    beats: [
      { index: 0, audioPath: voicePath, durationMs: ms / 2, startMs: 0, text: 'a' },
      { index: 1, audioPath: voicePath, durationMs: ms / 2, startMs: ms / 2, text: 'b' },
    ],
    voicePath,
    totalMs: ms,
    words: [],
    unmatchedWordCount: 0,
    timingSource: 'proportional',
    mix: null,
  };
}

describe('mixAudioImpl (real ffmpeg, LOCAL)', () => {
  it('mixes voice + ducked music + sfx to -14 ±1 LUFS with TP <= -1 dBTP and reports the MEASURED values', async () => {
    const base = path.join(PROJECT_ROOT, 'out', 'test-media');
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, 'mix-'));
    const track = await voiceTrack(dir, 8000);
    const music = await generateMusic({
      mood: 'tension',
      durationMs: 9500,
      outPath: path.join(dir, 'music.wav'),
    });
    const out = await mixAudioImpl(track, {
      outPath: path.join(dir, 'mix.wav'),
      brand,
      musicPath: music,
      musicMood: 'tension',
      sfx: [
        { atMs: 0, name: 'hit' },
        { atMs: 4000, name: 'whoosh' },
        { atMs: 4000, name: 'riser' },
      ],
    });
    expect(out.mix).not.toBeNull();
    const mix = out.mix!;
    expect(mix.musicMood).toBe('tension');
    expect(Math.abs(mix.integratedLufs - -14)).toBeLessThanOrEqual(1);
    expect(mix.truePeakDb).toBeLessThanOrEqual(-1);
    // Returned values are a real measurement of the written file.
    const again = await measureLoudness(mix.path);
    expect(again.integratedLufs).toBeCloseTo(mix.integratedLufs, 1);
    expect(loudnessProblems(again, brand)).toEqual([]);
  }, 120_000);

  it('normalizes a voice-only mix too', async () => {
    const base = path.join(PROJECT_ROOT, 'out', 'test-media');
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, 'mixv-'));
    const out = await mixAudioImpl(await voiceTrack(dir, 5000), {
      outPath: path.join(dir, 'mix.wav'),
      brand,
      musicPath: null,
      sfx: [],
    });
    expect(out.mix!.musicMood).toBeNull();
    expect(loudnessProblems(out.mix!, brand)).toEqual([]);
  }, 120_000);
});
