/** Mascot cut-in: speech bubble with the on-screen text, mascot talking with an audio-driven mouth. */
import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { BoxText } from '../components/BoxText';
import { Mascot } from '../components/Mascot';
import { isExpression } from '../components/MascotSvg';
import { palette, withAlpha } from '../theme';
import { boxByRole, type SceneComponentProps } from './types';

export function expressionFor(params: Record<string, unknown>, motion: string) {
  if (isExpression(params.expression)) return params.expression;
  const m = motion.toLowerCase();
  if (m.includes('surpris') || m.includes('shock')) return 'surprised' as const;
  if (m.includes('happy') || m.includes('smile')) return 'happy' as const;
  if (m.includes('think')) return 'thinking' as const;
  return 'neutral' as const;
}

export const MascotTalk: React.FC<SceneComponentProps> = ({
  layout,
  scene,
  startFrame,
  audioSrc,
  words,
  mascotEnabled,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bubbleRect = layout.regions.bubble;
  const mascot = layout.regions.mascot;
  const text = boxByRole(layout, 'bubble');
  const pop = spring({ frame: frame - 2, fps, config: { damping: 12, stiffness: 200 } });
  return (
    <AbsoluteFill>
      <Background seed={`mt-${scene.index}`} />
      <AbsoluteFill
        style={{
          transform: `scale(${0.8 + 0.2 * pop})`,
          opacity: Math.min(1, pop * 1.5),
          transformOrigin: '50% 30%',
        }}
      >
        {bubbleRect ? (
          <>
            <div
              style={{
                position: 'absolute',
                left: bubbleRect.x,
                top: bubbleRect.y,
                width: bubbleRect.width,
                height: bubbleRect.height,
                borderRadius: 48,
                background: palette.text,
                boxShadow: `0 24px 70px ${withAlpha('#000000', 0.45)}`,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: bubbleRect.x + bubbleRect.width / 2 - 28,
                top: bubbleRect.y + bubbleRect.height - 4,
                width: 0,
                height: 0,
                borderLeft: '28px solid transparent',
                borderRight: '28px solid transparent',
                borderTop: `40px solid ${palette.text}`,
              }}
            />
          </>
        ) : null}
        {text ? <BoxText box={text} style="bubble" color={palette.background} shadow={false} /> : null}
      </AbsoluteFill>
      {mascotEnabled && mascot && mascot.width > 0 ? (
        <div style={{ position: 'absolute', left: mascot.x, top: mascot.y }}>
          <Mascot
            expression={expressionFor(scene.params, scene.motion)}
            size={mascot.width}
            frameOffset={startFrame}
            audioSrc={audioSrc}
            words={words}
            seed={`mascot-${scene.index}`}
          />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
