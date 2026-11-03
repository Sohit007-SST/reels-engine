/** Fact card: badge (FACT or countdown rank), optional big stat, statement and source line. */
import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { BoxText } from '../components/BoxText';
import { palette, radii, withAlpha } from '../theme';
import { boxByRole, type SceneComponentProps } from './types';

export const FactCard: React.FC<SceneComponentProps> = ({ layout, scene }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const panel = layout.regions.panel;
  const s = spring({ frame, fps, config: { damping: 15, stiffness: 160 } });
  const rise = (1 - s) * 120;
  const fadeIn = (delay: number) => ({
    opacity: interpolate(frame, [delay, delay + 8], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  });
  const badge = boxByRole(layout, 'badge');
  const stat = boxByRole(layout, 'stat');
  const statement = boxByRole(layout, 'statement');
  const source = boxByRole(layout, 'source');
  return (
    <AbsoluteFill>
      <Background seed={`fact-${scene.index}`} intensity={0.6} />
      <AbsoluteFill style={{ transform: `translateY(${rise}px)`, opacity: Math.min(1, s * 1.5) }}>
        {panel ? (
          <div
            style={{
              position: 'absolute',
              left: panel.x,
              top: panel.y,
              width: panel.width,
              height: panel.height,
              borderRadius: radii.card,
              background: withAlpha(palette.surface, 0.94),
              border: `4px solid ${withAlpha(palette.primary, 0.8)}`,
              boxShadow: `0 30px 90px ${withAlpha('#000000', 0.5)}`,
            }}
          />
        ) : null}
        {badge ? <BoxText box={badge} style="badge" color={palette.accent} shadow={false} /> : null}
        {stat ? <BoxText box={stat} style="title" color={palette.highlight} boxStyle={fadeIn(4)} /> : null}
        {statement ? <BoxText box={statement} style="body" boxStyle={fadeIn(8)} shadow={false} /> : null}
        {source ? (
          <BoxText
            box={source}
            style="small"
            color={palette.mutedText}
            boxStyle={fadeIn(14)}
            shadow={false}
          />
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
