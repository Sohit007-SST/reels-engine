/**
 * qa-reviewer wrappers for the QA module (src/qa/visual.ts, src/qa/originality.ts).
 *
 *  createQaReviewer()       -> VisualReviewer: the agent may Read ONLY the frames folder (the CLI
 *                              gets `--tools Read --allowedTools Read(//<framesDir>/**)` and runs with
 *                              that folder as cwd). Frame files must live inside that folder.
 *  createOriginalityJudge() -> OriginalityJudge: same persona, no frames (empty sandbox folder).
 *
 * Both throw on a rejected agent run; runVisualQa / the originality check turn a thrown error
 * into a failing QA check (fail closed). Script text and earlier texts are untrusted data.
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JudgeInput, OriginalityJudge } from '../qa/originality';
import type { VisualReviewer, VisualReviewInput } from '../qa/visual';
import { OriginalityJudgeOutput, QaReviewerOutput } from './outputs';
import { agentRecordPath, runAgent, type ClaudeRunner } from './runAgent';

export interface QaReviewerOptions {
  runId: string;
  /** For AgentRunRecords: data/agent-runs/<date>/... (omit to skip persisting). */
  dataDir?: string;
  date?: string;
  model?: string;
  runner?: ClaudeRunner;
  timeoutMs?: number;
  baseEnv?: Record<string, string | undefined>;
}

const SAFE_FILE = /^[A-Za-z0-9._-]+$/;

/** Frame paths relative to framesDir; throws if any frame lies outside it or has an odd name. */
export function framesInside(framesDir: string, frames: Array<{ path: string }>): string[] {
  const root = path.resolve(framesDir);
  return frames.map((f) => {
    const rel = path.relative(root, path.resolve(root, f.path));
    if (
      !rel ||
      rel.startsWith('..') ||
      path.isAbsolute(rel) ||
      rel.includes(path.sep) ||
      !SAFE_FILE.test(rel)
    ) {
      throw new Error(`frame ${path.basename(f.path)} is not a plain file inside the frames folder`);
    }
    return rel;
  });
}

function recordPathFor(opts: QaReviewerOptions, suffix: string): string | undefined {
  if (!opts.dataDir || !opts.date) return undefined;
  return agentRecordPath(opts.dataDir, opts.date, opts.runId, 'qa-reviewer', suffix);
}

export function createQaReviewer(opts: QaReviewerOptions): VisualReviewer {
  return async (input: VisualReviewInput) => {
    if (input.frames.length === 0) throw new Error('no frames to review');
    const framesDir = path.resolve(input.framesDir);
    const files = framesInside(framesDir, input.frames);
    const frameIdx = new Set(input.frames.map((f) => f.frame));
    const listing = input.frames
      .map(
        (f, i) => `- ${files[i]}: frame ${f.frame}, scene ${f.sceneIndex ?? 'none'}, ${f.labels.join('+')}`,
      )
      .join('\n');
    const recordPath = recordPathFor(opts, `visual-${input.reelId}`);
    const res = await runAgent({
      agent: 'qa-reviewer',
      runId: opts.runId,
      instruction: [
        `Review the sampled frames of reel ${input.reelId}. Open each of these files with Read (they are in your working folder):`,
        listing,
        `Brand look: palette ${Object.values(input.brand.palette).join(', ')}; style: ${input.brand.styleSuffix}.`,
        'The script is in the data block. Return the review JSON.',
      ].join('\n'),
      data: input.spec
        ? [
            {
              label: 'script',
              content: {
                hook: input.spec.hook.onScreen,
                beats: input.spec.beats.map((b, i) => ({
                  index: i,
                  role: b.role,
                  onScreenText: b.onScreenText,
                })),
              },
            },
          ]
        : [],
      schema: QaReviewerOutput,
      validate: (out) =>
        out.issues
          .filter((i) => i.frame !== null && !frameIdx.has(i.frame))
          .map((i) => `issue frame ${i.frame} was not one of the listed frames`),
      readOnlyDir: framesDir,
      inputRefs: [input.reelId, ...files],
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.runner ? { runner: opts.runner } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.baseEnv ? { baseEnv: opts.baseEnv } : {}),
      ...(recordPath ? { recordPath } : {}),
    });
    if (!res.ok || !res.output)
      throw new Error(`qa-reviewer rejected: ${res.record.error ?? 'invalid output'}`);
    return res.output;
  };
}

function emptySandbox(): string {
  const dir = path.join(os.tmpdir(), 'reels-engine-agent', 'judge-empty');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createOriginalityJudge(opts: QaReviewerOptions): OriginalityJudge {
  return async (input: JudgeInput) => {
    const recordPath = recordPathFor(opts, `judge-${input.closest.id}`);
    const res = await runAgent({
      agent: 'qa-reviewer',
      runId: opts.runId,
      instruction:
        'Originality question: compare our text with the closest earlier text in the data. Do not open any file. Return {"verdict","reason"}.',
      data: [
        { label: 'our_text', content: input.ours.slice(0, 4000) },
        {
          label: 'closest_earlier_text',
          content: { source: input.closest.source, text: input.closest.text.slice(0, 4000) },
        },
        { label: 'similarity_signals', content: input.signals },
      ],
      schema: OriginalityJudgeOutput,
      readOnlyDir: emptySandbox(),
      inputRefs: [input.closest.id],
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.runner ? { runner: opts.runner } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.baseEnv ? { baseEnv: opts.baseEnv } : {}),
      ...(recordPath ? { recordPath } : {}),
    });
    if (!res.ok || !res.output)
      throw new Error(`originality judge rejected: ${res.record.error ?? 'invalid output'}`);
    return res.output;
  };
}
