/** Thin progress bar along the top edge (graphic only, not text; outside the text report). */
import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { palette, withAlpha } from '../theme';

export const PROGRESS_BAR_HEIGHT = 10;

export const ProgressBar: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames, width } = useVideoConfig();
  const p = Math.min(1, (frame + 1) / durationInFrames);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width,
        height: PROGRESS_BAR_HEIGHT,
        background: withAlpha(palette.text, 0.15),
      }}
    >
      <div style={{ width: width * p, height: '100%', background: palette.accent }} />
    </div>
  );
};
