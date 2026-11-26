import type { Todo } from './types';

/** A due-now task waits one check cycle so creation itself never pings. */
export const CREATE_GRACE_MS = 30_000;

/** If the deadline passed and the task is still open, remind again this often. */
export const OVERDUE_REPEAT_MS = 60 * 60 * 1000;

export function hasDeadline(todo: Todo): todo is Todo & { deadline: number } {
  return !todo.completed && todo.deadline !== undefined;
}

/** Incomplete tasks whose deadline has arrived. O(n). */
export function dueTodos(todos: readonly Todo[], now: number): Todo[] {
  return todos
    .filter(
      (todo) =>
        hasDeadline(todo) &&
        todo.deadline <= now &&
        now - (todo.createdAt ?? 0) >= CREATE_GRACE_MS,
    )
    .sort((a, b) => (a.deadline as number) - (b.deadline as number));
}

/**
 * A reminder is due to fire (OS notification + character reaction).
 * Create is never a fire: the grace window covers "I just typed this".
 */
export function shouldFireReminder(todo: Todo, now: number): boolean {
  if (!hasDeadline(todo) || todo.deadline > now) return false;
  const createdAt = todo.createdAt ?? 0;
  if (now - createdAt < CREATE_GRACE_MS) return false;
  if (todo.lastNotifiedAt === undefined) return true;
  return now - todo.lastNotifiedAt >= OVERDUE_REPEAT_MS;
}

/** Next clock wake: the soonest deadline or overdue repeat. O(n). */
export function nextWakeAt(todos: readonly Todo[], now: number): number | null {
  let wake: number | null = null;
  const consider = (at: number) => {
    if (at <= now) return;
    if (wake === null || at < wake) wake = at;
  };

  for (const todo of todos) {
    if (!hasDeadline(todo)) continue;
    if (todo.deadline > now) {
      consider(todo.deadline);
      continue;
    }
    const createdAt = todo.createdAt ?? 0;
    const graceEnds = createdAt + CREATE_GRACE_MS;
    if (now < graceEnds) {
      consider(graceEnds);
      continue;
    }
    if (todo.lastNotifiedAt === undefined) return now;
    consider(todo.lastNotifiedAt + OVERDUE_REPEAT_MS);
  }
  return wake;
}

export function reminderBody(todo: Todo, now: number): string {
  if (todo.deadline !== undefined && todo.deadline < now) {
    return `Still open: ${todo.text}`;
  }
  return todo.text;
}
