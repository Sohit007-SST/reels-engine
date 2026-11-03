/**
 * Original mascot (brand/mascot.md): a small round space probe with one big lens eye, two short
 * antenna ears and a soft glow ring. Pure SVG, no hooks, so it can be rendered to static files
 * (assets/mascot/*.svg) and tested in Node. Animation state is passed in as props.
 */
import React from 'react';
import { palette } from '../theme';

export const EXPRESSIONS = ['neutral', 'surprised', 'happy', 'thinking'] as const;
export type Expression = (typeof EXPRESSIONS)[number];

export const isExpression = (v: unknown): v is Expression =>
  typeof v === 'string' && (EXPRESSIONS as readonly string[]).includes(v);

export interface MascotSvgProps {
  expression: Expression;
  /** 0 = closed, 1–3 = increasingly open (4 openness levels). */
  mouthLevel: 0 | 1 | 2 | 3;
  /** 0 = eye open, 1 = fully closed. */
  blink: number;
  /** Glow ring pulse 0..1. */
  glow: number;
  size: number;
  /** Unique prefix for SVG ids (several mascots may share a page). */
  idPrefix?: string;
}

const MOUTH = [
  { rx: 30, ry: 0 },
  { rx: 30, ry: 9 },
  { rx: 34, ry: 17 },
  { rx: 38, ry: 26 },
] as const;

export const MascotSvg: React.FC<MascotSvgProps> = ({
  expression,
  mouthLevel,
  blink,
  glow,
  size,
  idPrefix = 'm',
}) => {
  const id = (n: string) => `${idPrefix}-${n}`;
  const eyeR = expression === 'surprised' ? 76 : 68;
  const open = Math.max(0, Math.min(1, 1 - blink));
  const pupilR = expression === 'surprised' ? 22 : 30;
  const look = expression === 'thinking' ? { x: -22, y: -24 } : { x: 0, y: 0 };
  // Surprised forces an "O" mouth even between words.
  const level = expression === 'surprised' ? (Math.max(mouthLevel, 2) as 2 | 3) : mouthLevel;
  const m = MOUTH[level];
  const ex = 200;
  const ey = 190;
  const mouthY = 300;

  let mouth: React.ReactNode;
  if (expression === 'happy' && level <= 1) {
    mouth = (
      <path
        d="M160 292 Q200 330 240 292"
        fill="none"
        stroke={palette.background}
        strokeWidth={9}
        strokeLinecap="round"
      />
    );
  } else if (expression === 'thinking' && level === 0) {
    mouth = (
      <path
        d="M172 304 L226 298"
        fill="none"
        stroke={palette.background}
        strokeWidth={9}
        strokeLinecap="round"
      />
    );
  } else if (level === 0) {
    mouth = (
      <path
        d="M170 300 Q200 310 230 300"
        fill="none"
        stroke={palette.background}
        strokeWidth={9}
        strokeLinecap="round"
      />
    );
  } else {
    mouth = (
      <g>
        <ellipse cx={200} cy={mouthY} rx={m.rx} ry={m.ry} fill={palette.background} />
        <ellipse
          cx={200}
          cy={mouthY + m.ry * 0.45}
          rx={m.rx * 0.55}
          ry={m.ry * 0.4}
          fill={palette.accent}
          opacity={0.85}
        />
      </g>
    );
  }

  let eye: React.ReactNode;
  if (expression === 'happy') {
    // Squint: a smiling arc instead of an open lens.
    eye = (
      <path
        d={`M${ex - 58} ${ey + 14} Q${ex} ${ey - 52} ${ex + 58} ${ey + 14}`}
        fill="none"
        stroke={palette.background}
        strokeWidth={14}
        strokeLinecap="round"
      />
    );
  } else {
    eye = (
      <g>
        <ellipse
          cx={ex}
          cy={ey}
          rx={eyeR}
          ry={Math.max(3, eyeR * open)}
          fill={palette.text}
          stroke={palette.background}
          strokeWidth={6}
        />
        {open > 0.35 ? (
          <g transform={`translate(${look.x} ${look.y * open})`}>
            <circle cx={ex} cy={ey} r={pupilR} fill={palette.background} />
            <circle
              cx={ex + pupilR * 0.35}
              cy={ey - pupilR * 0.4}
              r={pupilR * 0.32}
              fill={palette.highlight}
            />
          </g>
        ) : null}
        {expression === 'thinking' ? (
          <path
            d={`M${ex - 70} ${ey - 92} L${ex + 40} ${ey - 104}`}
            stroke={palette.background}
            strokeWidth={10}
            strokeLinecap="round"
          />
        ) : null}
      </g>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 400 400"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`mascot ${expression}`}
    >
      <defs>
        <radialGradient id={id('body')} cx="35%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#9DB9FF" />
          <stop offset="55%" stopColor={palette.primary} />
          <stop offset="100%" stopColor="#3A63D8" />
        </radialGradient>
      </defs>
      <circle
        cx={200}
        cy={215}
        r={172}
        fill="none"
        stroke={palette.accent}
        strokeWidth={10 + glow * 8}
        opacity={0.25 + glow * 0.3}
      />
      <g stroke={palette.background} strokeWidth={6} strokeLinecap="round">
        <line x1={128} y1={110} x2={98} y2={52} />
        <line x1={272} y1={110} x2={302} y2={52} />
      </g>
      <circle cx={98} cy={48} r={16} fill={palette.accent} stroke={palette.background} strokeWidth={6} />
      <circle cx={302} cy={48} r={16} fill={palette.accent} stroke={palette.background} strokeWidth={6} />
      <circle
        cx={200}
        cy={215}
        r={140}
        fill={`url(#${id('body')})`}
        stroke={palette.background}
        strokeWidth={6}
      />
      <ellipse
        cx={150}
        cy={140}
        rx={34}
        ry={18}
        fill="#FFFFFF"
        opacity={0.28}
        transform="rotate(-30 150 140)"
      />
      {eye}
      {mouth}
    </svg>
  );
};

/** Openness level from audio amplitude (0..1) with 4 levels. */
export function mouthLevelFromAmplitude(amplitude: number): 0 | 1 | 2 | 3 {
  if (amplitude < 0.035) return 0;
  if (amplitude < 0.1) return 1;
  if (amplitude < 0.2) return 2;
  return 3;
}
