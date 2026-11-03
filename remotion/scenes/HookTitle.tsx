/**
 * Hook (0–2 s): zoom punch over 0–0.4 s with motion from frame 0 (the title is already moving and
 * a flash is fading on the very first frame, so the cover never looks static).
 * The title overshoots at most 4 % and its layout leaves that headroom inside the safe zone.
 */
import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { BoxText } from '../components/BoxText';
import { palette, timing, withAlpha } from '../theme';
import { boxByRole, type SceneComponentProps } from './types';

export const HookTitle: React.FC<SceneComponentProps> = ({ layout }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const punch = Math.max(2, Math.round((timing.hookPunchMs / 1000) * fps));
  const scale =
    frame < punch
      ? interpolate(frame, [0, punch * 0.7, punch], [0.72, 1.04, 1], { easing: Easing.out(Easing.cubic) })
      : 1 + Math.min(0.03, (frame - punch) * 0.0006);
  const flash = interpolate(frame, [0, 6], [0.15, 0], { extrapolateRight: 'clamp' });
  const ring = interpolate(frame, [0, punch], [0.4, 1.25], {
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.quad),
  });
  const title = boxByRole(layout, 'title');
  const kicker = boxByRole(layout, 'kicker');
  const cy = title ? title.y + title.height / 2 : 700;
  return (
    <AbsoluteFill>
      <Background seed="hook" intensity={1.2} />
      <div
        style={{
          position: 'absolute',
          left: width / 2 - 450,
          top: cy - 450,
          width: 900,
          height: 900,
          borderRadius: '50%',
          border: `6px solid ${withAlpha(palette.accent, 0.5)}`,
          transform: `scale(${ring})`,
          opacity: interpolate(frame, [0, punch * 2], [1, 0.25], { extrapolateRight: 'clamp' }),
        }}
      />
      {kicker ? (
        <BoxText
          box={kicker}
          style="kicker"
          color={palette.accent}
          boxStyle={{
            opacity: interpolate(frame, [2, 10], [0, 1], {
              extrapolateRight: 'clamp',
              extrapolateLeft: 'clamp',
            }),
          }}
        />
      ) : null}
      {title ? (
        <BoxText
          box={title}
          style="title"
          boxStyle={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}
        />
      ) : null}
      <AbsoluteFill style={{ background: palette.text, opacity: flash }} />
    </AbsoluteFill>
  );
};
