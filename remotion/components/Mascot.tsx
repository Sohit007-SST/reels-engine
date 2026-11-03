/**
 * Animated mascot: deterministic blinking (every 3–5 s), glow pulse (2 s) and a mouth driven by the
 * voice audio through Remotion's audio visualization (useAudioData + visualizeAudio). Without an
 * audio track the mouth follows the caption word timings instead.
 */
import React from 'react';
import { random, useCurrentFrame, useVideoConfig, staticFile } from 'remotion';
import { useAudioData, visualizeAudio } from '@remotion/media-utils';
import type { RenderWord } from '../props';
import { MascotSvg, mouthLevelFromAmplitude, type Expression } from './MascotSvg';

const BLINK_FRAMES = 6;

/** Blink amount (0 open … 1 closed) at a frame; blinks start every 3–5 s, deterministic per seed. */
export function blinkAt(frame: number, fps: number, seed: string): number {
  let t = Math.round(fps * (1 + random(`${seed}-first`) * 1.5));
  for (let i = 0; t <= frame; i++) {
    const d = frame - t;
    if (d < BLINK_FRAMES) return 1 - Math.abs(d - BLINK_FRAMES / 2) / (BLINK_FRAMES / 2);
    t += Math.round(fps * (3 + random(`${seed}-${i}`) * 2));
  }
  return 0;
}

/** Glow pulse 0..1 with a 2 s period. */
export const glowAt = (frame: number, fps: number): number => 0.5 + 0.5 * Math.sin((frame / fps) * Math.PI);

/** Fallback amplitude from word timings: talking while a word is active. */
export function amplitudeFromWords(words: RenderWord[], ms: number, frame: number): number {
  const active = words.some((w) => ms >= w.startMs && ms < w.endMs);
  if (!active) return 0;
  return 0.06 + 0.16 * Math.abs(Math.sin(frame * 0.9));
}

export const resolveSrc = (src: string): string =>
  /^(https?:|data:|blob:)/.test(src) ? src : staticFile(src);

interface MascotProps {
  expression: Expression;
  size: number;
  /** Absolute frame of this mascot's frame 0 on the reel (audio is reel-global). */
  frameOffset: number;
  audioSrc: string | null;
  words: RenderWord[];
  seed?: string;
  /** If false, the mouth stays closed (listening). */
  talking?: boolean;
}

const Body: React.FC<MascotProps & { amplitude: number }> = (p) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const level = p.talking === false ? 0 : mouthLevelFromAmplitude(p.amplitude);
  const bob = Math.sin((frame / fps) * Math.PI * 0.8) * 10;
  return (
    <div style={{ width: p.size, height: p.size, transform: `translateY(${bob}px)` }}>
      <MascotSvg
        expression={p.expression}
        mouthLevel={level}
        blink={blinkAt(frame + p.frameOffset, fps, p.seed ?? 'mascot')}
        glow={glowAt(frame + p.frameOffset, fps)}
        size={p.size}
        idPrefix={`m${p.frameOffset}`}
      />
    </div>
  );
};

const WithAudio: React.FC<MascotProps & { audioSrc: string }> = (p) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const audioData = useAudioData(resolveSrc(p.audioSrc));
  let amplitude: number;
  if (audioData) {
    const bins = visualizeAudio({
      fps,
      frame: frame + p.frameOffset,
      audioData,
      numberOfSamples: 32,
      smoothing: true,
    });
    const speech = bins.slice(0, 10);
    amplitude = speech.reduce((a, b) => a + b, 0) / Math.max(1, speech.length);
  } else {
    amplitude = amplitudeFromWords(p.words, ((frame + p.frameOffset) / fps) * 1000, frame);
  }
  return <Body {...p} amplitude={amplitude} />;
};

const WithoutAudio: React.FC<MascotProps> = (p) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <Body {...p} amplitude={amplitudeFromWords(p.words, ((frame + p.frameOffset) / fps) * 1000, frame)} />
  );
};

export const Mascot: React.FC<MascotProps> = (p) =>
  p.audioSrc ? <WithAudio {...p} audioSrc={p.audioSrc} /> : <WithoutAudio {...p} />;
