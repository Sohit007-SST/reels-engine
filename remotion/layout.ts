/**
 * Text layout for every scene and the captions (spec 7.6 "text bounds report").
 *
 * Pure and deterministic given a text measurer. In the Remotion bundle the measurer is
 * @remotion/layout-utils measureText() (real fonts, see measure.ts); in Node unit tests an
 * estimating measurer is used. Scenes render EXACTLY the boxes computed here (absolute position,
 * explicit lines, fixed font size), so the report QA reads matches what is on screen.
 */
import { createTikTokStyleCaptions, type Caption } from '@remotion/captions';
import type { CaptionPageLayout, LaidOutBox, ReelLayout, RenderWord, SceneLayout, SceneProps } from './props';
import { computeTimeline } from './timeline';
import { fonts, safeRect, VIDEO, type Rect, type SafeZonePct } from './theme';

export interface TextStyle {
  fontFamily: string;
  fontWeight: number;
  uppercase: boolean;
  lineHeight: number;
  letterSpacing?: string;
}

export type Measurer = (
  text: string,
  style: TextStyle,
  fontSize: number,
) => { width: number; height: number };

/** Style tokens; scenes import these so render and layout always agree. */
export const TEXT_STYLES = {
  title: { fontFamily: fonts.heading, fontWeight: 400, uppercase: true, lineHeight: 1.14 },
  kicker: {
    fontFamily: fonts.body,
    fontWeight: 600,
    uppercase: true,
    lineHeight: 1.2,
    letterSpacing: '0.12em',
  },
  body: { fontFamily: fonts.body, fontWeight: 800, uppercase: false, lineHeight: 1.18 },
  small: { fontFamily: fonts.body, fontWeight: 500, uppercase: false, lineHeight: 1.25 },
  label: { fontFamily: fonts.body, fontWeight: 700, uppercase: false, lineHeight: 1.18 },
  badge: {
    fontFamily: fonts.captions,
    fontWeight: 800,
    uppercase: true,
    lineHeight: 1.1,
    letterSpacing: '0.08em',
  },
  bubble: { fontFamily: fonts.captions, fontWeight: 800, uppercase: false, lineHeight: 1.16 },
  caption: { fontFamily: fonts.captions, fontWeight: 800, uppercase: true, lineHeight: 1.12 },
} as const satisfies Record<string, TextStyle>;
export type TextStyleName = keyof typeof TEXT_STYLES;

/** Rough per-family width factors (fraction of the font size per character) for estimating. */
const WIDTH_FACTOR: Record<string, number> = {
  [fonts.heading]: 0.5,
  [fonts.body]: 0.58,
  [fonts.captions]: 0.66,
};

/** Deterministic estimate used in Node tests and as a fallback when fonts can't be measured. */
export const estimateMeasurer: Measurer = (text, style, fontSize) => {
  const factor = WIDTH_FACTOR[style.fontFamily] ?? 0.6;
  const boldBoost = style.fontWeight >= 700 ? 1.06 : 1;
  const wide = [...text].reduce(
    (n, ch) => n + (/[MW@]/.test(ch) ? 1.35 : /[il.,'!|:;]/.test(ch) ? 0.45 : 1),
    0,
  );
  const spacing = style.letterSpacing ? parseFloat(style.letterSpacing) * fontSize * text.length : 0;
  return { width: wide * fontSize * factor * boldBoost + spacing, height: fontSize * style.lineHeight };
};

export const ZOOM_MAX = 1.1; // Ken Burns peak scale; card size is limited so content is never upscaled.

const MIN_GAP = 28;

export interface FitRequest {
  id: string;
  role: string;
  text: string;
  /** Pre-split units (caption tokens); default = whitespace words. */
  units?: string[];
  style: TextStyleName;
  maxWidth: number;
  maxLines: number;
  maxFontSize: number;
  minFontSize: number;
}

export interface FittedText {
  id: string;
  role: string;
  text: string;
  lines: string[];
  fontSize: number;
  lineHeight: number;
  width: number;
  height: number;
  overflow: boolean;
}

function wrapUnits(
  units: string[],
  style: TextStyle,
  fontSize: number,
  maxWidth: number,
  measure: Measurer,
): { lines: string[]; widest: number; fits: boolean } {
  const lines: string[] = [];
  let current = '';
  let widest = 0;
  let fits = true;
  for (const unit of units) {
    const candidate = current ? `${current} ${unit}` : unit;
    const w = measure(candidate, style, fontSize).width;
    if (w <= maxWidth || !current) {
      if (w > maxWidth) fits = false; // a single unit wider than the box
      current = candidate;
    } else {
      lines.push(current);
      current = unit;
      if (measure(unit, style, fontSize).width > maxWidth) fits = false;
    }
  }
  if (current) lines.push(current);
  for (const l of lines) widest = Math.max(widest, measure(l, style, fontSize).width);
  return { lines, widest, fits };
}

/** Largest font size (step 2 px) at which the text wraps into maxLines within maxWidth. */
export function fitText(req: FitRequest, measure: Measurer): FittedText {
  const style = TEXT_STYLES[req.style];
  const raw = req.text.trim();
  const shown = style.uppercase ? raw.toUpperCase() : raw;
  const units = (req.units ?? shown.split(/\s+/))
    .map((u) => (style.uppercase ? u.toUpperCase() : u))
    .filter(Boolean);
  if (units.length === 0) {
    return {
      id: req.id,
      role: req.role,
      text: '',
      lines: [],
      fontSize: req.minFontSize,
      lineHeight: style.lineHeight,
      width: 0,
      height: 0,
      overflow: false,
    };
  }
  let size = req.maxFontSize;
  for (; size >= req.minFontSize; size -= 2) {
    const r = wrapUnits(units, style, size, req.maxWidth, measure);
    if (r.fits && r.lines.length <= req.maxLines) {
      return {
        id: req.id,
        role: req.role,
        text: units.join(' '),
        lines: r.lines,
        fontSize: size,
        lineHeight: style.lineHeight,
        width: Math.ceil(r.widest),
        height: Math.ceil(r.lines.length * size * style.lineHeight),
        overflow: false,
      };
    }
  }
  // Could not fit even at the minimum size: keep min size, clamp lines, flag overflow for QA.
  const r = wrapUnits(units, style, req.minFontSize, req.maxWidth, measure);
  const lines = r.lines.slice(0, req.maxLines);
  if (r.lines.length > req.maxLines && lines.length > 0)
    lines[lines.length - 1] = `${lines[lines.length - 1]}…`;
  return {
    id: req.id,
    role: req.role,
    text: units.join(' '),
    lines,
    fontSize: req.minFontSize,
    lineHeight: style.lineHeight,
    width: Math.ceil(Math.min(r.widest, req.maxWidth)),
    height: Math.ceil(lines.length * req.minFontSize * style.lineHeight),
    overflow: true,
  };
}

export const place = (t: FittedText, x: number, y: number): LaidOutBox => ({
  id: t.id,
  role: t.role,
  text: t.text,
  lines: t.lines,
  x: Math.round(x),
  y: Math.round(y),
  width: t.width,
  height: t.height,
  fontSize: t.fontSize,
  lineHeight: t.lineHeight,
  overflow: t.overflow,
});

/** Geometry shared by scenes and captions. */
export function frameGeometry(sz?: SafeZonePct | null) {
  const safe = safeRect(sz ?? undefined);
  const cx = safe.x + safe.width / 2;
  const contentWidth = safe.width - 40;
  const captionBottom = safe.y + safe.height - 36;
  const captionMaxHeight = 190;
  const sceneTop = safe.y + 40;
  const sceneBottom = captionBottom - captionMaxHeight - 30;
  return { safe, cx, contentWidth, captionBottom, captionMaxHeight, sceneTop, sceneBottom };
}
export type Geometry = ReturnType<typeof frameGeometry>;

type Item =
  | { kind: 'text'; t: FittedText; align?: 'center' | 'left'; x?: number }
  | { kind: 'region'; name: string; width: number; height: number };

/** Stack items vertically, centred in [top, bottom]; returns boxes and regions. */
function stack(items: Item[], top: number, bottom: number, cx: number, gap = MIN_GAP) {
  const visible = items.filter((it) => (it.kind === 'text' ? it.t.lines.length > 0 : it.height > 0));
  const total =
    visible.reduce((h, it) => h + (it.kind === 'text' ? it.t.height : it.height), 0) +
    gap * Math.max(0, visible.length - 1);
  let y = top + Math.max(0, (bottom - top - total) / 2);
  const boxes: LaidOutBox[] = [];
  const regions: Record<string, Rect> = {};
  for (const it of visible) {
    if (it.kind === 'text') {
      const x = it.align === 'left' ? (it.x ?? cx) : cx - it.t.width / 2;
      boxes.push(place(it.t, x, y));
      y += it.t.height + gap;
    } else {
      regions[it.name] = {
        x: Math.round(cx - it.width / 2),
        y: Math.round(y),
        width: Math.round(it.width),
        height: Math.round(it.height),
      };
      y += it.height + gap;
    }
  }
  return { boxes, regions };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export interface TimelineItem {
  year: string;
  label: string;
}

export function timelineItems(scene: SceneProps): TimelineItem[] {
  const raw = scene.params.items;
  if (Array.isArray(raw)) {
    const items = raw
      .map((it): TimelineItem | null => {
        if (typeof it === 'string') return { year: '', label: it };
        if (it && typeof it === 'object') {
          const o = it as Record<string, unknown>;
          const label = str(o.label) ?? str(o.text);
          if (!label) return null;
          return { year: str(o.year) ?? str(o.when) ?? '', label };
        }
        return null;
      })
      .filter((x): x is TimelineItem => x !== null);
    if (items.length > 0) return items.slice(0, 5);
  }
  return [{ year: '', label: scene.onScreenText || scene.voiceover }];
}

export const SCENE_TYPES = [
  'HookTitle',
  'KineticText',
  'ImageKenBurns',
  'FactCard',
  'Timeline',
  'MascotTalk',
  'CTAEnd',
] as const;
export type SceneType = (typeof SCENE_TYPES)[number];
export const isSceneType = (s: string): s is SceneType => (SCENE_TYPES as readonly string[]).includes(s);

export interface LayoutContext {
  geometry: Geometry;
  commentQuestion: string | null;
  mascotEnabled: boolean;
}

/** Layout one scene; unknown scene types render (and are reported) as KineticText. */
export function layoutScene(scene: SceneProps, ctx: LayoutContext, measure: Measurer): SceneLayout {
  const g = ctx.geometry;
  const W = g.contentWidth;
  const renderedAs: SceneType = isSceneType(scene.sceneType) ? scene.sceneType : 'KineticText';
  const id = (n: string) => `s${scene.index}-${n}`;
  const fit = (
    n: string,
    text: string,
    style: TextStyleName,
    maxWidth: number,
    maxLines: number,
    maxFontSize: number,
    minFontSize: number,
  ) => fitText({ id: id(n), role: n, text, style, maxWidth, maxLines, maxFontSize, minFontSize }, measure);
  const p = scene.params;
  const text = scene.onScreenText || scene.voiceover;
  let out: { boxes: LaidOutBox[]; regions: Record<string, Rect> };

  switch (renderedAs) {
    case 'HookTitle': {
      const kicker = str(p.kicker);
      out = stack(
        [
          ...(kicker ? [{ kind: 'text' as const, t: fit('kicker', kicker, 'kicker', W, 1, 46, 30) }] : []),
          { kind: 'text', t: fit('title', text, 'title', W, 3, 168, 72) },
        ],
        g.sceneTop,
        g.sceneTop + (g.sceneBottom - g.sceneTop) * 0.8,
        g.cx,
      );
      break;
    }
    case 'KineticText': {
      out = stack(
        [{ kind: 'text', t: fit('text', text, 'title', W, 4, 150, 64) }],
        g.sceneTop,
        g.sceneBottom,
        g.cx,
      );
      break;
    }
    case 'ImageKenBurns': {
      const label = fit('label', text, 'title', W, 2, 96, 56);
      const availH = g.sceneBottom - g.sceneTop - label.height - MIN_GAP;
      let cw: number;
      let ch: number;
      if (scene.image) {
        const aspect = scene.image.width / scene.image.height;
        cw = Math.min(W, availH * aspect, scene.image.width / ZOOM_MAX);
        ch = cw / aspect;
      } else {
        cw = W;
        ch = Math.min(availH, W * 1.1);
      }
      out = stack(
        [
          { kind: 'text', t: label },
          { kind: 'region', name: 'card', width: Math.floor(cw), height: Math.floor(ch) },
        ],
        g.sceneTop,
        g.sceneBottom,
        g.cx,
      );
      break;
    }
    case 'FactCard': {
      const pad = 48;
      const inner = W - pad * 2;
      const rank = p.rank !== undefined && p.rank !== null ? `#${String(p.rank)}` : null;
      const badge = fit('badge', rank ?? str(p.badge) ?? 'FACT', 'badge', inner, 1, 44, 30);
      const stat = str(p.stat);
      const statT = stat ? fit('stat', stat, 'title', inner, 1, 180, 90) : null;
      const statement = fit('statement', text, 'body', inner, 4, 76, 44);
      const source = str(p.source);
      const sourceT = source ? fit('source', `Source: ${source}`, 'small', inner, 2, 30, 24) : null;
      const parts = [badge, statT, statement, sourceT].filter((t): t is FittedText => t !== null);
      const contentH = parts.reduce((h, t) => h + t.height, 0) + MIN_GAP * (parts.length - 1);
      const panelH = contentH + pad * 2;
      const panelY = g.sceneTop + Math.max(0, (g.sceneBottom - g.sceneTop - panelH) / 2);
      const panel: Rect = {
        x: Math.round(g.cx - W / 2),
        y: Math.round(panelY),
        width: W,
        height: Math.round(panelH),
      };
      let y = panelY + pad;
      const boxes = parts.map((t) => {
        const b = place(t, g.cx - t.width / 2, y);
        y += t.height + MIN_GAP;
        return b;
      });
      out = { boxes, regions: { panel } };
      break;
    }
    case 'Timeline': {
      const title = fit('title', text, 'title', W, 2, 96, 56);
      const items = timelineItems(scene);
      const left = g.safe.x + 150;
      const labelW = g.safe.x + g.safe.width - 20 - left;
      const rows = items.map((it, i) => ({
        year: it.year ? fit(`year${i}`, it.year, 'title', labelW, 1, 64, 40) : null,
        label: fit(`item${i}`, it.label, 'label', labelW, 2, 48, 30),
      }));
      const rowH = (r: (typeof rows)[number]) => (r.year ? r.year.height + 6 : 0) + r.label.height;
      const listH = rows.reduce((h, r) => h + rowH(r), 0) + 40 * Math.max(0, rows.length - 1);
      const total = title.height + 56 + listH;
      let y = g.sceneTop + Math.max(0, (g.sceneBottom - g.sceneTop - total) / 2);
      const boxes: LaidOutBox[] = [place(title, g.cx - title.width / 2, y)];
      y += title.height + 56;
      const listTop = y;
      rows.forEach((r) => {
        if (r.year) {
          boxes.push(place(r.year, left, y));
          y += r.year.height + 6;
        }
        boxes.push(place(r.label, left, y));
        y += r.label.height + 40;
      });
      out = {
        boxes,
        regions: {
          rail: { x: Math.round(left - 70), y: Math.round(listTop), width: 12, height: Math.round(listH) },
        },
      };
      break;
    }
    case 'MascotTalk': {
      const bubble = fit('bubble', text, 'bubble', W - 100, 3, 72, 44);
      const mascot = ctx.mascotEnabled
        ? Math.min(460, g.sceneBottom - g.sceneTop - bubble.height - 100 - MIN_GAP)
        : 0;
      out = stack(
        [
          { kind: 'text', t: bubble },
          { kind: 'region', name: 'mascot', width: mascot, height: mascot },
        ],
        g.sceneTop + 50,
        g.sceneBottom,
        g.cx,
        MIN_GAP + 50,
      );
      const b = out.boxes[0];
      if (b) out.regions.bubble = { x: b.x - 50, y: b.y - 50, width: b.width + 100, height: b.height + 100 };
      break;
    }
    case 'CTAEnd': {
      const question = str(p.question) ?? ctx.commentQuestion;
      const cta = str(p.cta) ?? 'Follow for more';
      const mascot = ctx.mascotEnabled ? 260 : 0;
      out = stack(
        [
          { kind: 'region', name: 'mascot', width: mascot, height: mascot },
          { kind: 'text', t: fit('headline', text, 'title', W, 3, 120, 60) },
          ...(question
            ? [{ kind: 'text' as const, t: fit('question', question, 'label', W - 60, 3, 56, 34) }]
            : []),
          { kind: 'text', t: fit('cta', cta, 'badge', W - 160, 1, 52, 32) },
        ],
        g.sceneTop,
        g.sceneBottom,
        g.cx,
        36,
      );
      const pill = out.boxes.find((b) => b.role === 'cta');
      if (pill)
        out.regions.pill = {
          x: pill.x - 44,
          y: pill.y - 22,
          width: pill.width + 88,
          height: pill.height + 44,
        };
      break;
    }
  }
  return {
    index: scene.index,
    sceneType: scene.sceneType,
    renderedAs,
    boxes: out.boxes,
    regions: out.regions,
  };
}

/** Caption pages (word-by-word highlight) via @remotion/captions, with our own page-break rules. */
export function captionPages(words: RenderWord[], maxWords = 4, maxChars = 24) {
  const captions: Caption[] = [];
  let count = 0;
  let chars = 0;
  words.forEach((w, i) => {
    const next = words[i + 1];
    count += 1;
    chars += w.text.length + 1;
    const nextLen = next ? next.text.length + 1 : 0;
    const pageBreakAfter =
      !next ||
      next.beatIndex !== w.beatIndex ||
      count >= maxWords ||
      chars + nextLen > maxChars ||
      next.startMs - w.endMs > 350;
    captions.push({
      text: ` ${w.text.trim()}`,
      startMs: w.startMs,
      endMs: w.endMs,
      timestampMs: null,
      confidence: null,
      pageBreakAfter,
    });
    if (pageBreakAfter) {
      count = 0;
      chars = 0;
    }
  });
  const { pages } = createTikTokStyleCaptions({
    captions,
    combineTokensWithinMilliseconds: 1500,
    breakOnSilenceAfterMilliseconds: 350,
  });
  return pages.map((page, i) => {
    const lastTo = page.tokens.reduce((m, t) => Math.max(m, t.toMs), page.startMs);
    const nextStart = pages[i + 1]?.startMs ?? Infinity;
    return {
      index: i,
      startMs: page.startMs,
      endMs: Math.min(nextStart, lastTo + 400),
      tokens: page.tokens.map((t) => ({ text: t.text.trim(), fromMs: t.fromMs, toMs: t.toMs })),
    };
  });
}

export function layoutCaptions(words: RenderWord[], g: Geometry, measure: Measurer): CaptionPageLayout[] {
  return captionPages(words).map((page) => {
    const t = fitText(
      {
        id: `cap${page.index}`,
        role: 'caption',
        text: page.tokens.map((x) => x.text).join(' '),
        units: page.tokens.map((x) => x.text),
        style: 'caption',
        maxWidth: g.contentWidth,
        maxLines: 2,
        maxFontSize: 76,
        minFontSize: 44,
      },
      measure,
    );
    return { ...page, box: place(t, g.cx - t.width / 2, g.captionBottom - t.height) };
  });
}

export interface LayoutInput {
  scenes: SceneProps[];
  words: RenderWord[];
  totalMs: number;
  tailMs: number;
  transitionFrames: number;
  commentQuestion: string | null;
  mascotEnabled: boolean;
  safeZone: SafeZonePct | null;
  fps?: number;
}

/** Full reel layout: timeline + per-scene text boxes + caption boxes. */
export function computeReelLayout(
  input: LayoutInput,
  measure: Measurer,
  measuredWith: ReelLayout['measuredWith'],
): ReelLayout {
  const g = frameGeometry(input.safeZone);
  const tl = computeTimeline({
    scenes: input.scenes,
    totalMs: input.totalMs,
    tailMs: input.tailMs,
    fps: input.fps ?? VIDEO.fps,
    transitionFrames: input.transitionFrames,
  });
  const ctx: LayoutContext = {
    geometry: g,
    commentQuestion: input.commentQuestion,
    mascotEnabled: input.mascotEnabled,
  };
  return {
    measuredWith,
    durationInFrames: tl.durationInFrames,
    timeline: tl.entries,
    scenes: input.scenes.map((s) => layoutScene(s, ctx, measure)),
    captions: layoutCaptions(input.words, g, measure),
  };
}
