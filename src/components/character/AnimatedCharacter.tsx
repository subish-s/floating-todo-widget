'use client';

/**
 * The interactive character.
 *
 * Sits above the toolbar, handles hover and directional drag, and delegates
 * every animation choice to the state machine. Pointer coordinates are tracked
 * in refs during a drag, so moving the mouse never triggers a React render;
 * only the drag's *result* does.
 */
import { useCallback, useRef, type RefObject } from 'react';
import './character.css';
import { DRAG_THRESHOLD_PX, type CharacterState } from '@/character/characterAnimations';
import { useAnimationPlayer } from '@/character/useAnimationPlayer';
import { CANVAS } from '@/character/manifest';
import type { WindowDragHandle } from '../useWindowDrag';

type Props = {
  state: CharacterState;
  /** Live playback rate for a drag. See `useAnimationPlayer`. */
  dragFpsRef: RefObject<number>;
  /** Hover reaction; arbitrated by priority inside the state machine. */
  onHover: () => void;
  /** Directional drag result. */
  onDrag: (direction: 'up' | 'down' | 'left' | 'right', fps: number) => void;
  /** Keyboard activation, for users without a pointer. */
  onActivate: () => void;
  /**
   * Set when the character is the handle for moving the widget around the
   * desktop. Under the drag threshold it stays a click; past it the window
   * travels and the character leans against the pull (drag left → tilt right).
   */
  windowDrag?: WindowDragHandle;
  /**
   * Set while the window is hidden. `document.hidden` is not enough on its own:
   * `win.hide()` unmaps the window without hiding the page, so an animation loop
   * keyed off that keeps running against a window nobody can see.
   */
  paused?: boolean;
};

type DragState = {
  pointerId: number;
  originX: number;
  originY: number;
  lastX: number;
  lastY: number;
};

export default function AnimatedCharacter({
  state,
  dragFpsRef,
  onHover,
  onDrag,
  onActivate,
  windowDrag,
  paused = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const draggingRef = useRef(false);

  useAnimationPlayer(canvasRef, state, dragFpsRef, paused);

  const handlePointerEnter = useCallback(() => {
    // Never let a hover reaction interrupt a drag.
    if (draggingRef.current) return;
    onHover();
  }, [onHover]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      draggingRef.current = true;
      dragRef.current = {
        pointerId: e.pointerId,
        originX: e.clientX,
        originY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
      };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // The pointer can already be gone by the time this runs; the window
        // listens for the rest of the drag anyway.
      }
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      // Ref writes only: this is the hot path while the pointer moves, and it
      // must not re-render React.
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
    },
    [],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      draggingRef.current = false;
      dragRef.current = null;
      if (!drag || drag.pointerId !== e.pointerId) return;

      const deltaX = drag.lastX - drag.originX;
      const deltaY = drag.lastY - drag.originY;
      const withinThreshold =
        Math.abs(deltaX) < DRAG_THRESHOLD_PX && Math.abs(deltaY) < DRAG_THRESHOLD_PX;

      if (withinThreshold) {
        onActivate();
        return;
      }
      // With a window drag attached the direction is reported continuously while
      // the pointer moves, and repeating it here only produced a second, wrong
      // reaction from a release the browser had already begun to take back.
      if (windowDrag) return;
      // Dominant axis wins, so a diagonal drag resolves to one clear reaction.
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        onDrag(deltaX > 0 ? 'right' : 'left', 36);
      } else {
        onDrag(deltaY > 0 ? 'down' : 'up', 36);
      }
    },
    [onActivate, onDrag, windowDrag],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    },
    [onActivate],
  );

  return (
    <button
      type="button"
      className="fw-character"
      aria-label="Assistant character. Hover, drag, or press Enter to interact."
      data-character-state={state}
      onPointerEnter={handlePointerEnter}
      onPointerDown={(e) => {
        handlePointerDown(e);
        windowDrag?.onPointerDown(e);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
    >
      <canvas
        ref={canvasRef}
        className="fw-character__canvas"
        width={CANVAS.width}
        height={CANVAS.height}
      />
    </button>
  );
}
