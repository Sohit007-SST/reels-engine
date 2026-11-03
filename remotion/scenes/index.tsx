/** Scene registry. sceneType strings come from the ReelSpec; unknown types fall back to KineticText. */
import React from 'react';
import type { SceneType } from '../layout';
import { CTAEnd } from './CTAEnd';
import { FactCard } from './FactCard';
import { HookTitle } from './HookTitle';
import { ImageKenBurns } from './ImageKenBurns';
import { KineticText } from './KineticText';
import { MascotTalk } from './MascotTalk';
import { Timeline } from './Timeline';
import type { SceneComponentProps } from './types';

export const SCENES: Record<SceneType, React.FC<SceneComponentProps>> = {
  HookTitle,
  KineticText,
  ImageKenBurns,
  FactCard,
  Timeline,
  MascotTalk,
  CTAEnd,
};

export const SceneRenderer: React.FC<SceneComponentProps> = (props) => {
  const Comp = SCENES[props.layout.renderedAs as SceneType] ?? KineticText;
  return <Comp {...props} />;
};
