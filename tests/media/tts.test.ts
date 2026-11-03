import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthesizeBeatsWith, ttsCacheKey, type TtsRunner } from '../../src/media/tts';
import { writeWav } from '../../src/media/wav';

describe('ttsCacheKey', () => {
  const o = { voiceId: 'af_heart', speed: 1.08, lang: 'en-us' };
  it('is stable, trims text, and varies with text/voice', () => {
    expect(ttsCacheKey('Hi there', o)).toBe(ttsCacheKey('  Hi there ', o));
    expect(ttsCacheKey('Hi there', o)).not.toBe(ttsCacheKey('Hi there!', o));
    expect(ttsCacheKey('Hi', o)).not.toBe(ttsCacheKey('Hi', { ...o, voiceId: 'am_adam' }));
  });
});

describe('synthesizeBeatsWith caching', () => {
  it('only synthesizes uncached texts on the second run', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tts-'));
    let calls = 0;
    const runner: TtsRunner = async (job) => {
      calls += job.beats.length;
      for (const b of job.beats) {
        await writeWav(b.outPath, { sampleRate: 24000, channels: 1, data: new Int16Array(12000).fill(1000) });
      }
      return { beats: job.beats.map((b) => ({ index: b.index, path: b.outPath, durationMs: 500 })) };
    };
    const spec = { id: '2026-11-03-01', beats: [{ voiceover: 'One.' }, { voiceover: 'Two.' }] } as never;
    const opts = { outDir: path.join(dir, 'o'), voiceId: 'af_heart', lang: 'en-us', speed: 1, gapMs: 100 };
    const a = await synthesizeBeatsWith(spec, opts, { runner, cacheDir: path.join(dir, 'c') });
    const first = calls;
    await synthesizeBeatsWith(spec, opts, { runner, cacheDir: path.join(dir, 'c') });
    expect(first).toBe(2);
    expect(calls).toBe(2);
    expect(a.beats.length).toBe(2);
  });
});
