/** Kinetic typography: words pop in one after another; the last word is highlighted. */
import React from 'react';
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { BoxText } from '../components/BoxText';
import { palette } from '../theme';
import { boxByRole, type SceneComponentProps } from './types';

export const KineticText: React.FC<SceneComponentProps> = ({ layout, scene }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const box = boxByRole(layout, 'text');
  const highlight = typeof scene.params.highlight === 'string' ? scene.params.highlight.toUpperCase() : null;
  const total = box ? box.lines.reduce((n, l) => n + l.split(' ').length, 0) : 0;
  let cursor = 0;
  return (
    <AbsoluteFill>
      <Background seed={`kin-${scene.index}`} />
      {box ? (
        <BoxText
          box={box}
          style="title"
          renderLine={(line) => {
            const words = line.split(' ');
            return words.map((w, wi) => {
              const i = cursor++;
              const s = spring({ frame: frame - i * 3, fps, config: { damping: 12, stiffness: 180 } });
              const hl = highlight
                ? w.replace(/[^\p{L}\p{N}]/gu, '') === highlight.replace(/[^\p{L}\p{N}]/gu, '')
                : i === total - 1;
              return (
                <span
                  key={wi}
                  style={{
                    display: 'inline-block',
                    transform: `translateY(${(1 - s) * 40}px) scale(${0.85 + 0.15 * s})`,
                    opacity: Math.min(1, s * 1.4),
                    color: hl ? palette.highlight : palette.text,
                  }}
                >
                  {w}
                  {wi < words.length - 1 ? ' ' : ''}
                </span>
              );
            });
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};
