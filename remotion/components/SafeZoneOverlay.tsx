/** Preview-only overlay: shades the margins Instagram's UI covers and outlines measured text boxes. */
import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import type { LaidOutBox } from '../props';
import { safeZonePx, type SafeZonePct } from '../theme';

export const SafeZoneOverlay: React.FC<{ safeZone: SafeZonePct | null; boxes?: LaidOutBox[] }> = ({
  safeZone,
  boxes = [],
}) => {
  const { width, height } = useVideoConfig();
  const m = safeZonePx(safeZone ?? undefined, width, height);
  const shade = 'rgba(255, 40, 80, 0.28)';
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width, height: m.top, background: shade }} />
      <div style={{ position: 'absolute', left: 0, bottom: 0, width, height: m.bottom, background: shade }} />
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: m.top,
          width: m.left,
          height: height - m.top - m.bottom,
          background: shade,
        }}
      />
      <div
        style={{
          position: 'absolute',
          right: 0,
          top: m.top,
          width: m.right,
          height: height - m.top - m.bottom,
          background: shade,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: m.left,
          top: m.top,
          width: width - m.left - m.right,
          height: height - m.top - m.bottom,
          border: '3px dashed rgba(255,255,255,0.7)',
          boxSizing: 'border-box',
        }}
      />
      {boxes.map((b) => (
        <div
          key={b.id}
          style={{
            position: 'absolute',
            left: b.x,
            top: b.y,
            width: b.width,
            height: b.height,
            outline: `2px solid ${b.overflow ? '#FF3355' : '#35E08A'}`,
          }}
        />
      ))}
    </AbsoluteFill>
  );
};
