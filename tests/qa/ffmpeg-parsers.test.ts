import { describe, expect, it } from 'vitest';
import {
  parseAnalysis,
  parseFrameStats,
  parseProbeJson,
  runProcess,
  speechOnsets,
} from '../../src/qa/ffmpeg';

describe('ffprobe JSON parser', () => {
  it('reads video + audio stream facts', () => {
    const json = JSON.stringify({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1080,
          height: 1920,
          avg_frame_rate: '30/1',
          pix_fmt: 'yuv420p',
          nb_frames: '600',
        },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
      ],
      format: { duration: '20.000000', size: '8237245' },
    });
    const p = parseProbeJson(json);
    expect(p).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 30,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioSampleRate: 48000,
      durationSec: 20,
      sizeBytes: 8237245,
      frameCount: 600,
    });
  });

  it('handles NTSC rates, a missing audio stream and 0/0 rates', () => {
    const p = parseProbeJson(
      JSON.stringify({
        streams: [{ codec_type: 'video', avg_frame_rate: '0/0', r_frame_rate: '30000/1001' }],
        format: {},
      }),
    );
    expect(p.fps).toBeCloseTo(29.97, 2);
    expect(p.audioCodec).toBeNull();
    expect(p.durationSec).toBeNull();
  });
});

describe('ffmpeg analysis stderr parser', () => {
  const stderr = [
    '[blackdetect @ 0x1] black_start:3 black_end:4.0333 black_duration:1.0333',
    '[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 5.7333',
    '[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 3.2667',
    '[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 9',
    '[silencedetect @ 0x3] silence_start: 4.1',
    '[silencedetect @ 0x3] silence_end: 7.1 | silence_duration: 3',
    '[silencedetect @ 0x3] silence_start: 9.5',
    '[Parsed_ebur128_1 @ 0x4] Summary:',
    '  Integrated loudness:',
    '    I:         -14.2 LUFS',
    '  True peak:',
    '    Peak:       -1.6 dBFS',
  ].join('\n');

  it('extracts intervals and loudness', () => {
    const a = parseAnalysis(stderr, 10);
    expect(a.black).toEqual([{ startSec: 3, endSec: 4.0333, durationSec: 1.0333 }]);
    expect(a.freeze[0]).toMatchObject({ startSec: 5.7333, endSec: 9 });
    expect(a.silence).toHaveLength(2);
    // still-open silence at EOF lasts until the end of the file
    expect(a.silence[1]).toMatchObject({ startSec: 9.5, endSec: 10 });
    expect(a.integratedLufs).toBe(-14.2);
    expect(a.truePeakDb).toBe(-1.6);
  });

  it('returns nulls when there is no loudness summary', () => {
    const a = parseAnalysis('', 5);
    expect(a.integratedLufs).toBeNull();
    expect(a.truePeakDb).toBeNull();
    expect(a.black).toEqual([]);
  });

  it('parses -inf loudness (digital silence)', () => {
    const a = parseAnalysis('Summary:\n    I:         -inf LUFS\n    Peak:       -inf dBFS', 5);
    expect(a.integratedLufs).toBe(-Infinity);
  });
});

describe('speech onsets', () => {
  it('derives onsets from silence gaps', () => {
    const onsets = speechOnsets(
      [
        { startSec: 1.5, endSec: 1.62, durationSec: 0.12 },
        { startSec: 3.62, endSec: 3.74, durationSec: 0.12 },
        { startSec: 5.24, endSec: 5.5, durationSec: 0.26 },
      ],
      5.5,
    );
    expect(onsets).toEqual([0, 1.62, 3.74]);
  });

  it('leading silence => first onset is its end', () => {
    expect(speechOnsets([{ startSec: 0, endSec: 0.4, durationSec: 0.4 }], 3)).toEqual([0.4]);
  });
});

describe('frame stats parser', () => {
  it('maps pts_time to frame index and reads YLOW/YHIGH', () => {
    const s = parseFrameStats(
      [
        'frame:0    pts:0       pts_time:0',
        'lavfi.signalstats.YLOW=16',
        'lavfi.signalstats.YHIGH=235',
        'frame:1    pts:45568   pts_time:2.966667',
        'lavfi.signalstats.YLOW=106',
        'lavfi.signalstats.YHIGH=106',
      ].join('\n'),
      30,
    );
    expect(s).toEqual([
      { frame: 0, yLow: 16, yHigh: 235 },
      { frame: 89, yLow: 106, yHigh: 106 },
    ]);
  });
});

describe('runProcess', () => {
  it('kills a process that exceeds its timeout', async () => {
    await expect(runProcess('sleep', ['5'], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });
  it('rejects on non-zero exit and on a missing binary', async () => {
    await expect(runProcess('false', [])).rejects.toThrow(/exited with code 1/);
    await expect(runProcess('definitely-not-a-binary-xyz', [])).rejects.toThrow(/could not start/);
  });
});
