import { beforeAll, describe, expect, it } from 'vitest';
import type { Blocklist, Brand, QaCheck } from '../../src/schemas';
import { checkFacts, htmlToText, isFetchableSource, quoteAppears, verifyFacts } from '../../src/qa/facts';
import { checkContent, checkPolicy } from '../../src/qa/policy';
import { brandAndBlocklist, DISCLOSURE, makeSpec } from '../fixtures/qa/factories';

const fails = (c: QaCheck[], id?: string) => c.filter((x) => x.status === 'fail' && (!id || x.id === id));
const QUOTE = 'Most animals that live in the deep sea make their own light through bioluminescence.';
const PAGE = `<html><body><h1>Ocean</h1><p>Most animals that live in the <b>deep sea</b> make their own light
  through bioluminescence.</p><script>var x = 1;</script></body></html>`;

describe('checkFacts (recorded statuses)', () => {
  it('SUPPORTED + HYPOTHETICAL pass', () => {
    expect(fails(checkFacts(makeSpec()))).toEqual([]);
  });

  it.each(['PENDING', 'UNSUPPORTED'] as const)('defect: status %s fails', (status) => {
    const spec = makeSpec();
    spec.facts[0]!.status = status;
    expect(fails(checkFacts(spec), 'facts.claim')).toHaveLength(1);
  });

  it('defect: SUPPORTED without source/quote fails', () => {
    const spec = makeSpec();
    spec.facts[0] = { ...spec.facts[0]!, sourceUrl: null, supportingQuote: null };
    expect(fails(checkFacts(spec)).length).toBeGreaterThan(0);
  });
});

describe('verifyFacts (mocked source fetch, no network)', () => {
  const now = () => new Date('2026-11-05T00:00:00Z');

  it('quote on page -> SUPPORTED; fetched once per URL', async () => {
    const urls: string[] = [];
    const r = await verifyFacts(makeSpec(), {
      now,
      fetchText: async (u) => (urls.push(u), htmlToText(PAGE)),
    });
    expect(fails(r.checks)).toEqual([]);
    expect(r.facts[0]!.status).toBe('SUPPORTED');
    expect(urls).toEqual(['https://example.org/bioluminescence']);
  });

  it('defect: quote missing from page -> UNSUPPORTED + fail', async () => {
    const r = await verifyFacts(makeSpec(), {
      now,
      fetchText: async () => 'A page about something else entirely.',
    });
    expect(r.facts[0]!.status).toBe('UNSUPPORTED');
    expect(fails(r.checks, 'facts.verify')).toHaveLength(1);
  });

  it('defect: quote present but unrelated to the claim -> UNSUPPORTED', async () => {
    const spec = makeSpec();
    spec.facts[0]!.claim = 'whales sleep for 12 hours a day';
    const r = await verifyFacts(spec, { now, fetchText: async () => htmlToText(PAGE) });
    expect(r.facts[0]!.status).toBe('UNSUPPORTED');
  });

  it('defect: fetch error -> stays PENDING + fail; private/non-http source rejected', async () => {
    const r = await verifyFacts(makeSpec(), {
      now,
      fetchText: async () => {
        throw new Error('timeout');
      },
    });
    expect(r.facts[0]!.status).toBe('PENDING');
    expect(fails(r.checks)).toHaveLength(1);
    expect(isFetchableSource('file:///etc/passwd')).toBe(false);
    expect(isFetchableSource('http://localhost/x')).toBe(false);
    expect(isFetchableSource('https://example.org/a')).toBe(true);
  });

  it('quote matching tolerates whitespace/markup/case', () => {
    expect(quoteAppears(htmlToText(PAGE), QUOTE.toUpperCase())).toBe(true);
    expect(htmlToText(PAGE)).not.toContain('var x');
  });
});

describe('checkPolicy + checkContent', () => {
  let brand: Brand;
  let blocklist: Blocklist;
  beforeAll(async () => {
    ({ brand, blocklist } = await brandAndBlocklist());
  });

  it('clean spec passes', () => {
    expect(fails(checkPolicy(makeSpec(), brand, blocklist))).toEqual([]);
    expect(checkContent(makeSpec()).every((c) => c.status !== 'fail')).toBe(true);
  });

  it('defect: blocklisted word and pattern', () => {
    const a = makeSpec();
    a.beats[2]!.voiceover = 'This is a guaranteed way to see it.';
    expect(fails(checkPolicy(a, brand, blocklist), 'policy.blocklist').length).toBeGreaterThan(0);
    const b = makeSpec();
    b.beats[2]!.onScreenText = 'Scientists hate this';
    expect(fails(checkPolicy(b, brand, blocklist), 'policy.blocklist').length).toBeGreaterThan(0);
  });

  it('defect: missing disclosure line', () => {
    const spec = makeSpec({ caption: makeSpec().caption.replace(DISCLOSURE, '') });
    expect(fails(checkPolicy(spec, brand, blocklist), 'policy.disclosure')).toHaveLength(1);
  });

  it.each([
    ['policy.copyrighted_characters', 'voiceover', 'What if Pikachu was real?'],
    ['policy.medical_advice', 'voiceover', 'Stop taking your medication and try this instead.'],
    ['policy.harm', 'voiceover', 'The gore would be everywhere.'],
    ['policy.fake_news', 'voiceover', 'Breaking news: the ocean is glowing.'],
    ['policy.real_people', 'prompt', 'photo of a real person on a beach'],
    ['policy.logos_brands', 'prompt', 'a diver wearing a nike logo'],
  ] as const)('defect: %s', (id, where, text) => {
    const spec = makeSpec();
    if (where === 'prompt') spec.beats[1]!.visual = { tier: 'B', prompt: text };
    else spec.beats[2]!.voiceover = text;
    expect(fails(checkPolicy(spec, brand, blocklist), id).length).toBeGreaterThan(0);
  });

  it('defect: hashtag count out of range', () => {
    const spec = makeSpec({ hashtags: [] });
    expect(fails(checkPolicy(spec, brand, blocklist), 'policy.hashtags')).toHaveLength(1);
  });
});
