/**
 * Weekly learning (spec 7.11). Reads data/metrics/scores.json and proposes changes (format
 * weights, hooks to promote/retire, slot notes) into data/proposals/<week>.json and
 * progress/runs/week-YYYY-WW.md.
 *
 * Minimum evidence: every compared group needs >= 8 reels AND the data must span >= 7 days;
 * otherwise the proposal is "not enough data yet" and nothing changes.
 * LEARNING_MODE=propose: changes apply only after the owner approves in Telegram.
 * LEARNING_MODE=bounded_auto: weights move at most +-20%, no format is removed (weight floor > 0).
 * Every applied change bumps the playbook version and appends a changelog row (git rollback).
 * No statistical significance is claimed: these are descriptive medians.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyWritePolicy, BRAND_DIR, loadConfig, type Config } from '../config';
import { createLogger, type Logger } from '../lib/logger';
import { readJsonOrNull, writeFileAtomic, writeJsonAtomic } from '../lib/store';
import { isoWeekLabel, istDate } from '../lib/time';
import { Brand } from '../schemas/brand';
import type { Approval } from '../schemas/approval';
import type { TelegramClient } from '../telegram/index';
import { createApproval, setTelegramMessageId } from '../state/approvals';
import type { DataPaths } from '../state/paths';
import { proposalFile, proposalPayloadHash, readProposal } from '../state/replies';
import { ProposalFile, ScoresFile, type ProposalChange, type ScoreEntry } from '../state/schemas';
import { buildRuntime, isEntryPoint } from '../state/runtime';
import { median } from './analyze';

export const MIN_REELS_PER_GROUP = 8;
export const MIN_DAYS_OF_DATA = 7;
export const MAX_WEIGHT_CHANGE = 0.2;
export const MIN_FORMAT_WEIGHT = 0.01;
export const NOT_ENOUGH = 'not enough data yet';

export interface LearnDeps {
  paths: DataPaths;
  telegram: TelegramClient | null;
  learningMode: 'propose' | 'bounded_auto';
  runId: string;
  /** brand/ directory (brand.json + playbook.md). Tests pass a temp copy. */
  brandDir?: string;
  now?: () => Date;
  logger?: Logger;
}

/** Latest-window score per reel (prefer 7d, then 72h, then 24h). */
function latestPerReel(entries: ScoreEntry[]): ScoreEntry[] {
  const rank = { '7d': 3, '72h': 2, '24h': 1 } as const;
  const best = new Map<string, ScoreEntry>();
  for (const e of entries) {
    if (e.scoreVsMedian === null) continue;
    const cur = best.get(e.reelId);
    if (!cur || rank[e.window] > rank[cur.window]) best.set(e.reelId, e);
  }
  return [...best.values()];
}

const clampChange = (from: number, factor: number): number => {
  const f = Math.min(1 + MAX_WEIGHT_CHANGE, Math.max(1 - MAX_WEIGHT_CHANGE, factor));
  return Math.max(MIN_FORMAT_WEIGHT, Math.round(from * f * 1000) / 1000);
};

export function buildProposal(
  scores: ScoresFile | null,
  brand: Pick<Brand, 'formats'>,
  now: Date,
  learningMode: 'propose' | 'bounded_auto',
): ProposalFile {
  const week = isoWeekLabel(now);
  const base: ProposalFile = {
    schemaVersion: 1,
    week,
    createdAt: now.toISOString(),
    learningMode,
    enoughData: false,
    summary: NOT_ENOUGH,
    changes: [],
    status: 'not_enough_data',
    approvalId: null,
    appliedAt: null,
    playbookVersion: null,
  };
  const reels = latestPerReel(scores?.entries ?? []);
  const times = reels.map((r) => (r.publishedAt ? Date.parse(r.publishedAt) : NaN)).filter(Number.isFinite);
  const spanDays = times.length ? (now.getTime() - Math.min(...times)) / 86_400_000 : 0;
  if (spanDays < MIN_DAYS_OF_DATA)
    return { ...base, summary: `${NOT_ENOUGH} (${spanDays.toFixed(1)} of ${MIN_DAYS_OF_DATA} days)` };

  const changes: ProposalChange[] = [];
  const group = (key: (e: ScoreEntry) => string | null): Map<string, number[]> => {
    const m = new Map<string, number[]>();
    for (const r of reels) {
      const k = key(r);
      if (k) m.set(k, [...(m.get(k) ?? []), r.scoreVsMedian!]);
    }
    return m;
  };
  const formats = group((e) => e.format);
  const enoughFormats = [...formats].filter(([, v]) => v.length >= MIN_REELS_PER_GROUP);
  // Compare formats only when at least two groups each have the minimum evidence.
  if (enoughFormats.length >= 2) {
    for (const [id, vals] of enoughFormats) {
      const f = brand.formats.find((x) => x.id === id);
      const med = median(vals);
      if (!f || med === null || Math.abs(med - 1) < 0.05) continue;
      const to = clampChange(f.weight, med);
      if (to !== f.weight) {
        changes.push({
          kind: 'format_weight',
          target: id,
          from: f.weight,
          to,
          evidence: `median score ${med.toFixed(2)} over ${vals.length} reels`,
        });
      }
    }
  }
  const hooks = [...group((e) => e.hookFormula)].filter(([, v]) => v.length >= MIN_REELS_PER_GROUP);
  if (hooks.length >= 2) {
    for (const [id, vals] of hooks) {
      const med = median(vals)!;
      if (med >= 1.15)
        changes.push({
          kind: 'hook_promote',
          target: id,
          from: null,
          to: null,
          evidence: `median score ${med.toFixed(2)} over ${vals.length} reels`,
        });
      if (med <= 0.85)
        changes.push({
          kind: 'hook_retire',
          target: id,
          from: null,
          to: null,
          evidence: `median score ${med.toFixed(2)} over ${vals.length} reels`,
        });
    }
  }
  const enough = enoughFormats.length >= 2 || hooks.length >= 2;
  if (!enough)
    return { ...base, summary: `${NOT_ENOUGH} (need ${MIN_REELS_PER_GROUP} reels in each compared group)` };
  return {
    ...base,
    enoughData: true,
    summary: changes.length
      ? `${changes.length} change(s) proposed`
      : 'no change: groups are within noise of the median',
    changes,
    status: changes.length ? 'proposed' : 'not_enough_data',
  };
}

/** Apply a proposal to brand.json + playbook.md (bounded). Returns the new playbook version. */
export async function applyProposal(
  p: ProposalFile,
  brandDir: string,
  approvedBy: string,
  now: Date,
): Promise<number> {
  const brandFile = path.join(brandDir, 'brand.json');
  const brand = Brand.parse(JSON.parse(await fs.readFile(brandFile, 'utf8')));
  const formats = brand.formats.map((f) => {
    const c = p.changes.find((x) => x.kind === 'format_weight' && x.target === f.id);
    if (!c || c.to === null) return f;
    return { ...f, weight: clampChange(f.weight, c.to / Math.max(f.weight, MIN_FORMAT_WEIGHT)) }; // re-bound
  });
  await writeJsonAtomic(brandFile, { ...brand, formats }, Brand);
  const pbFile = path.join(brandDir, 'playbook.md');
  let pb = await fs.readFile(pbFile, 'utf8');
  const cur = Number(/^# Playbook v(\d+)/m.exec(pb)?.[1] ?? '1');
  const next = cur + 1;
  pb = pb.replace(/^# Playbook v\d+/m, `# Playbook v${next}`);
  const change = p.changes
    .map((c) => `${c.kind} ${c.target}${c.to !== null ? ` ${c.from}->${c.to}` : ''}`)
    .join('; ');
  const evidence = p.changes.map((c) => c.evidence).join('; ');
  pb = `${pb.trimEnd()}\n| v${next} | ${istDate(now)} | ${change.replace(/\|/g, '/')} | ${evidence.replace(/\|/g, '/')} | ${approvedBy} |\n`;
  await writeFileAtomic(pbFile, pb);
  return next;
}

function weekMarkdown(p: ProposalFile): string {
  const rows = p.changes
    .map((c) => `| ${c.kind} | ${c.target} | ${c.from ?? ''} | ${c.to ?? ''} | ${c.evidence} |`)
    .join('\n');
  return [
    `# Learning run week ${p.week}`,
    '',
    `- Mode: ${p.learningMode}`,
    `- Status: ${p.status}`,
    `- Summary: ${p.summary}`,
    `- Evidence rule: >= ${MIN_REELS_PER_GROUP} reels per compared group and >= ${MIN_DAYS_OF_DATA} days of data. Medians only; no significance claimed.`,
    '',
    p.changes.length
      ? '| Kind | Target | From | To | Evidence |\n| --- | --- | --- | --- | --- |\n' + rows
      : '_No changes._',
    '',
  ].join('\n');
}

export async function runLearn(deps: LearnDeps): Promise<ProposalFile> {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? createLogger({ runId: deps.runId, stage: 'learn' });
  const brandDir = deps.brandDir ?? BRAND_DIR;
  const scores = await readJsonOrNull(path.join(deps.paths.metricsDir, 'scores.json'), ScoresFile);
  const brand = Brand.parse(JSON.parse(await fs.readFile(path.join(brandDir, 'brand.json'), 'utf8')));
  let p = buildProposal(scores, brand, now(), deps.learningMode);
  const existing = await readProposal(deps.paths, p.week);
  if (existing && (existing.status === 'applied' || existing.status === 'proposed')) {
    log.info('proposal for this week already exists', { week: p.week, status: existing.status });
    return existing;
  }
  if (p.status === 'proposed' && deps.learningMode === 'bounded_auto') {
    const v = await applyProposal(p, brandDir, 'bounded_auto', now());
    p = { ...p, status: 'applied', appliedAt: now().toISOString(), playbookVersion: v };
  }
  if (p.status === 'proposed' && deps.learningMode === 'propose' && deps.telegram?.sendApprovalRequest) {
    const a = await createApproval(deps.paths, {
      reelId: '0000-00-00-00',
      kind: 'learning',
      versionHash: proposalPayloadHash(p),
      ttlHours: 7 * 24,
      note: p.week,
      now: now(),
    });
    p = { ...p, approvalId: a.id };
    await writeJsonAtomic(proposalFile(deps.paths, p.week), p, ProposalFile);
    try {
      const m = await deps.telegram.sendApprovalRequest(
        `Weekly learning proposal ${p.week}:\n${weekMarkdown(p)}`,
        a,
      );
      await setTelegramMessageId(deps.paths, a, m.messageId);
    } catch (err) {
      log.warn('learning approval request failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await writeJsonAtomic(proposalFile(deps.paths, p.week), p, ProposalFile);
  await fs.mkdir(deps.paths.reportsDir, { recursive: true });
  await writeFileAtomic(path.join(deps.paths.reportsDir, `week-${p.week}.md`), weekMarkdown(p));
  return p;
}

/** Telegram "approve" on a learning proposal (wired into processTelegramUpdates). */
export function learningApplier(
  paths: DataPaths,
  brandDir: string = BRAND_DIR,
  now: () => Date = () => new Date(),
) {
  return async (week: string, approval: Approval): Promise<string> => {
    const p = await readProposal(paths, week);
    if (!p || p.status !== 'proposed' || p.approvalId !== approval.id)
      return 'Proposal is no longer pending.';
    const v = await applyProposal(p, brandDir, 'owner (Telegram)', now());
    await writeJsonAtomic(
      proposalFile(paths, week),
      { ...p, status: 'applied', appliedAt: now().toISOString(), playbookVersion: v },
      ProposalFile,
    );
    return `Applied learning proposal ${week}; playbook v${v}. Commit to keep a rollback point.`;
  };
}

export async function main(cfg: Config = loadConfig()): Promise<number> {
  applyWritePolicy(cfg);
  const rt = buildRuntime(cfg, 'learn');
  const p = await runLearn({
    paths: rt.paths,
    telegram: rt.telegram,
    learningMode: cfg.settings.learningMode,
    runId: rt.runId,
    logger: rt.logger,
  });
  rt.logger.info('learn done', { week: p.week, status: p.status, changes: p.changes.length });
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  main().then(
    (c) => process.exit(c),
    (err: unknown) => {
      createLogger({ stage: 'learn' }).error('learn crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    },
  );
}
