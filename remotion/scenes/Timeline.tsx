/** Vertical timeline: the rail grows and each event appears in turn (pov_history, what_if). */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Background } from '../components/Background';
import { BoxText } from '../components/BoxText';
import { palette, withAlpha } from '../theme';
import { boxByRole, type SceneComponentProps } from './types';

export const Timeline: React.FC<SceneComponentProps> = ({ layout, scene, frames }) => {
  const frame = useCurrentFrame();
  const title = boxByRole(layout, 'title');
  const rail = layout.regions.rail;
  const items = layout.boxes.filter((b) => b.role.startsWith('item'));
  const per = Math.max(6, Math.floor((frames * 0.7) / Math.max(1, items.length)));
  const grow = interpolate(frame, [4, 4 + per * items.length], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill>
      <Background seed={`tl-${scene.index}`} intensity={0.7} />
      {title ? <BoxText box={title} style="title" /> : null}
      {rail ? (
        <div
          style={{
            position: 'absolute',
            left: rail.x,
            top: rail.y,
            width: rail.width,
            height: rail.height * grow,
            borderRadius: 6,
            background: `linear-gradient(${palette.primary}, ${palette.accent})`,
          }}
        />
      ) : null}
      {items.map((label, i) => {
        const n = label.role.slice('item'.length);
        const year = boxByRole(layout, `year${n}`);
        const at = 4 + per * i;
        const o = interpolate(frame, [at, at + 8], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const dx = (1 - o) * 50;
        const top = year ? year.y : label.y;
        return (
          <React.Fragment key={label.id}>
            {rail ? (
              <div
                style={{
                  position: 'absolute',
                  left: rail.x + rail.width / 2 - 18,
                  top: top + 10,
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  background: palette.highlight,
                  border: `5px solid ${palette.background}`,
                  transform: `scale(${o})`,
                  boxShadow: `0 0 24px ${withAlpha(palette.highlight, 0.7)}`,
                }}
              />
            ) : null}
            {year ? (
              <BoxText
                box={year}
                style="title"
                align="left"
                color={palette.accent}
                boxStyle={{ opacity: o, transform: `translateX(${dx}px)` }}
              />
            ) : null}
            <BoxText
              box={label}
              style="label"
              align="left"
              boxStyle={{ opacity: o, transform: `translateX(${dx}px)` }}
            />
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};
