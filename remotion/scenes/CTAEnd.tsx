/** End card: headline, the one comment question, a pulsing follow pill and a happy mascot. */
import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { BoxText } from '../components/BoxText';
import { Mascot } from '../components/Mascot';
import { palette, radii } from '../theme';
import { boxByRole, type SceneComponentProps } from './types';

export const CTAEnd: React.FC<SceneComponentProps> = ({
  layout,
  scene,
  startFrame,
  audioSrc,
  words,
  mascotEnabled,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const headline = boxByRole(layout, 'headline');
  const question = boxByRole(layout, 'question');
  const cta = boxByRole(layout, 'cta');
  const pill = layout.regions.pill;
  const mascot = layout.regions.mascot;
  const s = spring({ frame, fps, config: { damping: 14, stiffness: 150 } });
  const pulse = 1 + 0.035 * Math.sin((frame / fps) * Math.PI * 2);
  const qIn = interpolate(frame, [8, 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill>
      <Background seed={`cta-${scene.index}`} intensity={1.1} />
      {mascotEnabled && mascot && mascot.width > 0 ? (
        <div style={{ position: 'absolute', left: mascot.x, top: mascot.y, transform: `scale(${s})` }}>
          <Mascot
            expression="happy"
            size={mascot.width}
            frameOffset={startFrame}
            audioSrc={audioSrc}
            words={words}
            seed="mascot-cta"
          />
        </div>
      ) : null}
      {headline ? (
        <BoxText
          box={headline}
          style="title"
          boxStyle={{ opacity: s, transform: `translateY(${(1 - s) * 40}px)` }}
        />
      ) : null}
      {question ? (
        <BoxText box={question} style="label" color={palette.highlight} boxStyle={{ opacity: qIn }} />
      ) : null}
      {pill ? (
        <div
          style={{
            position: 'absolute',
            left: pill.x,
            top: pill.y,
            width: pill.width,
            height: pill.height,
            borderRadius: radii.pill,
            background: palette.accent,
            transform: `scale(${pulse * s})`,
          }}
        />
      ) : null}
      {cta ? (
        <BoxText
          box={cta}
          style="badge"
          color={palette.background}
          shadow={false}
          boxStyle={{ transform: `scale(${pulse * s})` }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
