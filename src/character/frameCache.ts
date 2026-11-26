/**
 * Frame cache for the character clips.
 *
 * Frames are pre-decoded into detached <img> elements once and then reused, so
 * playback is a single drawImage per frame with no network/decode work and no
 * image flicker. Nothing here touches React state.
 *
 * Decoded frames are expensive: each 264x264 RGBA bitmap costs ~272 KiB of RAM
 * for a source file of a few kilobytes, so every clip that gets played stays
 * resident until something evicts it. Two things keep that bounded:
 *
 *  - only the frames a clip actually plays are decoded. A tilt stops on frame
 *    47 of 56, so its nine tail frames would otherwise be decoded and held
 *    forever without ever being drawn;
 *  - the resident set is capped and evicted least-recently-used. The clip being
 *    played is touched on every frame, so it is always the most recent entry
 *    and is therefore never the one evicted.
 */
import {
  ANIMATION_FOR_STATE,
  FRAME_RANGE_FOR_STATE,
  type AnimationName,
  frameUrl,
} from './characterAnimations';
import { CANVAS, frameCountOf } from './manifest';

type FrameSet = (HTMLImageElement | undefined)[];

/** RAM cost of one decoded frame, straight from the manifest's canvas size. */
const FRAME_BYTES = CANVAS.width * CANVAS.height * 4;

/**
 * Ceiling on decoded frame memory. Startup alone (idle + hai) is ~20 MiB, so
 * this leaves room for the clip in use plus one recently played clip, while
 * capping the worst case at a few clips rather than all eleven.
 */
const MAX_RESIDENT_BYTES = 64 * 1024 * 1024;

/**
 * The frame span each clip actually draws, taken from the states that use it.
 * Clips with no explicit range play start to end. A clip mapped from more than
 * one state uses the widest span, so the range can never be narrower than
 * something that plays it.
 */
const PLAYED_RANGE: Partial<Record<AnimationName, { start: number; end: number }>> =
  (() => {
    const ranges: Partial<Record<AnimationName, { start: number; end: number }>> = {};
    for (const [state, animation] of Object.entries(ANIMATION_FOR_STATE)) {
      const range = FRAME_RANGE_FOR_STATE[state as keyof typeof FRAME_RANGE_FOR_STATE];
      const existing = ranges[animation];
      if (!range) continue;
      ranges[animation] = existing
        ? {
            start: Math.min(existing.start, range.start),
            end: Math.max(existing.end, range.end),
          }
        : { ...range };
    }
    return ranges;
  })();

/** Insertion order is the LRU order: re-inserting on every read moves to the end. */
const ready = new Map<AnimationName, FrameSet>();
const loading = new Map<AnimationName, Promise<FrameSet>>();
let residentBytes = 0;

function bytesOf(frames: FrameSet): number {
  let total = 0;
  for (const frame of frames) if (frame) total += FRAME_BYTES;
  return total;
}

function makeImage(src: string): HTMLImageElement {
  const img = new Image();
  img.decoding = 'async';
  // Keep the decoded bitmap off-screen but alive; detaching it would let some
  // browsers evict the decode and re-decode on every draw.
  img.src = src;
  return img;
}

function evict() {
  // The newest entry is whatever was read last, i.e. the clip on screen, so
  // walking from the oldest end can never take the playing clip. The size guard
  // keeps at least one clip resident even if it alone exceeds the budget.
  while (residentBytes > MAX_RESIDENT_BYTES && ready.size > 1) {
    const oldest = ready.keys().next();
    if (oldest.done) return;
    const frames = ready.get(oldest.value);
    if (frames) residentBytes -= bytesOf(frames);
    ready.delete(oldest.value);
    // The FrameSet is now unreferenced, so Chromium is free to release the
    // decoded bitmaps. Nothing else needs tearing down.
  }
}

function load(name: AnimationName): Promise<FrameSet> {
  const existing = ready.get(name);
  if (existing) {
    touch(name);
    return Promise.resolve(existing);
  }
  const inflight = loading.get(name);
  if (inflight) return inflight;

  const count = frameCountOf(name);
  const range = PLAYED_RANGE[name] ?? { start: 0, end: count };
  const startIndex = Math.min(range.start, count - 1);
  const endIndex = Math.max(startIndex + 1, Math.min(range.end, count));

  // Sparse on purpose: indices stay aligned with the clip's own frame numbers,
  // so the player can index this array with absolute frame numbers and get
  // `undefined` for anything outside the played span.
  const frames: FrameSet = new Array(count);
  const wanted: HTMLImageElement[] = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    const img = makeImage(frameUrl(name, i + 1));
    frames[i] = img;
    wanted.push(img);
  }

  const promise = Promise.all(wanted.map((img) => decode(img)))
    .then(() => {
      loading.delete(name);
      residentBytes += bytesOf(frames);
      ready.delete(name);
      ready.set(name, frames);
      evict();
      return frames;
    })
    .catch((error: unknown) => {
      loading.delete(name);
      throw error;
    });

  loading.set(name, promise);
  return promise;
}

/** Move a clip to the most-recently-used end of the eviction order. */
function touch(name: AnimationName) {
  const frames = ready.get(name);
  if (!frames) return;
  ready.delete(name);
  ready.set(name, frames);
}

function decode(img: HTMLImageElement): Promise<unknown> {
  if (typeof img.decode === 'function') {
    return img.decode().catch(() => undefined);
  }
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    img.addEventListener('load', () => resolve(undefined), { once: true });
    img.addEventListener(
      'error',
      () => resolve(undefined),
      { once: true },
    );
  });
}

/** Begin loading a clip. Safe to call repeatedly; work happens once. */
export function preloadAnimation(name: AnimationName): Promise<FrameSet> {
  return load(name);
}

/** Already-decoded frames, or null while the clip is still loading. */
export function getAnimation(name: AnimationName): FrameSet | null {
  const frames = ready.get(name) ?? null;
  if (frames) touch(name);
  return frames;
}
