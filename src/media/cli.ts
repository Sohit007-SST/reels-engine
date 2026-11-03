/**
 * Audio CLI (local, no external writes).
 *
 *   tsx src/media/cli.ts voice --spec <spec.json> [--out out/<reelId>] [--mood wonder] [--no-music] [--no-cache]
 *       TTS per beat -> word timings -> music bed -> mix; writes <out>/voice.json (VoiceTrack)
 *       and prints a JSON summary (durations, unmatched words, timing check, loudness).
 *   tsx src/media/cli.ts assets
 *       Regenerates assets/music/{wonder,tension,upbeat}.wav (64 s) and assets/sfx/*.wav.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_ROOT, loadBrand } from '../config';
import { runMain } from '../lib/cli';
import { ReelSpec } from '../schemas';
import {
  alignWordTimings,
  ensureSfxPack,
  generateMusic,
  loudnessProblems,
  mixAudio,
  sfxCuesFromSpec,
  synthesizeBeats,
  ttsOptionsFor,
  verifyCaptionTiming,
  writeVoiceTrack,
} from './index';
import { MUSIC_DIR, MUSIC_MOODS, SFX_DIR, isMusicMood } from './music';
import { runPythonJson } from './proc';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function voice(): Promise<number> {
  const specPath = arg('spec');
  if (!specPath) {
    process.stderr.write(
      'usage: tsx src/media/cli.ts voice --spec <spec.json> [--out dir] [--mood m] [--no-music]\n',
    );
    return 2;
  }
  const spec = ReelSpec.parse(JSON.parse(await readFile(specPath, 'utf8')));
  const brand = await loadBrand();
  const outDir = path.resolve(arg('out') ?? path.join(PROJECT_ROOT, 'out', spec.id));
  const opts = { ...ttsOptionsFor(spec, brand, outDir), cache: !flag('no-cache') };

  let track = await synthesizeBeats(spec, opts);
  track = await alignWordTimings(spec, track);
  const timing = await verifyCaptionTiming(track);

  const mood = arg('mood') ?? spec.musicMood ?? brand.audio.defaultMood;
  let musicPath: string | null = null;
  if (!flag('no-music')) {
    if (!isMusicMood(mood)) throw new Error(`unknown mood ${mood}; expected ${MUSIC_MOODS.join(', ')}`);
    musicPath = await generateMusic({
      mood,
      durationMs: track.totalMs + 1500,
      outPath: path.join(outDir, `music-${mood}.wav`),
    });
  }
  track = await mixAudio(track, {
    outPath: path.join(outDir, 'mix.wav'),
    brand,
    musicPath,
    musicMood: musicPath ? mood : null,
    sfx: sfxCuesFromSpec(spec, track),
  });
  await writeVoiceTrack(path.join(outDir, 'voice.json'), track);

  const loud = track.mix ? loudnessProblems(track.mix, brand) : ['no mix'];
  process.stdout.write(
    JSON.stringify(
      {
        reelId: spec.id,
        voiceJson: path.join(outDir, 'voice.json'),
        totalMs: track.totalMs,
        beatsMs: track.beats.map((b) => Math.round(b.durationMs)),
        words: track.words.length,
        unmatchedWords: track.words.filter((w) => !w.matched).map((w) => w.text),
        timingSource: track.timingSource,
        timingCheck: { ok: timing.ok, maxOnsetDriftMs: timing.maxOnsetDriftMs, problems: timing.problems },
        mix: track.mix,
        loudnessProblems: loud,
      },
      null,
      2,
    ) + '\n',
  );
  return timing.ok && loud.length === 0 ? 0 : 1;
}

async function assets(): Promise<number> {
  const music = await runPythonJson(
    'music_gen.py',
    ['--all-moods', '--out-dir', MUSIC_DIR, '--duration-ms', '64000'],
    {
      timeoutMs: 5 * 60_000,
    },
  );
  const sfx = await runPythonJson('sfx_gen.py', ['--all', '--out-dir', SFX_DIR], { timeoutMs: 2 * 60_000 });
  await ensureSfxPack();
  process.stdout.write(JSON.stringify({ music, sfx }, null, 2) + '\n');
  return 0;
}

runMain('media', async () => {
  const cmd = process.argv[2];
  if (cmd === 'voice') return voice();
  if (cmd === 'assets') return assets();
  process.stderr.write('usage: tsx src/media/cli.ts <voice|assets> ...\n');
  return 2;
});
