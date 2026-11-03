/**
 * Hand-written fixture ReelSpec that exercises every scene the launch formats use.
 * Used by Studio previews (`npm run preview`), `npm run reel:fixture` and the render tests.
 * Claims are framed as hypothetical; the one factual claim stays PENDING (no invented evidence).
 */
import type { ReelSpec } from '../src/schemas/reelSpec';

export const FIXTURE_SPEC: ReelSpec = {
  schemaVersion: 1,
  id: '2026-11-03-90',
  promptVersion: 'fixture@1',
  model: 'hand-written',
  language: 'en',
  placement: 'main',
  format: 'what_if',
  hook: {
    formulaId: 'what_if',
    spoken: 'What if the Moon vanished tonight?',
    onScreen: 'NO MOON TONIGHT?',
    alternates: [],
  },
  beats: [
    {
      role: 'hook',
      voiceover: 'What if the Moon vanished tonight?',
      onScreenText: 'NO MOON TONIGHT?',
      sceneType: 'HookTitle',
      visual: { tier: 'A', params: { kicker: 'What if' } },
      motion: 'zoom_punch',
      sfx: 'hit',
    },
    {
      role: 'setup',
      voiceover: 'First, the night sky would get much darker, with no silver light to guide you home.',
      onScreenText: 'THE NIGHT GOES DARK',
      sceneType: 'KineticText',
      visual: { tier: 'A', params: { highlight: 'dark' } },
      motion: 'slide',
      sfx: 'whoosh',
    },
    {
      role: 'escalation',
      voiceover:
        'Ocean tides would shrink to a fraction of their size, because the Sun alone would pull them.',
      onScreenText: 'TIDES SHRINK',
      sceneType: 'ImageKenBurns',
      visual: { tier: 'B', prompt: 'calm ocean shoreline under a starry sky without a moon', params: {} },
      motion: 'ken_burns_in',
      sfx: 'whoosh',
    },
    {
      role: 'escalation',
      voiceover: 'Today the Moon slowly drifts away from us, a few centimetres every single year.',
      onScreenText: 'It drifts away every year',
      sceneType: 'FactCard',
      visual: { tier: 'A', params: { stat: '3.8 cm', badge: 'Fact' } },
      motion: 'wipe',
      sfx: 'pop',
    },
    {
      role: 'escalation',
      voiceover: 'Without it, Earth could wobble on its axis over millions of years, shifting the seasons.',
      onScreenText: 'SEASONS COULD SHIFT',
      sceneType: 'Timeline',
      visual: {
        tier: 'A',
        params: {
          items: [
            { year: 'Night 1', label: 'Darker skies everywhere' },
            { year: 'Year 1', label: 'Smaller tides' },
            { year: 'Millions of years', label: 'Tilt starts to wobble' },
          ],
        },
      },
      motion: 'fade',
      sfx: 'click',
    },
    {
      role: 'payoff',
      voiceover: 'So that quiet rock up there is quietly keeping our days and seasons steady.',
      onScreenText: 'It keeps our seasons steady',
      sceneType: 'MascotTalk',
      visual: { tier: 'A', params: { expression: 'surprised' } },
      motion: 'zoom',
      sfx: 'ding',
    },
    {
      role: 'cta',
      voiceover: 'Would you miss the Moon? Tell me below.',
      onScreenText: 'WOULD YOU MISS IT?',
      sceneType: 'CTAEnd',
      visual: { tier: 'A', params: { cta: 'Follow for more what-ifs' } },
      motion: 'fade',
      sfx: 'pop',
    },
  ],
  caption:
    "What if the Moon vanished tonight?\nDarker nights, smaller tides and wobbling seasons.\nWould you miss the Moon?\nVisuals and voice made with AI. 'What if' scenarios are hypothetical.",
  captionVersion: 1,
  hashtags: ['#whatif', '#space', '#science'],
  commentQuestion: 'Would you miss the Moon?',
  facts: [
    {
      claim: 'The Moon moves a few centimetres farther from Earth each year.',
      sourceUrl: null,
      publisher: null,
      retrievedAt: null,
      supportingQuote: null,
      status: 'PENDING',
    },
  ],
  coverOffsetMs: 400,
  tags: { hookFormula: 'what_if', format: 'what_if', visualTiers: ['A', 'B'], targetSeconds: 30, slot: null },
  musicMood: 'wonder',
  ideaId: null,
};
