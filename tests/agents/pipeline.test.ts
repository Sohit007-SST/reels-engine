import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadBrand, loadHookLibrary } from '../../src/config';
import { createLogger } from '../../src/lib/logger';
import {
  BACKLOG_TARGET,
  isNearDuplicate,
  pastPerformanceScore,
  pickHooks,
  runIdeas,
  toHook,
} from '../../src/pipeline/ideas';
import { assembleCaption, runScript, writerProblems } from '../../src/pipeline/script';
import { ReelSpec, type Brand, type Fact, type HookLibrary } from '../../src/schemas';
import { fakeByAgent } from './fakeClaude';

let brand: Brand;
let hookLibrary: HookLibrary;
beforeAll(async () => {
  brand = await loadBrand();
  hookLibrary = await loadHookLibrary();
});
const logger = createLogger({ stage: 'test' });
const FORMULAS = ['what_if', 'pov', 'nobody_talks', 'shocking_number', 'stop_scrolling'];
const sc = (t: number) => ({
  scrollStop: 8,
  brevity: 8,
  curiosity: 8,
  specificity: 7,
  truthfulness: t,
  visualMatch: 7,
});

const TOPICS = [
  ['moon vanished tonight', 'tides would shrink and nights darken across every coastline'],
  ['octopus three hearts', 'cephalopod circulation explained through blue copper blood'],
  ['pyramid builders paid', 'egyptian workers received bread beer rations and medical care'],
  ['saturn would float', 'gas giant density lower than water in a giant bathtub'],
  ['lightning strikes twice', 'tall towers receive dozens of bolts every single year'],
  ['honey never spoils', 'archaeologists tasted edible jars from ancient tombs'],
  ['venus day longer', 'slow rotation makes one day exceed one venusian year'],
  ['sharks older trees', 'cartilaginous fish predate the first forests by millions'],
  ['bananas are berries', 'botanical definitions surprise grocery shoppers everywhere'],
  ['mars sunset blue', 'fine dust scatters red light leaving bluish dusk skies'],
  ['great wall visibility', 'astronauts cannot spot the wall with naked eyes'],
  ['cleopatra iphone closer', 'timeline gap between pyramids and cleopatra versus today'],
];
const ideaDrafts = TOPICS.map(([title, premise], i) => ({
  title: title!,
  premise: premise!,
  format: 'what_if',
  tags: ['space', `t${i}`],
  trendRefs: [],
  scores: { trendVelocity: 5 + (i % 5), nicheFit: 7, originality: 6, feasibility: 8 },
}));
const hooks10 = Array.from({ length: 10 }, (_, i) => ({
  formulaId: FORMULAS[i % 5]!,
  spoken: `Hook line number ${i}`,
  onScreen: `HOOK ${i} NOW`,
  scores: sc(i === 0 ? 2 : 7 + (i % 3)),
}));

const writerOut = (claimStatus: 'PENDING' | 'HYPOTHETICAL') => ({
  beats: [
    { role: 'hook', voiceover: 'Hook line number 2', onScreenText: 'NO MOON TONIGHT?' },
    {
      role: 'setup',
      voiceover:
        'The Moon sits about three hundred eighty thousand kilometres away and it pulls on every ocean.',
      onScreenText: 'Our tidal anchor',
    },
    {
      role: 'escalation',
      voiceover:
        'Without it, tides would shrink to a third of their height almost overnight around the world.',
      onScreenText: 'Tides shrink fast',
    },
    {
      role: 'escalation',
      voiceover: 'Nights would get much darker, and animals that hunt by moonlight would lose their edge.',
      onScreenText: 'Darker nights',
    },
    {
      role: 'payoff',
      voiceover: 'Over millions of years, the tilt of Earth could wobble and seasons could swing wildly.',
      onScreenText: 'Seasons go wild',
    },
    {
      role: 'loop',
      voiceover: 'So next time you look up, thank the Moon for keeping things steady.',
      onScreenText: 'Thank the Moon',
    },
  ],
  caption: 'Three things change fast.\nTides, nights and seasons.',
  commentQuestion: 'Which change scares you most?',
  hashtags: ['#whatif', '#space', '#science'],
  facts: [
    {
      claim: 'The Moon is about 384,400 km from Earth.',
      sourceUrl: claimStatus === 'PENDING' ? 'https://example.org/moon' : null,
      publisher: claimStatus === 'PENDING' ? 'Example' : null,
      retrievedAt: claimStatus === 'PENDING' ? '2026-11-03' : null,
      supportingQuote: claimStatus === 'PENDING' ? 'about 384,400 km' : null,
      status: claimStatus,
    },
  ],
});
const visualOut = {
  beats: Array.from({ length: 6 }, () => ({
    sceneType: 'KineticText',
    visual: { tier: 'A', params: {} },
    motion: 'slide',
    sfx: 'whoosh',
  })),
  coverOffsetMs: 400,
  musicMood: 'curious',
};

describe('ideas helpers', () => {
  it('near-duplicate detection and neutral past performance on small samples', () => {
    expect(
      isNearDuplicate(
        { title: 'What if the Moon vanished', premise: 'tides shrink' },
        { title: 'What if the moon vanished?', premise: 'x' },
      ),
    ).toBe(true);
    expect(
      isNearDuplicate(
        { title: 'Octopus hearts', premise: 'blue blood' },
        { title: 'Saturn floats', premise: 'density' },
      ),
    ).toBe(false);
    expect(pastPerformanceScore(['space'], [{ tags: ['space'], score: 9 }])).toBe(5);
  });

  it('pickHooks skips untruthful hooks and duplicate on-screen text', () => {
    const hooks = hooks10.map(toHook);
    const { primary, alternates } = pickHooks(hooks);
    expect(primary).not.toBe(0);
    expect(alternates).toHaveLength(2);
    expect(new Set([primary, ...alternates]).size).toBe(3);
  });
});

describe('runIdeas (fake claude)', () => {
  it('3x ideas, hooks for chosen ones, backlog >= 10, files written, 60-day dedupe on rerun', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ideas-'));
    const runner = fakeByAgent({
      'trend-scout': [{ ideas: ideaDrafts }],
      'hook-master': [{ hooks: hooks10 }],
    });
    const ctx = {
      runId: 'r1',
      date: '2026-11-03',
      now: new Date('2026-11-03T03:00:00Z'),
      brand,
      hookLibrary,
      logger,
      dataDir,
      runner,
    };
    const res = await runIdeas(ctx, null, 2);
    expect(res.ready).toHaveLength(2);
    expect(res.ready[0]!.hooks).toHaveLength(10);
    expect(res.backlog.length).toBeGreaterThanOrEqual(BACKLOG_TARGET);
    expect(res.backlogShortfall).toBe(0);
    expect(readdirSync(path.join(dataDir, 'ideas', '2026-11-03'))).toHaveLength(2);
    expect(existsSync(path.join(dataDir, 'agent-runs', '2026-11-03'))).toBe(true);
    // the same drafts next day are all near-duplicates of recent/backlog ideas
    const again = await runIdeas({ ...ctx, date: '2026-11-04', runId: 'r2' }, null, 1);
    expect(again.dropped.length).toBeGreaterThan(0);
  });
});

describe('runScript (fake claude)', () => {
  const idea = () => ({
    schemaVersion: 1 as const,
    id: 'idea-1',
    createdAt: '2026-11-03T03:00:00.000Z',
    title: 'Moon vanished',
    premise: 'What changes if the Moon disappears',
    format: 'what_if',
    tags: ['space'],
    trendRefs: [],
    scores: {
      trendVelocity: 5,
      nicheFit: 7,
      originality: 6,
      feasibility: 8,
      pastPerformance: 5,
      requestBonus: 0,
    },
    totalScore: 6,
    hooks: hooks10.map(toHook),
    primaryHookIndex: 2,
    alternateHookIndexes: [3, 4],
    status: 'chosen' as const,
    series: null,
    dropReason: null,
  });

  it('builds a valid ReelSpec with caption parts and verified claims', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'script-'));
    const runner = fakeByAgent({ 'script-writer': [writerOut('PENDING')], 'visual-director': [visualOut] });
    const verifyFacts = async (spec: ReelSpec) => ({
      facts: spec.facts.map((f): Fact => ({ ...f, status: 'SUPPORTED', verifiedAt: 'now' })),
    });
    const res = await runScript(
      { runId: 'r', date: '2026-11-03', brand, logger, dataDir, runner, verifyFacts },
      { idea: idea(), reelId: '2026-11-03-01', slot: '08:30' },
    );
    expect(res.problems).toEqual([]);
    expect(res.ready).toBe(true);
    const spec = ReelSpec.parse(res.spec);
    expect(spec.caption.split('\n')[0]).toBe('Hook line number 2');
    expect(spec.caption).toContain('Which change scares you most?');
    expect(spec.caption).toContain('#whatif #space #science');
    if (brand.disclosure.includeInCaption) expect(spec.caption).toContain(brand.disclosure.captionLine);
    expect(spec.promptVersion).toMatch(/^script-writer@/);
    expect(spec.tags.slot).toBe('08:30');
    expect(existsSync(res.specPath!)).toBe(true);
  });

  it('unsupported claim -> one revision (hypothetical) -> ready; still unsupported -> blocked', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'script-'));
    const verify = async (spec: ReelSpec) => ({
      facts: spec.facts.map((f): Fact => (f.status === 'PENDING' ? { ...f, status: 'UNSUPPORTED' } : f)),
    });
    const fixed = fakeByAgent({
      'script-writer': [writerOut('PENDING'), writerOut('HYPOTHETICAL')],
      'visual-director': [visualOut],
    });
    const ok = await runScript(
      { runId: 'r', date: '2026-11-03', brand, logger, dataDir, runner: fixed, verifyFacts: verify },
      { idea: idea(), reelId: '2026-11-03-02', slot: null },
    );
    expect(ok.ready).toBe(true);
    expect(ok.spec!.facts[0]!.status).toBe('HYPOTHETICAL');

    const stuck = fakeByAgent({ 'script-writer': [writerOut('PENDING')], 'visual-director': [visualOut] });
    const bad = await runScript(
      { runId: 'r', date: '2026-11-03', brand, logger, dataDir, runner: stuck, verifyFacts: verify },
      { idea: idea(), reelId: '2026-11-03-03', slot: null },
    );
    expect(bad.ready).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/not verified \(UNSUPPORTED\)/);
  });

  it('writer checks: structure, hashtags from pool, PENDING claims need evidence', () => {
    const w = writerOut('PENDING');
    expect(writerProblems(w as never, brand)).toEqual([]);
    const broken = { ...w, hashtags: ['#notinpool', '#space', '#science'], beats: w.beats.slice(1) };
    const probs = writerProblems(broken as never, brand).join(' ');
    expect(probs).toMatch(/hook/);
    expect(probs).toMatch(/not in the brand pool/);
    expect(
      assembleCaption('Hook', 'Hook\nvalue', 'Q?', ['#a'], {
        ...brand,
        disclosure: { ...brand.disclosure, includeInCaption: false },
      }),
    ).toBe('Hook\n\nvalue\n\nQ?\n\n#a');
  });
});
