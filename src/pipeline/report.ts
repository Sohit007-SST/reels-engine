/**
 * Daily report (spec 7.9, ~23:30 IST): trends found, reels produced and published (links),
 * approvals, comment replies, metrics for yesterday's reels, free-tier usage, publish quota,
 * late starts, NEEDS_REVIEW items, errors and tomorrow's plan. Written to
 * progress/runs/<DATE>.md and sent to Telegram (notification-only; allowed in dry_run).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyWritePolicy, loadConfig, type Config } from '../config';
import { createLogger, type Logger } from '../lib/logger';
import { readJson, readJsonOrNull, writeFileAtomic } from '../lib/store';
import { addDays, istDate } from '../lib/time';
import { Metrics } from '../schemas/metrics';
import type { TelegramClient } from '../telegram/index';
import { listApprovals } from '../state/approvals';
import { readUsage, pauseState, trialPaused } from '../state/control';
import { readLedger } from '../state/ledger';
import type { DataPaths } from '../state/paths';
import { listQueueItems } from '../state/queue';
import { EngageDay, RunSummary } from '../state/schemas';
import { buildRuntime, isEntryPoint } from '../state/runtime';

export interface ReportDeps {
  paths: DataPaths;
  telegram: TelegramClient | null;
  publishMode: 'dry_run' | 'approval' | 'auto';
  configPaused?: boolean;
  now?: () => Date;
  logger?: Logger;
}

async function listJson(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

const fmt = (v: number | null | undefined): string => (v === null || v === undefined ? 'n/a' : String(v));

export async function buildDailyReport(
  deps: ReportDeps,
): Promise<{ date: string; markdown: string; telegram: string }> {
  const now = (deps.now ?? (() => new Date()))();
  const date = istDate(now);
  const yesterday = addDays(date, -1);
  const tomorrow = addDays(date, 1);
  const { items } = await listQueueItems(deps.paths);

  const trends = (await listJson(deps.paths.trendsDir)).filter((f) =>
    path.basename(f).startsWith(date),
  ).length;
  const produced = items.filter((i) => istDate(new Date(i.createdAt)) === date);
  const published: string[] = [];
  const yReels: string[] = [];
  for (const i of items.filter((x) => x.state === 'PUBLISHED')) {
    const l = await readLedger(deps.paths, i.reelId);
    const d = l?.publishedAt ? istDate(new Date(l.publishedAt)) : null;
    if (d === date) published.push(`${i.reelId} (${i.placement}) ${l?.permalink ?? l?.mediaId ?? ''}`.trim());
    if (d === yesterday) yReels.push(i.reelId);
  }
  const approvals = (await listApprovals(deps.paths)).filter(
    (a) => a.decidedAt && istDate(new Date(a.decidedAt)) === date,
  );
  const engage = await readJsonOrNull(path.join(deps.paths.engageDir, `${date}.json`), EngageDay).catch(
    () => null,
  );
  const replies = engage?.runs.reduce((s, r) => s + r.posted, 0) ?? 0;
  const drafted = engage?.runs.reduce((s, r) => s + r.drafted, 0) ?? 0;

  const metricsLines: string[] = [];
  for (const id of yReels) {
    const m = await readJsonOrNull(path.join(deps.paths.metricsDir, `${id}.json`), Metrics).catch(() => null);
    const s = m?.snapshots.at(-1);
    metricsLines.push(
      s
        ? `${id} [${s.window}]: views ${fmt(s.values.views)}, reach ${fmt(s.values.reach)}, avg watch ${fmt(s.values.ig_reels_avg_watch_time)}, shares ${fmt(s.values.shares)}, saves ${fmt(s.values.saved)}`
        : `${id}: no metrics yet`,
    );
  }

  const runs: RunSummary[] = [];
  for (const f of await listJson(deps.paths.runsDir)) {
    const r = RunSummary.safeParse(await readJson(f).catch(() => null));
    if (r.success && r.data.date === date) runs.push(r.data);
  }
  runs.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
  const quota = runs.findLast((r) => r.quota)?.quota ?? null;
  const late = runs.flatMap((r) => r.lateStarts.map((l) => `${l.reelId} (+${l.minutesLate} min)`));
  const errors = runs.flatMap((r) => r.errors).slice(0, 20);
  const needsReview = items
    .filter((i) => i.state === 'NEEDS_REVIEW')
    .map((i) => `${i.reelId}: ${i.lastError ?? ''}`);
  const usage = await readUsage(deps.paths).catch(() => null);
  const usageLines = usage
    ? Object.entries(usage.providers).map(([k, u]) => `${k}: ${u.used}/${u.limit ?? '?'} ${u.unit}`)
    : ['no usage recorded'];
  const plan = items
    .filter((i) => i.slot.date === tomorrow && !['PUBLISHED', 'REJECTED', 'SKIPPED'].includes(i.state))
    .map((i) => `${i.slot.time} IST ${i.reelId} (${i.state}, ${i.placement})`);
  const pause = await pauseState(deps.paths, deps.configPaused ?? false);

  const list = (xs: string[], empty = 'none'): string =>
    xs.length ? xs.map((x) => `- ${x}`).join('\n') : `- ${empty}`;
  const md = [
    `# Daily report ${date}${deps.publishMode === 'dry_run' ? ' (DRY RUN)' : ''}`,
    '',
    `Mode: ${deps.publishMode}. Pipeline ${pause.paused ? `PAUSED (${pause.reason ?? ''})` : 'running'}. Trial reels ${(await trialPaused(deps.paths)) ? 'paused' : 'active'}.`,
    '',
    `## Trends found\n- ${trends} trend file(s) today`,
    `## Reels produced\n${list(produced.map((i) => `${i.reelId} (${i.state})`))}`,
    `## Published\n${list(published)}`,
    `## Would publish (dry run)\n${list([...new Set(runs.flatMap((r) => r.wouldPublish))])}`,
    `## Approvals\n${list(approvals.map((a) => `${a.kind} ${a.reelId}: ${a.decision}`))}`,
    `## Comments\n- ${replies} replies posted, ${drafted} drafted`,
    `## Yesterday's reels\n${list(metricsLines)}`,
    `## Free-tier usage\n${list(usageLines)}\n- Instagram publish quota: ${quota ? `${quota.used}/${quota.limit ?? '?'}` : 'unknown'}`,
    `## Late starts\n${list(late)}`,
    `## NEEDS_REVIEW\n${list(needsReview)}`,
    `## Errors\n${list(errors)}`,
    `## Tomorrow's plan\n${list(plan, 'nothing queued yet')}`,
    '',
  ].join('\n\n');
  const tg = [
    `Daily report ${date}`,
    `Published: ${published.length}${published.length ? `\n${published.join('\n')}` : ''}`,
    `Produced: ${produced.length}, approvals: ${approvals.length}, replies: ${replies}`,
    `Quota: ${quota ? `${quota.used}/${quota.limit ?? '?'}` : 'unknown'}`,
    needsReview.length ? `NEEDS_REVIEW: ${needsReview.length}` : '',
    errors.length ? `Errors: ${errors.length}` : '',
    `Tomorrow: ${plan.length} slot(s)`,
  ]
    .filter(Boolean)
    .join('\n');
  return { date, markdown: md, telegram: tg };
}

export async function runReport(deps: ReportDeps): Promise<{ file: string; sent: boolean }> {
  const r = await buildDailyReport(deps);
  await fs.mkdir(deps.paths.reportsDir, { recursive: true });
  const file = path.join(deps.paths.reportsDir, `${r.date}.md`);
  await writeFileAtomic(file, r.markdown);
  let sent = false;
  if (deps.telegram) {
    try {
      await deps.telegram.notify(r.telegram);
      sent = true;
    } catch (err) {
      (deps.logger ?? createLogger({ stage: 'report' })).warn('report not sent', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { file, sent };
}

export async function main(cfg: Config = loadConfig()): Promise<number> {
  applyWritePolicy(cfg);
  const rt = buildRuntime(cfg, 'analyze');
  const r = await runReport({
    paths: rt.paths,
    telegram: rt.telegram,
    publishMode: cfg.settings.publishMode,
    configPaused: cfg.settings.pipelinePaused,
    logger: rt.logger,
  });
  rt.logger.info('report written', { file: path.basename(r.file), sent: r.sent });
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (err: unknown) => {
      createLogger({ stage: 'report' }).error('report crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    },
  );
}
