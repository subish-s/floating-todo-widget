'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  dueTodos,
  reminderBody,
  shouldFireReminder,
} from './reminders';
import type { Todo } from './types';

type Play = (state: 'RESPONSE' | 'WONDERING' | 'SAD') => void;
const REMINDER_CHECK_INTERVAL_MS = 30_000;

function showOsNotification(title: string, body: string) {
  const desktop = typeof window !== 'undefined' ? window.desktop : undefined;
  if (desktop && typeof desktop.notify === 'function') {
    desktop.notify({ title, body });
    return;
  }
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

/**
 * Deadline clock + OS reminders.
 *
 * Deadlines are checked every 30 seconds and immediately when the app returns
 * to the foreground. Creating a task never notifies in the same check cycle.
 */
export function useReminders(
  todos: readonly Todo[],
  setTodos: Dispatch<SetStateAction<Todo[]>>,
  play: Play,
) {
  const [now, setNow] = useState(() => Date.now());
  const playRef = useRef(play);
  playRef.current = play;
  const announced = useRef(new Map<number, number | undefined>());
  const hasActiveDeadlines = todos.some(
    (todo) => !todo.completed && todo.deadline !== undefined,
  );

  const due = useMemo(() => dueTodos(todos, now), [todos, now]);

  useEffect(() => {
    if (!hasActiveDeadlines) return undefined;
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, REMINDER_CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [hasActiveDeadlines]);

  useEffect(() => {
    const instant = Date.now();
    const byId = new Map(todos.map((todo) => [todo.id, todo]));
    for (const [id, notifiedAt] of announced.current) {
      if (byId.get(id)?.lastNotifiedAt !== notifiedAt) announced.current.delete(id);
    }
    const ready = todos.filter(
      (todo) => shouldFireReminder(todo, instant) && !announced.current.has(todo.id),
    );
    if (ready.length === 0) return;

    for (const todo of ready) announced.current.set(todo.id, todo.lastNotifiedAt);
    const ids = new Set(ready.map((todo) => todo.id));
    setTodos((current) =>
      current.map((todo) =>
        ids.has(todo.id) ? { ...todo, lastNotifiedAt: instant } : todo,
      ),
    );

    const first = ready[0];
    showOsNotification(
      ready.length === 1 ? 'Task due' : `${ready.length} tasks due`,
      reminderBody(first, instant),
    );
    playRef.current('SAD');
  }, [todos, now, setTodos]);

  return due;
}
