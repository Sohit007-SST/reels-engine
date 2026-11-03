/** Scene transitions: slide, wipe, fade (from @remotion/transitions) and a custom zoom punch. */
import React from 'react';
import { AbsoluteFill } from 'remotion';
import type { TransitionPresentation, TransitionPresentationComponentProps } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';
import type { TransitionKind } from '../timeline';

type ZoomProps = Record<string, never>;

const ZoomPunch: React.FC<TransitionPresentationComponentProps<ZoomProps>> = ({
  presentationProgress,
  presentationDirection,
  children,
}) => {
  const p = presentationProgress;
  const entering = presentationDirection === 'entering';
  const scale = entering ? 1.18 - 0.18 * p : 1 - 0.08 * p;
  const opacity = entering ? Math.min(1, p * 1.6) : 1 - p;
  return <AbsoluteFill style={{ transform: `scale(${scale})`, opacity }}>{children}</AbsoluteFill>;
};

export const zoomPunch = (): TransitionPresentation<ZoomProps> => ({ component: ZoomPunch, props: {} });

/** Presentation for a transition kind. Typed loosely because presentations have different prop types. */
export function presentationFor(
  kind: TransitionKind | string,
): TransitionPresentation<Record<string, unknown>> {
  switch (kind) {
    case 'slide':
      return slide({ direction: 'from-right' }) as unknown as TransitionPresentation<Record<string, unknown>>;
    case 'wipe':
      return wipe({ direction: 'from-left' }) as unknown as TransitionPresentation<Record<string, unknown>>;
    case 'zoom':
      return zoomPunch() as unknown as TransitionPresentation<Record<string, unknown>>;
    default:
      return fade() as unknown as TransitionPresentation<Record<string, unknown>>;
  }
}
