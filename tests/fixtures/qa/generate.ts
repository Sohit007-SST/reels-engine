/**
 * Generates the QA video/audio fixtures with ffmpeg at test time (binaries are never committed;
 * *.mp4 / *.wav and out/ are gitignored). Every broken fixture has exactly one injected defect.
 *
 *   npx tsx tests/fixtures/qa/generate.ts [outDir]     (default out/qa-fixtures)
 *
 * Writes are atomic (tmp file + rename) so parallel test files can call ensureQaFixtures safely.
 */
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG_BIN, runProcess } from '../../../src/qa/ffmpeg';

export const FIXTURE_VERSION = 1;
export const DEFAULT_FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../out/qa-fixtures',
);

const W = 1080;
const H = 1920;
const FPS = 30;

/** Voice-track fixture: three "beats" of continuous tone separated by 120 ms gaps. */
export const VOICE_BEATS = [
  { index: 0, startMs: 0, durationMs: 1500 },
  { index: 1, startMs: 1620, durationMs: 2000 },
  { index: 2, startMs: 3740, durationMs: 1500 },
] as const;

const videoEnc = [
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-crf',
  '32',
  '-maxrate',
  '3M',
  '-bufsize',
  '6M',
  '-pix_fmt',
  'yuv420p',
];
const audioEnc = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000'];

function src(seconds: number, opts: { w?: number; h?: number; fps?: number } = {}): string[] {
  return [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${opts.w ?? W}x${opts.h ?? H}:rate=${opts.fps ?? FPS}:duration=${seconds}`,
  ];
}
function tone(seconds: number): string[] {
  return ['-f', 'lavfi', '-i', `sine=frequency=220:sample_rate=48000:duration=${seconds}`];
}
const LOUDNORM = 'loudnorm=I=-14:TP=-2:LRA=7,aresample=48000';

interface FixtureDef {
  file: string;
  args: (out: string) => string[];
}

const DEFS = {
  /** 20 s, 1080x1920@30, h264 + AAC 48 kHz at -14 LUFS: passes every technical check. */
  good: {
    file: 'good.mp4',
    args: (o) => [
      ...src(20),
      ...tone(20),
      '-filter_complex',
      `[1:a]${LOUDNORM}[a]`,
      '-map',
      '0:v',
      '-map',
      '[a]',
      ...videoEnc,
      ...audioEnc,
      o,
    ],
  },
  wrong_aspect: {
    file: 'wrong_aspect.mp4',
    args: (o) => [
      ...src(6, { w: 1080, h: 1080 }),
      ...tone(6),
      '-filter_complex',
      `[1:a]${LOUDNORM}[a]`,
      '-map',
      '0:v',
      '-map',
      '[a]',
      ...videoEnc,
      ...audioEnc,
      o,
    ],
  },
  no_audio: {
    file: 'no_audio.mp4',
    args: (o) => [...src(6), ...videoEnc, '-an', o],
  },
  black_frames: {
    file: 'black_frames.mp4',
    args: (o) => [
      ...src(8),
      ...tone(8),
      '-filter_complex',
      `[0:v]drawbox=c=black:t=fill:enable='between(t,3,4)'[v];[1:a]${LOUDNORM}[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      ...videoEnc,
      ...audioEnc,
      o,
    ],
  },
  frozen: {
    file: 'frozen.mp4',
    args: (o) => [
      ...src(10),
      ...tone(10),
      // repeat frame 150 (5 s) for 120 extra frames (4 s), then trim back to 10 s
      '-filter_complex',
      `[0:v]loop=loop=120:size=1:start=150,trim=duration=10,setpts=N/FRAME_RATE/TB[v];[1:a]${LOUDNORM}[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      ...videoEnc,
      ...audioEnc,
      o,
    ],
  },
  silent_gap: {
    file: 'silent_gap.mp4',
    args: (o) => [
      ...src(10),
      ...tone(10),
      '-filter_complex',
      `[1:a]${LOUDNORM},volume=enable='between(t,4,7)':volume=0[a]`,
      '-map',
      '0:v',
      '-map',
      '[a]',
      ...videoEnc,
      ...audioEnc,
      o,
    ],
  },
  too_loud: {
    file: 'too_loud.mp4',
    args: (o) => [
      ...src(6),
      ...tone(6),
      '-filter_complex',
      `[1:a]loudnorm=I=-7:TP=-0.5:LRA=7,aresample=48000[a]`,
      '-map',
      '0:v',
      '-map',
      '[a]',
      ...videoEnc,
      ...audioEnc,
      o,
    ],
  },
  too_long: {
    file: 'too_long.mp4',
    args: (o) => [
      ...src(62),
      ...tone(62),
      '-filter_complex',
      `[1:a]${LOUDNORM}[a]`,
      '-map',
      '0:v',
      '-map',
      '[a]',
      ...videoEnc,
      ...audioEnc,
      o,
    ],
  },
  wrong_fps: {
    file: 'wrong_fps.mp4',
    args: (o) => [
      ...src(6, { fps: 25 }),
      ...tone(6),
      '-filter_complex',
      `[1:a]${LOUDNORM}[a]`,
      '-map',
      '0:v',
      '-map',
      '[a]',
      ...videoEnc,
      ...audioEnc,
      o,
    ],
  },
  wrong_codec: {
    file: 'wrong_codec.mp4',
    args: (o) => [
      ...src(6),
      ...tone(6),
      '-filter_complex',
      `[1:a]${LOUDNORM}[a]`,
      '-map',
      '0:v',
      '-map',
      '[a]',
      '-c:v',
      'mpeg4',
      '-q:v',
      '10',
      '-pix_fmt',
      'yuv420p',
      ...audioEnc,
      o,
    ],
  },
  /** 3 scenes x 3 s; ONE flat magenta frame at the last frame of scene 0 (frame 89). */
  scene_glitch: {
    file: 'scene_glitch.mp4',
    args: (o) => [
      ...src(9),
      ...tone(9),
      '-filter_complex',
      `[0:v]drawbox=c=magenta:t=fill:enable='eq(n,89)'[v];[1:a]${LOUDNORM}[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      ...videoEnc,
      ...audioEnc,
      o,
    ],
  },
  /** Voice track: tone bursts exactly at VOICE_BEATS, silence in the 120 ms gaps. */
  voice: {
    file: 'voice.wav',
    args: (o) => {
      const on = VOICE_BEATS.map(
        (b) => `between(t,${b.startMs / 1000},${(b.startMs + b.durationMs) / 1000})`,
      ).join('+');
      return [
        '-f',
        'lavfi',
        '-i',
        `aevalsrc='0.3*sin(2*PI*220*t)*(${on})':s=48000:d=5.5`,
        '-c:a',
        'pcm_s16le',
        o,
      ];
    },
  },
} satisfies Record<string, FixtureDef>;

export type FixtureName = keyof typeof DEFS;
export const FIXTURE_NAMES = Object.keys(DEFS) as FixtureName[];

export async function ensureQaFixtures(
  names: FixtureName[] = FIXTURE_NAMES,
  dir: string = DEFAULT_FIXTURE_DIR,
): Promise<Record<FixtureName, string>> {
  const vdir = path.join(dir, `v${FIXTURE_VERSION}`);
  await mkdir(vdir, { recursive: true });
  const out = {} as Record<FixtureName, string>;
  await Promise.all(
    names.map(async (name) => {
      const def = DEFS[name];
      if (!def) throw new Error(`unknown fixture ${name}`);
      const target = path.join(vdir, def.file);
      out[name] = target;
      if (existsSync(target)) return;
      const ext = path.extname(def.file);
      const tmp = path.join(vdir, `.${name}.${process.pid}.${Math.random().toString(36).slice(2)}${ext}`);
      try {
        await runProcess(FFMPEG_BIN, ['-hide_banner', '-loglevel', 'error', '-y', ...def.args(tmp)], {
          timeoutMs: 180_000,
        });
        await rename(tmp, target);
      } finally {
        await rm(tmp, { force: true });
      }
    }),
  );
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FIXTURE_DIR;
  ensureQaFixtures(FIXTURE_NAMES, dir)
    .then((paths) => {
      for (const [k, v] of Object.entries(paths)) process.stdout.write(`${k}\t${v}\n`);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `fixture generation failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}
