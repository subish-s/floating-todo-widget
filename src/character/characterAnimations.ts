/**
 * Character animation catalogue and state machine.
 *
 * Every animation decision in the widget resolves through this file: the
 * toolbar never names a zip/clip directly, it emits a state and this module
 * decides which clip plays, whether it loops, and how urgent it is.
 */

/**
 * Relative on purpose. The desktop app loads the export straight off disk with
 * `file://`, where an absolute "/character/..." would resolve to the filesystem
 * root. A relative base works both there and from a normal web server.
 */
export const CHARACTER_ASSET_BASE = './character/animations';

export type AnimationName =
  | 'hai'
  | 'idle'
  | 'jump_and_wiz'
  | 'keep_quite'
  | 'No and Saying yes'
  | 'see_down'
  | 'see_up'
  | 'tilt_left'
  | 'tilt_right'
  | 'wondering'
  | 'yoho_and_wink';

export type CharacterState =
  /** Very first paint, before anything has been decoded. */
  | 'STARTING'
  /** Startup / wake greeting. */
  | 'HAI'
  /** Default resting loop. */
  | 'IDLE'
  /** Pointer entered the character. */
  | 'HOVER'
  | 'DRAG_UP'
  | 'DRAG_DOWN'
  | 'DRAG_LEFT'
  | 'DRAG_RIGHT'
  /** A deadline arrived. */
  | 'SAD'
  /** A task was completed. */
  | 'SUCCESS'
  /** Everything finished - a friendly celebration. */
  | 'CHEER'
  /** Awaiting the user / thinking. */
  | 'WONDERING'
  /** Nothing to do, stay quiet. */
  | 'QUIET'
  /** The character is answering the user. */
  | 'RESPONSE';

/**
 * Priority arbitration (Part 24). A lower number may never interrupt a higher
 * one, so mouse movement cannot restart a success animation mid-play, and a
 * drag cannot stutter an explicit application event.
 */
export const PRIORITY = {
  STARTING: 0,
  IDLE: 0,
  HOVER: 1,
  DRAG_UP: 2,
  DRAG_DOWN: 2,
  DRAG_LEFT: 2,
  DRAG_RIGHT: 2,
  HAI: 3,
  SUCCESS: 3,
  CHEER: 3,
  WONDERING: 3,
  QUIET: 3,
  RESPONSE: 4,
  SAD: 4,
} as const satisfies Record<CharacterState, number>;

/** State -> clip. */
export const ANIMATION_FOR_STATE = {
  STARTING: 'idle',
  HAI: 'hai',
  IDLE: 'idle',
  HOVER: 'wondering',
  DRAG_UP: 'see_up',
  DRAG_DOWN: 'see_down',
  // Lean against the pull: drag left → tilt right, and the other way around.
  DRAG_LEFT: 'tilt_right',
  DRAG_RIGHT: 'tilt_left',
  SAD: 'see_down',
  SUCCESS: 'jump_and_wiz',
  CHEER: 'yoho_and_wink',
  WONDERING: 'wondering',
  QUIET: 'keep_quite',
  RESPONSE: 'No and Saying yes',
} as const satisfies Record<CharacterState, AnimationName>;

/**
 * Drag clips play once and hold their final frame until the pointer is released.
 * The idle loop repeats; other states are one-shots.
 */
export const LOOPS = {
  STARTING: true,
  HAI: false,
  IDLE: true,
  HOVER: false,
  DRAG_UP: false,
  DRAG_DOWN: false,
  DRAG_LEFT: false,
  DRAG_RIGHT: false,
  SUCCESS: false,
  CHEER: false,
  WONDERING: false,
  QUIET: false,
  RESPONSE: false,
  SAD: false,
} as const satisfies Record<CharacterState, boolean>;

/** Drag states freeze on their last frame until drag-end explicitly resets them. */
export const HOLD_UNTIL_RELEASE: Partial<Record<CharacterState, true>> = {
  DRAG_UP: true,
  DRAG_DOWN: true,
  DRAG_LEFT: true,
  DRAG_RIGHT: true,
};

/** Faster playback keeps the drag reactions feeling immediate. */
export const FPS_FOR_STATE: Partial<Record<CharacterState, number>> = {
  DRAG_LEFT: 36,
  DRAG_RIGHT: 36,
};

/** Zero-based, end-exclusive ranges trim the slow lead-in and tail of each tilt. */
export const FRAME_RANGE_FOR_STATE: Partial<
  Record<CharacterState, { start: number; end: number }>
> = {
  DRAG_LEFT: { start: 4, end: 47 },
  DRAG_RIGHT: { start: 4, end: 47 },
};

/** Minimum drag distance in px before a direction counts. */
export const DRAG_THRESHOLD_PX = 6;

/** Idle gap after a one-shot finishes, so the character settles before idling. */
export const ONE_SHOT_SETTLE_MS = 120;

export function isTransient(state: CharacterState): boolean {
  return !LOOPS[state];
}

export function priorityOf(state: CharacterState): number {
  return PRIORITY[state];
}

/** Frame URL for a clip. Frames are zero-padded to 4 digits by the build. */
export function frameUrl(animation: AnimationName, index1: number): string {
  return `${CHARACTER_ASSET_BASE}/${encodeURIComponent(animation)}/frame_${String(
    index1,
  ).padStart(4, '0')}.webp`;
}
