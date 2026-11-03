/**
 * The reel: 1080x1920 @ 30 fps. Scenes are placed on the MEASURED voice timeline (timeline.ts),
 * joined by transitions that never shift scene starts; captions, progress bar, audio and the
 * optional safe-zone overlay sit on top.
 */
import React from 'react';
import { AbsoluteFill, Html5Audio } from 'remotion';
import { TransitionSeries, linearTiming } from '@remotion/transitions';
import { Captions } from './components/Captions';
import { resolveSrc } from './components/Mascot';
import { ProgressBar } from './components/ProgressBar';
import { SafeZoneOverlay } from './components/SafeZoneOverlay';
import { presentationFor } from './components/Transitions';
import { computeReelLayout, estimateMeasurer } from './layout';
import type { ReelRenderProps } from './props';
import { SceneRenderer } from './scenes';
import { palette } from './theme';

export const Reel: React.FC<ReelRenderProps> = (props) => {
  // calculateMetadata() always fills layout; the estimate is only a defensive fallback.
  const layout =
    props.layout ??
    computeReelLayout(
      {
        scenes: props.scenes,
        words: props.words,
        totalMs: props.totalMs,
        tailMs: props.tailMs,
        transitionFrames: props.transitionFrames,
        commentQuestion: props.commentQuestion,
        mascotEnabled: props.mascotEnabled,
        safeZone: props.safeZone,
      },
      estimateMeasurer,
      'estimate',
    );
  const children: React.ReactNode[] = [];
  props.scenes.forEach((scene, i) => {
    const t = layout.timeline[i];
    const sl = layout.scenes[i];
    if (!t || !sl) return;
    children.push(
      <TransitionSeries.Sequence key={`s${i}`} durationInFrames={t.sequenceFrames}>
        <SceneRenderer
          scene={scene}
          layout={sl}
          startFrame={t.startFrame}
          frames={t.frames}
          audioSrc={props.audioSrc}
          words={props.words}
          mascotEnabled={props.mascotEnabled}
        />
      </TransitionSeries.Sequence>,
    );
    if (t.transitionFrames > 0) {
      children.push(
        <TransitionSeries.Transition
          key={`t${i}`}
          presentation={presentationFor(t.transition)}
          timing={linearTiming({ durationInFrames: t.transitionFrames })}
        />,
      );
    }
  });
  const allBoxes = [...layout.scenes.flatMap((s) => s.boxes), ...layout.captions.map((c) => c.box)];
  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      <TransitionSeries>{children}</TransitionSeries>
      {props.showCaptions ? <Captions pages={layout.captions} /> : null}
      {props.showProgressBar ? <ProgressBar /> : null}
      {props.audioSrc ? <Html5Audio src={resolveSrc(props.audioSrc)} /> : null}
      {props.showSafeZone ? <SafeZoneOverlay safeZone={props.safeZone} boxes={allBoxes} /> : null}
    </AbsoluteFill>
  );
};

/** T2.1: a blank brand-coloured 1080x1920 video. */
export const Blank: React.FC = () => <AbsoluteFill style={{ backgroundColor: palette.background }} />;
