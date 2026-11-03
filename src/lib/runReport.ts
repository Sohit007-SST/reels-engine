/**
 * Daily run report (T1.5): renders a RunReport into the 02 section 5.7 markdown template
 * and writes progress/runs/DATE.md (plus the JSON next to it) atomically.
 * All text passes through the redactor.
 */
import path from 'node:path';
import { RunReport } from '../schemas/runReport';
import { redact } from './redact';
import { writeFileAtomic, writeJsonAtomic } from './store';

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  return redact(String(v)).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
};

const meter = (m: { used: number; limit: number | null } | null): string =>
  m ? `${m.used} / ${m.limit ?? 'unknown'}` : 'not measured';

export function renderDailyReport(input: RunReport): string {
  const r = RunReport.parse(input);
  const warnCount = r.warnings.length;
  const errCount = r.errors.length;
  const statusNote =
    r.status === 'OK' && warnCount === 0
      ? 'OK'
      : `${r.status}${warnCount || errCount ? ` (${[errCount ? `${errCount} error${errCount > 1 ? 's' : ''}` : '', warnCount ? `${warnCount} warning${warnCount > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ')})` : ''}`;

  const lines: string[] = [];
  lines.push(
    `# Daily run — ${r.date} · publish: ${r.modes.publish} · replies: ${r.modes.reply} · learning: ${r.modes.learning} · status: ${statusNote}`,
  );
  lines.push(
    '',
    `Run ID: \`${cell(r.runId)}\` · kind: ${r.kind} · started ${r.startedAt} · finished ${r.finishedAt ?? 'n/a'}`,
  );

  lines.push(
    '',
    '## Trends found (top 5)',
    "| # | Account / source | Why it's trending | Pattern we can use | Confidence | Link |",
    '|---|---|---|---|---|---|',
  );
  if (r.trends.length === 0) lines.push('| — | none | | | | |');
  r.trends
    .slice(0, 5)
    .forEach((t, i) =>
      lines.push(
        `| ${i + 1} | ${cell(t.source)} | ${cell(t.why)} | ${cell(t.pattern)} | ${t.confidence} | ${cell(t.link)} |`,
      ),
    );

  lines.push(
    '',
    '## Reels produced',
    '| ID | Hook | Format | Visual tiers | Length | QA | Slot | Placement |',
    '|---|---|---|---|---|---|---|---|',
  );
  if (r.reelsProduced.length === 0) lines.push('| — | none | | | | | | |');
  for (const p of r.reelsProduced) {
    lines.push(
      `| ${cell(p.id)} | ${cell(p.hook)} | ${cell(p.format)} | ${cell(p.visualTiers.join(', '))} | ${p.lengthSec === null ? '—' : `${p.lengthSec.toFixed(1)} s`} | ${p.qa} | ${cell(p.slot)} | ${p.placement} |`,
    );
  }

  lines.push(
    '',
    '## Published',
    '| Time (IST) | Reel | Main/Trial | Link | Late start? |',
    '|---|---|---|---|---|',
  );
  if (r.published.length === 0) lines.push('| — | none | | | |');
  for (const p of r.published) {
    lines.push(
      `| ${cell(p.timeIst)} | ${cell(p.reelId)} | ${p.placement} | ${cell(p.link)} | ${p.lateStart ? 'yes' : 'no'} |`,
    );
  }

  lines.push(
    '',
    '## Approvals, replies and items needing review',
    `- Approved ${r.approvals.approved} / Rejected ${r.approvals.rejected} / Expired ${r.approvals.expired}`,
    `- Replies posted: ${r.replies.posted} (drafts awaiting approval: ${r.replies.draftsAwaiting})`,
    `- NEEDS_REVIEW (publish unclear): ${r.needsReview.length ? r.needsReview.map(cell).join(', ') : 'none'}`,
  );

  lines.push(
    '',
    "## Yesterday's performance",
    '| Reel | Views | Avg watch time | Shares | Saves | Score vs median |',
    '|---|---|---|---|---|---|',
  );
  if (r.performance.length === 0) lines.push('| — | not enough data yet | | | | |');
  for (const p of r.performance) {
    lines.push(
      `| ${cell(p.reelId)} | ${cell(p.views)} | ${p.avgWatchTimeSec === null ? '—' : `${p.avgWatchTimeSec} s`} | ${cell(p.shares)} | ${cell(p.saves)} | ${cell(p.scoreVsMedian)} |`,
    );
  }

  lines.push(
    '',
    '## Free-tier usage (measured)',
    `- Cloudflare neurons: ${meter(r.usage.cloudflareNeurons)} · Instagram publish quota: ${meter(r.usage.igPublishQuota)} · GitHub minutes this month: ${meter(r.usage.githubMinutesThisMonth)}`,
  );

  lines.push('', '## Errors and warnings');
  if (r.errors.length + r.warnings.length === 0) lines.push('- none');
  for (const e of r.errors) lines.push(`- ERROR: ${cell(e)}`);
  for (const w of r.warnings) lines.push(`- WARN: ${cell(w)}`);

  lines.push('', '## Plan for tomorrow');
  if (r.plan.length === 0) lines.push('- (no plan recorded)');
  for (const p of r.plan) lines.push(`- ${cell(p)}`);

  return lines.join('\n') + '\n';
}

/** Write <dir>/<date>.md and <dir>/<date>.json. Returns the markdown path. */
export async function writeDailyReport(report: RunReport, dir: string): Promise<string> {
  const md = renderDailyReport(report);
  const mdPath = path.join(dir, `${report.date}.md`);
  await writeFileAtomic(mdPath, md);
  await writeJsonAtomic(path.join(dir, `${report.date}.json`), report, RunReport);
  return mdPath;
}

/** A minimal valid report (used by `npm run report:dummy` and tests). */
export function dummyRunReport(runId: string, date: string, now: Date = new Date()): RunReport {
  return RunReport.parse({
    schemaVersion: 1,
    runId,
    kind: 'dummy',
    date,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    modes: { publish: 'dry_run', reply: 'approval', learning: 'propose' },
    status: 'OK',
    trends: [],
    reelsProduced: [],
    published: [],
    approvals: { approved: 0, rejected: 0, expired: 0 },
    replies: { posted: 0, draftsAwaiting: 0 },
    needsReview: [],
    performance: [],
    usage: { cloudflareNeurons: null, igPublishQuota: null, githubMinutesThisMonth: null },
    errors: [],
    warnings: ['dummy run: no pipeline stages executed'],
    plan: ['nothing scheduled (dummy run)'],
  });
}
