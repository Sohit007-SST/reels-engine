/**
 * Technical QA (spec 7.7, task T2.6).
 *
 *  ffprobe:  resolution, 9:16 aspect, fps, codec, audio stream (AAC 48 kHz), duration <= 60 s, size <= 20 MB
 *  ffmpeg:   blackdetect, freezedetect, silencedetect, ebur128 loudness + true peak (one decode pass)
 *  captions: word timings vs measured speech onsets on the voice track (±150 ms), ordering, beat bounds
 *  layout:   every text box from the render report inside the safe zone, no overflow
 *
 * Every check returns a QaCheck; defects that map to a scene carry beatIndex for the one auto-fix.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Brand, QaCheck, RenderReport, TextBox, VoiceTrack } from '../schemas';
import { createLogger } from '../lib/logger';
import { serializeError } from '../lib/redact';
import {
  analyzeMedia,
  detectSilences,
  probe,
  speechOnsets,
  type AnalysisResult,
  type Interval,
  type ProbeResult,
} from './ffmpeg';

export interface TechnicalThresholds {
  /** Caption start vs speech tolerance (spec 7.4). */
  captionToleranceMs: number;
  /** Any black interval at least this long fails. */
  blackMinSec: number;
  /** Any frozen interval at least this long fails. */
  freezeFailSec: number;
  /** Any silence at least this long fails (voice reels should never go quiet this long). */
  silenceFailSec: number;
  /** Silence that touches the very end of the file is ignored up to this much (loop tail). */
  trailingSilenceGraceSec: number;
  /** Integrated loudness must be within target ± this (LU). */
  loudnessToleranceLu: number;
  /** True peak may exceed the brand ceiling by at most this (dB) to absorb AAC overshoot. */
  truePeakToleranceDb: number;
  /** Allowed fps deviation. */
  fpsTolerance: number;
  /** Required codecs / audio rate (spec 7.6). */
  videoCodec: string;
  audioCodec: string;
  audioSampleRate: number;
  /** Render report vs file duration mismatch (s) that triggers a warning. */
  durationMismatchWarnSec: number;
}

export const DEFAULT_TECHNICAL_THRESHOLDS: TechnicalThresholds = {
  captionToleranceMs: 150,
  blackMinSec: 0.1,
  freezeFailSec: 2.5,
  silenceFailSec: 2.0,
  trailingSilenceGraceSec: 1.0,
  loudnessToleranceLu: 1.0,
  truePeakToleranceDb: 0.5,
  fpsTolerance: 0.01,
  videoCodec: 'h264',
  audioCodec: 'aac',
  audioSampleRate: 48_000,
  durationMismatchWarnSec: 0.5,
};

export interface TechnicalQaOptions {
  thresholds?: Partial<TechnicalThresholds>;
  /** Inject measured speech onsets (seconds) instead of analysing voiceTrack.voicePath. */
  speechOnsetsSec?: number[];
  /**
   * Independent word timings (e.g. a second transcription). When given, each caption word is
   * compared with the reference word at the same index (same text) as well.
   */
  referenceWords?: Array<{ text: string; startMs: number }>;
  /** Base dir for relative paths in the voice track (default: cwd). */
  baseDir?: string;
}

const check = (
  id: string,
  status: QaCheck['status'],
  message: string,
  details: Record<string, unknown> = {},
  beatIndex: number | null = null,
): QaCheck => ({ id, category: 'technical', status, message, details, beatIndex });

/** Scene (beat) index that contains a time, from the render report. */
export function sceneAtSec(report: RenderReport, sec: number): number | null {
  const frame = Math.floor(sec * report.fps);
  for (const s of report.scenes) {
    const end = Math.max(s.endFrame, s.startFrame + 1);
    if (frame >= s.startFrame && frame < end) return s.index;
  }
  return null;
}

// ---------------------------------------------------------------- container / stream checks

export function checkProbe(p: ProbeResult, brand: Brand, t: TechnicalThresholds): QaCheck[] {
  const out: QaCheck[] = [];
  const W = brand.video.width;
  const H = brand.video.height;

  if (p.width === null || p.height === null) {
    out.push(check('tech.video_stream', 'fail', 'no video stream found'));
    return out;
  }
  out.push(
    p.width === W && p.height === H
      ? check('tech.resolution', 'pass', `${p.width}x${p.height}`, { width: p.width, height: p.height })
      : check('tech.resolution', 'fail', `resolution ${p.width}x${p.height}, expected ${W}x${H}`, {
          width: p.width,
          height: p.height,
        }),
  );
  const aspect = p.width / p.height;
  const want = W / H;
  out.push(
    Math.abs(aspect - want) < 0.005
      ? check('tech.aspect', 'pass', 'aspect 9:16', { aspect })
      : check('tech.aspect', 'fail', `aspect ${aspect.toFixed(4)} is not 9:16 (${want.toFixed(4)})`, {
          aspect,
        }),
  );
  out.push(
    p.fps !== null && Math.abs(p.fps - brand.video.fps) <= t.fpsTolerance
      ? check('tech.fps', 'pass', `${p.fps} fps`, { fps: p.fps })
      : check('tech.fps', 'fail', `fps ${p.fps ?? 'unknown'}, expected ${brand.video.fps}`, { fps: p.fps }),
  );
  out.push(
    p.videoCodec === t.videoCodec
      ? check('tech.video_codec', 'pass', `${p.videoCodec}${p.pixFmt ? ` ${p.pixFmt}` : ''}`, {
          codec: p.videoCodec,
          pixFmt: p.pixFmt,
        })
      : check(
          'tech.video_codec',
          'fail',
          `video codec ${p.videoCodec ?? 'unknown'}, expected ${t.videoCodec}`,
          {
            codec: p.videoCodec,
          },
        ),
  );
  if (p.pixFmt !== null && p.pixFmt !== 'yuv420p') {
    out.push(check('tech.pix_fmt', 'warn', `pixel format ${p.pixFmt}; yuv420p plays everywhere`, {}));
  }

  if (p.audioCodec === null) {
    out.push(check('tech.audio_stream', 'fail', 'no audio stream'));
  } else {
    out.push(check('tech.audio_stream', 'pass', 'audio stream present', { codec: p.audioCodec }));
    const okCodec = p.audioCodec === t.audioCodec;
    const okRate = p.audioSampleRate === t.audioSampleRate;
    out.push(
      okCodec && okRate
        ? check('tech.audio_codec', 'pass', `${p.audioCodec} ${p.audioSampleRate} Hz`, {
            codec: p.audioCodec,
            sampleRate: p.audioSampleRate,
          })
        : check(
            'tech.audio_codec',
            'fail',
            `audio ${p.audioCodec} ${p.audioSampleRate ?? '?'} Hz, expected ${t.audioCodec} ${t.audioSampleRate} Hz`,
            { codec: p.audioCodec, sampleRate: p.audioSampleRate },
          ),
    );
  }

  const maxSec = Math.min(60, brand.video.maxSeconds);
  if (p.durationSec === null) {
    out.push(check('tech.duration', 'fail', 'duration unknown'));
  } else if (p.durationSec > maxSec + 0.05) {
    out.push(
      check('tech.duration', 'fail', `duration ${p.durationSec.toFixed(2)} s exceeds ${maxSec} s`, {
        durationSec: p.durationSec,
        maxSec,
      }),
    );
  } else {
    out.push(check('tech.duration', 'pass', `${p.durationSec.toFixed(2)} s`, { durationSec: p.durationSec }));
    if (p.durationSec < brand.video.minSeconds) {
      out.push(
        check(
          'tech.duration_min',
          'warn',
          `duration ${p.durationSec.toFixed(2)} s is under the ${brand.video.minSeconds} s target`,
          { durationSec: p.durationSec },
        ),
      );
    }
  }

  if (p.sizeBytes === null) {
    out.push(check('tech.size', 'fail', 'file size unknown'));
  } else {
    out.push(
      p.sizeBytes <= brand.video.maxBytes
        ? check('tech.size', 'pass', `${(p.sizeBytes / 1e6).toFixed(2)} MB`, { sizeBytes: p.sizeBytes })
        : check(
            'tech.size',
            'fail',
            `file is ${(p.sizeBytes / 1e6).toFixed(2)} MB, limit ${(brand.video.maxBytes / 1e6).toFixed(2)} MB`,
            { sizeBytes: p.sizeBytes, maxBytes: brand.video.maxBytes },
          ),
    );
  }
  return out;
}

// ---------------------------------------------------------------- decoded-content checks

function intervalsCheck(
  id: string,
  label: string,
  intervals: Interval[],
  minSec: number,
  report: RenderReport,
): QaCheck[] {
  const bad = intervals.filter((i) => i.durationSec >= minSec - 1e-6);
  if (bad.length === 0) return [check(id, 'pass', `no ${label}`, { count: 0 })];
  return bad.map((i) => {
    const beat = sceneAtSec(report, i.startSec + Math.min(i.durationSec, 0.05));
    return check(
      id,
      'fail',
      `${label} from ${i.startSec.toFixed(2)} s to ${i.endSec.toFixed(2)} s (${i.durationSec.toFixed(2)} s)`,
      {
        startSec: i.startSec,
        endSec: i.endSec,
        durationSec: i.durationSec,
        startFrame: Math.floor(i.startSec * report.fps),
      },
      beat,
    );
  });
}

export function checkAnalysis(
  a: AnalysisResult,
  p: ProbeResult,
  brand: Brand,
  report: RenderReport,
  t: TechnicalThresholds,
): QaCheck[] {
  const out: QaCheck[] = [];
  out.push(...intervalsCheck('tech.black_frames', 'black frames', a.black, t.blackMinSec, report));
  out.push(...intervalsCheck('tech.freeze', 'frozen video', a.freeze, t.freezeFailSec, report));

  if (p.audioCodec !== null) {
    const dur = p.durationSec;
    const silences = a.silence.filter(
      (s) => !(dur !== null && s.endSec >= dur - 0.01 && s.durationSec <= t.trailingSilenceGraceSec + 1e-6),
    );
    out.push(...intervalsCheck('tech.silence', 'silence', silences, t.silenceFailSec, report));

    const target = brand.audio.targetLufs;
    if (a.integratedLufs === null || !Number.isFinite(a.integratedLufs)) {
      out.push(check('tech.loudness', 'fail', 'integrated loudness could not be measured'));
    } else {
      const diff = a.integratedLufs - target;
      out.push(
        Math.abs(diff) <= t.loudnessToleranceLu
          ? check('tech.loudness', 'pass', `${a.integratedLufs.toFixed(1)} LUFS`, {
              integratedLufs: a.integratedLufs,
              targetLufs: target,
            })
          : check(
              'tech.loudness',
              'fail',
              `${a.integratedLufs.toFixed(1)} LUFS, target ${target} ±${t.loudnessToleranceLu}`,
              { integratedLufs: a.integratedLufs, targetLufs: target },
            ),
      );
    }
    if (a.truePeakDb === null) {
      out.push(check('tech.true_peak', 'warn', 'true peak could not be measured'));
    } else {
      const ceiling = brand.audio.truePeakDb + t.truePeakToleranceDb;
      out.push(
        a.truePeakDb <= ceiling
          ? check('tech.true_peak', 'pass', `${a.truePeakDb.toFixed(1)} dBTP`, { truePeakDb: a.truePeakDb })
          : check(
              'tech.true_peak',
              'fail',
              `true peak ${a.truePeakDb.toFixed(1)} dBTP above ${brand.audio.truePeakDb} dBTP`,
              { truePeakDb: a.truePeakDb, ceilingDb: ceiling },
            ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- render report checks

export interface SafeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Safe rectangle in px: the stricter of the render report margins and brand.safeZone percentages. */
export function safeRect(report: RenderReport, brand: Brand): SafeRect {
  const W = report.width;
  const H = report.height;
  const z = brand.safeZone;
  const left = Math.max(report.safeZonePx.left, (z.leftPct / 100) * W);
  const right = Math.max(report.safeZonePx.right, (z.rightPct / 100) * W);
  const top = Math.max(report.safeZonePx.top, (z.topPct / 100) * H);
  const bottom = Math.max(report.safeZonePx.bottom, (z.bottomPct / 100) * H);
  return { left, top, right: W - right, bottom: H - bottom };
}

function boxProblems(b: TextBox, r: SafeRect): string[] {
  const eps = 1;
  const p: string[] = [];
  if (b.x < r.left - eps) p.push(`left edge ${b.x.toFixed(0)} < ${r.left.toFixed(0)}`);
  if (b.y < r.top - eps) p.push(`top edge ${b.y.toFixed(0)} < ${r.top.toFixed(0)}`);
  if (b.x + b.width > r.right + eps)
    p.push(`right edge ${(b.x + b.width).toFixed(0)} > ${r.right.toFixed(0)}`);
  if (b.y + b.height > r.bottom + eps)
    p.push(`bottom edge ${(b.y + b.height).toFixed(0)} > ${r.bottom.toFixed(0)}`);
  return p;
}

export function checkTextBounds(report: RenderReport, brand: Brand): QaCheck[] {
  const r = safeRect(report, brand);
  const out: QaCheck[] = [];
  let boxes = 0;
  const visit = (b: TextBox, beatIndex: number | null, where: string) => {
    if (b.text.trim() === '') return;
    boxes++;
    if (b.overflow) {
      out.push(
        check(
          'tech.text_overflow',
          'fail',
          `text "${b.text.slice(0, 40)}" overflows its box (${where})`,
          {
            boxId: b.id,
            where,
          },
          beatIndex,
        ),
      );
    }
    const problems = boxProblems(b, r);
    if (problems.length > 0) {
      out.push(
        check(
          'tech.text_bounds',
          'fail',
          `text "${b.text.slice(0, 40)}" leaves the safe zone (${where}): ${problems.join('; ')}`,
          { boxId: b.id, where, box: { x: b.x, y: b.y, width: b.width, height: b.height }, safe: r },
          beatIndex,
        ),
      );
    }
  };
  for (const s of report.scenes) for (const b of s.textBoxes) visit(b, s.index, `scene ${s.index}`);
  for (const b of report.captionBoxes) {
    const beat = /^cap(?:tion)?[-_]?(\d+)/.exec(b.id);
    visit(b, beat ? Number(beat[1]) : null, 'captions');
  }
  if (!out.some((c) => c.id === 'tech.text_overflow'))
    out.push(check('tech.text_overflow', 'pass', `no overflow in ${boxes} text boxes`, { boxes }));
  if (!out.some((c) => c.id === 'tech.text_bounds'))
    out.push(
      check('tech.text_bounds', 'pass', `${boxes} text boxes inside the safe zone`, { boxes, safe: r }),
    );
  return out;
}

export function checkRenderReportMatch(
  report: RenderReport,
  p: ProbeResult,
  t: TechnicalThresholds,
): QaCheck[] {
  const problems: string[] = [];
  if (p.width !== null && p.height !== null && (p.width !== report.width || p.height !== report.height))
    problems.push(`file ${p.width}x${p.height} vs report ${report.width}x${report.height}`);
  const reportSec = report.durationInFrames / report.fps;
  if (p.durationSec !== null && Math.abs(p.durationSec - reportSec) > t.durationMismatchWarnSec)
    problems.push(`file ${p.durationSec.toFixed(2)} s vs report ${reportSec.toFixed(2)} s`);
  if (report.coverFrame >= report.durationInFrames)
    problems.push(`cover frame ${report.coverFrame} is beyond the last frame`);
  return problems.length === 0
    ? [check('tech.render_report', 'pass', 'render report matches the file')]
    : [check('tech.render_report', 'warn', `render report mismatch: ${problems.join('; ')}`, { problems })];
}

// ---------------------------------------------------------------- caption timing

export function checkCaptionTiming(
  track: VoiceTrack,
  onsetsSec: number[] | null,
  t: TechnicalThresholds,
  referenceWords?: Array<{ text: string; startMs: number }>,
): QaCheck[] {
  const out: QaCheck[] = [];
  const tol = t.captionToleranceMs;
  const words = track.words;
  if (words.length === 0) return [check('tech.caption_words', 'fail', 'voice track has no caption words')];

  // Structure: ordering, sane durations, inside the owning beat.
  const structural: QaCheck[] = [];
  let prevStart = -Infinity;
  words.forEach((w, i) => {
    const beat = track.beats.find((b) => b.index === w.beatIndex);
    if (w.endMs < w.startMs)
      structural.push(
        check(
          'tech.caption_words',
          'fail',
          `word ${i} "${w.text}" ends before it starts`,
          { word: i },
          w.beatIndex,
        ),
      );
    if (w.startMs + 10 < prevStart)
      structural.push(
        check(
          'tech.caption_words',
          'fail',
          `word ${i} "${w.text}" starts before the previous word`,
          { word: i },
          w.beatIndex,
        ),
      );
    prevStart = Math.max(prevStart, w.startMs);
    if (!beat) {
      structural.push(
        check('tech.caption_words', 'fail', `word ${i} "${w.text}" points at missing beat ${w.beatIndex}`, {
          word: i,
        }),
      );
    } else if (w.startMs < beat.startMs - tol || w.startMs > beat.startMs + beat.durationMs + tol) {
      structural.push(
        check(
          'tech.caption_drift',
          'fail',
          `word ${i} "${w.text}" at ${w.startMs} ms is outside beat ${beat.index} (${beat.startMs}-${beat.startMs + beat.durationMs} ms)`,
          { word: i, startMs: w.startMs },
          w.beatIndex,
        ),
      );
    }
  });
  if (!structural.some((c) => c.id === 'tech.caption_words'))
    out.push(check('tech.caption_words', 'pass', `${words.length} caption words ordered and in range`));
  out.push(...structural.filter((c) => c.id === 'tech.caption_words' || c.id === 'tech.caption_drift'));

  if (track.unmatchedWordCount > 0 || words.some((w) => !w.matched)) {
    const n = Math.max(track.unmatchedWordCount, words.filter((w) => !w.matched).length);
    out.push(
      check('tech.caption_unmatched', 'warn', `${n} caption words have interpolated timings`, { count: n }),
    );
  }

  // Drift vs measured speech: the first word of every beat must start within ±tol of a speech onset.
  const drifts: Array<{ beat: number; driftMs: number; wordMs: number; onsetMs: number | null }> = [];
  if (onsetsSec !== null) {
    const onsetsMs = onsetsSec.map((s) => s * 1000);
    for (const b of track.beats) {
      const first = words.find((w) => w.beatIndex === b.index);
      if (!first) continue;
      const lo = b.startMs - 500;
      const hi = b.startMs + b.durationMs;
      const candidates = onsetsMs.filter((o) => o >= lo && o <= hi);
      if (candidates.length === 0) {
        drifts.push({
          beat: b.index,
          driftMs: Number.POSITIVE_INFINITY,
          wordMs: first.startMs,
          onsetMs: null,
        });
        continue;
      }
      const nearest = candidates.reduce((a, c) =>
        Math.abs(c - first.startMs) < Math.abs(a - first.startMs) ? c : a,
      );
      drifts.push({
        beat: b.index,
        driftMs: Math.abs(first.startMs - nearest),
        wordMs: first.startMs,
        onsetMs: nearest,
      });
    }
  }
  if (referenceWords) {
    words.forEach((w, i) => {
      const ref = referenceWords[i];
      if (!ref || ref.text.toLowerCase() !== w.text.toLowerCase()) return;
      const d = Math.abs(w.startMs - ref.startMs);
      if (d > tol) drifts.push({ beat: w.beatIndex, driftMs: d, wordMs: w.startMs, onsetMs: ref.startMs });
    });
  }
  if (onsetsSec === null && !referenceWords) {
    out.push(check('tech.caption_drift', 'skip', 'no speech measurement available (voice file missing)'));
    return out;
  }
  const bad = drifts.filter((d) => d.driftMs > tol);
  for (const d of bad) {
    out.push(
      check(
        'tech.caption_drift',
        'fail',
        d.onsetMs === null
          ? `beat ${d.beat}: no speech found near its first caption word (${d.wordMs} ms)`
          : `beat ${d.beat}: caption at ${Math.round(d.wordMs)} ms vs speech at ${Math.round(d.onsetMs)} ms (drift ${Math.round(d.driftMs)} ms > ${tol} ms)`,
        { driftMs: Number.isFinite(d.driftMs) ? Math.round(d.driftMs) : null, toleranceMs: tol },
        d.beat,
      ),
    );
  }
  if (bad.length === 0 && !out.some((c) => c.id === 'tech.caption_drift' && c.status === 'fail')) {
    const max = drifts.reduce((m, d) => Math.max(m, d.driftMs), 0);
    out.push(
      check('tech.caption_drift', 'pass', `max caption drift ${Math.round(max)} ms (±${tol} ms)`, {
        maxDriftMs: Math.round(max),
        toleranceMs: tol,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- orchestration

export interface TechnicalInput {
  videoPath: string;
  brand: Brand;
  renderReport: RenderReport;
  voiceTrack: VoiceTrack | null;
}

export async function technicalChecks(
  input: TechnicalInput,
  opts: TechnicalQaOptions = {},
): Promise<QaCheck[]> {
  const t: TechnicalThresholds = { ...DEFAULT_TECHNICAL_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const log = createLogger({ stage: 'qa.technical', reelId: input.renderReport.reelId });
  const out: QaCheck[] = [];

  let p: ProbeResult;
  try {
    p = await probe(input.videoPath);
  } catch (err) {
    return [check('tech.probe', 'fail', `ffprobe failed: ${serializeError(err).message}`)];
  }
  out.push(...checkProbe(p, input.brand, t));
  out.push(...checkRenderReportMatch(input.renderReport, p, t));

  if (p.width !== null) {
    try {
      const a = await analyzeMedia(input.videoPath, p.audioCodec !== null, p.durationSec, {
        blackMinSec: t.blackMinSec,
        freezeMinSec: Math.min(2, t.freezeFailSec),
        silenceMinSec: Math.min(1, t.silenceFailSec),
      });
      out.push(...checkAnalysis(a, p, input.brand, input.renderReport, t));
    } catch (err) {
      out.push(check('tech.analysis', 'fail', `ffmpeg analysis failed: ${serializeError(err).message}`));
    }
  }

  out.push(...checkTextBounds(input.renderReport, input.brand));

  if (input.voiceTrack === null) {
    out.push(check('tech.caption_drift', 'skip', 'no voice track supplied'));
  } else {
    let onsets: number[] | null = opts.speechOnsetsSec ?? null;
    if (onsets === null) {
      const voicePath = path.resolve(opts.baseDir ?? process.cwd(), input.voiceTrack.voicePath);
      if (existsSync(voicePath)) {
        try {
          const { silences, durationSec } = await detectSilences(voicePath);
          onsets = speechOnsets(silences, durationSec);
        } catch (err) {
          log.warn('speech onset detection failed', { err });
        }
      }
    }
    out.push(...checkCaptionTiming(input.voiceTrack, onsets, t, opts.referenceWords));
  }
  log.info('technical QA done', {
    fails: out.filter((c) => c.status === 'fail').length,
    checks: out.length,
  });
  return out;
}
