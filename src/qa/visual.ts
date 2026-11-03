/**
 * Visual QA (spec 7.7, PA-15): scene-aware frame sampling + an injected reviewer.
 *
 * Samples: frame 0, the cover frame, and the first / middle / last frame of EVERY scene, extracted
 * exactly with ffmpeg's select filter in one decode pass. A deterministic pre-check flags blank
 * (flat) frames, which catches glitches at scene boundaries without any model. The judgment
 * (hook readable, no cut-off text, no garbled AI text or deformed hands/faces, no logos or real
 * people, on-brand) comes from a VisualReviewer function: the agents module supplies the Claude
 * qa-reviewer; tests use a fake. The reviewer's output is validated with zod (fail closed).
 */
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import type { Brand, QaCheck, ReelSpec, RenderReport } from '../schemas';
import { createLogger } from '../lib/logger';
import { serializeError } from '../lib/redact';
import { extractFramesExact, type FrameStat } from './ffmpeg';

export type SampleLabel = 'frame0' | 'cover' | 'scene_first' | 'scene_middle' | 'scene_last';

export interface FrameSample {
  frame: number;
  labels: SampleLabel[];
  /** Scene that contains the frame (null if outside every scene). */
  sceneIndex: number | null;
}

function clampFrame(f: number, report: RenderReport): number {
  return Math.min(Math.max(0, Math.round(f)), Math.max(0, report.durationInFrames - 1));
}

/** Last frame of a scene; endFrame is treated as exclusive when it is greater than startFrame. */
function sceneLast(s: RenderReport['scenes'][number]): number {
  return s.endFrame > s.startFrame ? s.endFrame - 1 : s.startFrame;
}

/** Labeled sampling plan (sorted, unique frames). */
export function sampleFramePlan(report: RenderReport): FrameSample[] {
  const byFrame = new Map<number, FrameSample>();
  const sceneOf = (frame: number): number | null => {
    for (const s of report.scenes) if (frame >= s.startFrame && frame <= sceneLast(s)) return s.index;
    return null;
  };
  const add = (raw: number, label: SampleLabel, scene?: number) => {
    const frame = clampFrame(raw, report);
    const cur = byFrame.get(frame) ?? { frame, labels: [], sceneIndex: scene ?? sceneOf(frame) };
    if (!cur.labels.includes(label)) cur.labels.push(label);
    byFrame.set(frame, cur);
  };
  add(0, 'frame0');
  add(report.coverFrame, 'cover');
  for (const s of report.scenes) {
    const last = sceneLast(s);
    add(s.startFrame, 'scene_first', s.index);
    add(Math.floor((s.startFrame + last) / 2), 'scene_middle', s.index);
    add(last, 'scene_last', s.index);
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/** Frame indexes to sample: first/middle/last of every scene + frame 0 + cover frame. */
export function sampleFrames(report: RenderReport): number[] {
  return sampleFramePlan(report).map((s) => s.frame);
}

// ---------------------------------------------------------------- reviewer contract

export const VisualIssue = z.object({
  frame: z.number().int().nonnegative().nullable(),
  sceneIndex: z.number().int().nonnegative().nullable(),
  kind: z.enum([
    'hook_unreadable',
    'text_cut_off',
    'garbled_text',
    'deformed_anatomy',
    'logo',
    'real_person',
    'off_brand',
    'other',
  ]),
  severity: z.enum(['minor', 'major']),
  note: z.string().max(500),
});
export type VisualIssue = z.infer<typeof VisualIssue>;

/** What the qa-reviewer agent (or any reviewer) must return. */
export const VisualReview = z.object({
  schemaVersion: z.literal(1),
  hookReadable: z.boolean(),
  textCutOff: z.boolean(),
  garbledText: z.boolean(),
  deformedAnatomy: z.boolean(),
  logosOrRealPeople: z.boolean(),
  onBrand: z.boolean(),
  issues: z.array(VisualIssue).max(50),
  summary: z.string().max(1000),
});
export type VisualReview = z.infer<typeof VisualReview>;

export interface ReviewFrame extends FrameSample {
  path: string;
}

export interface VisualReviewInput {
  reelId: string;
  framesDir: string;
  frames: ReviewFrame[];
  spec: ReelSpec | null;
  brand: Brand;
}

export type VisualReviewer = (input: VisualReviewInput) => Promise<unknown>;

// ---------------------------------------------------------------- checks

const check = (
  id: string,
  status: QaCheck['status'],
  message: string,
  details: Record<string, unknown> = {},
  beatIndex: number | null = null,
): QaCheck => ({ id, category: 'visual', status, message, details, beatIndex });

/** Luma spread (10th..90th percentile) below this means a flat/blank frame. */
export const FLAT_FRAME_SPREAD = 8;

export function checkFrameStats(stats: FrameStat[], plan: FrameSample[]): QaCheck[] {
  const out: QaCheck[] = [];
  const missing = plan.filter((p) => !stats.some((s) => s.frame === p.frame));
  if (missing.length > 0) {
    out.push(
      check('visual.frames_extracted', 'fail', `${missing.length} sampled frames could not be extracted`, {
        frames: missing.map((m) => m.frame),
      }),
    );
  } else {
    out.push(
      check('visual.frames_extracted', 'pass', `${plan.length} frames sampled`, { count: plan.length }),
    );
  }
  const flat = stats.filter(
    (s) => s.yLow !== null && s.yHigh !== null && s.yHigh - s.yLow < FLAT_FRAME_SPREAD,
  );
  for (const f of flat) {
    const p = plan.find((x) => x.frame === f.frame);
    out.push(
      check(
        'visual.blank_frame',
        'fail',
        `frame ${f.frame} (${p?.labels.join('/') ?? 'sample'}) is blank or flat (luma ${f.yLow}-${f.yHigh})`,
        { frame: f.frame, yLow: f.yLow, yHigh: f.yHigh, labels: p?.labels ?? [] },
        p?.sceneIndex ?? null,
      ),
    );
  }
  if (flat.length === 0) out.push(check('visual.blank_frame', 'pass', 'no blank sampled frames'));
  return out;
}

const DIMENSIONS: Array<{
  id: string;
  key: keyof Pick<
    VisualReview,
    'hookReadable' | 'textCutOff' | 'garbledText' | 'deformedAnatomy' | 'logosOrRealPeople' | 'onBrand'
  >;
  good: boolean;
  label: string;
  kinds: VisualIssue['kind'][];
}> = [
  {
    id: 'visual.hook_readable',
    key: 'hookReadable',
    good: true,
    label: 'hook reads at a glance',
    kinds: ['hook_unreadable'],
  },
  {
    id: 'visual.text_cut_off',
    key: 'textCutOff',
    good: false,
    label: 'no text cut off',
    kinds: ['text_cut_off'],
  },
  {
    id: 'visual.garbled_text',
    key: 'garbledText',
    good: false,
    label: 'no garbled AI text',
    kinds: ['garbled_text'],
  },
  {
    id: 'visual.anatomy',
    key: 'deformedAnatomy',
    good: false,
    label: 'no deformed faces or hands',
    kinds: ['deformed_anatomy'],
  },
  {
    id: 'visual.logos_people',
    key: 'logosOrRealPeople',
    good: false,
    label: 'no logos or real people',
    kinds: ['logo', 'real_person'],
  },
  { id: 'visual.on_brand', key: 'onBrand', good: true, label: 'look is on-brand', kinds: ['off_brand'] },
];

/** Turn a validated review into checks (major issues fail; minor issues warn). */
export function reviewToChecks(review: VisualReview): QaCheck[] {
  const out: QaCheck[] = [];
  for (const d of DIMENSIONS) {
    const ok = review[d.key] === d.good;
    const related = review.issues.filter((i) => d.kinds.includes(i.kind));
    const beat = related.find((i) => i.sceneIndex !== null)?.sceneIndex ?? null;
    out.push(
      ok
        ? check(d.id, 'pass', d.label)
        : check(
            d.id,
            'fail',
            `reviewer: ${d.label} FAILED${related[0] ? ` (${related[0].note})` : ''}`,
            {
              issues: related,
            },
            beat,
          ),
    );
  }
  for (const i of review.issues) {
    const covered = DIMENSIONS.some((d) => d.kinds.includes(i.kind) && review[d.key] !== d.good);
    if (covered) continue;
    out.push(
      check(
        'visual.issue',
        i.severity === 'major' ? 'fail' : 'warn',
        `reviewer (${i.kind}, frame ${i.frame ?? '?'}): ${i.note}`,
        { issue: i },
        i.sceneIndex,
      ),
    );
  }
  return out;
}

export interface VisualQaInput {
  videoPath: string;
  renderReport: RenderReport;
  brand: Brand;
  spec: ReelSpec | null;
  /** Where sampled PNGs go (e.g. out/<reelId>/frames). The reviewer may read ONLY this folder. */
  framesDir: string;
}

export interface VisualQaResult {
  checks: QaCheck[];
  samples: ReviewFrame[];
  review: VisualReview | null;
  /** true when no reviewer was available, so a human must look (verdict flagged). */
  unreviewed: boolean;
}

export async function runVisualQa(
  input: VisualQaInput,
  reviewer: VisualReviewer | null,
): Promise<VisualQaResult> {
  const log = createLogger({ stage: 'qa.visual', reelId: input.renderReport.reelId });
  const plan = sampleFramePlan(input.renderReport);
  const checks: QaCheck[] = [];
  let samples: ReviewFrame[] = [];
  try {
    await mkdir(input.framesDir, { recursive: true });
    const { paths, stats } = await extractFramesExact(
      input.videoPath,
      plan.map((p) => p.frame),
      input.framesDir,
      input.renderReport.fps,
    );
    samples = plan.flatMap((p) => {
      const pth = paths.get(p.frame);
      return pth ? [{ ...p, path: pth }] : [];
    });
    checks.push(...checkFrameStats(stats, plan));
  } catch (err) {
    checks.push(
      check('visual.frames_extracted', 'fail', `frame extraction failed: ${serializeError(err).message}`),
    );
    return { checks, samples, review: null, unreviewed: true };
  }

  if (!reviewer) {
    checks.push(
      check('visual.review', 'warn', 'no visual reviewer configured; owner must look at the frames'),
    );
    return { checks, samples, review: null, unreviewed: true };
  }
  let raw: unknown;
  try {
    raw = await reviewer({
      reelId: input.renderReport.reelId,
      framesDir: input.framesDir,
      frames: samples,
      spec: input.spec,
      brand: input.brand,
    });
  } catch (err) {
    log.warn('visual reviewer failed', { err });
    checks.push(check('visual.review', 'fail', `visual reviewer failed: ${serializeError(err).message}`));
    return { checks, samples, review: null, unreviewed: false };
  }
  const parsed = VisualReview.safeParse(raw);
  if (!parsed.success) {
    checks.push(
      check('visual.review', 'fail', 'visual reviewer returned invalid JSON (fail closed)', {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      }),
    );
    return { checks, samples, review: null, unreviewed: false };
  }
  checks.push(check('visual.review', 'pass', parsed.data.summary || 'reviewed'));
  checks.push(...reviewToChecks(parsed.data));
  return { checks, samples, review: parsed.data, unreviewed: false };
}
