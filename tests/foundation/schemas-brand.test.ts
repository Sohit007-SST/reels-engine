import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBlocklist, loadBrand, loadHookLibrary, loadWatchlist, slotsFor } from '../../src/config';
import { dummyRunReport, renderDailyReport, writeDailyReport } from '../../src/lib/runReport';
import {
  Approval,
  AssetProvenance,
  isAssetUsable,
  quotaAllows,
  ReelSpec,
  reelSpecStructureProblems,
  RunReport,
} from '../../src/schemas';

const spec = {
  schemaVersion: 1,
  id: '2026-11-05-01',
  promptVersion: 'script-writer@3',
  model: 'fixture',
  language: 'en',
  placement: 'main',
  format: 'what_if',
  hook: {
    formulaId: 'what_if',
    spoken: 'What if the Moon vanished tonight?',
    onScreen: 'NO MOON TONIGHT?',
    alternates: ['a', 'b'],
  },
  beats: [
    {
      role: 'hook',
      voiceover: 'What if the Moon vanished tonight?',
      onScreenText: 'NO MOON TONIGHT?',
      sceneType: 'HookTitle',
      visual: { tier: 'B', prompt: 'empty night sky' },
      motion: 'zoom_punch',
      sfx: 'hit',
    },
  ],
  caption: 'What if the Moon vanished?',
  captionVersion: 1,
  hashtags: ['#whatif', '#space'],
  facts: [
    {
      claim: 'The Moon drives most ocean tides.',
      sourceUrl: 'https://example.org',
      publisher: 'Example',
      retrievedAt: '2026-11-05',
      supportingQuote: '...',
      status: 'SUPPORTED',
    },
  ],
  coverOffsetMs: 400,
  tags: {
    hookFormula: 'what_if',
    format: 'what_if',
    visualTiers: ['A', 'B'],
    targetSeconds: 30,
    slot: '08:30',
  },
};

describe('schemas', () => {
  it('accepts the spec 7.3 ReelSpec example shape', () => {
    const r = ReelSpec.safeParse(spec);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it('rejects unknown fields, long on-screen text, bad ids, schemaVersion mismatch', () => {
    expect(ReelSpec.safeParse({ ...spec, extra: 1 }).success).toBe(false);
    expect(ReelSpec.safeParse({ ...spec, schemaVersion: 2 }).success).toBe(false);
    expect(ReelSpec.safeParse({ ...spec, id: '2026-11-05' }).success).toBe(false);
    const longText = {
      ...spec,
      beats: [{ ...spec.beats[0], onScreenText: 'one two three four five six seven' }],
    };
    expect(ReelSpec.safeParse(longText).success).toBe(false);
  });

  it('structure check flags the 1-beat example (needs full Hook→Setup→Escalation→Payoff→Loop)', () => {
    const problems = reelSpecStructureProblems(ReelSpec.parse(spec));
    expect(problems.join(' ')).toMatch(/escalation/);
  });

  it('provenance with unknown commercial use is blocked', () => {
    const p = AssetProvenance.parse({
      schemaVersion: 1,
      assetId: 'a',
      kind: 'image',
      path: 'x.png',
      sha256: 'a'.repeat(64),
      provider: 'cloudflare',
      model: 'flux',
      modelVersion: null,
      license: 'unknown',
      commercialUse: 'unknown',
      termsCheckedAt: null,
      prompt: null,
      promptHash: null,
      createdAt: '2026-11-05T00:00:00Z',
      reelId: null,
    });
    expect(isAssetUsable(p)).toBe(false);
    expect(isAssetUsable({ ...p, commercialUse: 'allowed', termsCheckedAt: '2026-11-05' })).toBe(true);
  });

  it('quota guard stops at 85% and skips unknown usage', () => {
    const u = { used: 0, limit: 10_000, unit: 'neurons', updatedAt: '2026-11-05T00:00:00Z' };
    expect(quotaAllows(u, 100)).toBe(true);
    expect(quotaAllows({ ...u, used: 8_450 }, 100)).toBe(false);
    expect(quotaAllows({ ...u, used: 9_500 }, 1)).toBe(false);
    expect(quotaAllows({ ...u, used: 10_000 }, 1)).toBe(false);
    expect(quotaAllows({ ...u, limit: null }, 1)).toBe(false);
    expect(quotaAllows(undefined, 1)).toBe(false);
  });

  it('approval schema enforces short version hash', () => {
    expect(Approval.safeParse({ versionHash: 'x' }).success).toBe(false);
  });
});

describe('brand files (T1.4)', () => {
  it('all brand files validate', async () => {
    const brand = await loadBrand();
    expect(brand.language).toBe('en');
    expect(slotsFor(brand, 3)).toEqual(['08:30', '13:00', '19:30']);
    expect(slotsFor(brand, 5)).toHaveLength(5);
    expect(slotsFor(brand, 2)).toEqual(['08:30', '11:30']);
    const w = brand.scoringWeights;
    expect(w.watchTime + w.shares + w.saves + w.comments + w.skipRate).toBeCloseTo(1);
    const hooks = await loadHookLibrary();
    expect(hooks.formulas).toHaveLength(12);
    expect(new Set(hooks.formulas.map((f) => f.id)).size).toBe(12);
    expect(hooks.leaderboard).toEqual([]);
    const bl = await loadBlocklist();
    for (const p of bl.patterns) expect(() => new RegExp(p, 'i')).not.toThrow();
    const wl = await loadWatchlist();
    expect(wl.status).toBe('pending M12');
    expect(wl.accounts).toEqual([]);
  });

  it('brand hashtags are well-formed and the disclosure line is set', async () => {
    const brand = await loadBrand();
    expect(brand.disclosure.captionLine.length).toBeGreaterThan(10);
    expect(brand.hashtagPool.length).toBeGreaterThanOrEqual(brand.hashtagsPerReel.max);
  });
});

describe('run report (T1.5)', () => {
  it('a dummy run writes a correct report following the 5.7 template', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'runs-'));
    const r = dummyRunReport('dummy-20261105-051700-abcdef', '2026-11-05', new Date('2026-11-04T23:47:00Z'));
    const file = await writeDailyReport(r, dir);
    const md = readFileSync(file, 'utf8');
    expect(md.split('\n')[0]).toBe(
      '# Daily run — 2026-11-05 · publish: dry_run · replies: approval · learning: propose · status: OK (1 warning)',
    );
    for (const h of [
      '## Trends found (top 5)',
      '## Reels produced',
      '## Published',
      '## Approvals, replies and items needing review',
      "## Yesterday's performance",
      '## Free-tier usage (measured)',
      '## Errors and warnings',
      '## Plan for tomorrow',
    ]) {
      expect(md).toContain(h);
    }
    expect(md).toContain('dummy-20261105-051700-abcdef');
    expect(RunReport.parse(JSON.parse(readFileSync(path.join(dir, '2026-11-05.json'), 'utf8'))).runId).toBe(
      r.runId,
    );
  });

  it('report text is redacted and table-safe', () => {
    const r = dummyRunReport('x', '2026-11-05');
    const md = renderDailyReport({
      ...r,
      status: 'WARN',
      errors: ['call failed access_token=EAAabcdefghijklmnopqrstuvwxyz | pipe'],
    });
    expect(md).not.toContain('EAAabcdefghij');
    expect(md).toContain('status: WARN (1 error, 1 warning)');
  });
});
