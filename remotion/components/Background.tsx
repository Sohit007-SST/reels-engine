/** Brand backdrop: deep gradient, drifting stars (deterministic) and a slow accent glow. */
import React, { useMemo } from 'react';
import { AbsoluteFill, random, useCurrentFrame, useVideoConfig } from 'remotion';
import { palette, withAlpha } from '../theme';

export const Background: React.FC<{ seed?: string; intensity?: number }> = ({
  seed = 'bg',
  intensity = 1,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const stars = useMemo(
    () =>
      Array.from({ length: 90 }, (_, i) => ({
        x: random(`${seed}-x-${i}`) * width,
        y: random(`${seed}-y-${i}`) * height,
        r: 1.2 + random(`${seed}-r-${i}`) * 2.8,
        speed: 6 + random(`${seed}-s-${i}`) * 22,
        phase: random(`${seed}-p-${i}`) * Math.PI * 2,
      })),
    [seed, width, height],
  );
  const t = frame / fps;
  return (
    <AbsoluteFill
      style={{ background: `linear-gradient(180deg, ${palette.background} 0%, ${palette.surface} 100%)` }}
    >
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${50 + Math.sin(t * 0.4) * 18}% ${38 + Math.cos(t * 0.3) * 10}%, ${withAlpha(
            palette.primary,
            0.28 * intensity,
          )} 0%, transparent 55%)`,
        }}
      />
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
        {stars.map((s, i) => (
          <circle
            key={i}
            cx={s.x}
            cy={(s.y + t * s.speed) % height}
            r={s.r}
            fill={palette.text}
            opacity={(0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2 + s.phase))) * intensity}
          />
        ))}
      </svg>
    </AbsoluteFill>
  );
};
