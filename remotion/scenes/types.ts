import type { RenderWord, SceneLayout, SceneProps } from '../props';

/** Props every scene component receives. Frames are relative to the scene's own Sequence. */
export interface SceneComponentProps {
  scene: SceneProps;
  layout: SceneLayout;
  /** Absolute start frame on the reel (for reel-global audio). */
  startFrame: number;
  /** Frames this scene owns on the voice timeline. */
  frames: number;
  audioSrc: string | null;
  words: RenderWord[];
  mascotEnabled: boolean;
}

export const boxByRole = (layout: SceneLayout, role: string) => layout.boxes.find((b) => b.role === role);
