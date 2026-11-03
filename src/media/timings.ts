/**
 * T2.4 Word timings (spec 7.4).
 *
 * faster-whisper gives timestamps ONLY. Captions always show the canonical script words:
 * recognized words are aligned to script words (global DP alignment with fuzzy matching,
 * 1:2 and 2:1 merges for split/joined words, and a beat-window constraint because every
 * beat's position in the voice track is known exactly from synthesis). Script words with no
 * acceptable match get timings interpolated inside their beat and are flagged matched=false.
 *
 * Tolerance: caption word starts must be within ±150 ms of the speech (QA fails beyond).
 */
import path from 'node:path';
import { createLogger } from '../lib/logger';
import { VoiceTrack, type CaptionWord, type ReelSpec } from '../schemas';
import { runPythonJson } from './proc';
import { readWav, speechBounds } from './wav';

export const CAPTION_TOLERANCE_MS = 150;
const WHISPER_TIMEOUT_MS = 10 * 60_000;
/** Minimum similarity (0..1) for a recognized word to count as the script word. */
export const MATCH_MIN_SIMILARITY = 0.6;
const MERGE_MIN_SIMILARITY = 0.85;
/** A recognized word may sit this far outside its script word's beat window and still match. */
const WINDOW_SLACK_MS = 250;

export interface RecognizedWord {
  word: string;
  startMs: number;
  endMs: number;
  probability?: number;
}

export interface BeatWindow {
  index: number;
  startMs: number;
  durationMs: number;
  text: string;
}

export interface AlignResult {
  words: CaptionWord[];
  unmatchedWordCount: number;
}

/** Lowercase, strip accents' compatibility forms and everything that is not a letter/mark/digit. */
export function normalizeToken(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

/** Script words as shown in captions (whitespace tokens that contain a letter or digit). */
export function splitScriptWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => normalizeToken(w).length > 0);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

/** 0..1 similarity of two normalized tokens. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

interface ScriptTok {
  text: string;
  norm: string;
  beat: number;
  beatStart: number;
  beatEnd: number;
}
interface RecTok {
  norm: string;
  startMs: number;
  endMs: number;
}

type Move = 'S' | 'R' | 'D' | 'M' | 'M12' | 'M21';

/** Align recognized words to the script. Pure and deterministic (unit tested). */
export function alignWords(
  beats: BeatWindow[],
  recognized: RecognizedWord[],
  opts: { windowSlackMs?: number } = {},
): AlignResult {
  const slack = opts.windowSlackMs ?? WINDOW_SLACK_MS;
  const S: ScriptTok[] = [];
  for (const b of beats) {
    for (const w of splitScriptWords(b.text)) {
      S.push({
        text: w,
        norm: normalizeToken(w),
        beat: b.index,
        beatStart: b.startMs,
        beatEnd: b.startMs + b.durationMs,
      });
    }
  }
  const R: RecTok[] = recognized
    .map((r) => ({ norm: normalizeToken(r.word), startMs: r.startMs, endMs: Math.max(r.startMs, r.endMs) }))
    .filter((r) => r.norm.length > 0);
  const N = S.length;
  const M = R.length;

  const inWindow = (s: ScriptTok, startMs: number, endMs: number) => {
    const mid = (startMs + endMs) / 2;
    return mid >= s.beatStart - slack && mid <= s.beatEnd + slack;
  };
  const GAP = -0.4;
  const SUB = -0.7;
  const score: Float64Array[] = Array.from({ length: N + 1 }, () => new Float64Array(M + 1).fill(-Infinity));
  const move: Move[][] = Array.from({ length: N + 1 }, () => new Array<Move>(M + 1).fill('S'));
  const row = (i: number) => score[i] as Float64Array;
  row(0)[0] = 0;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= M; j++) {
      if (i === 0 && j === 0) continue;
      let best = -Infinity;
      let mv: Move = 'S';
      const consider = (v: number, m: Move) => {
        if (v > best) {
          best = v;
          mv = m;
        }
      };
      if (i > 0) consider(row(i - 1)[j]! + GAP, 'S');
      if (j > 0) consider(row(i)[j - 1]! + GAP, 'R');
      if (i > 0 && j > 0) {
        const s = S[i - 1]!;
        const r = R[j - 1]!;
        const sim = similarity(s.norm, r.norm);
        if (sim >= MATCH_MIN_SIMILARITY && inWindow(s, r.startMs, r.endMs))
          consider(row(i - 1)[j - 1]! + 1 + sim, 'M');
        else consider(row(i - 1)[j - 1]! + SUB, 'D');
      }
      if (i > 0 && j > 1) {
        const s = S[i - 1]!;
        const r1 = R[j - 2]!;
        const r2 = R[j - 1]!;
        const sim = similarity(s.norm, r1.norm + r2.norm);
        if (sim >= MERGE_MIN_SIMILARITY && inWindow(s, r1.startMs, r2.endMs))
          consider(row(i - 1)[j - 2]! + 1.5 + sim, 'M12');
      }
      if (i > 1 && j > 0) {
        const s1 = S[i - 2]!;
        const s2 = S[i - 1]!;
        const r = R[j - 1]!;
        const sim = similarity(s1.norm + s2.norm, r.norm);
        if (s1.beat === s2.beat && sim >= MERGE_MIN_SIMILARITY && inWindow(s1, r.startMs, r.endMs))
          consider(row(i - 2)[j - 1]! + 1.5 + sim, 'M21');
      }
      row(i)[j] = best;
      move[i]![j] = mv;
    }
  }

  // Backtrack: timing per script token (null = unmatched).
  const timing: Array<{ startMs: number; endMs: number } | null> = new Array<null>(N).fill(null);
  let i = N;
  let j = M;
  while (i > 0 || j > 0) {
    const mv = move[i]![j]!;
    if (mv === 'M') {
      const r = R[j - 1]!;
      timing[i - 1] = { startMs: r.startMs, endMs: r.endMs };
      i--;
      j--;
    } else if (mv === 'M12') {
      timing[i - 1] = { startMs: R[j - 2]!.startMs, endMs: R[j - 1]!.endMs };
      i--;
      j -= 2;
    } else if (mv === 'M21') {
      const r = R[j - 1]!;
      const a = S[i - 2]!;
      const b = S[i - 1]!;
      const split = r.startMs + ((r.endMs - r.startMs) * a.norm.length) / (a.norm.length + b.norm.length);
      timing[i - 2] = { startMs: r.startMs, endMs: split };
      timing[i - 1] = { startMs: split, endMs: r.endMs };
      i -= 2;
      j--;
    } else if (mv === 'D') {
      i--;
      j--;
    } else if (mv === 'S' && i > 0) {
      i--;
    } else {
      j--;
    }
  }

  return buildCaptionWords(S, timing);
}

function buildCaptionWords(
  S: ScriptTok[],
  timing: Array<{ startMs: number; endMs: number } | null>,
): AlignResult {
  const out: CaptionWord[] = [];
  let unmatched = 0;
  let k = 0;
  while (k < S.length) {
    const beat = S[k]!.beat;
    let end = k;
    while (end < S.length && S[end]!.beat === beat) end++;
    const toks = S.slice(k, end);
    const times = timing.slice(k, end);
    const bStart = toks[0]!.beatStart;
    const bEnd = toks[0]!.beatEnd;

    // Clamp matched timings into the beat window.
    const t = times.map((x) =>
      x ? { startMs: clamp(x.startMs, bStart, bEnd), endMs: clamp(x.endMs, bStart, bEnd) } : null,
    );
    // Interpolate unmatched runs between anchors, proportional to word length.
    let p = 0;
    while (p < toks.length) {
      if (t[p]) {
        p++;
        continue;
      }
      let q = p;
      while (q < toks.length && !t[q]) q++;
      const left = p > 0 ? t[p - 1]!.endMs : bStart;
      const right = q < toks.length ? t[q]!.startMs : bEnd;
      const span = Math.max(0, right - left);
      const weights = toks.slice(p, q).map((w) => Math.max(1, w.norm.length));
      const total = weights.reduce((a, b) => a + b, 0);
      let cursor = left;
      for (let r = p; r < q; r++) {
        const dur = (span * weights[r - p]!) / total;
        t[r] = { startMs: cursor, endMs: cursor + dur };
        cursor += dur;
      }
      unmatched += q - p;
      p = q;
    }
    toks.forEach((tok, idx) => {
      const x = t[idx]!;
      out.push({
        text: tok.text,
        startMs: round1(x.startMs),
        endMs: round1(Math.max(x.startMs, x.endMs)),
        beatIndex: beat,
        matched: times[idx] !== null,
      });
    });
    k = end;
  }
  // Enforce monotonic starts and trim overlaps.
  for (let n = 1; n < out.length; n++) {
    const prev = out[n - 1]!;
    const cur = out[n]!;
    if (cur.startMs < prev.startMs) cur.startMs = prev.startMs;
    if (cur.endMs < cur.startMs) cur.endMs = cur.startMs;
    if (prev.endMs > cur.startMs && cur.startMs > prev.startMs) prev.endMs = cur.startMs;
  }
  return { words: out, unmatchedWordCount: unmatched };
}

/** Fallback when no recognizer is available: every word interpolated inside its beat (all flagged). */
export function proportionalWords(beats: BeatWindow[]): AlignResult {
  return alignWords(beats, []);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function beatWindows(spec: ReelSpec, track: VoiceTrack): BeatWindow[] {
  return track.beats.map((b) => ({
    index: b.index,
    startMs: b.startMs,
    durationMs: b.durationMs,
    text: spec.beats[b.index]?.voiceover ?? b.text,
  }));
}

// ---------------------------------------------------------------------------------------------
// Tolerance checks (also usable by QA)
// ---------------------------------------------------------------------------------------------

export interface TimingCheck {
  ok: boolean;
  problems: string[];
  /** Largest |first-word start − measured speech onset| over beats (ms). */
  maxOnsetDriftMs: number;
  matchedRatio: number;
}

/**
 * Pure check of caption timing against measured speech onsets (one per beat, absolute ms in the
 * voice track). Fails when: words are missing, not monotonic, outside their beat (± tolerance),
 * or a beat's first caption word starts more than `toleranceMs` away from the speech onset.
 */
export function captionTimingProblems(
  track: Pick<VoiceTrack, 'beats' | 'words'>,
  onsetsMs: Array<number | null>,
  toleranceMs = CAPTION_TOLERANCE_MS,
): TimingCheck {
  const problems: string[] = [];
  const words = track.words;
  if (words.length === 0) problems.push('no caption words');
  for (let n = 1; n < words.length; n++) {
    if (words[n]!.startMs < words[n - 1]!.startMs) problems.push(`word ${n} starts before word ${n - 1}`);
  }
  let maxDrift = 0;
  for (const b of track.beats) {
    const bw = words.filter((w) => w.beatIndex === b.index);
    if (bw.length === 0) {
      problems.push(`beat ${b.index} has no caption words`);
      continue;
    }
    for (const w of bw) {
      if (w.startMs < b.startMs - toleranceMs || w.startMs > b.startMs + b.durationMs + toleranceMs) {
        problems.push(`word "${w.text}" (beat ${b.index}) starts outside its beat`);
      }
      if (w.endMs < w.startMs) problems.push(`word "${w.text}" ends before it starts`);
    }
    const onset = onsetsMs[b.index];
    if (onset !== null && onset !== undefined) {
      const drift = Math.abs(bw[0]!.startMs - onset);
      maxDrift = Math.max(maxDrift, drift);
      if (drift > toleranceMs) {
        problems.push(
          `beat ${b.index}: first caption word is ${Math.round(drift)} ms from the speech onset (max ${toleranceMs})`,
        );
      }
    }
  }
  const matched = words.filter((w) => w.matched).length;
  return {
    ok: problems.length === 0,
    problems,
    maxOnsetDriftMs: Math.round(maxDrift),
    matchedRatio: words.length ? matched / words.length : 0,
  };
}

/** Compare caption starts to reference starts (same words, same order); drift beyond tolerance fails. */
export function captionDriftProblems(
  words: Array<{ text: string; startMs: number }>,
  reference: Array<{ startMs: number }>,
  toleranceMs = CAPTION_TOLERANCE_MS,
): string[] {
  const problems: string[] = [];
  if (words.length !== reference.length)
    problems.push(`word count ${words.length} != reference ${reference.length}`);
  const n = Math.min(words.length, reference.length);
  for (let k = 0; k < n; k++) {
    const d = Math.abs(words[k]!.startMs - reference[k]!.startMs);
    if (d > toleranceMs) problems.push(`word ${k} "${words[k]!.text}" drifts ${Math.round(d)} ms`);
  }
  return problems;
}

/** Measure each beat's speech onset from its WAV and run captionTimingProblems. */
export async function verifyCaptionTiming(
  track: VoiceTrack,
  toleranceMs = CAPTION_TOLERANCE_MS,
): Promise<TimingCheck & { onsetsMs: Array<number | null> }> {
  const onsets: Array<number | null> = [];
  for (const b of track.beats) {
    const bounds = speechBounds(await readWav(b.audioPath));
    onsets[b.index] = bounds ? b.startMs + bounds.onsetMs : null;
  }
  return { ...captionTimingProblems(track, onsets, toleranceMs), onsetsMs: onsets };
}

// ---------------------------------------------------------------------------------------------
// Pipeline entry
// ---------------------------------------------------------------------------------------------

export interface WhisperResult {
  model: string;
  language?: string;
  words: RecognizedWord[];
}
export type WhisperRunner = (
  audioPath: string,
  o: { lang: string; prompt: string; model: string },
) => Promise<WhisperResult>;

export const fasterWhisperRunner: WhisperRunner = (audioPath, o) =>
  runPythonJson<WhisperResult>(
    'timings_whisper.py',
    ['--audio', path.resolve(audioPath), '--model', o.model, '--lang', o.lang, '--prompt', o.prompt],
    { timeoutMs: WHISPER_TIMEOUT_MS },
  );

export interface AlignOptions {
  runner?: WhisperRunner;
  /** small (default) or base. */
  model?: string;
}

export async function alignWordTimingsWith(
  spec: ReelSpec,
  track: VoiceTrack,
  opts: AlignOptions = {},
): Promise<VoiceTrack> {
  const log = createLogger({ reelId: spec.id, stage: 'timings', provider: 'faster-whisper' });
  const windows = beatWindows(spec, track);
  const runner = opts.runner ?? fasterWhisperRunner;
  const model = opts.model ?? process.env.WHISPER_MODEL ?? 'small';
  // The script biases spelling only; whisper output is still used for timestamps only.
  const prompt = spec.beats
    .map((b) => b.voiceover)
    .join(' ')
    .slice(0, 600);
  let result: AlignResult;
  let source: VoiceTrack['timingSource'];
  try {
    const rec = await log.time('whisper', () =>
      runner(track.voicePath, { lang: spec.language, prompt, model }),
    );
    result = alignWords(windows, rec.words);
    source = 'faster-whisper';
  } catch (err) {
    log.warn('recognizer failed; falling back to proportional timings (all words flagged)', { err });
    result = proportionalWords(windows);
    source = 'proportional';
  }
  log.info('aligned', { words: result.words.length, unmatched: result.unmatchedWordCount, source });
  return VoiceTrack.parse({
    ...track,
    words: result.words,
    unmatchedWordCount: result.unmatchedWordCount,
    timingSource: source,
  });
}
