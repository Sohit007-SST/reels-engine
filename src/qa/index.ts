/**
 * QA module (spec 7.7; tasks T2.6, T4.7). Signatures of the original contract are kept:
 * runTechnicalQa, checkFacts, checkPolicy, checkOriginality, sampleFrames, runFullQa.
 *
 * runQA() adds the one automatic fix: if the first pass fails on fixable checks, the injected
 * AutoFixHook regenerates the failing beat/scene and returns new inputs; QA runs exactly once more.
 * A second failure drops the reel (the caller fills the slot from the backlog).
 */
import path from 'node:path';
import type { Blocklist, Brand, QaCheck, QaReport, ReelSpec, RenderReport, VoiceTrack } from '../schemas';
import { QaReport as QaReportSchema, qaVerdict } from '../schemas';
import { writeJsonAtomic } from '../lib/store';
import { createLogger } from '../lib/logger';
import { serializeError } from '../lib/redact';
import { technicalChecks, type TechnicalQaOptions } from './technical';
import {
  runVisualQa,
  sampleFrames as sampleFramesImpl,
  type VisualReview,
  type VisualReviewer,
} from './visual';
import { checkFacts as checkFactsImpl, verifyFacts, type FetchText } from './facts';
import { checkContent, checkPolicy as checkPolicyImpl } from './policy';
import {
  checkOriginality as checkOriginalityImpl,
  type OriginalityCorpus,
  type OriginalityOptions,
  type OriginalityResult,
} from './originality';

export * from './technical';
export * from './visual';
export * from './facts';
export * from './policy';
export * from './originality';
export { analyzeMedia, probe, extractFramesExact, type ProbeResult, type AnalysisResult } from './ffmpeg';

export interface TechnicalQaInput {
  videoPath: string;
  brand: Brand;
  renderReport: RenderReport;
  voiceTrack: VoiceTrack | null;
}

/** ffprobe + blackdetect/freezedetect/silencedetect + loudness + caption drift + text bounds. */
export async function runTechnicalQa(
  input: TechnicalQaInput,
  opts: TechnicalQaOptions = {},
): Promise<QaCheck[]> {
  return technicalChecks(input, opts);
}

/** Facts: every claim must be SUPPORTED or HYPOTHETICAL. */
export function checkFacts(spec: ReelSpec): QaCheck[] {
  return checkFactsImpl(spec);
}

/** Policy: blocklist, disclosure line present, content-safety rules. */
export function checkPolicy(spec: ReelSpec, brand: Brand, blocklist: Blocklist): QaCheck[] {
  return checkPolicyImpl(spec, brand, blocklist);
}

/** Multi-signal originality (n-gram overlap + embeddings + agent judgment for borderline). */
export async function checkOriginality(
  spec: ReelSpec,
  corpus: OriginalityCorpus,
  opts: OriginalityOptions = {},
): Promise<OriginalityResult> {
  return checkOriginalityImpl(spec, corpus, opts);
}

/** Scene-aware frame sampling: first/middle/last of every scene + frame 0 + cover frame. */
export function sampleFrames(report: RenderReport): number[] {
  return sampleFramesImpl(report);
}

export interface FullQaInput extends TechnicalQaInput {
  spec: ReelSpec;
  blocklist: Blocklist;
  corpus: OriginalityCorpus;
  publishMode: 'dry_run' | 'approval' | 'auto';
  /** Where sampled frames go (default out/<reelId>/frames next to the video). */
  framesDir?: string;
  /** Claude qa-reviewer (agents module) or a fake in tests. null => owner must look (flagged). */
  reviewer?: VisualReviewer | null;
  originality?: OriginalityOptions;
  technical?: TechnicalQaOptions;
  /**
   * Fact verification: 'check' (default) only validates recorded statuses; 'verify' fetches each
   * source through the shared http wrapper first (GET only) and updates statuses.
   */
  facts?: { mode?: 'check' | 'verify'; fetchText?: FetchText };
  now?: () => Date;
}

export interface QaRunDetails {
  report: QaReport;
  /** Spec facts after verification (when facts.mode = 'verify'). */
  spec: ReelSpec;
  originality: OriginalityResult;
  visualReview: VisualReview | null;
  sampledFrames: number[];
}

async function runOnce(input: FullQaInput, autoFixAttempted: boolean): Promise<QaRunDetails> {
  const now = input.now ?? (() => new Date());
  const log = createLogger({ stage: 'qa', reelId: input.spec.id });
  const checks: QaCheck[] = [];
  let spec = input.spec;

  const safe = async (category: QaCheck['category'], id: string, fn: () => Promise<QaCheck[]>) => {
    try {
      checks.push(...(await fn()));
    } catch (err) {
      log.error(`${id} crashed`, { err });
      checks.push({
        id,
        category,
        status: 'fail',
        message: `check crashed: ${serializeError(err).message}`,
        details: {},
        beatIndex: null,
      });
    }
  };

  await safe('technical', 'tech.run', () => runTechnicalQa(input, input.technical));

  const framesDir =
    input.framesDir ?? path.join(path.dirname(path.resolve(input.videoPath)), `${input.spec.id}-frames`);
  let visualReview: VisualReview | null = null;
  let unreviewed = false;
  let sampled: number[] = [];
  await safe('visual', 'visual.run', async () => {
    const r = await runVisualQa(
      { videoPath: input.videoPath, renderReport: input.renderReport, brand: input.brand, spec, framesDir },
      input.reviewer ?? null,
    );
    visualReview = r.review;
    unreviewed = r.unreviewed;
    sampled = r.samples.map((s) => s.frame);
    return r.checks;
  });

  await safe('facts', 'facts.run', async () => {
    const out: QaCheck[] = [];
    if (input.facts?.mode === 'verify') {
      const v = await verifyFacts(spec, {
        ...(input.facts.fetchText ? { fetchText: input.facts.fetchText } : {}),
        now,
      });
      spec = { ...spec, facts: v.facts };
      out.push(...v.checks);
    }
    out.push(...checkFacts(spec));
    return out;
  });

  let originality: OriginalityResult = {
    maxNgramOverlap: 0,
    maxEmbeddingSimilarity: null,
    verdict: 'borderline',
    closestId: null,
    checks: [],
  };
  await safe('originality', 'originality.run', async () => {
    originality = await checkOriginality(spec, input.corpus, {
      disclosureLine: input.brand.disclosure.captionLine,
      ...(input.originality ?? {}),
    });
    return originality.checks;
  });
  // In auto mode borderline reels are dropped; otherwise the owner is asked (flagged).
  if (originality.verdict === 'borderline' && input.publishMode === 'auto') {
    checks.push({
      id: 'originality.auto_mode',
      category: 'originality',
      status: 'fail',
      message: 'borderline originality is dropped in auto mode',
      details: { closestId: originality.closestId },
      beatIndex: null,
    });
  }

  await safe('policy', 'policy.run', async () => checkPolicy(spec, input.brand, input.blocklist));
  await safe('content', 'content.run', async () => checkContent(spec));

  const flagged = originality.verdict === 'borderline' || unreviewed;
  const report = QaReportSchema.parse({
    schemaVersion: 1,
    reelId: input.spec.id,
    createdAt: now().toISOString(),
    verdict: qaVerdict(checks, flagged),
    checks,
    autoFixAttempted,
  });
  log.info('QA finished', {
    verdict: report.verdict,
    fails: checks.filter((c) => c.status === 'fail').map((c) => c.id),
  });
  return { report, spec, originality, visualReview, sampledFrames: sampled };
}

/** Runs every category and returns a QaReport (verdict pass | fail | flagged). */
export async function runFullQa(input: FullQaInput): Promise<QaReport> {
  return (await runOnce(input, false)).report;
}

// ---------------------------------------------------------------- auto-fix

/** Check ids a regenerate-and-re-render can plausibly fix. Copying, policy and facts cannot. */
export const FIXABLE_PREFIXES = ['tech.', 'visual.'];

export function fixableFailures(report: QaReport): QaCheck[] {
  return report.checks.filter((c) => c.status === 'fail' && FIXABLE_PREFIXES.some((p) => c.id.startsWith(p)));
}

export function unfixableFailures(report: QaReport): QaCheck[] {
  return report.checks.filter(
    (c) => c.status === 'fail' && !FIXABLE_PREFIXES.some((p) => c.id.startsWith(p)),
  );
}

export interface AutoFixContext {
  report: QaReport;
  failing: QaCheck[];
  /** Beats/scenes to regenerate (from beatIndex of failing checks); empty => whole-reel re-render. */
  beatIndexes: number[];
  input: FullQaInput;
}

/** Regenerate the failing beat/scene and re-render; return the new inputs, or null if it cannot. */
export type AutoFixHook = (ctx: AutoFixContext) => Promise<FullQaInput | null>;

export interface QaOutcome extends QaRunDetails {
  /** true => drop the reel and fill the slot from the backlog. */
  dropped: boolean;
  dropReason: string | null;
  /** The inputs that produced the final report (the fixed ones after an auto-fix). */
  finalInput: FullQaInput;
}

/** Full QA with at most ONE automatic fix (spec 7.7). Never loops. */
export async function runQA(input: FullQaInput, autoFix?: AutoFixHook | null): Promise<QaOutcome> {
  const log = createLogger({ stage: 'qa', reelId: input.spec.id });
  const first = await runOnce(input, false);
  if (first.report.verdict !== 'fail') {
    return { ...first, dropped: false, dropReason: null, finalInput: input };
  }
  const failing = first.report.checks.filter((c) => c.status === 'fail');
  const reasonOf = (r: QaReport) =>
    r.checks
      .filter((c) => c.status === 'fail')
      .map((c) => `${c.id}: ${c.message}`)
      .slice(0, 5)
      .join(' | ');

  const fixable = fixableFailures(first.report);
  if (!autoFix || fixable.length === 0 || unfixableFailures(first.report).length > 0) {
    return { ...first, dropped: true, dropReason: reasonOf(first.report), finalInput: input };
  }
  const beatIndexes = [
    ...new Set(failing.map((c) => c.beatIndex).filter((b): b is number => b !== null)),
  ].sort((a, b) => a - b);
  let fixed: FullQaInput | null = null;
  try {
    fixed = await autoFix({ report: first.report, failing, beatIndexes, input });
  } catch (err) {
    log.warn('auto-fix hook failed', { err });
  }
  if (!fixed) {
    const report = { ...first.report, autoFixAttempted: true };
    return {
      ...first,
      report,
      dropped: true,
      dropReason: `auto-fix unavailable; ${reasonOf(first.report)}`,
      finalInput: input,
    };
  }
  const second = await runOnce(fixed, true);
  if (second.report.verdict === 'fail') {
    return {
      ...second,
      dropped: true,
      dropReason: `failed after one auto-fix: ${reasonOf(second.report)}`,
      finalInput: fixed,
    };
  }
  return { ...second, dropped: false, dropReason: null, finalInput: fixed };
}

/** data/qa/<DATE>/<reelId>.json (DATE = the reel id's date part). */
export function qaReportPath(dataDir: string, reelId: string): string {
  return path.join(dataDir, 'qa', reelId.slice(0, 10), `${reelId}.json`);
}

export async function writeQaReport(dataDir: string, report: QaReport): Promise<string> {
  const p = qaReportPath(dataDir, report.reelId);
  await writeJsonAtomic(p, report, QaReportSchema);
  return p;
}

export type { OriginalityCorpus, OriginalityResult, VisualReviewer };
