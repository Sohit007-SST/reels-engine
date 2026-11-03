/**
 * Script -> ReelSpec (T4.6, spec 7.3).
 *  1. script-writer: beats (hook -> setup -> 2-4 escalation -> payoff -> loop/cta), caption body,
 *     comment question, 3-5 hashtags from brand.hashtagPool, claim-level fact records (PENDING).
 *  2. visual-director: sceneType / visual / motion / sfx per beat, cover offset, music mood.
 *  3. assemble + zod-validate ReelSpec (caption line 1 = hook, question, hashtags, disclosure).
 *  4. separate fact check (injected; default = src/qa/facts verifyFacts, read-only GETs). Claims that
 *     are not SUPPORTED get ONE script-writer revision (rewrite as hypothetical or cut), then are
 *     re-verified. Anything still UNSUPPORTED/PENDING => ready=false (QA blocks the reel).
 * Untrusted text (idea titles from trends, comment requests) only ever goes in data blocks.
 */
import path from 'node:path';
import { ScriptWriterOutput, VisualDirectorOutput, type FactDraft } from '../claude/outputs';
import { agentRecordPath, runAgent, type ClaudeRunner } from '../claude/runAgent';
import { loadAgentDefinition } from '../claude/agents';
import type { Logger } from '../lib/logger';
import { writeJsonAtomic } from '../lib/store';
import {
  KNOWN_SCENE_TYPES,
  ReelSpec,
  reelSpecStructureProblems,
  wordCount,
  type Brand,
  type Fact,
  type Idea,
} from '../schemas';

export const MIN_WORDS_EN = 60;
export const MAX_WORDS_EN = 110;

export type FactVerifier = (spec: ReelSpec) => Promise<{ facts: Fact[] }>;

export interface ScriptContext {
  runId: string;
  date: string;
  brand: Brand;
  logger: Logger;
  dataDir: string;
  model?: string;
  runner?: ClaudeRunner;
  /** Separate claim verifier. Default: src/qa/facts verifyFacts (lazy import). */
  verifyFacts?: FactVerifier;
}

export interface ScriptRequest {
  idea: Idea;
  reelId: string;
  slot: string | null;
  placement?: 'main' | 'trial';
}

export interface ScriptResult {
  spec: ReelSpec | null;
  /** true only when the spec validated and every claim is SUPPORTED or HYPOTHETICAL. */
  ready: boolean;
  problems: string[];
  specPath: string | null;
}

export const specFile = (dataDir: string, date: string, id: string) =>
  path.join(dataDir, 'specs', date, `${id}.json`);

/** Semantic checks on the writer output (fed back to the repair retry). */
export function writerProblems(out: ScriptWriterOutput, brand: Brand): string[] {
  const roles = out.beats.map((b) => b.role);
  const problems: string[] = [];
  if (roles[0] !== 'hook') problems.push('beats[0].role must be "hook"');
  const esc = roles.filter((r) => r === 'escalation').length;
  if (esc < 2 || esc > 4) problems.push(`need 2-4 escalation beats, got ${esc}`);
  if (!roles.includes('setup')) problems.push('missing a setup beat');
  if (!roles.includes('payoff')) problems.push('missing a payoff beat');
  const last = roles[roles.length - 1];
  if (last !== 'loop' && last !== 'cta') problems.push('last beat must be loop or cta');
  if (brand.language === 'en') {
    const words = out.beats.reduce((n, b) => n + wordCount(b.voiceover), 0);
    if (words < MIN_WORDS_EN || words > MAX_WORDS_EN)
      problems.push(`total voiceover is ${words} words; must be ${MIN_WORDS_EN}-${MAX_WORDS_EN}`);
  }
  const pool = new Set(brand.hashtagPool.map((h) => h.toLowerCase()));
  for (const h of out.hashtags)
    if (!pool.has(h.toLowerCase())) problems.push(`hashtag ${h} is not in the brand pool`);
  const { min, max } = brand.hashtagsPerReel;
  if (out.hashtags.length < min || out.hashtags.length > max) problems.push(`use ${min}-${max} hashtags`);
  out.facts.forEach((f, i) => {
    if (f.status === 'PENDING' && (!f.sourceUrl || !f.supportingQuote))
      problems.push(
        `facts.${i}: a PENDING claim needs sourceUrl and supportingQuote (else mark HYPOTHETICAL or drop it)`,
      );
  });
  return problems;
}

/** Caption per 7.3: hook line, value lines, question, hashtags, disclosure (if configured). */
export function assembleCaption(
  hookLine: string,
  body: string,
  question: string,
  hashtags: string[],
  brand: Brand,
): string {
  const lines = [hookLine.trim()];
  const bodyTrim = body.trim();
  const firstBodyLine = bodyTrim.split('\n')[0]?.trim() ?? '';
  lines.push(
    firstBodyLine.toLowerCase() === hookLine.trim().toLowerCase()
      ? bodyTrim.split('\n').slice(1).join('\n').trim()
      : bodyTrim,
  );
  if (!bodyTrim.includes(question.trim())) lines.push(question.trim());
  lines.push(hashtags.join(' '));
  if (brand.disclosure.includeInCaption && brand.disclosure.captionLine.trim())
    lines.push(brand.disclosure.captionLine.trim());
  return lines
    .filter((l) => l.length > 0)
    .join('\n\n')
    .slice(0, 2200);
}

function factFromDraft(f: FactDraft): Fact {
  return { ...f };
}

async function defaultVerifier(spec: ReelSpec): Promise<{ facts: Fact[] }> {
  const mod = await import('../qa/facts');
  return mod.verifyFacts(spec);
}

export async function runScript(ctx: ScriptContext, req: ScriptRequest): Promise<ScriptResult> {
  const { idea } = req;
  const { brand } = ctx;
  const hook = idea.primaryHookIndex !== null ? idea.hooks[idea.primaryHookIndex] : undefined;
  if (!hook) return { spec: null, ready: false, problems: ['idea has no primary hook'], specPath: null };
  const alternates = idea.alternateHookIndexes
    .map((i) => idea.hooks[i]?.spoken)
    .filter((s): s is string => !!s);
  const common = {
    runId: ctx.runId,
    inputRefs: [idea.id],
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.runner ? { runner: ctx.runner } : {}),
  };
  const ideaData = {
    title: idea.title,
    premise: idea.premise,
    format: idea.format,
    hook: { spoken: hook.spoken, onScreen: hook.onScreen, formulaId: hook.formulaId },
  };
  const writerInstruction = [
    `Write a ${brand.language} reel script for the idea in the data. The first beat speaks the given hook.`,
    `Beats: hook, setup, 2-4 escalation, payoff, then loop or cta; ${MIN_WORDS_EN}-${MAX_WORDS_EN} spoken words in total.`,
    `Pick ${brand.hashtagsPerReel.min}-${brand.hashtagsPerReel.max} hashtags only from the hashtag_pool data.`,
    'List every factual claim as a fact record with a public sourceUrl, publisher, retrievedAt and an exact supportingQuote',
    '(status PENDING), or status HYPOTHETICAL when the line is framed as hypothetical.',
  ].join(' ');
  const writerData = [
    { label: 'idea', content: ideaData },
    { label: 'hashtag_pool', content: brand.hashtagPool },
  ];

  const writer = await runAgent({
    ...common,
    agent: 'script-writer',
    instruction: writerInstruction,
    data: writerData,
    schema: ScriptWriterOutput,
    validate: (out) => writerProblems(out, brand),
    recordPath: agentRecordPath(ctx.dataDir, ctx.date, ctx.runId, 'script-writer', req.reelId),
  });
  if (!writer.ok || !writer.output) {
    return {
      spec: null,
      ready: false,
      problems: [`script-writer rejected: ${writer.record.error ?? 'invalid'}`],
      specPath: null,
    };
  }
  let script = writer.output;

  const sceneTypes = [...KNOWN_SCENE_TYPES];
  const visual = await runAgent({
    ...common,
    agent: 'visual-director',
    instruction: `Direct every beat in the data, in order (exactly ${script.beats.length} beats). Prefer tier A motion graphics; sceneType from scene_types.`,
    data: [
      { label: 'beats', content: script.beats },
      { label: 'scene_types', content: sceneTypes },
    ],
    schema: VisualDirectorOutput,
    validate: (out) =>
      out.beats.length === script.beats.length
        ? []
        : [`return exactly ${script.beats.length} beats (got ${out.beats.length})`],
    recordPath: agentRecordPath(ctx.dataDir, ctx.date, ctx.runId, 'visual-director', req.reelId),
  });
  if (!visual.ok || !visual.output) {
    return {
      spec: null,
      ready: false,
      problems: [`visual-director rejected: ${visual.record.error ?? 'invalid'}`],
      specPath: null,
    };
  }
  const vd = visual.output;
  const promptVersion = loadAgentDefinition('script-writer').promptVersion;

  const build = (s: ScriptWriterOutput, facts: Fact[]): ReelSpec =>
    ReelSpec.parse({
      schemaVersion: 1,
      id: req.reelId,
      promptVersion,
      model: writer.record.model,
      language: brand.language,
      placement: req.placement ?? 'main',
      format: idea.format,
      hook: {
        formulaId: hook.formulaId,
        spoken: hook.spoken,
        onScreen: hook.onScreen,
        alternates: alternates.slice(0, 2),
      },
      beats: s.beats.map((b, i) => {
        const v = vd.beats[i];
        if (!v) throw new Error(`missing visual for beat ${i}`);
        return { ...b, sceneType: v.sceneType, visual: v.visual, motion: v.motion, sfx: v.sfx };
      }),
      caption: assembleCaption(hook.spoken, s.caption, s.commentQuestion, s.hashtags, brand),
      captionVersion: 1,
      hashtags: s.hashtags,
      commentQuestion: s.commentQuestion,
      facts,
      coverOffsetMs: vd.coverOffsetMs,
      tags: {
        hookFormula: hook.formulaId,
        format: idea.format,
        visualTiers: [...new Set(vd.beats.map((b) => b.visual.tier))],
        targetSeconds: brand.video.targetSeconds,
        slot: req.slot,
      },
      musicMood: vd.musicMood,
      ideaId: idea.id,
    });

  let spec: ReelSpec;
  try {
    spec = build(script, script.facts.map(factFromDraft));
  } catch (err) {
    return {
      spec: null,
      ready: false,
      problems: [`spec assembly failed: ${(err as Error).message.slice(0, 300)}`],
      specPath: null,
    };
  }

  // Separate claim-level verification (never trusts the writer's own status).
  const verify = ctx.verifyFacts ?? defaultVerifier;
  let facts = (await verify(spec)).facts;
  const bad = (fs: Fact[]) =>
    fs.filter((f) => f.status !== 'SUPPORTED' && f.status !== 'HYPOTHETICAL' && f.status !== 'CUT');
  if (bad(facts).length > 0) {
    const revise = await runAgent({
      ...common,
      agent: 'script-writer',
      instruction: [
        writerInstruction,
        'REVISION: the claims listed in unverified_claims could not be confirmed from their sources.',
        'Rewrite each as clearly hypothetical (status HYPOTHETICAL) or remove it from the script and facts.',
      ].join(' '),
      data: [
        ...writerData,
        { label: 'previous_script', content: script },
        {
          label: 'unverified_claims',
          content: bad(facts).map((f) => ({ claim: f.claim, note: f.verifierNote ?? null })),
        },
      ],
      schema: ScriptWriterOutput,
      validate: (out) => {
        const errs = writerProblems(out, brand);
        if (out.beats.length !== script.beats.length) errs.push(`keep exactly ${script.beats.length} beats`);
        return errs;
      },
      recordPath: agentRecordPath(ctx.dataDir, ctx.date, ctx.runId, 'script-writer', `${req.reelId}-revise`),
    });
    if (revise.ok && revise.output) {
      script = revise.output;
      try {
        spec = build(script, script.facts.map(factFromDraft));
        facts = (await verify(spec)).facts;
      } catch (err) {
        ctx.logger.warn('revised spec invalid', { reelId: req.reelId, err });
      }
    }
  }
  spec = ReelSpec.parse({ ...spec, facts });

  const problems = [...reelSpecStructureProblems(spec)];
  for (const f of bad(spec.facts))
    problems.push(`claim not verified (${f.status}): ${f.claim.slice(0, 120)}`);
  const specPath = specFile(ctx.dataDir, ctx.date, spec.id);
  await writeJsonAtomic(specPath, spec, ReelSpec);
  const ready = problems.length === 0;
  ctx.logger.info(ready ? 'spec ready' : 'spec blocked', { reelId: spec.id, problems: problems.slice(0, 5) });
  return { spec, ready, problems, specPath };
}
