import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../../src/config';
import { sha256File } from '../../src/lib/ids';
import { fileExists } from '../../src/lib/store';
import {
  MUSIC_DIR,
  MUSIC_MOODS,
  SFX_DIR,
  SFX_NAMES,
  ensureSfxPack,
  generateMusic,
  generateSfx,
  sfxCuesFromSpec,
} from '../../src/media/music';
import { durationMs, readWav } from '../../src/media/wav';
import type { ReelSpec, VoiceTrack } from '../../src/schemas';

async function tmp(prefix: string): Promise<string> {
  const base = path.join(PROJECT_ROOT, 'out', 'test-media');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, prefix));
}

describe('procedural music (python/music_gen.py)', () => {
  it.each(MUSIC_MOODS)(
    'renders %s at the requested length, 48 kHz stereo, deterministic per seed',
    async (mood) => {
      const dir = await tmp(`music-${mood}-`);
      const a = await generateMusic({ mood, durationMs: 3000, outPath: path.join(dir, 'a.wav'), seed: 3 });
      const b = await generateMusic({ mood, durationMs: 3000, outPath: path.join(dir, 'b.wav'), seed: 3 });
      const wav = await readWav(a);
      expect(wav.sampleRate).toBe(48_000);
      expect(wav.channels).toBe(2);
      expect(Math.abs(durationMs(wav) - 3000)).toBeLessThan(5);
      expect(await sha256File(a)).toBe(await sha256File(b));
    },
    60_000,
  );

  it('rejects unknown moods', async () => {
    await expect(generateMusic({ mood: 'polka', durationMs: 2000, outPath: '/nowhere.wav' })).rejects.toThrow(
      /unknown music mood/,
    );
  });

  // *.wav is gitignored: the beds are regenerated with `tsx src/media/cli.ts assets` (deterministic).
  it.skipIf(!existsSync(path.join(MUSIC_DIR, 'wonder.wav')))(
    'generated beds in assets/music are valid',
    async () => {
      for (const m of MUSIC_MOODS) {
        const wav = await readWav(path.join(MUSIC_DIR, `${m}.wav`));
        expect(durationMs(wav)).toBeGreaterThan(30_000);
      }
    },
  );
});

describe('sfx pack (python/sfx_gen.py)', () => {
  it('generates every effect as a short non-empty WAV', async () => {
    const dir = await tmp('sfx-');
    for (const n of SFX_NAMES) {
      const p = await generateSfx(n, dir);
      const d = durationMs(await readWav(p));
      expect(d).toBeGreaterThan(20);
      expect(d).toBeLessThan(5000);
    }
  }, 60_000);

  it('ensureSfxPack fills assets/sfx (idempotent; generates missing effects)', async () => {
    const pack = await ensureSfxPack();
    for (const n of SFX_NAMES) {
      expect(pack[n]).toBe(path.join(SFX_DIR, `${n}.wav`));
      expect(await fileExists(pack[n])).toBe(true);
    }
  }, 60_000);

  it('places cues at beat starts (cut times) and skips "none"', () => {
    const spec = { beats: [{ sfx: 'hit' }, { sfx: 'none' }, { sfx: 'whoosh' }] } as unknown as ReelSpec;
    const track = {
      beats: [
        { index: 0, startMs: 0 },
        { index: 1, startMs: 1500 },
        { index: 2, startMs: 3200 },
      ],
    } as unknown as VoiceTrack;
    expect(sfxCuesFromSpec(spec, track)).toEqual([
      { atMs: 0, name: 'hit' },
      { atMs: 3200, name: 'whoosh' },
    ]);
  });
});
