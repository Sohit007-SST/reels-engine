/** Builders for QA test inputs (valid by default; tests inject one defect at a time). */
import {
  Blocklist,
  Brand,
  ReelSpec,
  RenderReport,
  VoiceTrack,
  type ReelSpecInput,
} from '../../../src/schemas';
import { loadBlocklist, loadBrand } from '../../../src/config';
import { VOICE_BEATS } from './generate';

export async function brandAndBlocklist(): Promise<{ brand: Brand; blocklist: Blocklist }> {
  const [brand, blocklist] = await Promise.all([loadBrand(), loadBlocklist()]);
  return { brand: Brand.parse(brand), blocklist: Blocklist.parse(blocklist) };
}

export const DISCLOSURE = "Visuals and voice made with AI. 'What if' scenarios are hypothetical.";

export function makeSpec(overrides: Partial<ReelSpecInput> = {}): ReelSpec {
  const base: ReelSpecInput = {
    schemaVersion: 1,
    id: '2026-11-05-01',
    promptVersion: 'fixture@1',
    model: 'fixture',
    language: 'en',
    placement: 'main',
    format: 'what_if',
    hook: {
      formulaId: 'what_if',
      spoken: 'What if the ocean floor lit up at night?',
      onScreen: 'GLOWING SEAFLOOR?',
      alternates: [],
    },
    beats: [
      {
        role: 'hook',
        voiceover: 'What if the ocean floor lit up at night?',
        onScreenText: 'GLOWING SEAFLOOR?',
        sceneType: 'HookTitle',
        visual: { tier: 'A', params: { title: 'GLOWING SEAFLOOR?' } },
        motion: 'zoom_punch',
        sfx: 'hit',
      },
      {
        role: 'setup',
        voiceover:
          'Deep water is the darkest place on the planet, yet many animals there already make their own light.',
        onScreenText: 'Living light',
        sceneType: 'KineticText',
        visual: { tier: 'B', prompt: 'deep sea creatures glowing blue in dark water' },
        motion: 'slow_zoom',
        sfx: 'whoosh',
      },
      {
        role: 'escalation',
        voiceover:
          'Imagine every trench glowing like a city seen from a plane, bright enough to map from orbit.',
        onScreenText: 'Trenches like cities',
        sceneType: 'ImageKenBurns',
        visual: { tier: 'B', prompt: 'glowing ocean trench seen from above at night' },
        motion: 'pan_left',
        sfx: 'none',
      },
      {
        role: 'escalation',
        voiceover: 'Ships could steer by the glow, and sailors might stop fearing the open sea after sunset.',
        onScreenText: 'Navigation by glow',
        sceneType: 'KineticText',
        visual: { tier: 'A' },
        motion: 'slide_up',
        sfx: 'pop',
      },
      {
        role: 'payoff',
        voiceover:
          'The strange part is that predators would see everything too, so the whole food chain would change.',
        onScreenText: 'Nowhere to hide',
        sceneType: 'FactCard',
        visual: { tier: 'A' },
        motion: 'fade',
        sfx: 'ding',
      },
      {
        role: 'cta',
        voiceover: 'Would you swim in a glowing sea? Follow for part 2.',
        onScreenText: 'Follow for part 2',
        sceneType: 'CTAEnd',
        visual: { tier: 'A' },
        motion: 'fade',
        sfx: 'none',
      },
    ],
    caption: [
      'What if the ocean floor lit up at night?',
      'Deep-sea animals already glow. Picture whole trenches shining like cities.',
      'Would you swim in it?',
      '#whatif #science #earth',
      DISCLOSURE,
    ].join('\n'),
    captionVersion: 1,
    hashtags: ['#whatif', '#science', '#earth'],
    commentQuestion: 'Would you swim in it?',
    facts: [
      {
        claim: 'many deep sea animals make their own light',
        sourceUrl: 'https://example.org/bioluminescence',
        publisher: 'Example Ocean Institute',
        retrievedAt: '2026-11-01',
        supportingQuote:
          'Most animals that live in the deep sea make their own light through bioluminescence.',
        status: 'SUPPORTED',
        verifiedAt: '2026-11-01T10:00:00.000Z',
        verifierNote: 'quote found on source page',
      },
      {
        claim: 'trenches glowing like a city',
        sourceUrl: null,
        publisher: null,
        retrievedAt: null,
        supportingQuote: null,
        status: 'HYPOTHETICAL',
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
    musicMood: 'wonder',
    ideaId: null,
  };
  return ReelSpec.parse({ ...base, ...overrides });
}

/** Render report for an N-second 1080x1920@30 file split into equal scenes, text inside the safe zone. */
export function makeRenderReport(
  seconds: number,
  scenes = 3,
  overrides: Partial<RenderReport> = {},
): RenderReport {
  const total = Math.round(seconds * 30);
  const per = Math.floor(total / scenes);
  return RenderReport.parse({
    schemaVersion: 1,
    reelId: '2026-11-05-01',
    createdAt: '2026-11-05T00:00:00.000Z',
    outputPath: 'out/2026-11-05-01/reel.mp4',
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: total,
    safeZonePx: { top: 192, bottom: 384, left: 54, right: 130 },
    scenes: Array.from({ length: scenes }, (_, i) => ({
      index: i,
      sceneType: i === 0 ? 'HookTitle' : 'KineticText',
      startFrame: i * per,
      endFrame: i === scenes - 1 ? total : (i + 1) * per,
      textBoxes: [
        {
          id: `scene${i}-title`,
          text: `Scene ${i} title`,
          x: 100,
          y: 400,
          width: 800,
          height: 220,
          fontSize: 96,
          overflow: false,
        },
      ],
    })),
    captionBoxes: [
      {
        id: 'caption-0',
        text: 'What if the ocean',
        x: 120,
        y: 1300,
        width: 760,
        height: 140,
        fontSize: 64,
        overflow: false,
      },
    ],
    coverFrame: 12,
    renderMs: 1000,
    ...overrides,
  });
}

/** Voice track matching tests/fixtures/qa voice.wav (3 beats, 120 ms gaps). */
export function makeVoiceTrack(voicePath: string, shiftBeat1Ms = 0): VoiceTrack {
  const words = [
    { text: 'What', startMs: 0, endMs: 250, beatIndex: 0 },
    { text: 'if', startMs: 300, endMs: 420, beatIndex: 0 },
    { text: 'the', startMs: 700, endMs: 800, beatIndex: 0 },
    { text: 'ocean', startMs: 1050, endMs: 1450, beatIndex: 0 },
    { text: 'Deep', startMs: 1620, endMs: 1900, beatIndex: 1 },
    { text: 'water', startMs: 2000, endMs: 2400, beatIndex: 1 },
    { text: 'is', startMs: 2500, endMs: 2650, beatIndex: 1 },
    { text: 'dark', startMs: 3000, endMs: 3500, beatIndex: 1 },
    { text: 'Imagine', startMs: 3740, endMs: 4200, beatIndex: 2 },
    { text: 'every', startMs: 4300, endMs: 4600, beatIndex: 2 },
    { text: 'trench', startMs: 4700, endMs: 5150, beatIndex: 2 },
  ].map((w) => ({
    ...w,
    startMs: w.beatIndex === 1 ? w.startMs + shiftBeat1Ms : w.startMs,
    endMs: w.beatIndex === 1 ? w.endMs + shiftBeat1Ms : w.endMs,
    matched: true,
  }));
  return VoiceTrack.parse({
    schemaVersion: 1,
    reelId: '2026-11-05-01',
    createdAt: '2026-11-05T00:00:00.000Z',
    voiceId: 'af_heart',
    speed: 1.08,
    gapMs: 120,
    beats: VOICE_BEATS.map((b) => ({ ...b, audioPath: `beat${b.index}.wav`, text: `beat ${b.index}` })),
    voicePath,
    totalMs: 5240,
    words,
    unmatchedWordCount: 0,
    timingSource: 'faster-whisper',
    mix: null,
  });
}
