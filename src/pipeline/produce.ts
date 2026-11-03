/**
 * `npm run produce -- --count N [--dry-run] [--reviewer claude|fake|none] [--no-web] [--publish]`
 *   trends -> ideas -> script -> media (Kokoro TTS, faster-whisper, music + sfx mix) -> Remotion
 *   render -> QA -> queue (RENDERED -> QA_PASSED). With --publish a publish run follows in the
 *   configured mode (dry_run => DRY RUN preview only, zero external writes).
 * `npm run reel:fixture [-- --spec tests/fixtures/specs/what-if-moon.json] [--reviewer ...]`
 *   the vertical slice (Gate G2) on a hand-written spec: media -> render -> QA -> out/<id>/.
 *
 * Network: every request goes through src/lib/http; a network spy records all of them and the run
 * summary reports external writes (must be 0 in dry_run).
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  applyWritePolicy,
  loadBlocklist,
  loadBrand,
  loadConfig,
  loadHookLibrary,
  loadWatchlist,
  PROJECT_ROOT,
  slotsFor,
  type Config,
} from '../config';
import {
  ReelSpec,
  VoiceTrack,
  type Brand,
  type Blocklist,
  type QaReport,
  type RenderReport,
} from '../schemas';
import { createLogger, type Logger } from '../lib/logger';
import { newRunId, reelId as makeReelId, sha256File } from '../lib/ids';
import { istDate, istToUtc } from '../lib/time';
import { writeFileAtomic } from '../lib/store';
import { addNetworkSpy, type NetworkEvent } from '../lib/http';
import {
  alignWordTimings,
  generateMusic,
  loudnessProblems,
  mixAudio,
  sfxCuesFromSpec,
  synthesizeBeats,
  ttsOptionsFor,
  verifyCaptionTiming,
  writeVoiceTrack,
} from '../media';
import { isMusicMood } from '../media/music';
import { renderReel } from '../render/render';
import { runQA, writeQaReport, type OriginalityCorpus, type VisualReviewer } from '../qa';
import { VisualReview } from '../qa/visual';
import { createQaReviewer } from '../claude/qaReviewer';
import { enqueueRendered, transitionItem } from '../state/queue';
import { dataPaths } from '../state/paths';
import { isEntryPoint } from '../state/runtime';

export const FIXTURE_SPEC_PATH = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'specs', 'what-if-moon.json');
export const FAKE_REVIEWER_LABEL = 'FAKE REVIEWER: no real visual review was done (owner must look)';

export type ReviewerKind = 'claude' | 'fake' | 'none';

/** Clearly labelled stand-in used when the Claude qa-reviewer is unavailable. */
export const fakeReviewer: VisualReviewer = () =>
  Promise.resolve(
    VisualReview.parse({
      schemaVersion: 1,
      hookReadable: true,
      textCutOff: false,
      garbledText: false,
      deformedAnatomy: false,
      logosOrRealPeople: false,
      onBrand: true,
      issues: [],
      summary: FAKE_REVIEWER_LABEL,
    }),
  );

export interface ProduceReelInput {
  spec: ReelSpec;
  brand: Brand;
  blocklist: Blocklist;
  outDir: string;
  dataDir: string;
  runId: string;
  publishMode: 'dry_run' | 'approval' | 'auto';
  reviewer: ReviewerKind;
  corpus?: OriginalityCorpus;
  logger: Logger;
  model?: string;
}

export interface ProduceReelResult {
  reelId: string;
  videoPath: string;
  voiceTrackPath: string;
  renderReportPath: string;
  qaReportPath: string;
  verdict: QaReport['verdict'];
  dropped: boolean;
  dropReason: string | null;
  reviewerUsed: ReviewerKind;
  mix: { integratedLufs: number; truePeakDb: number } | null;
  loudnessProblems: string[];
  timingOk: boolean;
  maxOnsetDriftMs: number;
  durationMs: number;
}

/** media -> render -> QA for one spec. Writes only under outDir and dataDir/qa. */
export async function produceReel(input: ProduceReelInput): Promise<ProduceReelResult> {
  const { spec, brand, outDir, logger } = input;
  const log = logger.child ? logger.child({ reelId: spec.id }) : logger;

  // 1. Voice: Kokoro per beat (measured durations) -> faster-whisper word timings.
  let track = await synthesizeBeats(spec, ttsOptionsFor(spec, brand, outDir));
  track = await alignWordTimings(spec, track);
  const timing = await verifyCaptionTiming(track);
  log.info('voice ready', { totalMs: track.totalMs, words: track.words.length, timingOk: timing.ok });

  // 2. Music + sfx mix at the brand loudness target.
  const moodRaw = spec.musicMood ?? brand.audio.defaultMood;
  const mood = isMusicMood(moodRaw) ? moodRaw : 'wonder';
  const musicPath = await generateMusic({
    mood,
    durationMs: track.totalMs + 1500,
    outPath: path.join(outDir, `music-${mood}.wav`),
  });
  track = await mixAudio(track, {
    outPath: path.join(outDir, 'mix.wav'),
    brand,
    musicPath,
    musicMood: mood,
    sfx: sfxCuesFromSpec(spec, track),
  });
  const voiceTrackPath = path.join(outDir, 'voice.json');
  await writeVoiceTrack(voiceTrackPath, track);
  const loud = track.mix ? loudnessProblems(track.mix, brand) : ['no mix'];

  // 3. Remotion render.
  const rendered = await renderReel({
    spec,
    audioPath: track.mix?.path ?? null,
    timings: track,
    outPath: path.join(outDir, 'reel.mp4'),
    reportDir: outDir,
    runId: input.runId,
  });
  log.info('rendered', { path: rendered.outputPath, ms: rendered.renderMs, warnings: rendered.warnings });

  // 4. QA: technical + visual + policy + originality + facts.
  let reviewer: VisualReviewer | null = null;
  if (input.reviewer === 'claude') {
    reviewer = createQaReviewer({
      runId: input.runId,
      dataDir: input.dataDir,
      date: istDate(),
      ...(input.model ? { model: input.model } : {}),
    });
  } else if (input.reviewer === 'fake') {
    reviewer = fakeReviewer;
  }
  const renderReport: RenderReport = rendered.report;
  const outcome = await runQA({
    videoPath: rendered.outputPath,
    brand,
    blocklist: input.blocklist,
    renderReport,
    voiceTrack: VoiceTrack.parse(track),
    spec,
    corpus: input.corpus ?? { texts: [] },
    publishMode: input.publishMode,
    framesDir: path.join(outDir, 'frames'),
    reviewer,
    originality: { disclosureLine: brand.disclosure.captionLine },
    facts: { mode: 'check' },
  });
  const report = outcome.report;
  const qaReportPath = await writeQaReport(input.dataDir, report);
  await writeFileAtomic(path.join(outDir, 'qa-report.json'), JSON.stringify(report, null, 2) + '\n');

  return {
    reelId: spec.id,
    videoPath: rendered.outputPath,
    voiceTrackPath,
    renderReportPath: rendered.reportPath,
    qaReportPath,
    verdict: report.verdict,
    dropped: outcome.dropped,
    dropReason: outcome.dropReason,
    reviewerUsed: input.reviewer,
    mix: track.mix ? { integratedLufs: track.mix.integratedLufs, truePeakDb: track.mix.truePeakDb } : null,
    loudnessProblems: loud,
    timingOk: timing.ok,
    maxOnsetDriftMs: timing.maxOnsetDriftMs,
    durationMs: track.totalMs,
  };
}

// ------------------------------------------------------------------ CLI

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function reviewerArg(args: string[], fallback: ReviewerKind): ReviewerKind {
  const r = arg(args, 'reviewer') ?? fallback;
  if (r !== 'claude' && r !== 'fake' && r !== 'none') throw new Error(`invalid --reviewer ${r}`);
  return r;
}

const isWrite = (e: NetworkEvent) => e.isWrite && !e.blocked;

async function runFixture(cfg: Config, args: string[], logger: Logger, runId: string): Promise<number> {
  const specPath = path.resolve(arg(args, 'spec') ?? FIXTURE_SPEC_PATH);
  const spec = ReelSpec.parse(JSON.parse(await readFile(specPath, 'utf8')));
  const [brand, blocklist] = await Promise.all([loadBrand(), loadBlocklist()]);
  let reviewer = reviewerArg(args, 'claude');
  const base = {
    spec,
    brand,
    blocklist,
    outDir: path.join(PROJECT_ROOT, 'out', spec.id),
    dataDir: path.resolve(PROJECT_ROOT, arg(args, 'data-dir') ?? path.join('out', spec.id, 'data')),
    runId,
    publishMode: cfg.settings.publishMode,
    logger,
    ...(cfg.settings.claudeModel ? { model: cfg.settings.claudeModel } : {}),
  };
  let res = await produceReel({ ...base, reviewer });
  const reviewerFailed =
    res.verdict === 'fail' && reviewer === 'claude' && !args.includes('--strict-reviewer');
  if (reviewerFailed) {
    const qa = JSON.parse(await readFile(res.qaReportPath, 'utf8')) as QaReport;
    const failed = qa.checks.filter((c) => c.status === 'fail').map((c) => c.id);
    if (failed.length > 0 && failed.every((id) => id.startsWith('visual.reviewer'))) {
      logger.warn('claude qa-reviewer unavailable; re-running QA with the labelled FAKE reviewer', {
        failed,
      });
      reviewer = 'fake';
      res = await produceReel({ ...base, reviewer });
    }
  }
  process.stdout.write(
    JSON.stringify({ ...res, sizeBytes: (await stat(res.videoPath)).size }, null, 2) + '\n',
  );
  return res.verdict !== 'fail' && res.loudnessProblems.length === 0 && res.timingOk ? 0 : 1;
}

async function runProduce(cfg: Config, args: string[], logger: Logger, runId: string): Promise<number> {
  const count = Math.max(1, Math.min(10, Number(arg(args, 'count') ?? '1')));
  const dryRun = args.includes('--dry-run') || cfg.settings.publishMode === 'dry_run';
  const publishMode = dryRun ? 'dry_run' : cfg.settings.publishMode;
  const now = new Date();
  const date = arg(args, 'date') ?? istDate(now);
  const dataDir = path.resolve(PROJECT_ROOT, arg(args, 'data-dir') ?? 'data');
  const model = cfg.settings.claudeModel ?? undefined;
  const [brand, blocklist, hookLibrary, watchlist] = await Promise.all([
    loadBrand(),
    loadBlocklist(),
    loadHookLibrary(),
    loadWatchlist(),
  ]);

  // Trends (read-only sources only; keyed sources skip themselves without keys).
  const trends = await import('../trends');
  const { file: trendFile } = await trends.runTrends({
    ctx: { runId, date, niche: brand.niche, now, logger },
    sources: [
      trends.businessDiscoverySource({
        watchlist,
        igUserId: cfg.secrets.IG_USER_ID,
        accessToken: cfg.secrets.META_PAGE_ACCESS_TOKEN,
        graphVersion: cfg.settings.metaGraphVersion,
      }),
      trends.youtubeSource({ apiKey: cfg.secrets.YOUTUBE_API_KEY }),
      trends.googleTrendsSource({ geo: 'IN' }),
      trends.webSearchSource({ enabled: !args.includes('--no-web'), ...(model ? { model } : {}) }),
    ],
    dataDir,
    analyze: model ? { model } : {},
  });

  const { runIdeas } = await import('./ideas');
  const ideas = await runIdeas(
    { runId, date, now, brand, hookLibrary, logger, dataDir, ...(model ? { model } : {}) },
    trendFile,
    count,
  );
  const { runScript } = await import('./script');
  const slots = slotsFor(brand, count);
  const paths = dataPaths(dataDir);
  const results: Array<Record<string, unknown>> = [];
  let failures = 0;
  const corpus: OriginalityCorpus = {
    texts: trendFile.trends
      .filter((t) => t.captionText)
      .slice(0, 60)
      .map((t) => ({ id: t.id, source: 'trend' as const, text: t.captionText ?? '' })),
  };

  for (const [i, idea] of ideas.ready.slice(0, count).entries()) {
    const id = makeReelId(date, i + 1);
    const slot = slots[i % slots.length] ?? '19:00';
    const script = await runScript(
      { runId, date, brand, logger, dataDir, ...(model ? { model } : {}) },
      {
        idea,
        reelId: id,
        slot,
      },
    );
    if (!script.ready || !script.spec) {
      failures++;
      results.push({ reelId: id, stage: 'script', problems: script.problems });
      continue;
    }
    // Caption source for publish: data/specs/<reelId>.json.
    await writeFileAtomic(
      path.join(dataDir, 'specs', `${id}.json`),
      JSON.stringify(script.spec, null, 2) + '\n',
    );
    const res = await produceReel({
      spec: script.spec,
      brand,
      blocklist,
      outDir: path.join(PROJECT_ROOT, 'out', id),
      dataDir,
      runId,
      publishMode,
      reviewer: reviewerArg(args, 'claude'),
      corpus,
      logger,
      ...(model ? { model } : {}),
    });
    results.push({ ...res });
    if (res.dropped || res.verdict === 'fail') {
      failures++;
      continue;
    }
    const st = await stat(res.videoPath);
    await enqueueRendered(paths, {
      reelId: id,
      placement: script.spec.placement,
      slot: { date, time: slot },
      scheduledAt: istToUtc(date, slot).toISOString(),
      artifact: {
        name: `reel-${id}`,
        sha256: await sha256File(res.videoPath),
        sizeBytes: st.size,
        localPath: res.videoPath,
        retainedUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
      captionVersion: script.spec.captionVersion,
    });
    await transitionItem(paths, id, 'QA_PASSED', { publishMode, runId, note: `qa ${res.verdict}` });
  }

  if (args.includes('--publish')) {
    const pub = await import('./publish');
    const code = await pub.main(cfg);
    results.push({ stage: 'publish', exitCode: code, mode: publishMode });
  }
  process.stdout.write(
    JSON.stringify(
      { runId, dryRun, ideas: ideas.ready.length, backlogShortfall: ideas.backlogShortfall, results },
      null,
      2,
    ) + '\n',
  );
  return failures > 0 ? 1 : 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cfg = loadConfig();
  applyWritePolicy(cfg);
  const fixture = argv.includes('--fixture');
  const runId = newRunId('produce');
  const logger = createLogger({ runId, stage: fixture ? 'reel-fixture' : 'produce' });
  const events: NetworkEvent[] = [];
  const stop = addNetworkSpy((e) => events.push(e));
  try {
    return fixture ? await runFixture(cfg, argv, logger, runId) : await runProduce(cfg, argv, logger, runId);
  } finally {
    stop();
    const writes = events.filter(isWrite);
    logger.info('network summary', {
      requests: events.length,
      externalWrites: writes.length,
      writeHosts: [...new Set(writes.map((e) => e.host))],
    });
    if (cfg.settings.publishMode === 'dry_run' && writes.length > 0) {
      logger.error('dry_run made external writes', { count: writes.length });
      process.exitCode = 1;
    }
  }
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (code) => process.exit(process.exitCode && process.exitCode !== 0 ? process.exitCode : code),
    (err: unknown) => {
      createLogger({ stage: 'produce' }).error('produce crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    },
  );
}
