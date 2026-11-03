/**
 * Word-by-word highlighted captions. Pages and boxes come from layout.ts (built with
 * @remotion/captions createTikTokStyleCaptions); text is always the canonical script word.
 */
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CaptionPageLayout } from '../props';
import { palette } from '../theme';
import { BoxText } from './BoxText';

/** Index of the page visible at `ms`, or -1. */
export function pageAt(pages: CaptionPageLayout[], ms: number): number {
  return pages.findIndex((p) => ms >= p.startMs && ms < p.endMs);
}

/** Index of the highlighted token: the last token that has started. */
export function activeToken(page: CaptionPageLayout, ms: number): number {
  let idx = -1;
  page.tokens.forEach((t, i) => {
    if (ms >= t.fromMs) idx = i;
  });
  return idx;
}

export const Captions: React.FC<{ pages: CaptionPageLayout[] }> = ({ pages }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const pi = pageAt(pages, ms);
  const page = pages[pi];
  if (!page) return null;
  const active = activeToken(page, ms);
  const startFrame = Math.round((page.startMs / 1000) * fps);
  const pop = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 14, stiffness: 220 },
    durationInFrames: 8,
  });
  const scale = interpolate(pop, [0, 1], [0.9, 1]);
  let tokenCursor = 0;
  return (
    <BoxText
      box={page.box}
      style="caption"
      boxStyle={{
        transform: `scale(${scale})`,
        transformOrigin: 'center bottom',
        WebkitTextStroke: `3px ${palette.background}`,
        paintOrder: 'stroke fill',
      }}
      renderLine={(line) => {
        const words = line.split(' ');
        return words.map((w, wi) => {
          const idx = tokenCursor++;
          const on = idx === active;
          return (
            <span key={wi} style={{ color: on ? palette.highlight : palette.text }}>
              {w}
              {wi < words.length - 1 ? ' ' : ''}
            </span>
          );
        });
      }}
    />
  );
};
