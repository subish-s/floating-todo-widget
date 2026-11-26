'use client';

/**
 * The character state machine.
 *
 * All animation decisions funnel through `request()`. It applies the priority
 * rules from the brief so a low-priority event (hover, stray pointer move) can
 * never interrupt a high-priority one (explicit application event), and it
 * guarantees every temporary animation falls back to IDLE.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ANIMATION_FOR_STATE,
  HOLD_UNTIL_RELEASE,
  ONE_SHOT_SETTLE_MS,
  type CharacterState,
  isTransient,
  priorityOf,
} from './characterAnimations';
import { DEFAULT_FPS, frameCountOf } from './manifest';

export type CharacterController = {
  state: CharacterState;
  /** Ask to play a state. Ignored while a higher-priority state is active. */
  request: (next: CharacterState) => void;
  /** Force a state, bypassing arbitration (used for the startup greeting). */
  force: (next: CharacterState) => void;
};

export function useCharacterState(): CharacterController {
  const [state, setState] = useState<CharacterState>('STARTING');

  // Priority is compared against the live state, so it must be a ref: a stale
  // closure here would let a hover interrupt a success animation.
  const stateRef = useRef<CharacterState>('STARTING');
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSettle = useCallback(() => {
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  }, []);

  const apply = useCallback(
    (next: CharacterState) => {
      stateRef.current = next;
      setState(next);
    },
    [],
  );

  const request = useCallback(
    (next: CharacterState) => {
      const current = stateRef.current;
      if (current === next) return;
      if (HOLD_UNTIL_RELEASE[current] && !HOLD_UNTIL_RELEASE[next]) return;
      // Only a playing one-shot can block a request, and only if that one-shot
      // is strictly more urgent. Equal priority means the user just asked again
      // (a second drag while the first is still playing, say), and the newest
      // interaction is the one they meant.
      if (isTransient(current) && priorityOf(next) < priorityOf(current)) return;
      // Only now, once the transition is actually accepted, is it safe to drop
      // the pending settle timer. Clearing it earlier would let a *rejected*
      // hover or drag cancel the return-to-idle of the one-shot in progress,
      // stranding the character in that state forever.
      clearSettle();
      apply(next);
    },
    [apply, clearSettle],
  );

  const force = useCallback(
    (next: CharacterState) => {
      clearSettle();
      apply(next);
    },
    [apply, clearSettle],
  );

  // Fall back to IDLE once a one-shot has had time to play through.
  useEffect(() => {
    if (!isTransient(state) || HOLD_UNTIL_RELEASE[state]) return;
    const frames = frameCountOf(ANIMATION_FOR_STATE[state]);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      if (stateRef.current === state) apply('IDLE');
    }, (frames / DEFAULT_FPS) * 1000 + ONE_SHOT_SETTLE_MS);

    return clearSettle;
  }, [state, apply, clearSettle]);

  return { state, request, force };
}
