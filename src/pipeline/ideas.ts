/**
 * Ideas and Hook Lab (T4.5, spec 7.2).
 *  - generate 3x more ideas than reels needed (trend-scout, patterns from the trend file)
 *  - score 1-10: trend velocity, niche fit, originality, feasibility, past performance
 *  - drop near-duplicates of anything from the last 60 days (and of each other)
 *  - chosen ideas -> data/ideas/<date>/<id>.json; extras -> data/backlog/<id>.json (target >= 10)
 *  - hook-master writes 10 hooks per chosen idea, scored on the rubric; best = primary + 2 alternates
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HookMasterOutput, IdeaGenOutput, type HookDraft, type IdeaDraft } from '../claude/outputs';
import { agentRecordPath, runAgent, type ClaudeRunner } from '../claude/runAgent';
import { shortHash } from '../lib/ids';
import type { Logger } from '../lib/logger';
import { readJsonOrNull, writeJsonAtomic } from '../lib/store';
import { addDays } from '../lib/time';
import {
  Idea,
  wordCount,
  type Brand,
  type Hook,
  type HookLibrary,
  type HookScores,
  type IdeaScores,
  type TrendFile,
} from '../schemas';

export const IDEA_MULTIPLIER = 3;
export const DEDUPE_WINDOW_DAYS = 60;
export const DEDUPE_THRESHOLD = 0.5;
export const BACKLOG_TARGET = 10;
export const HOOKS_PER_IDEA = 10;
/** Hooks scoring below this on truthfulness can never be the primary or an alternate. */
export const MIN_TRUTHFULNESS = 6;

export const IDEA_WEIGHTS = {
  trendVelocity: 0.2,
  nicheFit: 0.2,
  originality: 0.25,
  feasibility: 0.2,
  pastPerformance: 0.15,
} as const;

// ------------------------------------------------------------------ similarity / dedupe

const STOP = new Set(
  'a an the of in on at to for and or but if what when why how is are was were be been it its this that these those you your we our they their with from by as into about than then so just very can could would will'.split(
    ' ',
  ),
);

export function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w))
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/** Jaccard similarity of content-word sets (0..1). */
export function ideaSimilarity(a: string, b: string): number {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const ideaText = (i: { title: string; premise: string }) => `${i.title}. ${i.premise}`;

export function isNearDuplicate(
  a: { title: string; premise: string },
  b: { title: string; premise: string },
  threshold = DEDUPE_THRESHOLD,
): boolean {
  const titleSim = ideaSimilarity(a.title, b.title);
  return titleSim >= 0.6 || ideaSimilarity(ideaText(a), ideaText(b)) >= threshold;
}

// ------------------------------------------------------------------ scoring

export function scoreIdea(scores: IdeaScores): number {
  const base =
    scores.trendVelocity * IDEA_WEIGHTS.trendVelocity +
    scores.nicheFit * IDEA_WEIGHTS.nicheFit +
    scores.originality * IDEA_WEIGHTS.originality +
    scores.feasibility * IDEA_WEIGHTS.feasibility +
    scores.pastPerformance * IDEA_WEIGHTS.pastPerformance;
  return Math.round((base + (scores.requestBonus ?? 0)) * 100) / 100;
}

/**
 * Past performance of similar tags, from our own published history. Returns 5 (neutral) when
 * fewer than 5 past reels share a tag — small samples never move the score.
 */
export function pastPerformanceScore(
  tags: string[],
  history: Array<{ tags: string[]; score: number | null }>,
  minSample = 5,
): number {
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  const matches = history.filter((h) => h.score !== null && h.tags.some((t) => tagSet.has(t.toLowerCase())));
  if (matches.length < minSample) return 5;
  const avg = matches.reduce((n, h) => n + (h.score as number), 0) / matches.length;
  return Math.min(10, Math.max(1, Math.round(avg * 10) / 10));
}

/** Hook total = mean of the six rubric scores; brevity is forced to 1 if the on-screen text is too long. */
export function hookTotal(scores: HookScores, onScreen: string): number {
  const s = { ...scores };
  if (wordCount(onScreen) > 7) s.brevity = 1;
  const vals = Object.values(s);
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

export function toHook(d: HookDraft): Hook {
  return { ...d, total: hookTotal(d.scores, d.onScreen) };
}

/** Pick primary + 2 alternates: highest totals among truthful hooks with distinct on-screen text. */
export function pickHooks(hooks: Hook[]): { primary: number | null; alternates: number[] } {
  const eligible = hooks
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.scores.truthfulness >= MIN_TRUTHFULNESS && wordCount(h.onScreen) <= 7)
    .sort((a, b) => b.h.total - a.h.total || a.i - b.i);
  const picked: number[] = [];
  const seenText = new Set<string>();
  for (const { h, i } of eligible) {
    const key = h.onScreen
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    if (seenText.has(key)) continue;
    seenText.add(key);
    picked.push(i);
    if (picked.length === 3) break;
  }
  return { primary: picked[0] ?? null, alternates: picked.slice(1) };
}

// ------------------------------------------------------------------ persistence helpers

export interface IdeaPaths {
  dataDir: string;
}

export const ideaFile = (dataDir: string, date: string, id: string) =>
  path.join(dataDir, 'ideas', date, `${id}.json`);
export const backlogFile = (dataDir: string, id: string) => path.join(dataDir, 'backlog', `${id}.json`);

async function readIdeasIn(dir: string): Promise<Idea[]> {
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Idea[] = [];
  for (const f of files) {
    try {
      const idea = await readJsonOrNull(path.join(dir, f), Idea);
      if (idea) out.push(idea);
    } catch {
      /* unreadable file: ignore for dedupe */
    }
  }
  return out;
}

/** Ideas from data/ideas/<date>/ within the last `days` days plus the whole backlog. */
export async function loadRecentIdeas(
  dataDir: string,
  today: string,
  days = DEDUPE_WINDOW_DAYS,
): Promise<{ recent: Idea[]; backlog: Idea[] }> {
  const since = addDays(today, -days);
  let dates: string[];
  try {
    dates = (await fs.readdir(path.join(dataDir, 'ideas'))).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  } catch {
    dates = [];
  }
  const recent: Idea[] = [];
  for (const d of dates.filter((d) => d >= since && d <= today)) {
    recent.push(...(await readIdeasIn(path.join(dataDir, 'ideas', d))));
  }
  const backlog = await readIdeasIn(path.join(dataDir, 'backlog'));
  return { recent, backlog };
}

// ------------------------------------------------------------------ generation

export interface IdeaContext {
  runId: string;
  date: string;
  now: Date;
  brand: Brand;
  hookLibrary: HookLibrary;
  logger: Logger;
  dataDir: string;
  model?: string;
  runner?: ClaudeRunner;
  /** Topics people asked for in comments (untrusted). */
  requests?: Array<{ topic: string; count: number }>;
  /** Own history for past-performance scoring. */
  history?: Array<{ tags: string[]; score: number | null }>;
}

function ideaId(date: string, title: string): string {
  return `idea-${date}-${shortHash(title.toLowerCase(), 8)}`;
}

export function draftToIdea(
  d: IdeaDraft,
  ctx: Pick<IdeaContext, 'date' | 'now' | 'history' | 'requests'>,
): Idea {
  const reqBonus = Math.min(
    3,
    (ctx.requests ?? [])
      .filter((r) => ideaSimilarity(r.topic, ideaText(d)) >= 0.25)
      .reduce((n, r) => n + Math.min(3, r.count), 0),
  );
  const scores: IdeaScores = {
    ...d.scores,
    pastPerformance: pastPerformanceScore(d.tags, ctx.history ?? []),
    requestBonus: reqBonus,
  };
  return Idea.parse({
    schemaVersion: 1,
    id: ideaId(ctx.date, d.title),
    createdAt: ctx.now.toISOString(),
    title: d.title,
    premise: d.premise,
    format: d.format,
    tags: d.tags,
    trendRefs: d.trendRefs,
    scores,
    totalScore: scoreIdea(scores),
    hooks: [],
    primaryHookIndex: null,
    alternateHookIndexes: [],
    status: 'new',
    series: null,
    dropReason: null,
  });
}

/** Ask for `count * 3` ideas built on trend PATTERNS (analyses), never on copied captions. */
export async function generateIdeaDrafts(
  ctx: IdeaContext,
  trendFile: TrendFile | null,
  count: number,
  avoidTitles: string[],
): Promise<IdeaDraft[]> {
  const want = Math.max(1, count * IDEA_MULTIPLIER);
  const formats = ctx.brand.formats.filter((f) => f.enabled).map((f) => f.id);
  const trendIds = new Set((trendFile?.trends ?? []).map((t) => t.id));
  const res = await runAgent({
    agent: 'trend-scout',
    runId: ctx.runId,
    promptVersion: 'trend-scout@1+ideas@1',
    instruction: [
      `Write ${want} ORIGINAL reel ideas for the niche "${ctx.brand.niche}" (audience: ${ctx.brand.audience}).`,
      `Each idea uses one of these formats: ${formats.join(', ')}.`,
      'Learn only patterns (topic area, hook pattern, structure, emotion) from the trend analyses in the data;',
      'never reuse their wording. Ideas must work with motion graphics and AI still images (no real people,',
      'no brands, no famous characters, no medical/financial/legal advice). Frame hypotheticals as "what if".',
      'Score each idea 1-10 for trendVelocity, nicheFit, originality and feasibility (free visuals). Put the trend ids',
      'you learned from in trendRefs (only ids from the data). Do not repeat any title listed in avoid_titles.',
      'Return {"ideas": [...]} with title, premise (1-2 sentences), format, tags (lowercase words), trendRefs, scores.',
    ].join(' '),
    data: [
      {
        label: 'trend_patterns',
        content: (trendFile?.trends ?? []).slice(0, 20).map((t) => ({
          trendId: t.id,
          source: t.source,
          viralScore: t.viralScore,
          confidence: t.confidence,
          analysis: t.analysis,
        })),
      },
      { label: 'avoid_titles', content: avoidTitles.slice(0, 80) },
      { label: 'comment_requests', content: (ctx.requests ?? []).slice(0, 20) },
    ],
    schema: IdeaGenOutput,
    validate: (out) => {
      const errs: string[] = [];
      if (out.ideas.length < want) errs.push(`need ${want} ideas, got ${out.ideas.length}`);
      out.ideas.forEach((i, n) => {
        if (!formats.includes(i.format)) errs.push(`ideas.${n}.format must be one of ${formats.join(', ')}`);
        const bad = i.trendRefs.filter((r) => !trendIds.has(r));
        if (bad.length) errs.push(`ideas.${n}.trendRefs has unknown ids: ${bad.join(', ')}`);
      });
      return errs;
    },
    inputRefs: trendFile ? [`data/trends/${trendFile.date}.json`] : [],
    recordPath: agentRecordPath(ctx.dataDir, ctx.date, ctx.runId, 'trend-scout', 'ideas'),
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.runner ? { runner: ctx.runner } : {}),
  });
  if (!res.ok || !res.output) {
    ctx.logger.warn('idea generation rejected; falling back to backlog', { error: res.record.error });
    return [];
  }
  return res.output.ideas;
}

export interface IdeaPlan {
  chosen: Idea[];
  backlog: Idea[];
  dropped: Idea[];
  /** Ideas still needed to reach BACKLOG_TARGET ready backlog ideas (0 = target met). */
  backlogShortfall: number;
}

/**
 * Score, dedupe (vs the last 60 days, the backlog and each other) and split into chosen + backlog.
 * When too few new ideas survive, the best backlog ideas fill the gap.
 */
export function planIdeas(fresh: Idea[], count: number, recent: Idea[], existingBacklog: Idea[]): IdeaPlan {
  const dropped: Idea[] = [];
  const kept: Idea[] = [];
  const pastAll = [...recent, ...existingBacklog];
  for (const idea of [...fresh].sort((a, b) => b.totalScore - a.totalScore)) {
    const dupPast = pastAll.find((p) => p.id !== idea.id && isNearDuplicate(idea, p));
    const dupNow = kept.find((k) => isNearDuplicate(idea, k));
    const dup = dupPast ?? dupNow;
    if (dup) {
      dropped.push({ ...idea, status: 'dropped', dropReason: `near-duplicate of ${dup.id}` });
      continue;
    }
    kept.push(idea);
  }
  const usableBacklog = existingBacklog
    .filter((b) => b.status === 'backlog' || b.status === 'new')
    .sort((a, b) => b.totalScore - a.totalScore);
  const chosen: Idea[] = kept.slice(0, count).map((i) => ({ ...i, status: 'chosen' as const }));
  const fromBacklog: Idea[] = [];
  for (const b of usableBacklog) {
    if (chosen.length + fromBacklog.length >= count) break;
    fromBacklog.push({ ...b, status: 'chosen' });
  }
  const restFresh = kept.slice(count).map((i) => ({ ...i, status: 'backlog' as const }));
  const usedIds = new Set(fromBacklog.map((b) => b.id));
  const backlog = [...usableBacklog.filter((b) => !usedIds.has(b.id)), ...restFresh];
  return {
    chosen: [...chosen, ...fromBacklog],
    backlog: restFresh,
    dropped,
    backlogShortfall: Math.max(0, BACKLOG_TARGET - backlog.length),
  };
}

/** hook-master: 10 hooks scored on the rubric; the orchestrator computes totals and picks. */
export async function runHookLab(ctx: IdeaContext, idea: Idea): Promise<Idea | null> {
  const formulas = ctx.hookLibrary.formulas.filter((f) => f.enabled);
  const ids = new Set(formulas.map((f) => f.id));
  const res = await runAgent({
    agent: 'hook-master',
    runId: ctx.runId,
    instruction: [
      `Write exactly ${HOOKS_PER_IDEA} hooks for the idea in the data, using at least 4 different formula ids`,
      'from the hook library in the data. Score each on the rubric (1-10).',
    ].join(' '),
    data: [
      { label: 'idea', content: { title: idea.title, premise: idea.premise, format: idea.format } },
      { label: 'hook_library', content: formulas.map((f) => ({ id: f.id, template: f.template })) },
    ],
    schema: HookMasterOutput,
    validate: (out) => {
      const errs = out.hooks
        .map((h, i) =>
          ids.has(h.formulaId) ? null : `hooks.${i}.formulaId "${h.formulaId}" is not in the library`,
        )
        .filter((e): e is string => e !== null);
      if (new Set(out.hooks.map((h) => h.formulaId)).size < 4) errs.push('use at least 4 different formulas');
      return errs;
    },
    inputRefs: [idea.id],
    outputRef: ideaFile(ctx.dataDir, ctx.date, idea.id),
    recordPath: agentRecordPath(ctx.dataDir, ctx.date, ctx.runId, 'hook-master', idea.id),
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.runner ? { runner: ctx.runner } : {}),
  });
  if (!res.ok || !res.output) {
    ctx.logger.warn('hook lab rejected idea', { ideaId: idea.id, error: res.record.error });
    return null;
  }
  const hooks = res.output.hooks.map(toHook);
  const { primary, alternates } = pickHooks(hooks);
  if (primary === null) {
    ctx.logger.warn('no truthful hook; idea goes back to backlog', { ideaId: idea.id });
    return null;
  }
  return Idea.parse({ ...idea, hooks, primaryHookIndex: primary, alternateHookIndexes: alternates });
}

export interface RunIdeasResult extends IdeaPlan {
  /** Chosen ideas that got a valid hook set (ready for script-writer). */
  ready: Idea[];
}

/** Full ideas step: generate -> plan -> hook lab -> persist. */
export async function runIdeas(
  ctx: IdeaContext,
  trendFile: TrendFile | null,
  count: number,
): Promise<RunIdeasResult> {
  const { recent, backlog: existing } = await loadRecentIdeas(ctx.dataDir, ctx.date);
  const avoid = [...recent, ...existing].map((i) => i.title);
  const drafts = await generateIdeaDrafts(ctx, trendFile, count, avoid);
  const fresh = drafts.map((d) => draftToIdea(d, ctx));
  const plan = planIdeas(fresh, count, recent, existing);

  const ready: Idea[] = [];
  const backToBacklog: Idea[] = [];
  for (const idea of plan.chosen) {
    const withHooks = await runHookLab(ctx, idea);
    if (withHooks) ready.push(withHooks);
    else backToBacklog.push({ ...idea, status: 'backlog' });
  }
  for (const idea of ready) await writeJsonAtomic(ideaFile(ctx.dataDir, ctx.date, idea.id), idea, Idea);
  for (const idea of [...plan.backlog, ...backToBacklog]) {
    await writeJsonAtomic(backlogFile(ctx.dataDir, idea.id), idea, Idea);
  }
  // Ideas pulled from the backlog are marked chosen in place (no deletes), so they stop counting as ready.
  for (const idea of ready) {
    if (existing.some((e) => e.id === idea.id)) {
      await writeJsonAtomic(backlogFile(ctx.dataDir, idea.id), { ...idea, status: 'chosen' }, Idea);
    }
  }
  const backlogCount = (await loadRecentIdeas(ctx.dataDir, ctx.date)).backlog.filter(
    (b) => b.status === 'backlog' || b.status === 'new',
  ).length;
  return {
    ...plan,
    backlog: [...plan.backlog, ...backToBacklog],
    ready,
    backlogShortfall: Math.max(0, BACKLOG_TARGET - backlogCount),
  };
}
