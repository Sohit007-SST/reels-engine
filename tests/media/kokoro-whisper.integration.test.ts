/**
 * LOCAL evidence for T2.3/T2.4: a REAL Kokoro synthesis of fixture beats and a REAL faster-whisper
 * alignment. No network: skipped when the model files are not already cached in models/
 * (e.g. on CI), or when SKIP_MEDIA_INTEGRATION=1.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../src/config';
import { CAPTION_TOLERANCE_MS, alignWordTimingsWith, verifyCaptionTiming } from '../../src/media/timings';
import { synthesizeBeatsWith } from '../../src/media/tts';
import { durationMs, readWav } from '../../src/media/wav';
import { ReelSpec } from '../../src/schemas';

const models = path.join(PROJECT_ROOT, 'models');
const haveKokoro =
  existsSync(path.join(models, 'kokoro', 'kokoro-v1.0.onnx')) &&
  existsSync(path.join(models, 'kokoro', 'voices-v1.0.bin'));
const haveWhisper = existsSync(path.join(models, 'whisper', 'models--Systran--faster-whisper-small'));
const skip = process.env.SKIP_MEDIA_INTEGRATION === '1' || !haveKokoro;

describe.skipIf(skip)('real Kokoro + faster-whisper on fixture beats (LOCAL)', () => {
  it('synthesizes each beat with measured durations, then aligns words within ±150 ms', async () => {
    const full = ReelSpec.parse(
      JSON.parse(
        await readFile(path.join(PROJECT_ROOT, 'tests', 'media', 'fixtures', 'moon-spec.json'), 'utf8'),
      ),
    );
    const spec = { ...full, beats: full.beats.slice(0, 3) };
    const base = path.join(PROJECT_ROOT, 'out', 'test-media');
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(path.join(base, 'kokoro-'));
    // Fresh cache dir => Kokoro really runs.
    const track = await synthesizeBeatsWith(
      spec,
      {
        outDir: path.join(dir, 'out'),
        voiceId: 'af_heart',
        lang: 'en-us',
        speed: 1.08,
        gapMs: 120,
        cache: true,
      },
      { cacheDir: path.join(dir, 'cache') },
    );
    expect(track.beats).toHaveLength(3);
    for (const b of track.beats) {
      const wav = await readWav(b.audioPath);
      expect(wav.sampleRate).toBe(24_000);
      // Duration is MEASURED from the file and plausible for the text (>= 150 ms per word-ish).
      expect(b.durationMs).toBeCloseTo(durationMs(wav), 0);
      expect(b.durationMs).toBeGreaterThan(b.text.split(/\s+/).length * 150);
    }
    expect(track.beats[1]!.startMs).toBeCloseTo(track.beats[0]!.durationMs + 120, 0);

    if (!haveWhisper) return;
    const aligned = await alignWordTimingsWith(spec, track, { model: 'small' });
    expect(aligned.timingSource).toBe('faster-whisper');
    const scriptWords = spec.beats.flatMap((b) => b.voiceover.trim().split(/\s+/));
    expect(aligned.words.map((w) => w.text)).toEqual(scriptWords);
    expect(aligned.unmatchedWordCount).toBeLessThanOrEqual(2);
    const check = await verifyCaptionTiming(aligned);
    expect(check.problems).toEqual([]);
    expect(check.maxOnsetDriftMs).toBeLessThanOrEqual(CAPTION_TOLERANCE_MS);
  }, 300_000);
});
