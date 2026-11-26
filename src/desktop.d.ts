import type { Todo } from './todos/types';

export type DesktopBridge = {
  setContentBox: (size: { width: number; height: number }) => void;
  /** 'left' | 'right' | 'center'. Returns an unsubscribe function. */
  onHorizontalEdge: (callback: (side: string) => void) => () => void;
  beginDrag: () => Promise<{ originX: number; originY: number } | null>;
  moveDrag: (position: { x: number; y: number }) => void;
  endDrag: () => Promise<void>;
  loadTodos: () => Promise<Todo[] | null>;
  archiveTodos: (todos: readonly Todo[]) => Promise<boolean>;
  saveTodos: (todos: readonly Todo[]) => Promise<boolean>;
  showContextMenu: (position: { x: number; y: number }) => void;
  notify: (payload: { title: string; body: string }) => void;
  /** Reports window visibility; returns an unsubscribe function. */
  onVisibility: (callback: (visible: boolean) => void) => () => void;
  /** Reports how many tasks the optional panels hold, so the tray can mirror them. */
  reportOptions: (counts: { history: number; reminders: number }) => void;
  /** Opens a widget panel chosen from the tray menu; returns an unsubscribe function. */
  onOpenPanel: (callback: (mode: string) => void) => () => void;
};

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export {};
