'use client';

/**
 * Lets the widget be dragged anywhere on the desktop by its character.
 *
 * Lean direction is taken from screen coordinates, never from client
 * coordinates. Stretching the window to the work area jumps clientX/Y and used
 * to report the opposite axis (drag left, tilt left) after a long pause.
 *
 * The pose is reported as soon as the pointer clears the drag threshold, so the
 * lean never waits on the window move that runs alongside it.
 *
 * The window is moved from the pointer event itself. requestAnimationFrame is
 * not usable here: on this machine the compositor clock stalls and rAF fires
 * about once a second, so a move queued on it trailed a fast cursor and only
 * caught up when the button was released.
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { DRAG_THRESHOLD_PX } from '@/character/characterAnimations';

type DragDirection = 'up' | 'down' | 'left' | 'right';

type DragBridge = {
  beginDrag: () => Promise<{ originX: number; originY: number } | null>;
  moveDrag: (position: { x: number; y: number }) => void;
  endDrag: () => Promise<void>;
};

type Session = {
  pointerId: number;
  screenOriginX: number;
  screenOriginY: number;
  origin: { originX: number; originY: number } | null;
  opening: boolean;
  moved: boolean;
  lastDirection: DragDirection | null;
  pendingX: number;
  pendingY: number;
  lastScreenX: number;
  lastScreenY: number;
  startedAt: number;
  lastEventAt: number;
  /** Recent pointer samples, so speed is the cursor's speed and not one noisy step. */
  speedSamples: { t: number; x: number; y: number }[];
  latest: { screenX: number; screenY: number };
  giveUpTimer: ReturnType<typeof setTimeout> | null;
};

const GIVE_UP_MS = 400;
const DIRECTION_CHANGE_THRESHOLD_PX = 3;
/** How far back a speed sample may be. Long enough to smooth a step, short enough to notice a slow-down. */
const SPEED_WINDOW_MS = 80;
/** Lean playback for a deliberate drag. Slower than this stays here; it does not play in slow motion. */
const NORMAL_DRAG_FPS = 36;
/** Pointer speed, in px/ms, that still counts as that deliberate drag. */
const NORMAL_DRAG_SPEED = 0.4;
/**
 * Upper bound on lean playback. The frame pacer ticks at 60 Hz and skips
 * frames above that, so this finishes a tilt in about a tenth of a second,
 * which is as fast as a flick of the cursor without popping to the last frame.
 */
const MAX_DRAG_FPS = 480;

/** Horizontal lean rate for a pointer moving at `speed` px/ms. Vertical drags stay at the normal rate. */
export function dragFpsForSpeed(speed: number, horizontal: boolean): number {
  if (!horizontal || speed <= NORMAL_DRAG_SPEED) return NORMAL_DRAG_FPS;
  return Math.min(MAX_DRAG_FPS, Math.round(NORMAL_DRAG_FPS * (speed / NORMAL_DRAG_SPEED)));
}

function cursorSpeed(current: Session, t: number, x: number, y: number, stepSpeed: number): number {
  const samples = current.speedSamples;
  samples.push({ t, x, y });
  const cutoff = t - SPEED_WINDOW_MS;
  while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
  const first = samples[0];
  const dt = t - first.t;
  // The first few milliseconds have no window yet; the step itself is the speed.
  if (dt < 12) return stepSpeed;
  return Math.hypot(x - first.x, y - first.y) / dt;
}

export type WindowDragHandle = {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
};

function getBridge(): DragBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.desktop;
  return bridge && typeof bridge.beginDrag === 'function' ? bridge : null;
}

function directionOf(deltaX: number, deltaY: number): DragDirection {
  return Math.abs(deltaX) > Math.abs(deltaY)
    ? deltaX > 0
      ? 'right'
      : 'left'
    : deltaY > 0
      ? 'down'
      : 'up';
}

/** A one-pixel step that keeps the current lean while only the rate changes. */
function holdDelta(direction: DragDirection | null): { x: number; y: number } {
  switch (direction) {
    case 'left':
      return { x: -1, y: 0 };
    case 'up':
      return { x: 0, y: -1 };
    case 'down':
      return { x: 0, y: 1 };
    default:
      return { x: 1, y: 0 };
  }
}

export function useWindowDrag(
  rootRef: RefObject<HTMLElement | null>,
  onDirection?: (direction: DragDirection, fps: number) => void,
  onDragEnd?: () => void,
): WindowDragHandle {
  const session = useRef<Session | null>(null);
  const onDirectionRef = useRef(onDirection);
  onDirectionRef.current = onDirection;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;

  const moveWindow = useCallback((x: number, y: number) => {
    getBridge()?.moveDrag({ x, y });
  }, []);

  const report = useCallback((
    current: Session,
    deltaX: number,
    deltaY: number,
    speed: number,
  ) => {
    const send = onDirectionRef.current;
    if (!send) return;
    const direction = directionOf(deltaX, deltaY);
    const horizontal = direction === 'left' || direction === 'right';
    // Always delivered. The caller writes the rate into a ref and only
    // re-renders when the direction actually changes, so a fast drag does not
    // allocate a React render per pointer event.
    current.lastDirection = direction;
    send(direction, dragFpsForSpeed(speed, horizontal));
  }, []);

  const detach = useCallback(() => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const settle = useCallback(async () => {
    const current = session.current;
    session.current = null;
    detach();
    if (!current) return;
    if (current.giveUpTimer) clearTimeout(current.giveUpTimer);

    if (current.origin) await getBridge()?.endDrag();
    if (current.moved) onDragEndRef.current?.();
  }, [detach]);

  function onMove(event: PointerEvent) {
    const current = session.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (current.giveUpTimer) {
      clearTimeout(current.giveUpTimer);
      current.giveUpTimer = null;
    }

    current.latest = {
      screenX: event.screenX,
      screenY: event.screenY,
    };

    const travelX = event.screenX - current.screenOriginX;
    const travelY = event.screenY - current.screenOriginY;
    const stepX = event.screenX - current.lastScreenX;
    const stepY = event.screenY - current.lastScreenY;
    const eventAt = performance.now();
    const stepSpeed = Math.hypot(stepX, stepY) / Math.max(eventAt - current.lastEventAt, 1);
    const speed = cursorSpeed(current, eventAt, event.screenX, event.screenY, stepSpeed);
    current.lastEventAt = eventAt;
    current.lastScreenX = event.screenX;
    current.lastScreenY = event.screenY;

    if (!current.moved) {
      if (Math.abs(travelX) < DRAG_THRESHOLD_PX && Math.abs(travelY) < DRAG_THRESHOLD_PX) {
        return;
      }
      current.moved = true;
      report(current, travelX, travelY, speed);
    } else {
      current.pendingX += stepX;
      current.pendingY += stepY;
      const turned =
        Math.max(Math.abs(current.pendingX), Math.abs(current.pendingY)) >=
        DIRECTION_CHANGE_THRESHOLD_PX;
      // Rate on every event, so a flick speeds the lean up on the same move
      // that carries the window. Direction waits until the new axis is clear.
      const delta = turned
        ? { x: current.pendingX, y: current.pendingY }
        : holdDelta(current.lastDirection);
      report(current, delta.x, delta.y, speed);
      if (turned) {
        current.pendingX = 0;
        current.pendingY = 0;
      }
    }

    if (current.origin) {
      moveWindow(
        current.origin.originX + travelX,
        current.origin.originY + travelY,
      );
      return;
    }

    const bridge = getBridge();
    if (!bridge || current.opening) return;

    current.opening = true;
    void bridge
      .beginDrag()
      .then((result) => {
        if (session.current !== current) {
          if (result) void bridge.endDrag();
          return;
        }
        current.opening = false;
        if (!result) return;
        current.origin = result;
        moveWindow(
          result.originX + current.latest.screenX - current.screenOriginX,
          result.originY + current.latest.screenY - current.screenOriginY,
        );
      })
      .catch(() => {
        if (session.current === current) current.opening = false;
      });
  }

  function onUp(event: PointerEvent) {
    const current = session.current;
    if (!current || event.pointerId !== current.pointerId) return;
    current.latest.screenX = event.screenX;
    current.latest.screenY = event.screenY;
    if (current.origin) {
      moveWindow(
        current.origin.originX + event.screenX - current.screenOriginX,
        current.origin.originY + event.screenY - current.screenOriginY,
      );
    }
    void settle();
  }

  function onCancel(event: PointerEvent) {
    const current = session.current;
    if (!current || event.pointerId !== current.pointerId) return;
    if (current.giveUpTimer) clearTimeout(current.giveUpTimer);
    current.giveUpTimer = setTimeout(() => {
      if (session.current === current) void settle();
    }, GIVE_UP_MS);
  }

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const element = rootRef.current;
      if (!element || session.current) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      session.current = {
        pointerId: event.pointerId,
        screenOriginX: event.screenX,
        screenOriginY: event.screenY,
        origin: null,
        opening: false,
        moved: false,
        lastDirection: null,
        pendingX: 0,
        pendingY: 0,
        lastScreenX: event.screenX,
        lastScreenY: event.screenY,
        startedAt: performance.now(),
        lastEventAt: performance.now(),
        speedSamples: [],
        latest: {
          screenX: event.screenX,
          screenY: event.screenY,
        },
        giveUpTimer: null,
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    },
    [rootRef],
  );

  useEffect(
    () => () => {
      if (session.current) void settle();
    },
    [settle],
  );

  return { onPointerDown };
}
