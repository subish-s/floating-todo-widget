/** Frame counts and geometry, read from the manifest written by the asset build. */
import manifest from './manifest.json';
import type { AnimationName } from './characterAnimations';

export type AnimationMeta = {
  frameCount: number;
  fps: number;
  canvas: { width: number; height: number };
  scale: number;
  baseline: number;
};

const animations = manifest.animations as unknown as Record<
  string,
  AnimationMeta
>;

export const CANVAS = manifest.canvas as { width: number; height: number };
export const DEFAULT_FPS: number = manifest.fps;

export function metaOf(name: AnimationName): AnimationMeta {
  const meta = animations[name];
  if (!meta) {
    throw new Error(`Unknown character animation: ${name}`);
  }
  return meta;
}

export function frameCountOf(name: AnimationName): number {
  return metaOf(name).frameCount;
}
