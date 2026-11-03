/**
 * Tier B still in a framed card with a slow Ken Burns zoom/pan. The card is never larger than
 * natural size / ZOOM_MAX (layout.ts), so even at peak zoom the image is shown at or below its
 * native resolution: no blurry upscales. Without an image, a procedural Tier A planet is drawn.
 */
import React from 'react';
import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { BoxText } from '../components/BoxText';
import { resolveSrc } from '../components/Mascot';
import { ZOOM_MAX } from '../layout';
import { palette, radii, withAlpha } from '../theme';
import { boxByRole, type SceneComponentProps } from './types';

const PlaceholderArt: React.FC<{ w: number; h: number; t: number }> = ({ w, h, t }) => (
  <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
    <defs>
      <radialGradient id="kb-planet" cx="35%" cy="30%" r="70%">
        <stop offset="0%" stopColor={palette.highlight} />
        <stop offset="45%" stopColor={palette.accent} />
        <stop offset="100%" stopColor={palette.surface} />
      </radialGradient>
    </defs>
    <rect width={w} height={h} fill={palette.surface} />
    <circle cx={w * 0.5} cy={h * 0.55} r={Math.min(w, h) * 0.32} fill="url(#kb-planet)" />
    <ellipse
      cx={w * 0.5}
      cy={h * 0.55}
      rx={Math.min(w, h) * 0.48}
      ry={Math.min(w, h) * 0.09}
      fill="none"
      stroke={withAlpha(palette.text, 0.6)}
      strokeWidth={6}
      transform={`rotate(${-14 + t * 2} ${w * 0.5} ${h * 0.55})`}
    />
  </svg>
);

export const ImageKenBurns: React.FC<SceneComponentProps> = ({ layout, scene, frames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const label = boxByRole(layout, 'label');
  const card = layout.regions.card;
  const zoomOut = /out/i.test(scene.motion);
  const p = interpolate(frame, [0, Math.max(1, frames)], [0, 1], { extrapolateRight: 'clamp' });
  const scale = zoomOut ? ZOOM_MAX - (ZOOM_MAX - 1) * p : 1 + (ZOOM_MAX - 1) * p;
  // Pan stays within the zoom margin so the card edge never shows.
  const maxPan = card ? ((scale - 1) / 2) * card.width : 0;
  const panX = (/left/i.test(scene.motion) ? -1 : 1) * maxPan * (p - 0.5) * 1.6;
  const enter = interpolate(frame, [0, 10], [60, 0], { extrapolateRight: 'clamp' });
  const leak = interpolate(frame, [0, Math.max(1, frames)], [-40, 140]);
  return (
    <AbsoluteFill>
      <Background seed={`kb-${scene.index}`} intensity={0.7} />
      {label ? <BoxText box={label} style="title" /> : null}
      {card ? (
        <div
          style={{
            position: 'absolute',
            left: card.x,
            top: card.y,
            width: card.width,
            height: card.height,
            borderRadius: radii.card,
            overflow: 'hidden',
            border: `6px solid ${withAlpha(palette.text, 0.9)}`,
            boxShadow: `0 30px 80px ${withAlpha('#000000', 0.55)}`,
            transform: `translateY(${enter}px)`,
            background: palette.surface,
          }}
        >
          <div style={{ width: '100%', height: '100%', transform: `translateX(${panX}px) scale(${scale})` }}>
            {scene.image ? (
              <Img
                src={resolveSrc(scene.image.src)}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            ) : (
              <PlaceholderArt w={card.width} h={card.height} t={frame / fps} />
            )}
          </div>
          <AbsoluteFill
            style={{
              background: `linear-gradient(115deg, transparent ${leak - 30}%, ${withAlpha(palette.accent, 0.22)} ${leak}%, transparent ${leak + 30}%)`,
              mixBlendMode: 'screen',
            }}
          />
          <AbsoluteFill style={{ boxShadow: `inset 0 0 120px ${withAlpha('#000000', 0.5)}` }} />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
