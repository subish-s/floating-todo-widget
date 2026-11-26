export type Todo = {
  id: number;
  text: string;
  completed: boolean;
  /** When the task was added. */
  createdAt?: number;
  /** When the task is due. Reminders fire at this instant, never on create. */
  deadline?: number;
  /** Last OS/in-app reminder for this task. Absent until the deadline hits. */
  lastNotifiedAt?: number;
  /** When a completed task was hidden from the active checklist. */
  hiddenAt?: number;
};

export function isTodo(entry: unknown): entry is Todo {
  if (!entry || typeof entry !== 'object') return false;
  const todo = entry as Record<string, unknown>;
  if (typeof todo.id !== 'number' || typeof todo.text !== 'string') return false;
  if (typeof todo.completed !== 'boolean') return false;
  if (todo.createdAt !== undefined && typeof todo.createdAt !== 'number') return false;
  if (todo.deadline !== undefined && typeof todo.deadline !== 'number') return false;
  if (todo.lastNotifiedAt !== undefined && typeof todo.lastNotifiedAt !== 'number') {
    return false;
  }
  if (todo.hiddenAt !== undefined && typeof todo.hiddenAt !== 'number') return false;
  return true;
}
