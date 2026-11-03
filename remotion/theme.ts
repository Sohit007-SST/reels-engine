/**
 * Theme tokens for every scene. Values come from brand/brand.json (single source of truth);
 * this file must stay importable from Node (tests, layout) and from the Remotion bundle,
 * so it must not touch the DOM or load fonts (see fonts.ts for that).
 */
import brand from '../brand/brand.json';

export const VIDEO = {
  width: brand.video.width,
  height: brand.video.height,
  fps: brand.video.fps,
  maxSeconds: brand.video.maxSeconds,
  maxBytes: brand.video.maxBytes,
} as const;

export const palette = { ...brand.palette } as const;
export type Palette = typeof palette;

/** Font families. The real faces are loaded by fonts.ts; the fallbacks keep layout sane if loading fails. */
export const fonts = {
  heading: brand.fonts.heading,
  body: brand.fonts.body,
  captions: brand.fonts.captions,
} as const;

export const fontStack = (family: string): string => `'${family}', 'Helvetica Neue', Arial, sans-serif`;

export interface SafeZonePct {
  topPct: number;
  bottomPct: number;
  leftPct: number;
  rightPct: number;
}

export const defaultSafeZonePct: SafeZonePct = { ...brand.safeZone };

export interface SafeZonePx {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Margins in px (distance from each edge that text must stay out of). */
export function safeZonePx(
  sz: SafeZonePct = defaultSafeZonePct,
  w = VIDEO.width,
  h = VIDEO.height,
): SafeZonePx {
  return {
    top: Math.round((h * sz.topPct) / 100),
    bottom: Math.round((h * sz.bottomPct) / 100),
    left: Math.round((w * sz.leftPct) / 100),
    right: Math.round((w * sz.rightPct) / 100),
  };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The rectangle in which all text must sit. */
export function safeRect(sz: SafeZonePct = defaultSafeZonePct, w = VIDEO.width, h = VIDEO.height): Rect {
  const px = safeZonePx(sz, w, h);
  return { x: px.left, y: px.top, width: w - px.left - px.right, height: h - px.top - px.bottom };
}

export function rectInside(inner: Rect, outer: Rect, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/** Timing tokens. */
export const timing = {
  /** Gap between voice beats (spec 7.4); the audio module owns the real value via VoiceTrack.gapMs. */
  beatGapMs: brand.voice.beatGapMs,
  /** Held frames after the last word so the CTA can be read. */
  tailMs: 700,
  /** Default transition length. */
  transitionFrames: 8,
  /** Hook zoom punch lasts 0–0.4 s. */
  hookPunchMs: 400,
} as const;

export const radii = { card: 36, pill: 999 } as const;

/** Hex colour with alpha (0–1). */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}
