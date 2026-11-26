# Floating to-do widget

A lightweight desktop to-do widget with an animated assistant. It is a desktop
app and nothing else: there is no website, no dev server, and no external
database. Tasks are persisted in Electron's main process (`electron/store.js`)
to `tasks.v1.json` in the user-data folder using atomic temp-file writes, a
rolling `.bak` recovery snapshot, and automatic migration from legacy
`output.json` or `localStorage`.

## How to run

Needs **Node.js 20+**. From this folder:

```bash
npm install
npm run widget
```

`widget` builds the renderer and launches the app. Quit from the tray icon or by
right-clicking the widget.

To relaunch without rebuilding:

```bash
npm run widget:start
```

While working on the renderer, rebuild on every save and skip the relaunch:

```bash
npm run watch
```

### Typecheck

```bash
npm run typecheck
```

## Running it at login

`to_do_list.service` is a systemd **user** service that starts the widget with
your desktop session and keeps it running.

```bash
systemctl --user daemon-reload
systemctl --user enable --now to_do_list.service   # start now and at every login
```

Copy the unit to `~/.config/systemd/user/` first if it is not there already:

```bash
cp to_do_list.service ~/.config/systemd/user/
```

| | |
|---|---|
| Autostart | `WantedBy=graphical-session.target`, so it starts with the desktop rather than at boot, when there is a display to draw on |
| Crash recovery | `Restart=on-failure`, 2 s apart. A crash is a signal or non-zero exit and is restarted. |
| Deliberate exit | **Not** restarted. `Restart=on-failure` plus `SuccessExitStatus=0` means choosing **Exit** from the tray, or `systemctl --user stop`, stays stopped. `Restart=always` would bring the widget straight back and make it impossible to close. |
| Duplicates | The app takes a single-instance lock, so a stray manual launch reveals the running widget instead of adding a second one |
| Stopping | `systemctl --user stop` sends `SIGTERM`, which the app turns into an orderly quit so the position is saved |
| Supervision | `ExecStart` runs the real Electron binary rather than an `npm run` wrapper: one process instead of three, and systemd signals the widget itself |

The unit runs Electron with `--no-sandbox`. On this machine Chromium has no
sandbox available: the npm-installed `chrome-sandbox` helper is not `root:root
4755`, and AppArmor blocks unprivileged user namespaces for a binary that has no
profile, which a systemd-launched service does not have. The proper fix needs
root and is documented in the unit file:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Doing that lets you drop `--no-sandbox`. Until then the exposure is small: the
renderer loads one local file with `contextIsolation` on, `nodeIntegration` off
and no remote content. Running from a terminal is unaffected and does use the
namespace sandbox.

## Layout

| Path | What it is |
|------|------------|
| `electron/main.js` | Main process: the transparent always-on-top window, tray, menus, notifications and the task mirror on disk |
| `electron/preload.js` | The only bridge the renderer gets. No Node, no `ipcRenderer`, no remote |
| `src/main.tsx` | Renderer entry point - the widget is the whole app |
| `src/components/` | The toolbar, its panels, the character and the icons |
| `src/character/` | Animation catalogue, frame cache, frame pacer and the canvas player |
| `src/todos/` | Reminder scheduling |
| `public/character/animations/` | The animation clips, as webp frames |
| `src/character/framePacer.ts` | Worker-based frame clock, independent of the compositor |
| `assets/tray.png` | Tray icon |
| `to_do_list.service` | systemd user unit for autostart and crash recovery |
| `build.mjs` | The asset build |
| `dist/` | Build output: `index.html`, `renderer.js`, `renderer.css`, `character/` |

## The build

One JSX entry point and one stylesheet, bundled by **esbuild** into a flat
`dist/` that Electron loads over `file://`. There is no framework toolchain, no
router and no server-rendered markup.

| | |
|---|---|
| Renderer bundle | 208 KiB minified (React + the widget) |
| Stylesheet | 9 KiB |
| Build time | ~80 ms |

esbuild targets `chrome130`, the Chromium that ships with the pinned Electron,
so no legacy transpilation is emitted for browsers this app can never run in.

## Using it

### Tray menu

Left-click or right-click the tray icon for the same menu:

| Item | What it does |
|------|--------------|
| **New task** | Opens the create panel, same as the toolbar's Create button |
| **Tasks** | Opens the checklist, same as the toolbar's Tasks button |
| **Recently completed**, with a count | Opens the history panel |
| **Reminders**, with a count | Opens the deadline panel |
| **Hide Widget** / **Show Widget** | One entry that follows the window: it reads *Hide Widget* while the widget is on screen and *Show Widget* while it is hidden, and its action matches. Two fixed entries would leave one permanently a no-op and get the label wrong the moment the state changed |
| **Recentre** | Returns the widget to the default spot, bottom-right of the display, and forgets the saved position |
| **Exit** | Quits for real. Under systemd the service stays stopped rather than restarting |

The options mirror the toolbar, so anything reachable by clicking the widget is
reachable from the tray. That matters most when the widget is hidden, because
the tray is then the only way back to it: choosing an option reveals the window
and opens that panel, rather than opening a panel onto a window nobody can see.

The counts come from the renderer, which owns the task list, and are pushed
across whenever they change. A tray context menu is a snapshot, so the menu is
rebuilt when the window is shown or hidden and when those counts move.

Clicking the icon does not toggle the window. It opens this menu, so the options
are one click away rather than hidden behind a bare hide/show switch; show and
hide are still a single click once the menu is up.

The same items are on the widget's own right-click menu.

### Positioning

The widget can sit anywhere, and snaps flush to a screen edge when you let go
within 28 px of one. Corners snap on both axes; a single edge snaps only that
axis, so dropping the widget near the top of the screen leaves its horizontal
position alone. Releasing further away than the threshold leaves it exactly
where you dropped it. Dragging past an edge parks it on that edge rather than
half off-screen.

The window is only as wide as the character and the icons (and as wide as the
panel while one is open). That is what lets the character itself reach the left
and right edges, including the four corners. A fixed window wider than the
column could sit flush while the character stayed inset, and the desktop will
not let the window hang off the screen to make up the difference. A panel
opened on the left or right grows inward, so the character stays on that edge.

Positions are measured against the **work area** of the display the widget is
on, so a panel or menu bar is never covered, and coordinates are relative to
that display's origin, so a monitor to the left of the primary one (negative
coordinates) works. The first run puts it in the bottom-right corner.

Opening a panel grows the widget away from the edge it is nearest and closing it
puts it back exactly where it was, so the widget never drifts as you use it.

### Tasks

New tasks are added to the **bottom** of the list, oldest first, and stay in that
order across restarts. Completing a task moves it to the history panel, which is
also oldest first.

- **Create** - stage tasks one at a time with **Add task**, set an optional due date/time for each, then commit nonblank rows together with **Add all**.
- **Tasks** - completing a task hides it from the active checklist. The history panel keeps it undoable for 24 hours; restore returns it unchecked. After 24 hours it is archived as an `archiveOnly` entry in Electron's `tasks.v1.json` store. Each trash button deletes only its own task.
- **Reminders** - the bell appears only when a deadline has *arrived* and the task is still open. It does **not** appear when you save a future due date.

The history panel is marked with a history icon: an eye says "look at this", but
what the panel offers is "go back in time to this" - the row is stamped with when
it was done and carries an undo. It carries no counter, so the pill does not
change width as tasks come and go. The bell keeps its count, because how many
things are overdue is the one number worth reading at a glance.

### Reading a long task

The task list is a two-column grid inside a 300px panel, so a long task does not
fit: the checklist and history clamp it to two lines and the reminder list
ellipsises it on one. Whatever the panel had to cut is given back on hover - put
the cursor on the row and the whole task appears.

The tooltip only appears when text was actually clipped, so a task you can read
in full behaves like normal text and nothing pops up under the cursor. It is the
same native tooltip the delete and undo buttons use, which also means the desktop
draws it: a popup inside the panel would be swallowed by the list's
`overflow-y: auto`, the panel, and the 340px window.


## Notifications

Creating a task never notifies, even if you attach a deadline.

| When | What happens |
|------|----------------|
| Save a task with no due date | Nothing. |
| Save a task due tomorrow 6:00 PM | Silent until that instant. |
| Clock reaches the deadline, task still open | OS notification + bell badge + sad look. |
| Still incomplete after that | Repeat reminder once per hour. |
| Task completed | Reminders stop. |

A 30-second grace after create blocks an immediate "due now" ping. Active
deadlines are checked every 30 seconds; the interval is stopped when no
incomplete task has a deadline. Notifications go through Electron's
`Notification`.

## Drag tilt

The character leans **against** the pull and holds that pose for the whole drag:

- drag left -> tilt right
- drag right -> tilt left
- up and down drags look in the matching direction
- each pose stops on its final frame until release; horizontal tilts stop on frame 47 and skip their slow lead-in

Direction is read from **screen** movement immediately (6px threshold), not from
window-relative coordinates after the overlay resizes.

## Resource use

Measured on this machine with the widget started by the systemd service, CPU
averaged over 45 s from `/proc/<pid>/stat` deltas so startup is excluded, and
memory from `/proc/<pid>/smaps_rollup` for each process in the service cgroup.

| | Before (Next.js) | Now |
|---|---|---|
| CPU, character animating at 24 fps | 33% of one core | **15.2% of one core** |
| CPU, widget hidden | - | **0.09% of one core** |
| Physical RAM (PSS) | 292 MB | 343 MB |
| Memory charged to the service | - | 172 MB |
| Resident set (RSS) | 586 MB | 589 MB |
| Processes | 7 | 6 |
| Decoded frames | up to 170 MB | **capped at 64 MB** |
| `node_modules` | 622 MB | 314 MB |
| Build cache | 62 MB (`.next`) | none |
| Shipped output | 8.3 MB | 7.7 MB |

Two memory numbers are worth keeping apart. PSS is 343 MB because it shares
Chromium's pages with every other Electron process on the desktop;
`MemoryCurrent`, what the service is actually charged, is 172 MB.

Hiding the widget stops the animation loop outright, which takes it from 15.2%
of a core to 0.09%, so a widget you are not looking at is effectively free. The
reminder timer keeps running while hidden, which is the point of hiding rather
than quitting.

### Why the animation is not on the GPU

The obvious way to build this is `requestAnimationFrame` with hardware
acceleration on. On this machine that does not work, and it fails quietly: the
widget looks cheap because it is barely drawing.

The GPU process cannot get vsync parameters from this X11 session - it logs
`GetVSyncParametersIfAvailable() failed` on every launch - and when it cannot,
the display compositor stops driving frames for an always-on-top, tool-typed
window. Chromium aligns a renderer's whole task queue to that frame clock, so
the renderer starves with it. Measured on screen, with the character supposed to
be looping:

| Paced by | Frame rate | Worst frame gap |
|---|---|---|
| `requestAnimationFrame` | 1.3 fps | ~5 s |
| `setTimeout(41)` on the main thread | 2.2 fps | ~5 s |
| `setTimeout` + `--no-sandbox` | 2.2 fps | ~5 s |
| a plain Electron window, same options | 24.5 fps | 41 ms |
| **software compositing + worker pacer** | **24.1 fps** | **52 ms** |

Two changes fix it, and both are load-bearing:

- **`app.disableHardwareAcceleration()`** removes the dependency. The compositor
  no longer needs vsync, so it keeps producing frames, so the task queue keeps
  running. This also *lowered* CPU from 20.5% to 15.2% of a core, because the
  compositor is no longer copying and presenting a surface nothing else can see.
  It costs about 30 MB more resident, which is cheap: a 264x264 `drawImage` is
  0.1 ms, so 24 fps is roughly 2.4 ms of CPU per second.
- **A worker paces the loop** (`src/character/framePacer.ts`). A worker's timers
  run off the worker's own task queue, not the page's frame clock, so they keep
  time even if the compositor stalls again. The worker posts a tick at 60 Hz and
  the player decides whether that tick advances a frame, so one pacer serves
  every state. `setTimeout` is kept as a fallback if workers are unavailable.

The same frame-clock problem is why a `setTimeout` loop was not enough on its
own: it is aligned to the frame clock just like `requestAnimationFrame`.

Memory is dominated by the Electron/Chromium floor. The per-process split:

| Role | PSS |
|------|-----|
| renderer | 108 MB |
| GPU process (software raster) | 83 MB |
| main | 79 MB |
| utility | 23 MB |
| 2 zygotes | 24 MB |

What the build *did* fix on the memory side is the ceiling rather than the
baseline. A decoded 264x264 frame costs ~272 KiB of RAM, so a clip that gets
played used to stay resident forever: eleven clips is 170 MB. The cache now caps
the resident set at 64 MB and evicts least-recently-used, and it only decodes
the frames a clip actually draws - a tilt stops on frame 47 of 56, so its
nine-frame tail is never decoded at all.

The only lever that would cut memory further is dropping the software
compositor, which reintroduces the stalled frame clock above. The only lever
that would cut CPU further is dropping below 24 fps, which changes how the
animation looks.

## Design notes

- Static bundle + Electron; no API routes, no DB, no network access at any point after the build.
- The window is a `_NET_WM_WINDOW_TYPE_TOOLBAR` with `skipTaskbar`, so the widget is absent from the task switcher and the recent-apps list. It is still focusable, which is what the create-task field needs in order to accept typing.
- Geometry is always resolved against the work area of the display the widget is on, never against raw screen coordinates, so panels are not covered and a monitor left of the primary one works.
- Character frames decode into an in-memory `Map` only when needed: idle and greeting at startup, drag clips on first hover, and other clips on first use.
- The animation loop is paced by a worker and gated by a time-based accumulator, not `requestAnimationFrame`, because this window's compositor frame clock is unreliable (see Resource use). It runs at 24 fps and stops when a one-shot ends.
- Visibility is reported by the main process rather than inferred from `document.hidden`: `win.hide()` unmaps the window without hiding the page, so a loop keyed off `document.hidden` would keep running at full rate against a window nobody can see.
- Animation uses 24 fps; horizontal tilt playback adapts from 36 to 60 fps based on pointer speed. One-shots stop at their selected end frame and release the pacer.
- Compositing is software, on purpose: the GPU path cannot get vsync on this machine and stalls the renderer's frame clock (see Resource use).
- Reminders use one 30-second interval only while there are active deadlines, plus an immediate check when the app returns to the foreground. Chromium's background throttling is disabled, so the interval keeps firing while the widget is hidden.
- Hidden tasks use one timeout for the next 24-hour expiry; no cleanup timer runs when there are none.
- Drag pointer data stays in refs; React re-renders only when the lean direction actually changes.

### Time complexity

*n* = number of tasks. Per event, not per frame, unless noted.

| Operation | Time |
|-----------|------|
| Create / toggle / complete a task | **O(n)** (new array + persist JSON) |
| Filter active and completed tasks | **O(n)** |
| Order both task lists (on change, not per frame) | **O(n log n)** |
| Filter due reminders | **O(n)** |
| Sort due list for the panel | **O(n log n)** |
| 30-second reminder check | **O(n)** while active deadlines exist |
| Hidden-task expiry | **O(n)** once per nearest expiry |
| Pointer move / tilt | **O(1)** |
| Animation frame blit | **O(1)** |
| Frame cache lookup | **O(1)** |

### Space complexity

| Store | Space |
|-------|-------|
| Active and 24-hour recoverable tasks in renderer memory | **O(n)** |
| Older archived tasks | **Disk only** in Electron `tasks.v1.json` |
| Decoded animation frames | **O(F)** for resident clips, hard-capped at 64 MB. *F* is total frames in loaded clips. |
| Drag session | **O(1)** |
| Reminder timer and duplicate-fire guard | **O(a)** where *a* is the number of active deadline tasks |

CPU is one 24 fps loop drawing a 264x264 canvas while the widget is on screen
(15.2% of one core), and nothing at all while it is hidden (0.09%).

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Bundle the renderer into `dist/` |
| `npm run watch` | Rebuild on save without relaunching |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run widget` | `build` then Electron |
| `npm run widget:start` | Electron using the existing `dist/` |
