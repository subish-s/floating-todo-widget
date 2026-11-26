'use strict';

/**
 * Preload - the only surface the renderer gets.
 *
 * No Node, no `ipcRenderer`, no remote module: just the one call the widget
 * needs to behave like a real desktop overlay.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  /**
   * How big the visible widget currently is, in CSS pixels.
   *
   * The window is resized to match, so the transparent regions never exist and
   * there is nothing for a click to be swallowed by. Width as well as height:
   * a window wider than the column cannot be dragged until the column itself
   * reaches the left and right edges.
   */
  setContentBox(size) {
    ipcRenderer.send('widget:content-box', {
      width: Math.max(0, Math.round(Number(size?.width) || 0)),
      height: Math.max(0, Math.round(Number(size?.height) || 0)),
    });
  },

  /**
   * Which screen edge the column should sit against.
   *
   * 'left' and 'right' align the column and its panel to that edge so a corner
   * stays a corner when a panel opens. 'center' is everywhere else. Returns an
   * unsubscribe function.
   */
  onHorizontalEdge(callback) {
    const listener = (_event, side) => callback(String(side ?? 'center'));
    ipcRenderer.on('widget:horizontal-edge', listener);
    return () => ipcRenderer.removeListener('widget:horizontal-edge', listener);
  },

  /** The window's starting position, used to follow screen-coordinate movement. */
  beginDrag: () => ipcRenderer.invoke('widget:drag-begin'),

  moveDrag(position) {
    ipcRenderer.send('widget:drag-move', {
      x: Math.round(position?.x ?? 0),
      y: Math.round(position?.y ?? 0),
    });
  },

  endDrag: () => ipcRenderer.invoke('widget:drag-end'),

  loadTodos: () => ipcRenderer.invoke('widget:load-todos'),

  archiveTodos: (todos) => ipcRenderer.invoke('widget:archive-todos', todos),

  saveTodos: (todos) => ipcRenderer.invoke('widget:save-todos', todos),

  /** Right-click menu, so the widget can always be quit or recentred. */
  showContextMenu(position) {
    ipcRenderer.send('widget:context-menu', {
      x: Math.round(position?.x ?? 0),
      y: Math.round(position?.y ?? 0),
    });
  },

  notify(payload) {
    ipcRenderer.send('widget:notify', {
      title: String(payload?.title ?? ''),
      body: String(payload?.body ?? ''),
    });
  },

  /**
   * Whether the window is currently on screen.
   *
   * `win.hide()` unmaps the window without making the page hidden, so
   * `document.hidden` stays false and the animation loop would keep running
   * against a window nobody can see. The main process is the authority here.
   * Returns an unsubscribe function.
   */
  onVisibility(callback) {
    const listener = (_event, visible) => callback(Boolean(visible));
    ipcRenderer.on('widget:visibility', listener);
    return () => ipcRenderer.removeListener('widget:visibility', listener);
  },

  /**
   * Which optional panels currently have something in them.
   *
   * The renderer owns this state, and the tray menu has to mirror it, so the
   * counts are pushed across whenever they change instead of the main process
   * re-reading `output.json` and guessing what the widget is showing.
   */
  reportOptions(counts) {
    ipcRenderer.send('widget:options', {
      history: Math.max(0, Math.round(Number(counts?.history) || 0)),
      reminders: Math.max(0, Math.round(Number(counts?.reminders) || 0)),
    });
  },

  /**
   * Open one of the widget's own panels, chosen from the tray menu.
   *
   * The main process reveals the window first when it is hidden, so the panel
   * is never opened onto something nobody can see. Returns an unsubscribe
   * function.
   */
  onOpenPanel(callback) {
    const listener = (_event, mode) => callback(String(mode ?? ''));
    ipcRenderer.on('widget:open-panel', listener);
    return () => ipcRenderer.removeListener('widget:open-panel', listener);
  },
});
