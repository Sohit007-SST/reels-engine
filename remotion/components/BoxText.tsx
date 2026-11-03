/** Renders a laid-out text box exactly where layout.ts measured it (explicit lines, fixed size). */
import React from 'react';
import type { LaidOutBox } from '../props';
import { TEXT_STYLES, type TextStyleName } from '../layout';
import { fontStack, palette } from '../theme';

export interface BoxTextProps {
  box: LaidOutBox;
  style: TextStyleName;
  color?: string;
  align?: 'center' | 'left';
  /** Style for the outer box (transforms/opacity for animation). */
  boxStyle?: React.CSSProperties;
  /** Custom per-line renderer (e.g. word-by-word animation). */
  renderLine?: (line: string, lineIndex: number) => React.ReactNode;
  shadow?: boolean;
}

export function textCss(style: TextStyleName, fontSize: number): React.CSSProperties {
  const s = TEXT_STYLES[style];
  return {
    fontFamily: fontStack(s.fontFamily),
    fontWeight: s.fontWeight,
    fontSize,
    lineHeight: `${fontSize * s.lineHeight}px`,
    letterSpacing: 'letterSpacing' in s ? s.letterSpacing : undefined,
    whiteSpace: 'nowrap',
  };
}

export const BoxText: React.FC<BoxTextProps> = ({
  box,
  style,
  color = palette.text,
  align = 'center',
  boxStyle,
  renderLine,
  shadow = true,
}) => (
  <div
    data-box-id={box.id}
    style={{
      position: 'absolute',
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height,
      color,
      textAlign: align,
      ...textCss(style, box.fontSize),
      textShadow: shadow ? '0 6px 24px rgba(0,0,0,0.45)' : undefined,
      ...boxStyle,
    }}
  >
    {box.lines.map((line, i) => (
      <div key={i} style={{ height: box.fontSize * box.lineHeight }}>
        {renderLine ? renderLine(line, i) : line}
      </div>
    ))}
  </div>
);
