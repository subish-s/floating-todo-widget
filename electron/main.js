'use strict';

/**
 * Electron main process - hosts the floating widget on the desktop.
 *
 * The window is frameless, transparent and always on top, sized to exactly what
 * the widget is showing and parked above the taskbar. The renderer is a Next.js
 * static export loaded straight off disk over file://, so the app needs no web
 * server and no network access at all.
 *
 * There is deliberately no click-through logic here. The obvious approach -
 * setIgnoreMouseEvents plus a hit test to turn it back on - cannot work: while a
 * window ignores mouse events none are delivered to it, and under Wayland /
 * XWayland screen.getCursorScreenPoint() only refreshes while the pointer is
 * already over one of our windows. The result is a widget that can never be
 * clicked again. Sizing the window to its contents avoids the problem instead of
 * working around it: there is no empty region left to click through.
 */
const fs = require('node:fs');
const path = require('node:path');
const { TodoStore } = require('./store');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  Notification,
  screen,
} = require('electron');

/**
 * Width used only until the renderer reports the real one.
 *
 * The visible column is much narrower than the panel. Keeping a fixed 340px
 * window and centring the column in it left transparent gutters on both sides,
 * and the desktop will not place a window past the work area, so those gutters
 * stopped the character short of the left and right edges. The corners were the
 * obvious place it showed: the window could sit flush, and the character still
 * could not. The window now hugs whatever is actually visible.
 */
const WINDOW_WIDTH = 340;
/** Narrower than the character, so a real measurement is never rejected. */
const MIN_WINDOW_WIDTH = 120;
/** The 300px panel plus the horizontal padding the renderer adds around it. */
const MAX_WINDOW_WIDTH = 360;
/** Just the character and the icons; a panel grows this downwards. */
const WINDOW_HEIGHT = 176;
/**
 * Tallest the window ever gets: the base plus the tallest panel (170px).
 *
 * This is a ceiling and nothing more. It is deliberately *not* a margin that
 * positions the widget - an earlier version used it as a bottom clearance, which
 * parked the widget 164px above the taskbar and made the bottom edge and bottom
 * corners unreachable.
 */
const MAX_WINDOW_HEIGHT = 340;
/**
 * How close a released drag has to be to an edge, a corner or a centre line
 * before it snaps to it. Wide enough to hit deliberately, tight enough that a
 * position the user chose away from the grid survives.
 */
const SNAP_THRESHOLD_PX = 28;

const INDEX_FILE = path.join(__dirname, '..', 'dist', 'index.html');
const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.png');
/** Where the widget was left, so it reopens where the user put it. */
const POSITION_FILE = () => path.join(app.getPath('userData'), 'widget-position.json');
let todoStore = null;
function getTodoStore() {
  if (!todoStore) todoStore = new TodoStore(app.getPath('userData'));
  return todoStore;
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;

/** Last size the renderer asked for, so we only resize when it really moved. */
let contentHeight = WINDOW_HEIGHT;
let contentWidth = WINDOW_WIDTH;

/**
 * What the optional panels currently hold, reported by the renderer.
 *
 * The tray menu lists the same options the toolbar does, and the toolbar only
 * offers history and reminders when they have something in them. The renderer
 * owns that state, so it is pushed across rather than re-derived here.
 */
let optionCounts = { history: 0, reminders: 0 };

/**
 * The height the widget actually occupies with no panel open.
 *
 * The renderer reports the real laid-out height, which is a little taller than
 * the WINDOW_HEIGHT nominal used to create the window before the first report
 * arrives. Tracking the smallest height seen gives the true collapsed height,
 * which is what the widget should be anchored and saved against.
 */
let collapsedHeight = MAX_WINDOW_HEIGHT;
/**
 * The width with no panel open. Starts at the ceiling so the first real
 * measurement, which is the collapsed column, becomes the resting width.
 */
let collapsedWidth = MAX_WINDOW_WIDTH;

// A widget is not a document: closing the window would leave nothing able to
// bring it back, so the close button is suppressed and quitting goes through
// the tray menu or the widget's own right-click menu.
let quitting = false;

/** @type {{ x: number, y: number } | null} */
let savedPosition = null;
/**
 * Set for the duration of a drag, holding the bounds to settle back to. It is
 * null when no drag is in progress. The window is never resized mid-drag: a
 * resize under the pointer is what used to make the widget lurch and made the
 * lean direction read backwards.
 */
let dragRestore = null;

/**
 * Newest drag point that has not been applied yet. Pointer events can arrive
 * faster than the window manager can place the window, and applying every one
 * in order makes a fast drag walk a backlog of stale points. Keeping only the
 * latest point means a slow drag still moves on each event, and a fast drag
 * stays on the cursor.
 * @type {{ x: number, y: number } | null}
 */
let pendingDragMove = null;
let dragMoveQueued = false;

function flushDragMove() {
  dragMoveQueued = false;
  const target = pendingDragMove;
  pendingDragMove = null;
  if (!target || !mainWindow || mainWindow.isDestroyed() || !dragRestore) return;
  mainWindow.setPosition(target.x, target.y);
}

/** True while a drag is in progress, so content height updates stand down. */
function isDragging() {
  return dragRestore !== null;
}

function loadSavedPosition() {
  try {
    const saved = JSON.parse(fs.readFileSync(POSITION_FILE(), 'utf8'));
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
      savedPosition = { x: Math.round(saved.x), y: Math.round(saved.y) };
    }
  } catch {
    // First run, or nothing saved yet. The default placement is fine.
  }
}

function savePosition(position) {
  savedPosition = position;
  try {
    fs.mkdirSync(path.dirname(POSITION_FILE()), { recursive: true });
    fs.writeFileSync(POSITION_FILE(), JSON.stringify(position));
  } catch {
    // An unwritable profile just means it reopens in the default spot.
  }
}

/**
 * The work area of the display the window belongs to.
 *
 * The display is picked from the window's own centre point, and every bound used
 * from here on is relative to that display's origin rather than to 0,0. A
 * secondary monitor at a negative origin, a different resolution, or any other
 * offset is therefore handled by construction instead of by special-casing.
 */
function workAreaFor(x, y, width, height) {
  return screen.getDisplayNearestPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
  }).workArea;
}

function clamp(value, low, high) {
  return Math.round(Math.min(Math.max(value, low), Math.max(low, high)));
}

/**
 * Keep the whole window on some display, whatever the user dragged it onto.
 *
 * Both ends are inclusive of the edges: `area.x` is a legal left edge and
 * `area.x + area.width - width` a legal right edge, so a window can sit flush
 * against any edge of any display. `Math.max(low, high)` covers a display whose
 * work area is smaller than the window, which pins it to the near edge instead
 * of producing an inverted range.
 */
function clampToWorkArea(x, y, width, height) {
  const area = workAreaFor(x, y, width, height);
  return {
    x: clamp(x, area.x, area.x + area.width - width),
    y: clamp(y, area.y, area.y + area.height - height),
  };
}

/** The edge, centre line, or free position nearest to `value`. */
function nearestSnap(value, candidates) {
  let best = value;
  let bestDistance = SNAP_THRESHOLD_PX;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return Math.round(best);
}

/**
 * Pull a released position onto the nearest edge, corner or centre line.
 *
 * Each axis snaps independently against the same three candidates, which is what
 * makes all nine positions reachable: the four corners are left/right crossed
 * with top/bottom, the four edge midpoints are one snapped axis and one free
 * axis, and the centre is both. Treating the axes the same way is what makes
 * snapping behave consistently on every edge instead of only on the sides.
 *
 * A candidate has to be within SNAP_THRESHOLD_PX to win, so a position chosen
 * away from the grid is left exactly where it was put.
 */
function snapToWorkArea(x, y, width, height) {
  const area = workAreaFor(x, y, width, height);
  return {
    x: nearestSnap(x, [
      area.x,
      area.x + (area.width - width) / 2,
      area.x + area.width - width,
    ]),
    y: nearestSnap(y, [
      area.y,
      area.y + (area.height - height) / 2,
      area.y + area.height - height,
    ]),
  };
}

/** Bottom-right of the display the pointer is on, flush to both edges. */
function defaultPlacement(width, height) {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return {
    x: Math.round(area.x + area.width - width),
    y: Math.round(area.y + area.height - height),
  };
}

/** Where the user left it, or the default spot on the display under the pointer. */
function placementForDisplay(width, height) {
  if (!savedPosition) return defaultPlacement(width, height);
  return clampToWorkArea(savedPosition.x, savedPosition.y, width, height);
}

/**
 * Which edge the widget is currently growing from, or null while it is collapsed.
 *
 * Set when a panel opens and cleared when it closes. Remembering the choice is
 * what makes opening and closing exactly symmetrical: re-deciding on the way
 * down can pick the other edge and leave the widget somewhere new.
 */
let anchoredEdge = null;
/**
 * Which side the extra panel width grows away from, remembered for the same
 * reason as `anchoredEdge`: re-deciding while the panel closes can pick the
 * other side and leave a corner widget inset from the edge it was on.
 *
 * Null while the window is the collapsed column. 'center' holds the midpoint
 * when the widget is not against either side.
 *
 * @type {'left' | 'right' | 'center' | null}
 */
let anchoredSide = null;
/** Last side sent to the renderer. Repeating it restarts layout for nothing. */
let publishedSide = null;

/**
 * Where the widget's top edge belongs when its height changes to `to`.
 *
 * With no panel open there is a free choice, and the widget grows away from the
 * edge it is nearest: downwards from the top of the screen, upwards from the
 * bottom, and downwards in the middle where there is room. Pinning a single edge
 * made a widget at the top of the screen jump when a panel opened and refuse to
 * come back.
 */
function resolveAnchor(bounds, to, holdTop) {
  if (holdTop) return { y: bounds.y, edge: 'top' };
  if (anchoredEdge) {
    return {
      y: anchoredEdge === 'top' ? bounds.y : bounds.y + bounds.height - to,
      edge: anchoredEdge,
    };
  }
  const area = workAreaFor(bounds.x, bounds.y, bounds.width, to);
  const roomBelow = area.y + area.height - (bounds.y + bounds.height);
  const edge = to > bounds.height && roomBelow < to - bounds.height ? 'bottom' : 'top';
  return { y: edge === 'top' ? bounds.y : bounds.y + bounds.height - to, edge };
}

/**
 * Which horizontal edge the window is sitting on, or 'center' when it is not.
 *
 * Distances are measured from the window's own edges. A negative distance means
 * the window is already past that edge and still counts as touching it, which
 * is how a corner reached during a drag stays a corner once the column narrows.
 */
function sideForPosition(x, width) {
  const area = workAreaFor(x, 0, width, Math.max(contentHeight, 1));
  const leftDist = x - area.x;
  const rightDist = area.x + area.width - width - x;
  if (leftDist <= SNAP_THRESHOLD_PX && leftDist <= rightDist) return 'left';
  if (rightDist <= SNAP_THRESHOLD_PX) return 'right';
  return 'center';
}

/**
 * Which edge to hold while the width changes.
 *
 * A panel is wider than the column. Holding the edge the widget is already
 * against keeps a corner cornered: the extra width grows back onto the screen,
 * and closing the panel returns the column to that same edge. Away from either
 * side the centre is held, so the character does not slide sideways.
 */
function resolveSide(bounds, toWidth) {
  if (anchoredSide) return anchoredSide;
  const detected = sideForPosition(bounds.x, bounds.width);
  if (detected !== 'center') return detected;
  const area = workAreaFor(bounds.x, bounds.y, toWidth, bounds.height);
  const centered = bounds.x + (bounds.width - toWidth) / 2;
  if (centered < area.x) return 'left';
  if (centered > area.x + area.width - toWidth) return 'right';
  return 'center';
}

/** Left edge of a window whose width is changing, for the side being held. */
function resolveX(bounds, toWidth, side) {
  if (side === 'left') return bounds.x;
  if (side === 'right') return bounds.x + bounds.width - toWidth;
  return bounds.x + (bounds.width - toWidth) / 2;
}

/**
 * Tell the renderer which side the column should sit on.
 *
 * The panel is centred on the column. Against a side that would push half the
 * panel off the screen and drag the character back off the edge, so the column
 * and the panel are aligned to the outer edge instead and the spare width stays
 * inboard. The message is skipped when the side has not changed.
 */
function publishSide(side) {
  if (side === publishedSide) return;
  publishedSide = side;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('widget:horizontal-edge', side);
}

/** Resize around the anchored edges, so the character stays put. */
function applyContentBox(width, height) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const nextH = clamp(height, WINDOW_HEIGHT, MAX_WINDOW_HEIGHT);
  const nextW = clamp(width, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH);
  if (nextH === contentHeight && nextW === contentWidth) return;
  const bounds = mainWindow.getBounds();
  // The very first report only corrects the nominal height the window was
  // created with, so the top edge is held: anchoring the bottom there would lift
  // the widget by the difference between the nominal and real collapsed height,
  // and repeated restarts would ratchet it up a pixel at a time.
  const firstMeasurement = collapsedHeight === MAX_WINDOW_HEIGHT;
  const { y: anchoredY, edge } = resolveAnchor(bounds, nextH, firstMeasurement);
  const side = resolveSide(bounds, nextW);
  const anchoredX = resolveX(bounds, nextW, side);
  contentHeight = nextH;
  contentWidth = nextW;
  if (contentHeight < collapsedHeight) collapsedHeight = contentHeight;
  if (contentWidth < collapsedWidth) collapsedWidth = contentWidth;
  // An edge only matters while a panel makes the window larger than the column.
  anchoredEdge = contentHeight > collapsedHeight ? edge : null;
  anchoredSide = contentWidth > collapsedWidth ? side : null;
  const settled = clampToWorkArea(anchoredX, anchoredY, contentWidth, contentHeight);
  publishSide(side);
  mainWindow.setBounds({
    x: settled.x,
    y: settled.y,
    width: contentWidth,
    height: contentHeight,
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...placementForDisplay(WINDOW_WIDTH, WINDOW_HEIGHT),
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minHeight: WINDOW_HEIGHT,
    maxHeight: MAX_WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    /*
     * A tool window, not a normal application window.
     *
     * As _NET_WM_WINDOW_TYPE_NORMAL the widget is collected by the desktop's
     * window list, so it shows up in the task switcher and in recent
     * applications as though it were a program the user had opened. A tool
     * window is a desktop widget as far as the shell is concerned and is
     * skipped by both, while still being draggable, clickable and focusable.
     *
     * `focusable` is stated explicitly because tool windows are allowed to
     * refuse focus, and the create panel's text input depends on being able to
     * take it.
     */
    type: 'toolbar',
    focusable: true,
    // Focusable so Escape reaches the widget, but simply showing it must never
    // pull focus away from whatever the user is actually doing.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // Stay above other windows, including fullscreen ones.
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
  });

  // Hiding unmaps the window but leaves the page visible to Chromium, so
  // `document.hidden` never changes and a renderer loop keyed off it would keep
  // running against a window nobody can see. Report visibility explicitly.
  const reportVisibility = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('widget:visibility', mainWindow.isVisible());
    // The show/hide entry is one label, so it has to be rebuilt as the state flips.
    refreshTrayMenu();
  };
  mainWindow.on('show', reportVisibility);
  mainWindow.on('hide', reportVisibility);
  mainWindow.webContents.on('did-finish-load', reportVisibility);

  mainWindow.loadFile(INDEX_FILE);
}

/** Record where the widget is now, so it reopens there even after a crash. */
function rememberPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  // Persist the spot the widget rests at when collapsed, not wherever a
  // temporarily taller panel happened to push it. Without this, quitting with a
  // panel open would save a mid-screen Y and the widget would reappear there
  // instead of returning to its edge. Collapsing through the same anchoring used
  // when the panel opened means the saved Y is exactly where the widget will
  // sit again, so repeated restarts do not drift.
  const restingY = resolveAnchor(bounds, collapsedHeight, false).y;
  const restingX = resolveX(bounds, collapsedWidth, resolveSide(bounds, collapsedWidth));
  savePosition(clampToWorkArea(restingX, restingY, collapsedWidth, collapsedHeight));
}

/**
 * Bring the widget back.
 *
 * Only the window is shown: the process, its timers and the tray icon were never
 * touched, so reminders, task data and the saved position are exactly as they
 * were left.
 */
function revealWidget() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { x, y } = placementForDisplay(contentWidth, contentHeight);
  mainWindow.setBounds({ x, y, width: contentWidth, height: contentHeight });
  mainWindow.show();
}

/**
 * Hide only the widget.
 *
 * This is `hide()` and not `close()` or `quit()`: the process stays alive, so
 * deadline reminders keep firing and the tray icon stays available to bring the
 * widget back. Hiding is therefore always reversible and never loses state.
 */
function hideWidget() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  rememberPosition();
  mainWindow.hide();
}

/** Forget the saved spot and go back to the default corner of this display. */
function recentreWidget() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  savedPosition = null;
  try {
    fs.rmSync(POSITION_FILE(), { force: true });
  } catch {
    // Nothing to clear is not a problem.
  }
  revealWidget();
}

/**
 * Show one of the widget's own panels from the tray.
 *
 * The window is revealed first when it is hidden: the tray is the only way back
 * to a hidden widget, so a panel that opened onto an unmapped window would
 * look like the click did nothing.
 */
function openPanel(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) revealWidget();
  mainWindow.webContents.send('widget:open-panel', mode);
}

const isWidgetVisible = () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());

/**
 * The tray menu, and the widget's own options in one place.
 *
 * The options mirror the toolbar, so anything reachable by clicking the widget
 * is reachable from the tray, which is what makes the tray useful once the
 * widget itself is hidden.
 *
 * Show and hide share a single entry. Two fixed entries would leave one of them
 * permanently a no-op, and which one is a lie the moment the widget changes
 * state. The label follows the window instead, and keeps the word "Widget" so
 * the entry says what it acts on.
 */
function buildMenu() {
  const visible = isWidgetVisible();
  const count = (n, word) => (n > 0 ? `${n} ${word}${n === 1 ? '' : 's'}` : '');

  return Menu.buildFromTemplate([
    {
      label: 'New task',
      click: () => openPanel('create'),
    },
    {
      label: 'Tasks',
      click: () => openPanel('todo'),
    },
    {
      label: ['Recently completed', count(optionCounts.history, 'task')].filter(Boolean).join(', '),
      click: () => openPanel('hidden'),
    },
    {
      label: ['Reminders', count(optionCounts.reminders, 'due')].filter(Boolean).join(', '),
      click: () => openPanel('notifications'),
    },
    { type: 'separator' },
    {
      label: visible ? 'Hide Widget' : 'Show Widget',
      click: visible ? hideWidget : revealWidget,
    },
    {
      label: 'Recentre',
      click: recentreWidget,
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

/**
 * Reinstall the tray menu after something it displays has changed.
 *
 * A tray context menu is a snapshot, so a label that has to follow window
 * visibility or panel counts is only correct until the next rebuild.
 */
function refreshTrayMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
}

function createTray() {
  let image = nativeImage.createFromPath(TRAY_ICON);
  // A desktop without a system tray is fine; the right-click menu still quits.
  if (image.isEmpty()) return;
  image = image.resize({ width: 22, height: 22 });
  tray = new Tray(image);
  tray.setToolTip('Floating widget');
  tray.setContextMenu(buildMenu());
  // Left-click opens the menu rather than toggling the window. A bare click that
  // only hid or showed the widget meant the options were two clicks away and
  // the icon behaved like a switch, which is not what a menu-bearing tray icon
  // is expected to do. Show and hide are still one click away, inside the menu.
  tray.on('click', () => {
    if (!tray || tray.isDestroyed()) return;
    tray.popUpContextMenu();
  });
}

app.setAppUserModelId('com.taskminion.floatingwidget');

/**
 * The widget never scrolls, never plays video and never talks to the network,
 * so Chromium's occlusion tracking is pure overhead here: it polls the window
 * manager about a window that is deliberately always on top of everything and
 * can therefore never become occluded. Turning it off removes that polling from
 * every frame. Must be set before the app is ready.
 */
app.commandLine.appendSwitch(
  'disable-features',
  'CalculateNativeWinOcclusion',
);

/**
 * Software compositing, on purpose.
 *
 * With GPU compositing the widget's 24 fps animation does not actually run at
 * 24 fps on this machine. The GPU process cannot get vsync parameters from this
 * X11/Wayland session - it logs `GetVSyncParametersIfAvailable() failed` on
 * every launch - and when it cannot, the display compositor stops driving
 * frames for the always-on-top, tool-typed window. The renderer's whole task
 * queue is aligned to that frame clock, so it starves: measured on screen, the
 * character animated at 1.8 fps in bursts separated by five-second freezes, and
 * `requestAnimationFrame` fired 1.3 times a second. Under `--no-sandbox`, which
 * is how the service has to launch Electron here, it was worse still, and the
 * GPU process is what breaks either way.
 *
 * Turning acceleration off removes the dependency entirely: with software
 * compositing the widget holds 24.1 fps with a worst-case frame gap of 51 ms,
 * and idle CPU drops from 20.5% to 16.6% of one core, because the compositor is
 * no longer copying and presenting a surface nothing else can see. The cost is
 * about 30 MB more resident: the blit itself is 0.1 ms, so a 264x264 drawImage
 * at 24 fps is roughly 2.4 ms of CPU per second - far cheaper than a stalled
 * frame clock. Must be set before the app is ready.
 */
app.disableHardwareAcceleration();

/**
 * One widget, one tray icon.
 *
 * The service supervises this process, and a stray manual launch would otherwise
 * put a second widget and a second tray icon on the desktop. The second copy
 * exits immediately; the copy that already holds the lock simply reveals itself.
 *
 * This is checked before any lifecycle wiring so a losing copy never creates a
 * window or a tray at all.
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', revealWidget);

  app.whenReady().then(() => {
    loadSavedPosition();
    createWindow();
    createTray();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    quitting = true;
    rememberPosition();
  });

  // `systemctl --user stop` and a Ctrl-C in a terminal both arrive as a signal.
  // Electron's default reaction to SIGTERM is immediate termination, which skips
  // 'before-quit' and loses the saved position. Routing the signal through
  // app.quit() makes an orderly stop behave the same as choosing Exit.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => app.quit());
  }
}

ipcMain.on('widget:content-box', (event, box) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  // Mid-drag the pointer is driving the position; resizing under it would make
  // the widget lurch, so size updates are ignored until the drag settles.
  if (isDragging()) return;
  applyContentBox(Number(box?.width) || 0, Number(box?.height) || WINDOW_HEIGHT);
});

ipcMain.handle('widget:load-todos', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null;
  return getTodoStore().loadActiveTodos();
});

ipcMain.handle('widget:archive-todos', (event, todos) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !Array.isArray(todos)) return false;
  return getTodoStore().archiveTodos(todos);
});

ipcMain.handle('widget:save-todos', (event, todos) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !Array.isArray(todos)) return false;
  return getTodoStore().saveActiveTodos(todos);
});

ipcMain.handle('widget:drag-begin', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null;
  const bounds = mainWindow.getBounds();
  dragRestore = bounds;
  return { originX: bounds.x, originY: bounds.y };
});

ipcMain.on('widget:drag-move', (event, position) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !dragRestore) return;
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
  pendingDragMove = { x: Math.round(position.x), y: Math.round(position.y) };
  if (dragMoveQueued) return;
  dragMoveQueued = true;
  setImmediate(flushDragMove);
});

ipcMain.handle('widget:drag-end', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !dragRestore) return;
  // Apply the cursor's last point before snapping, so a move still waiting on
  // the event loop is not dropped when the drag ends.
  if (pendingDragMove && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setPosition(pendingDragMove.x, pendingDragMove.y);
  }
  pendingDragMove = null;
  dragMoveQueued = false;
  const previous = dragRestore;
  dragRestore = null;
  contentHeight = previous.height;
  const bounds = mainWindow.getBounds();
  // Snap first, then clamp: snapping picks the edge the user was aiming at, and
  // clamping afterwards only guarantees the result is on a display. Doing it the
  // other way round would let the clamp pull a corner snap back off the edge.
  const width = bounds.width;
  const snapped = snapToWorkArea(bounds.x, bounds.y, width, previous.height);
  const settled = clampToWorkArea(snapped.x, snapped.y, width, previous.height);
  if (
    bounds.x !== settled.x ||
    bounds.y !== settled.y ||
    bounds.width !== width ||
    bounds.height !== previous.height
  ) {
    mainWindow.setBounds({ ...settled, width, height: previous.height });
  }
  contentWidth = width;
  // A drag can move an open panel from the middle onto a corner. Remembering
  // the side here is what makes closing that panel return to the corner instead
  // of to the centre the panel was opened on.
  const side = sideForPosition(settled.x, width);
  if (width > collapsedWidth) anchoredSide = side;
  publishSide(side);
  savePosition(settled);
});

ipcMain.on('widget:notify', (event, payload) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  if (!Notification.isSupported()) return;
  const title = String(payload?.title ?? 'Task due');
  const body = String(payload?.body ?? '');
  const note = new Notification({ title, body });
  note.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });
  note.show();
});

ipcMain.on('widget:context-menu', (event, position) => {
  if (!mainWindow) return;
  buildMenu().popup({
    window: mainWindow,
    x: Math.round(position?.x ?? 0),
    y: Math.round(position?.y ?? 0),
  });
});

ipcMain.on('widget:options', (event, counts) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const next = {
    history: Math.max(0, Math.round(Number(counts?.history) || 0)),
    reminders: Math.max(0, Math.round(Number(counts?.reminders) || 0)),
  };
  if (next.history === optionCounts.history && next.reminders === optionCounts.reminders) return;
  optionCounts = next;
  refreshTrayMenu();
});
