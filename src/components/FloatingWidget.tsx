'use client';

/**
 * FloatingWidget - a compact dark pill toolbar with an interactive character.
 *
 * Markup, class names and icons follow the original ToolbarWidget reference;
 * the character, state machine, idle auto-hide and desktop bridge are layered
 * on top.
 *
 * One `mode` drives the whole toolbar so panels can never overlap. One
 * character state machine drives every animation. No props, no context.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnimatedCharacter from './character/AnimatedCharacter';
import DesktopPointerBridge from './DesktopPointerBridge';
import { useWindowDrag } from './useWindowDrag';
import { useClippedTextTitles } from './useClippedTextTitles';
import {
  BellIcon,
  CheckIcon,
  CloseIcon,
  EditIcon,
  HistoryIcon,
  PlusIcon,
  TrashIcon,
  UndoIcon,
} from './icons';
import './FloatingWidget.css';
import { useCharacterState } from '@/character/useCharacterState';
import { preloadAnimation } from '@/character/frameCache';
import type { CharacterState } from '@/character/characterAnimations';
import { useReminders } from '@/todos/useReminders';
import { isTodo, type Todo } from '@/todos/types';

type WidgetMode = 'default' | 'create' | 'todo' | 'hidden' | 'notifications';
type PanelMode = Exclude<WidgetMode, 'default'>;
type DragDirection = 'up' | 'down' | 'left' | 'right';
type TodoDraft = { key: number; text: string; deadline: string };

/** Ignore repeated wake events from tiny tab-visibility flickers (Part 12). */
const WAKE_DEBOUNCE_MS = 60_000;

/** The toolbar retires on its own after this long without interaction. */
const CHROME_IDLE_MS = 120_000;

/** Deadlines shown before the green "more" row takes over. */
const DEADLINE_VISIBLE_ROWS = 2;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const HIDDEN_RETENTION_MS = DAY;
const LEGACY_COMPLETED_RETENTION_MS = 30 * DAY;

const DRAG_TO_STATE: Record<DragDirection, CharacterState> = {
  up: 'DRAG_UP',
  down: 'DRAG_DOWN',
  left: 'DRAG_LEFT',
  right: 'DRAG_RIGHT',
};

const SEED_NOW = Date.now();

/** Where the tasks are kept between runs, in the desktop's own storage. */
const TASKS_STORAGE_KEY = 'floating-widget.tasks.v1';

const INITIAL_TODOS: Todo[] = [
  {
    id: 1,
    text: 'Update Daily Habit Tracker UX',
    completed: false,
    createdAt: SEED_NOW - 2 * HOUR,
    deadline: SEED_NOW + 3 * HOUR,
  },
  {
    id: 2,
    text: 'Review WhatsApp polling logic',
    completed: false,
    createdAt: SEED_NOW - 5 * HOUR,
  },
  {
    id: 3,
    text: 'Finalize PROTOOLS logo design',
    completed: false,
    createdAt: SEED_NOW - 26 * HOUR,
    deadline: SEED_NOW + 2 * DAY,
  },
  { id: 4, text: 'Visit Pollachi suppliers', completed: false },
  {
    id: 5,
    text: 'Send the invoice',
    completed: false,
    createdAt: SEED_NOW - 3 * DAY,
    deadline: SEED_NOW - 4 * HOUR,
    lastNotifiedAt: SEED_NOW,
  },
];

/**
 * Reads the saved task list. Anything unreadable, or any entry that is not a
 * well formed task, is dropped rather than trusted, because this file is read
 * back from disk on every start.
 */
function normalizeStoredTodos(parsed: unknown): Todo[] | null {
  if (!Array.isArray(parsed)) return null;
  const loadedAt = Date.now();
  return parsed.filter(isTodo).map((todo) => {
    if (!todo.completed || todo.hiddenAt !== undefined) return todo;
    const createdAt = todo.createdAt ?? loadedAt;
    const hiddenAt =
      loadedAt - createdAt >= LEGACY_COMPLETED_RETENTION_MS ? createdAt : loadedAt;
    return { ...todo, hiddenAt };
  });
}

function readStoredTodos(): Todo[] | null {
  try {
    const raw = window.localStorage.getItem(TASKS_STORAGE_KEY);
    if (!raw) return null;
    return normalizeStoredTodos(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * FIFO ordering key.
 *
 * `id` is already a persistent, monotonically increasing sequence - it is
 * allocated as `max(existing ids) + 1` and stored with the task - so it is the
 * creation order, and reusing it avoids adding a second field that could ever
 * disagree with it. Being greater than every existing id is what guarantees a
 * newly added task sorts after everything that is already there, including after
 * a deletion has lowered the current maximum.
 */
function byCreatedOrder(a: Todo, b: Todo): number {
  return a.id - b.id;
}

/** "just now" / "12m ago" / "3h ago" / "2d ago" / "12 Mar". */
function formatCreated(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.round(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.round(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.round(elapsed / DAY)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/** "Today 18:30" / "Tomorrow 09:00" / "12 Mar 09:00". */
function formatDeadline(timestamp: number): string {
  const target = new Date(timestamp);
  const time = target.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const today = new Date();
  if (target.toDateString() === today.toDateString()) return `Today ${time}`;
  const tomorrow = new Date(today.getTime() + DAY);
  if (target.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${target.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })} ${time}`;
}

export default function FloatingWidget() {
  const [mode, setMode] = useState<WidgetMode>('default');
  const [chromeVisible, setChromeVisible] = useState(true);
  /** Written on the pointer event. A React state here would re-render on every move. */
  const dragFpsRef = useRef(36);
  const dragDirectionRef = useRef<DragDirection | null>(null);
  const [drafts, setDrafts] = useState<TodoDraft[]>([
    { key: 0, text: '', deadline: '' },
  ]);
  const [todos, setTodos] = useState<Todo[]>(() => readStoredTodos() ?? INITIAL_TODOS);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const nextDraftKey = useRef(1);
  const lastWakeRef = useRef(0);
  const chromeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { state: characterState, request: play, force: forcePlay } =
    useCharacterState();

  const deadlines = useReminders(todos, setTodos, play);
  const visibleDeadlines = useMemo(
    () => deadlines.slice(0, DEADLINE_VISIBLE_ROWS),
    [deadlines],
  );
  const overflowDeadlines = deadlines.length - visibleDeadlines.length;
  const validDraftCount = drafts.filter((draft) => draft.text.trim()).length;
  // Oldest added first, on both panels. `filter` returns a fresh array, so
  // sorting it in place cannot disturb the stored order.
  const visibleTodos = useMemo(
    () => todos.filter((todo) => todo.hiddenAt === undefined).sort(byCreatedOrder),
    [todos],
  );
  const hiddenTodos = useMemo(
    () => todos.filter((todo) => todo.hiddenAt !== undefined).sort(byCreatedOrder),
    [todos],
  );

  // --- chrome idle: hide every option, come back on character hover --------
  const hideChrome = useCallback(() => {
    chromeTimer.current = null;
    setChromeVisible(false);
    setMode('default');
    play('QUIET');
  }, [play]);

  const keepChromeAwake = useCallback(() => {
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    chromeTimer.current = setTimeout(hideChrome, CHROME_IDLE_MS);
  }, [hideChrome]);

  useEffect(() => {
    keepChromeAwake();
    return () => {
      if (chromeTimer.current) clearTimeout(chromeTimer.current);
    };
  }, [keepChromeAwake]);

  // --- whether the window is on screen --------------------------------------
  // `win.hide()` does not make the page hidden, so the main process reports it.
  // A hidden widget must cost nothing: the character is still "playing" for an
  // empty screen otherwise.
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const unsubscribe = window.desktop?.onVisibility((visible) => setOnScreen(visible));
    return () => unsubscribe?.();
  }, []);

  // --- the tray can open a panel, or ask what the optional ones hold --------
  // The tray is the only way back to a hidden widget, so its menu carries the
  // same options the toolbar does. It cannot read this component's state, so
  // both directions cross the bridge: counts go out, a chosen panel comes in.
  useEffect(() => {
    const unsubscribe = window.desktop?.onOpenPanel((requested) => {
      if (requested !== 'create' && requested !== 'todo' && requested !== 'hidden' && requested !== 'notifications') {
        return;
      }
      setMode(requested);
      setChromeVisible(true);
      keepChromeAwake();
      play('RESPONSE');
    });
    return () => unsubscribe?.();
  }, [keepChromeAwake, play]);

  useEffect(() => {
    window.desktop?.reportOptions({
      history: hiddenTodos.length,
      reminders: deadlines.length,
    });
  }, [deadlines.length, hiddenTodos.length]);

  // --- hand clipped task text back on hover ---------------------------------
  useClippedTextTitles([mode, todos, visibleDeadlines]);

  // --- keep the task list saved in the Electron atomic store (with browser fallback) ---
  const storeHydratedRef = useRef(!window.desktop?.loadTodos);
  const skipNextSaveRef = useRef(false);

  useEffect(() => {
    const loadFromDesktop = window.desktop?.loadTodos;
    if (!loadFromDesktop) return;
    let cancelled = false;

    void loadFromDesktop().then((desktopTodos) => {
      if (cancelled) return;
      const normalized = normalizeStoredTodos(desktopTodos);
      if (normalized !== null) {
        skipNextSaveRef.current = true;
        storeHydratedRef.current = true;
        setTodos(normalized);
        return;
      }
      // First launch on the new atomic store: migrate any legacy localStorage tasks once.
      const legacyLocal = readStoredTodos();
      if (legacyLocal !== null) {
        skipNextSaveRef.current = true;
        storeHydratedRef.current = true;
        setTodos(legacyLocal);
        void window.desktop?.saveTodos(legacyLocal);
        return;
      }
      storeHydratedRef.current = true;
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const isFirstSave = useRef(true);
  useEffect(() => {
    if (!storeHydratedRef.current) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      isFirstSave.current = false;
      return;
    }
    // The seeded list is only written once something has actually changed, so a
    // fresh install does not sprout a file before the user does anything.
    if (isFirstSave.current) {
      isFirstSave.current = false;
      if (readStoredTodos() === null) return;
    }
    if (window.desktop?.saveTodos) {
      void window.desktop.saveTodos(todos);
      return;
    }
    try {
      window.localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(todos));
    } catch {
      // A full or blocked store must not take the widget down with it.
    }
  }, [todos]);

  useEffect(() => {
    if (hiddenTodos.length === 0) return undefined;
    const expiresAt = Math.min(
      ...hiddenTodos.map((todo) => (todo.hiddenAt as number) + HIDDEN_RETENTION_MS),
    );
    let retryTimer: number | undefined;
    let cancelled = false;
    const expireHidden = () => {
      const now = Date.now();
      const expired = todos.filter(
        (todo) =>
          todo.hiddenAt !== undefined &&
          now >= todo.hiddenAt + HIDDEN_RETENTION_MS,
      );
      if (expired.length === 0) return;
      const expiredIds = new Set(expired.map((todo) => todo.id));
      const removeExpired = () => {
        if (cancelled) return;
        setTodos((current) => current.filter((todo) => !expiredIds.has(todo.id)));
      };
      const archive = window.desktop?.archiveTodos;
      if (!archive) {
        removeExpired();
        return;
      }
      void archive(expired).then((saved) => {
        if (saved) removeExpired();
        else if (!cancelled) retryTimer = window.setTimeout(expireHidden, 30_000);
      }).catch(() => {
        if (!cancelled) retryTimer = window.setTimeout(expireHidden, 30_000);
      });
    };
    const timer = window.setTimeout(
      expireHidden,
      Math.max(0, expiresAt - Date.now()),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [todos, hiddenTodos]);

  // --- startup: HAI, then IDLE (Part 12) -----------------------------------
  useEffect(() => {
    // Keep startup decoding small; drag clips warm on first hover.
    preloadAnimation('idle');
    preloadAnimation('hai');
    forcePlay('HAI');
  }, [forcePlay]);

  // --- wake from background: debounced HAI (Part 12) ------------------------
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastWakeRef.current < WAKE_DEBOUNCE_MS) return;
      lastWakeRef.current = now;
      play('HAI');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [play]);

  // --- autofocus the create input (Part 3) ---------------------------------
  useEffect(() => {
    if (mode === 'create') inputRef.current?.focus();
  }, [mode]);

  // --- outside click (Part 19) and Escape (Part 20) -------------------------
  useEffect(() => {
    if (mode === 'default') return;

    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      // Clicks inside the widget must never close a panel.
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      setMode('default');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMode('default');
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mode]);

  // --- toolbar actions ------------------------------------------------------
  const togglePanel = useCallback(
    (next: PanelMode) => {
      const opening = mode !== next;
      setMode(opening ? next : 'default');
      if (!opening) return;
      keepChromeAwake();
      // Let the character react to what the app is now doing.
      if (next === 'todo') play('WONDERING');
      else if (next === 'hidden') play(hiddenTodos.length > 0 ? 'WONDERING' : 'QUIET');
      else if (next === 'notifications') {
        play(deadlines.length > 0 ? 'WONDERING' : 'QUIET');
      }
    },
    [mode, play, keepChromeAwake, deadlines.length, hiddenTodos.length],
  );

  const updateDraft = useCallback(
    (key: number, field: 'text' | 'deadline', value: string) => {
      setDrafts((current) =>
        current.map((draft) =>
          draft.key === key ? { ...draft, [field]: value } : draft,
        ),
      );
    },
    [],
  );

  const addDraftRow = useCallback(() => {
    const key = nextDraftKey.current++;
    setDrafts((current) => [...current, { key, text: '', deadline: '' }]);
    keepChromeAwake();
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLInputElement>(`[data-draft-key="${key}"]`)
        ?.focus();
    });
  }, [keepChromeAwake]);

  const removeDraftRow = useCallback((key: number) => {
    setDrafts((current) => {
      if (current.length === 1) {
        return current.map((draft) =>
          draft.key === key ? { ...draft, text: '', deadline: '' } : draft,
        );
      }
      return current.filter((draft) => draft.key !== key);
    });
  }, []);

  const submitDrafts = useCallback(() => {
    const createdAt = Date.now();
    const prepared = drafts.flatMap((draft) => {
      const text = draft.text.trim();
      if (!text) return [];
      const parsed = draft.deadline ? new Date(draft.deadline).getTime() : NaN;
      return [{
        text,
        createdAt,
        deadline: Number.isFinite(parsed) ? parsed : undefined,
      }];
    });
    if (prepared.length === 0) {
      inputRef.current?.focus();
      return;
    }

    setTodos((current) => {
      const firstId = Math.max(0, ...current.map((todo) => todo.id)) + 1;
      const added = prepared.map((draft, index) => ({
        ...draft,
        id: firstId + index,
        completed: false,
      }));
      // Appended, so a new task lands after the existing ones. Prepending it
      // was the bug this replaces: it put the newest task at the top of the
      // checklist instead of the bottom.
      return [...current, ...added];
    });
    const firstKey = nextDraftKey.current++;
    setDrafts([{ key: firstKey, text: '', deadline: '' }]);
    setMode('default');
    keepChromeAwake();
    if (prepared.some((draft) => draft.deadline !== undefined)) {
      void Notification.requestPermission?.();
    }
  }, [drafts, keepChromeAwake]);

  const toggleTodo = useCallback(
    (id: number) => {
      const target = todos.find((t) => t.id === id);
      if (!target) return;
      const hiddenAt = target.completed ? undefined : Date.now();
      const next = todos.map((t) =>
        t.id === id ? { ...t, completed: !t.completed, hiddenAt } : t,
      );
      setTodos(next);
      keepChromeAwake();
      if (!target.completed) {
        // Finishing the last task earns the bigger reaction.
        if (next.every((t) => t.completed)) forcePlay('CHEER');
        else play('SUCCESS');
      }
    },
    [todos, play, forcePlay, keepChromeAwake],
  );

  const deleteTodo = useCallback((id: number) => {
    setTodos((current) => current.filter((todo) => todo.id !== id));
    keepChromeAwake();
  }, [keepChromeAwake]);

  const restoreTodo = useCallback((id: number) => {
    setTodos((current) =>
      current.map((todo) => {
        if (todo.id !== id) return todo;
        const { hiddenAt, ...restored } = todo;
        return { ...restored, completed: false };
      }),
    );
    setMode('todo');
    keepChromeAwake();
  }, [keepChromeAwake]);

  /** Clearing a reminder means dealing with the task it came from. */
  const clearDeadline = useCallback(
    (id: number) => {
      const hiddenAt = Date.now();
      const next = todos.map((t) =>
        t.id === id ? { ...t, completed: true, hiddenAt } : t,
      );
      setTodos((current) =>
        current.map((t) =>
          t.id === id ? { ...t, completed: true, hiddenAt } : t,
        ),
      );
      keepChromeAwake();
      if (next.every((t) => t.completed)) forcePlay('CHEER');
      else play('SUCCESS');
    },
    [todos, play, forcePlay, keepChromeAwake],
  );

  // --- character interaction ------------------------------------------------
  const handleHover = useCallback(() => {
    // Hovering the character is how the toolbar comes back after it retires.
    // The reveal is plain UI state and must not wait on animation arbitration:
    // a QUIET clip may still be playing, and that must not delay the chrome.
    setChromeVisible(true);
    keepChromeAwake();
    void preloadAnimation('tilt_left').catch(() => undefined);
    void preloadAnimation('tilt_right').catch(() => undefined);
    play('HOVER');
  }, [keepChromeAwake, play]);

  /** The character is the handle, and it reacts to the way it is taken. */
  const handleDrag = useCallback(
    (direction: DragDirection, fps: number) => {
      // The rate is read by the player on its next tick. Setting state here
      // would re-render the whole widget on every pointer event.
      dragFpsRef.current = fps;
      if (dragDirectionRef.current === direction) return;
      dragDirectionRef.current = direction;
      setChromeVisible(true);
      keepChromeAwake();
      // The character is being physically dragged, so this pose is not one the
      // animation arbiter gets to overrule. Without this a greet or a cheer
      // playing at the time swallowed the drag: the window moved, the character
      // stayed waving, and it read as the drag not working.
      forcePlay(DRAG_TO_STATE[direction]);
    },
    [forcePlay, keepChromeAwake],
  );

  /** Letting go of the drag puts the character back on its own. */
  const handleDragEnd = useCallback(() => {
    dragFpsRef.current = 36;
    dragDirectionRef.current = null;
    forcePlay('IDLE');
  }, [forcePlay]);

  const drag = useWindowDrag(rootRef, handleDrag, handleDragEnd);

  const handleActivate = useCallback(() => {
    keepChromeAwake();
    play('WONDERING');
  }, [keepChromeAwake, play]);

  /** Any deliberate interaction inside the widget defers the idle hide. */
  const handleActivity = useCallback(() => {
    if (chromeVisible) keepChromeAwake();
  }, [chromeVisible, keepChromeAwake]);

  // --- development-only handle, used by the browser tests -------------------
  const stateRef = useRef(characterState);
  stateRef.current = characterState;
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    (window as unknown as Record<string, unknown>).__floatingWidget = {
      play: (state: CharacterState) => forcePlay(state),
      getState: () => stateRef.current,
      setMode,
      setChromeVisible,
    };
  }, [forcePlay]);

  return (
    <>
      <DesktopPointerBridge />
      <div
        className={`fw${chromeVisible ? '' : ' fw--chrome-hidden'}`}
        ref={rootRef}
        onPointerDown={handleActivity}
        onKeyDown={handleActivity}
      >
        <AnimatedCharacter
          state={characterState}
          dragFpsRef={dragFpsRef}
          onHover={handleHover}
          onDrag={handleDrag}
          onActivate={handleActivate}
          windowDrag={drag}
          paused={!onScreen}
        />

        <div className="fw-chrome">
          {mode === 'create' && (
            <div className="fw-panel fw-panel--create" role="dialog" aria-label="New task">
              <div className="fw-panel__head">
                <button
                  type="button"
                  className="fw-close"
                  onClick={() => setMode('default')}
                  aria-label="Close new task"
                >
                  <CloseIcon size={14} />
                </button>
              </div>
              <div className="fw-draft-list">
                {drafts.map((draft, index) => (
                  <div className="fw-draft" key={draft.key}>
                    <div className="fw-create">
                      <input
                        ref={index === 0 ? inputRef : undefined}
                        data-draft-key={draft.key}
                        className="fw-input"
                        type="text"
                        value={draft.text}
                        placeholder={`Task ${index + 1}`}
                        aria-label={`Task ${index + 1}`}
                        onChange={(event) =>
                          updateDraft(draft.key, 'text', event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            addDraftRow();
                          }
                        }}
                      />
                      {drafts.length > 1 && (
                        <button
                          type="button"
                          className="fw-mini-action"
                          onClick={() => removeDraftRow(draft.key)}
                          aria-label={`Remove task row ${index + 1}`}
                          title="Remove task row"
                        >
                          <TrashIcon />
                        </button>
                      )}
                    </div>
                    <label className="fw-draft__due">
                      <span className="fw-create__label">Due</span>
                      <input
                        className="fw-input fw-datetime"
                        type="datetime-local"
                        value={draft.deadline}
                        aria-label={`Due date for task ${index + 1}, optional`}
                        onChange={(event) =>
                          updateDraft(draft.key, 'deadline', event.target.value)
                        }
                      />
                    </label>
                  </div>
                ))}
              </div>
              <div className="fw-create__actions">
                <button type="button" className="fw-add-row" onClick={addDraftRow}>
                  <PlusIcon size={15} />
                  <span>Add task</span>
                </button>
                <button
                  type="button"
                  className="fw-add-all"
                  onClick={submitDrafts}
                  disabled={validDraftCount === 0}
                >
                  <CheckIcon size={15} />
                  <span>{validDraftCount > 1 ? 'Add all' : 'Add'}</span>
                </button>
              </div>
            </div>
          )}

          {mode === 'todo' && (
            <div className="fw-panel" role="dialog" aria-label="To-do list">
              <div className="fw-panel__head">
                <button
                  type="button"
                  className="fw-close"
                  onClick={() => setMode('default')}
                  aria-label="Close to-do list"
                >
                  <CloseIcon />
                </button>
              </div>
              <ul className="fw-list fw-list--tasks">
                {visibleTodos.map((todo) => (
                  <li key={todo.id} className="fw-item">
                    <label className="fw-item__label">
                      <input
                        type="checkbox"
                        className="fw-checkbox"
                        checked={todo.completed}
                        onChange={() => toggleTodo(todo.id)}
                      />
                      <span
                        className={
                          todo.completed
                            ? 'fw-item__text fw-item__text--done'
                            : 'fw-item__text'
                        }
                        data-full-text={todo.text}
                      >
                        {todo.text}
                      </span>
                    </label>
                    <span className="fw-item__meta">
                      {todo.deadline !== undefined && (
                        <BellIcon size={11} />
                      )}
                      {todo.createdAt !== undefined && (
                        <span className="fw-item__time">
                          {formatCreated(todo.createdAt)}
                        </span>
                      )}
                      <button
                        type="button"
                        className="fw-item__delete"
                        onClick={() => deleteTodo(todo.id)}
                        aria-label={`Delete ${todo.text}`}
                        title="Delete this task"
                      >
                        <TrashIcon size={12} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
              {visibleTodos.length === 0 && <p className="fw-empty">No active tasks</p>}
            </div>
          )}

          {mode === 'hidden' && (
            <div className="fw-panel" role="dialog" aria-label="Recently completed tasks">
              <div className="fw-panel__head">
                <button
                  type="button"
                  className="fw-close"
                  onClick={() => setMode('default')}
                  aria-label="Close recently completed tasks"
                >
                  <CloseIcon />
                </button>
              </div>
              {hiddenTodos.length === 0 ? (
                <p className="fw-empty">No recently completed tasks</p>
              ) : (
                <ul className="fw-list fw-list--tasks fw-list--hidden">
                  {hiddenTodos.map((todo) => (
                    <li key={todo.id} className="fw-item">
                      <span
                        className="fw-item__text fw-item__text--done"
                        data-full-text={todo.text}
                      >
                        {todo.text}
                      </span>
                      <span className="fw-item__meta">
                        <span className="fw-item__time">
                          Done {formatCreated(todo.hiddenAt as number)}
                        </span>
                        <button
                          type="button"
                          className="fw-item__restore"
                          onClick={() => restoreTodo(todo.id)}
                          aria-label={`Undo completion and restore ${todo.text}`}
                          title="Undo completion"
                        >
                          <UndoIcon />
                        </button>
                        <button
                          type="button"
                          className="fw-item__delete"
                          onClick={() => deleteTodo(todo.id)}
                          aria-label={`Delete ${todo.text}`}
                          title="Delete this task"
                        >
                          <TrashIcon size={12} />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {mode === 'notifications' && (
            <div className="fw-panel" role="dialog" aria-label="Deadline reminders">
              <div className="fw-panel__head">
                <button
                  type="button"
                  className="fw-close"
                  onClick={() => setMode('default')}
                  aria-label="Close reminders"
                >
                  <CloseIcon />
                </button>
              </div>
              {deadlines.length === 0 ? (
                <p className="fw-empty">No deadlines due</p>
              ) : (
                <ul className="fw-list fw-list--reminders">
                  {visibleDeadlines.map((todo) => (
                    <li key={todo.id} className="fw-item">
                      <button
                        type="button"
                        className="fw-reminder"
                        onClick={() => clearDeadline(todo.id)}
                      >
                        <BellIcon size={14} />
                        <span className="fw-item__text" data-full-text={todo.text}>
                          {todo.text}
                        </span>
                        <span
                          className={`fw-when${
                            (todo.deadline as number) < Date.now()
                              ? ' fw-when--overdue'
                              : ''
                          }`}
                        >
                          {formatDeadline(todo.deadline as number)}
                        </span>
                      </button>
                    </li>
                  ))}
                  {overflowDeadlines > 0 && (
                    <li className="fw-item fw-item--more">
                      <span className="fw-more__dot" aria-hidden="true" />
                      <span className="fw-more__text">
                        {overflowDeadlines} more to complete
                      </span>
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          <div className="fw-pill">
            <button
              type="button"
              className="fw-icon-btn"
              onClick={() => togglePanel('create')}
              aria-label="Create"
              title="Create"
              aria-expanded={mode === 'create'}
            >
              <EditIcon size={14} />
            </button>

            <div className="fw-divider" />

            <button
              type="button"
              className="fw-icon-btn"
              onClick={() => togglePanel('todo')}
              aria-label="To-Do"
              title="Tasks"
              aria-expanded={mode === 'todo'}
            >
              <CheckIcon size={15} />
            </button>

            {hiddenTodos.length > 0 && (
              <>
                <div className="fw-divider" />
                <button
                  type="button"
                  className="fw-icon-btn"
                  onClick={() => togglePanel('hidden')}
                  aria-label={`Recently completed, ${hiddenTodos.length} tasks`}
                  title="Recently completed"
                  aria-expanded={mode === 'hidden'}
                >
                  <HistoryIcon />
                </button>
              </>
            )}

            {deadlines.length > 0 && (
              <>
                <div className="fw-divider" />

                <button
                  type="button"
                  className="fw-icon-btn fw-icon-btn--badge"
                  onClick={() => togglePanel('notifications')}
                  aria-label={`Notifications, ${deadlines.length} due`}
                  title="Reminders"
                  aria-expanded={mode === 'notifications'}
                >
                  <BellIcon size={14} />
                  <span className="fw-badge" aria-hidden="true">
                    {deadlines.length}
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
