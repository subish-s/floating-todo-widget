'use client';

/**
 * Frame-accurate playback on a single <canvas>.
 *
 * Why a canvas rather than swapping an <img src>: the frames are already
 * decoded in the cache, so drawImage is a pure blit with no decode and no chance
 * of a blank frame, which is what causes flicker when animating <img>.
 *
 * The frame index lives in a ref and is never React state, so a 24 fps
 * animation causes zero re-renders. React only re-renders when the *state*
 * changes, which is what actually needs the DOM.
 *
 * The loop is paced by a worker rather than requestAnimationFrame, because
 * Chromium aligns main-thread timers to the compositor's frame clock and this
 * window's frame clock is unreliable — see the note in `framePacer.ts`. Measured
 * on this machine, rAF fired 1.3 times a second while the window was on screen,
 * so the 24 fps animation played as a slideshow, and a main-thread `setTimeout`
 * chain managed 2.2 fps whenever the app ran with `--no-sandbox`, which is how
 * the systemd service launches it. `framePacer` keeps time in both cases, and
 * the accumulator below turns its ticks into an exact frame rate.
 *
 * The loop stops entirely when a one-shot finishes, and while the widget is
 * hidden, so a hidden widget costs nothing. `document.hidden` is not enough on
 * its own: `win.hide()` unmaps the window without making the page hidden, so the
 * main process reports visibility explicitly and `paused` carries it.
 */
import { useEffect, useRef } from 'react';
import {
  ANIMATION_FOR_STATE,
  FRAME_RANGE_FOR_STATE,
  FPS_FOR_STATE,
  LOOPS,
  type CharacterState,
} from './characterAnimations';
import { getAnimation, preloadAnimation } from './frameCache';
import { subscribeToFrames, unsubscribeFromFrames } from './framePacer';
import { CANVAS, DEFAULT_FPS, frameCountOf } from './manifest';

type Controls = {
  /** Resume, keeping the current frame. */
  resume: () => void;
  /** Stop the loop without touching the frame on screen. */
  stop: () => void;
};

export function useAnimationPlayer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  state: CharacterState,
  /**
   * Live drag rate. Written from the pointer handler, not from React state, so
   * a faster cursor speeds the lean up on the next tick instead of on the next
   * render.
   */
  dragFpsRef: React.RefObject<number>,
  paused = false,
) {
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const controlsRef = useRef<Controls | null>(null);

  useEffect(() => {
    const animation = ANIMATION_FOR_STATE[state];
    const count = frameCountOf(animation);
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const loop = LOOPS[state];
    const baseFps = FPS_FOR_STATE[state] ?? DEFAULT_FPS;
    const range = FRAME_RANGE_FOR_STATE[state];
    const startIndex = Math.min(range?.start ?? 0, count - 1);
    const endIndex = Math.max(startIndex + 1, Math.min(range?.end ?? count, count));
    let cancelled = false;
    let running = false;
    let finished = false;
    let timer: number | null = null;
    let last = 0;
    let acc = 0;
    let index = 0;

    const held = () => cancelled || pausedRef.current || document.hidden;

    const draw = (frame: HTMLImageElement | undefined) => {
      ctx.clearRect(0, 0, CANVAS.width, CANVAS.height);
      if (frame) ctx.drawImage(frame, 0, 0, CANVAS.width, CANVAS.height);
    };

    const step = () => {
      if (!state.startsWith('DRAG_')) return baseFps;
      const live = dragFpsRef.current;
      // A bad rate would make the frame slice zero and spin the skip loop.
      return Number.isFinite(live) && live >= 1 ? live : baseFps;
    };

    const tick = (now: number) => {
      if (held()) return;
      const slice = 1000 / step();

      if (last === 0) last = now;
      const delta = now - last;
      last = now;
      acc += delta;

      // Only redraw when the frame index actually changes, so a 60 Hz pacer
      // still costs 24 draws per second rather than 60.
      let advanced = false;
      let completed = false;
      while (acc >= slice) {
        acc -= slice;
        index += 1;
        if (index >= endIndex) {
          if (loop) index = startIndex;
          else {
            index = endIndex - 1;
            completed = true;
          }
        }
        advanced = true;
        if (completed) break;
      }
      if (!advanced) return;

      const frames = getAnimation(animation);
      if (frames) {
        draw(frames[index]);
      }
      // A finished one-shot has nothing left to show, so stop asking for ticks.
      if (completed) {
        finished = true;
        stop();
      }
    };

    // Self-paced fallback, used only when a worker could not be started.
    const scheduleFallback = () => {
      if (cancelled || running || worker) return;
      running = true;
      timer = window.setTimeout(() => {
        timer = null;
        tick(performance.now());
        // A finished one-shot cleared `running` in tick, so this is a no-op then.
        scheduleFallback();
      }, 1000 / step());
    };

    let worker: Worker | null = null;
    const schedule = () => {
      if (cancelled) return;
      if (worker) {
        running = true;
        return;
      }
      scheduleFallback();
    };

    const begin = () => {
      if (held()) return;
      last = 0;
      acc = 0;
      finished = false;
      index = startIndex;
      draw(getAnimation(animation)?.[startIndex]);
      worker = subscribeToFrames(tick);
      schedule();
    };

    const resume = () => {
      if (held() || finished) return;
      // Keep the current frame; only the clock restarts, so a resumed loop does
      // not jump back to the first frame.
      last = 0;
      acc = 0;
      // `stop` unsubscribes, so a pause has to rejoin the pacer rather than
      // drop to the slower main-thread timer.
      if (!worker) worker = subscribeToFrames(tick);
      schedule();
    };

    const stop = () => {
      running = false;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      unsubscribeFromFrames(tick);
      worker = null;
    };

    controlsRef.current = { resume, stop };

    // If the clip is still decoding, hold the current frame, then play as soon
    // as it is ready rather than flashing an empty canvas.
    const frames = getAnimation(animation);
    if (frames) {
      begin();
    } else {
      preloadAnimation(animation).then(begin).catch(() => {
        // A missing clip must not break the widget; show the idle loop instead.
        if (!cancelled) preloadAnimation('idle').then(begin);
      });
    }

    const onVisibility = () => {
      if (cancelled) return;
      if (document.hidden) stop();
      else resume();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      stop();
      controlsRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [state, canvasRef]);

  // The main effect owns the loop, so hiding has to reach in and stop it.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    if (paused || document.hidden) controls.stop();
    else controls.resume();
  }, [paused, state]);
}
