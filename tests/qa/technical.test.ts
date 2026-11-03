/**
 * Technical QA: one defect-injection test per check. Media fixtures are generated with ffmpeg at
 * test time (tests/fixtures/qa/generate.ts -> out/qa-fixtures, gitignored).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Brand, QaCheck } from '../../src/schemas';
import {
  checkAnalysis,
  checkCaptionTiming,
  checkProbe,
  checkTextBounds,
  DEFAULT_TECHNICAL_THRESHOLDS,
  safeRect,
  sceneAtSec,
  technicalChecks,
} from '../../src/qa/technical';
import type { ProbeResult } from '../../src/qa/ffmpeg';
import { ensureQaFixtures, type FixtureName } from '../fixtures/qa/generate';
import { brandAndBlocklist, makeRenderReport, makeVoiceTrack } from '../fixtures/qa/factories';
import { HAS_FFMPEG, MEDIA_TIMEOUT } from './helpers';

const T = DEFAULT_TECHNICAL_THRESHOLDS;
let brand: Brand;
beforeAll(async () => {
  brand = (await brandAndBlocklist()).brand;
});

const fails = (checks: QaCheck[]) => checks.filter((c) => c.status === 'fail').map((c) => c.id);
const byId = (checks: QaCheck[], id: string) => checks.filter((c) => c.id === id);

const goodProbe: ProbeResult = {
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  pixFmt: 'yuv420p',
  audioCodec: 'aac',
  audioSampleRate: 48000,
  audioChannels: 2,
  durationSec: 30,
  sizeBytes: 9_000_000,
  frameCount: 900,
};

describe('checkProbe (pure, defect injection)', () => {
  it('a correct file passes every container check', () => {
    expect(fails(checkProbe(goodProbe, brand, T))).toEqual([]);
  });
  it.each<[string, Partial<ProbeResult>, string]>([
    ['wrong resolution', { width: 720, height: 1280 }, 'tech.resolution'],
    ['wrong aspect', { width: 1080, height: 1080 }, 'tech.aspect'],
    ['wrong fps', { fps: 25 }, 'tech.fps'],
    ['wrong video codec', { videoCodec: 'hevc' }, 'tech.video_codec'],
    ['no audio', { audioCodec: null }, 'tech.audio_stream'],
    ['wrong audio rate', { audioSampleRate: 44100 }, 'tech.audio_codec'],
    ['too long', { durationSec: 61 }, 'tech.duration'],
    ['unknown duration', { durationSec: null }, 'tech.duration'],
    ['too big', { sizeBytes: 20_000_001 }, 'tech.size'],
  ])('%s fails %s', (_label, patch, id) => {
    expect(fails(checkProbe({ ...goodProbe, ...patch }, brand, T))).toContain(id);
  });
  it('no video stream fails immediately', () => {
    expect(fails(checkProbe({ ...goodProbe, width: null, height: null }, brand, T))).toEqual([
      'tech.video_stream',
    ]);
  });
  it('exactly 60.0 s passes; short reels only warn', () => {
    expect(fails(checkProbe({ ...goodProbe, durationSec: 60 }, brand, T))).toEqual([]);
    const short = checkProbe({ ...goodProbe, durationSec: 8 }, brand, T);
    expect(fails(short)).toEqual([]);
    expect(byId(short, 'tech.duration_min')[0]?.status).toBe('warn');
  });
});

describe('checkAnalysis (pure, defect injection)', () => {
  const report = makeRenderReport(30, 3);
  const clean = { black: [], freeze: [], silence: [], integratedLufs: -14.1, truePeakDb: -1.5 };
  it('clean analysis passes', () => {
    expect(fails(checkAnalysis(clean, goodProbe, brand, report, T))).toEqual([]);
  });
  it('black interval fails and points at the scene that contains it', () => {
    const c = checkAnalysis(
      { ...clean, black: [{ startSec: 12, endSec: 12.2, durationSec: 0.2 }] },
      goodProbe,
      brand,
      report,
      T,
    );
    const b = byId(c, 'tech.black_frames')[0];
    expect(b?.status).toBe('fail');
    expect(b?.beatIndex).toBe(1);
  });
  it('freeze shorter than the threshold passes, longer fails', () => {
    const short = checkAnalysis(
      { ...clean, freeze: [{ startSec: 1, endSec: 3, durationSec: 2 }] },
      goodProbe,
      brand,
      report,
      T,
    );
    expect(fails(short)).toEqual([]);
    const long = checkAnalysis(
      { ...clean, freeze: [{ startSec: 1, endSec: 5, durationSec: 4 }] },
      goodProbe,
      brand,
      report,
      T,
    );
    expect(fails(long)).toContain('tech.freeze');
  });
  it('mid-reel silence fails; a short silent tail is tolerated', () => {
    const mid = checkAnalysis(
      { ...clean, silence: [{ startSec: 10, endSec: 13, durationSec: 3 }] },
      goodProbe,
      brand,
      report,
      T,
    );
    expect(fails(mid)).toContain('tech.silence');
    const tail = checkAnalysis(
      { ...clean, silence: [{ startSec: 29.2, endSec: 30, durationSec: 0.8 }] },
      goodProbe,
      brand,
      report,
      T,
    );
    expect(fails(tail)).toEqual([]);
  });
  it('loudness outside ±1 LU and true peak above the ceiling fail', () => {
    expect(fails(checkAnalysis({ ...clean, integratedLufs: -18 }, goodProbe, brand, report, T))).toContain(
      'tech.loudness',
    );
    expect(
      fails(checkAnalysis({ ...clean, integratedLufs: -Infinity }, goodProbe, brand, report, T)),
    ).toContain('tech.loudness');
    expect(fails(checkAnalysis({ ...clean, truePeakDb: 0.2 }, goodProbe, brand, report, T))).toContain(
      'tech.true_peak',
    );
  });
  it('audio checks are not run when there is no audio stream (that is its own failure)', () => {
    const c = checkAnalysis(clean, { ...goodProbe, audioCodec: null }, brand, report, T);
    expect(byId(c, 'tech.loudness')).toEqual([]);
  });
});

describe('text bounds vs safe zone (render report)', () => {
  it('safe rect is the stricter of render margins and brand percentages', () => {
    const r = safeRect(makeRenderReport(30), brand);
    expect(r).toEqual({ left: 54, top: 192, right: 1080 - 130, bottom: 1920 - 384 });
  });
  it('boxes inside the safe zone pass', () => {
    expect(fails(checkTextBounds(makeRenderReport(30), brand))).toEqual([]);
  });
  it('a title under the top UI band fails with the scene index', () => {
    const rep = makeRenderReport(30);
    const s1 = rep.scenes[1];
    if (!s1) throw new Error('fixture');
    s1.textBoxes = [
      { id: 't', text: 'TOO HIGH', x: 100, y: 50, width: 400, height: 100, fontSize: 80, overflow: false },
    ];
    const c = checkTextBounds(rep, brand);
    const f = byId(c, 'tech.text_bounds').find((x) => x.status === 'fail');
    expect(f?.beatIndex).toBe(1);
    expect(f?.message).toMatch(/top edge/);
  });
  it('a caption box under the right-side buttons or bottom bar fails', () => {
    const rep = makeRenderReport(30, 3, {
      captionBoxes: [
        {
          id: 'caption-2',
          text: 'wide caption',
          x: 100,
          y: 1500,
          width: 900,
          height: 140,
          fontSize: 64,
          overflow: false,
        },
      ],
    });
    const f = byId(checkTextBounds(rep, brand), 'tech.text_bounds').find((x) => x.status === 'fail');
    expect(f?.message).toMatch(/right edge.*bottom edge/);
    expect(f?.beatIndex).toBe(2);
  });
  it('overflowing text fails', () => {
    const rep = makeRenderReport(30);
    const s0 = rep.scenes[0];
    if (!s0?.textBoxes[0]) throw new Error('fixture');
    s0.textBoxes[0].overflow = true;
    expect(fails(checkTextBounds(rep, brand))).toContain('tech.text_overflow');
  });
  it('empty text boxes are ignored', () => {
    const rep = makeRenderReport(30, 3, {
      captionBoxes: [
        { id: 'c', text: '  ', x: 0, y: 0, width: 1080, height: 1920, fontSize: 10, overflow: true },
      ],
    });
    expect(fails(checkTextBounds(rep, brand))).toEqual([]);
  });
});

describe('caption timing drift (±150 ms)', () => {
  const onsets = [0, 1.62, 3.74];
  it('aligned captions pass', () => {
    const c = checkCaptionTiming(makeVoiceTrack('v.wav'), onsets, T);
    expect(fails(c)).toEqual([]);
    expect(byId(c, 'tech.caption_drift')[0]?.status).toBe('pass');
  });
  it('140 ms drift passes, 160 ms drift fails on that beat', () => {
    expect(fails(checkCaptionTiming(makeVoiceTrack('v.wav', 140), onsets, T))).toEqual([]);
    const c = checkCaptionTiming(makeVoiceTrack('v.wav', 160), onsets, T);
    const f = byId(c, 'tech.caption_drift').find((x) => x.status === 'fail');
    expect(f?.beatIndex).toBe(1);
    expect(f?.details.driftMs).toBe(160);
  });
  it('a reference transcription catches per-word drift inside a beat', () => {
    const track = makeVoiceTrack('v.wav');
    const ref = track.words.map((w) => ({
      text: w.text,
      startMs: w.text === 'water' ? w.startMs + 400 : w.startMs,
    }));
    expect(fails(checkCaptionTiming(track, onsets, T, ref))).toContain('tech.caption_drift');
  });
  it('words out of order or outside their beat fail', () => {
    const track = makeVoiceTrack('v.wav');
    const w = track.words[3];
    if (!w) throw new Error('fixture');
    w.startMs = 100;
    expect(fails(checkCaptionTiming(track, onsets, T))).toContain('tech.caption_words');
    const t2 = makeVoiceTrack('v.wav');
    const last = t2.words[t2.words.length - 1];
    if (!last) throw new Error('fixture');
    last.startMs = 9000;
    last.endMs = 9200;
    expect(fails(checkCaptionTiming(t2, onsets, T))).toContain('tech.caption_drift');
  });
  it('no measurement => skip, never a silent pass', () => {
    const c = checkCaptionTiming(makeVoiceTrack('v.wav'), null, T);
    expect(byId(c, 'tech.caption_drift')[0]?.status).toBe('skip');
  });
  it('interpolated words are flagged as a warning', () => {
    const track = { ...makeVoiceTrack('v.wav'), unmatchedWordCount: 2 };
    expect(byId(checkCaptionTiming(track, onsets, T), 'tech.caption_unmatched')[0]?.status).toBe('warn');
  });
});

describe('sceneAtSec', () => {
  it('maps seconds to scene index', () => {
    const rep = makeRenderReport(9, 3);
    expect(sceneAtSec(rep, 0)).toBe(0);
    expect(sceneAtSec(rep, 2.99)).toBe(0);
    expect(sceneAtSec(rep, 3)).toBe(1);
    expect(sceneAtSec(rep, 8.99)).toBe(2);
    expect(sceneAtSec(rep, 20)).toBeNull();
  });
});

describe.skipIf(!HAS_FFMPEG)('technical QA on real ffmpeg fixtures', () => {
  let fx: Record<FixtureName, string>;
  beforeAll(async () => {
    fx = await ensureQaFixtures();
  }, MEDIA_TIMEOUT);

  const fxPath = (name: FixtureName): string => {
    const p = fx[name];
    if (!p) throw new Error(`fixture ${name} missing`);
    return p;
  };
  const run = (name: FixtureName, seconds: number, shiftMs = 0) =>
    technicalChecks({
      videoPath: fxPath(name),
      brand,
      renderReport: makeRenderReport(seconds),
      voiceTrack: makeVoiceTrack(fxPath('voice'), shiftMs),
    });

  it(
    'good fixture passes everything (incl. measured caption drift)',
    async () => {
      const c = await run('good', 20);
      expect(fails(c)).toEqual([]);
      expect(byId(c, 'tech.caption_drift')[0]?.status).toBe('pass');
      expect(byId(c, 'tech.loudness')[0]?.status).toBe('pass');
    },
    MEDIA_TIMEOUT,
  );

  it.each<[FixtureName, number, string[]]>([
    ['wrong_aspect', 6, ['tech.resolution', 'tech.aspect']],
    ['no_audio', 6, ['tech.audio_stream']],
    ['black_frames', 8, ['tech.black_frames']],
    ['frozen', 10, ['tech.freeze']],
    ['silent_gap', 10, ['tech.silence']],
    ['too_loud', 6, ['tech.loudness', 'tech.true_peak']],
    ['too_long', 62, ['tech.duration']],
    ['wrong_fps', 6, ['tech.fps']],
    ['wrong_codec', 6, ['tech.video_codec']],
  ])(
    '%s is caught (%j)',
    async (name, seconds, expected) => {
      const f = fails(await run(name, seconds));
      for (const id of expected) expect(f).toContain(id);
    },
    MEDIA_TIMEOUT,
  );

  it(
    'black frames are located in the right scene for the auto-fix',
    async () => {
      const c = await run('black_frames', 8);
      const b = byId(c, 'tech.black_frames')[0];
      expect(b?.details.startSec).toBeCloseTo(3, 1);
      expect(b?.beatIndex).toBe(1);
    },
    MEDIA_TIMEOUT,
  );

  it(
    'captions shifted 300 ms against the real voice track fail drift',
    async () => {
      const c = await run('good', 20, 300);
      const f = byId(c, 'tech.caption_drift').find((x) => x.status === 'fail');
      expect(f?.beatIndex).toBe(1);
    },
    MEDIA_TIMEOUT,
  );

  it('a missing or unreadable file fails cleanly instead of crashing', async () => {
    const c = await technicalChecks({
      videoPath: `${fx.good}.missing.mp4`,
      brand,
      renderReport: makeRenderReport(20),
      voiceTrack: null,
    });
    expect(fails(c)).toEqual(['tech.probe']);
  });
});
