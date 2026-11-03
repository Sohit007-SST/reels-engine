/**
 * Compositions:
 *  - Reel:  the real reel. calculateMetadata() validates props, waits for fonts, measures all text
 *           with @remotion/layout-utils and derives the duration from the measured beat timeline.
 *  - Blank: T2.1 smoke composition (brand background, 1 s).
 */
import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import { buildRenderProps, syntheticTimings } from './buildProps';
import { FIXTURE_SPEC } from './fixture';
import { waitForFonts } from './fonts';
import { computeReelLayout } from './layout';
import { layoutUtilsMeasurer } from './measure';
import { ReelRenderProps } from './props';
import { Blank, Reel } from './Reel';
import { VIDEO } from './theme';

export const calculateReelMetadata: CalculateMetadataFunction<ReelRenderProps> = async ({ props }) => {
  const parsed = ReelRenderProps.parse(props);
  await waitForFonts();
  const layout = computeReelLayout(
    {
      scenes: parsed.scenes,
      words: parsed.words,
      totalMs: parsed.totalMs,
      tailMs: parsed.tailMs,
      transitionFrames: parsed.transitionFrames,
      commentQuestion: parsed.commentQuestion,
      mascotEnabled: parsed.mascotEnabled,
      safeZone: parsed.safeZone,
      fps: VIDEO.fps,
    },
    layoutUtilsMeasurer,
    'layout-utils',
  );
  return {
    durationInFrames: layout.durationInFrames,
    width: VIDEO.width,
    height: VIDEO.height,
    fps: VIDEO.fps,
    props: { ...parsed, layout },
  };
};

const fixtureProps = ReelRenderProps.parse(
  buildRenderProps(FIXTURE_SPEC, syntheticTimings(FIXTURE_SPEC), { audioSrc: null, showSafeZone: false }),
);

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Reel"
      component={Reel}
      width={VIDEO.width}
      height={VIDEO.height}
      fps={VIDEO.fps}
      durationInFrames={VIDEO.fps * 30}
      defaultProps={fixtureProps}
      calculateMetadata={calculateReelMetadata}
    />
    <Composition
      id="Blank"
      component={Blank}
      width={VIDEO.width}
      height={VIDEO.height}
      fps={VIDEO.fps}
      durationInFrames={VIDEO.fps}
    />
  </>
);
