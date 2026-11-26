'use client';

/**
 * DesktopPointerBridge
 *
 * Keeps the desktop window the same size as the widget.
 *
 * A transparent, always-on-top window that is larger than its contents is a
 * problem: the empty parts sit on top of the desktop and swallow clicks meant for
 * whatever is underneath. The usual fix is click-through, but that cannot be
 * done from here - while a window ignores mouse events it receives none, and
 * under Wayland / XWayland the pointer position is only refreshed while the
 * cursor is over one of our own windows, so the widget could never be clicked
 * again.
 *
 * So instead of punching holes in the window, the window is resized to fit
 * exactly what is visible. Nothing empty is left to intercept anything, and the
 * widget stays clickable and hoverable with no cleverness at all.
 *
 * It also marks which of the two places the widget is running in. The desktop
 * window is only as wide as the column and about 176px tall, so a media query
 * cannot tell a phone from the widget, and the only thing that can is the
 * presence of the bridge. The
 * inline script in the document head gets this right before the first paint, but
 * it can in principle run before the preload has finished, so the class is also
 * set from here once React is running. Layout that is wrong in the browser is
 * merely ugly; layout that is wrong on the desktop shrinks the character and
 * raises a scrollbar, so the desktop is the default and the browser opts in.
 *
 * In a plain browser there is no bridge, and this component does nothing else.
 */
import { useEffect } from 'react';

/** The parts that decide how tall the widget is right now. */
const VISIBLE_SELECTOR = '.fw-character, .fw-pill, .fw-panel';

/** Breathing room below the lowest visible part, so it is never flush to the edge. */
const BOTTOM_PADDING = 6;

/**
 * Breathing room on each side of the column.
 *
 * The focus ring sits 5px outside the character. This keeps it inside the
 * window, and it is the whole gap between the character and a screen edge once
 * the window has shrunk to the column.
 */
const HORIZONTAL_PADDING = 8;

function getBridge(): NonNullable<Window['desktop']> | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.desktop;
  return bridge && typeof bridge.setContentBox === 'function' ? bridge : null;
}

/**
 * Bottom edge of an element in document coordinates, from layout rather than
 * from getBoundingClientRect.
 *
 * The panel animates in with a transform, and a transformed rect reports a
 * different height on every frame of that animation - which made the window
 * creep downwards one pixel at a time while a panel opened. offsetTop and
 * offsetHeight ignore transforms, so the number is stable from the first frame.
 */
function layoutBottom(element: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = element;
  while (node) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top + element.offsetHeight;
}

/**
 * Width of whatever is actually on screen.
 *
 * `offsetWidth` ignores transforms, so the idle scale animation cannot make the
 * window breathe. The panel is position:absolute and does not contribute to the
 * column's width, so it is measured on its own. With the toolbar retired only
 * the character remains, and the window shrinks to it.
 */
function measureContentWidth(): number {
  const chromeRetired = document.querySelector('.fw--chrome-hidden') != null;
  const parts = [...document.querySelectorAll<HTMLElement>(VISIBLE_SELECTOR)].filter(
    (el) => !(chromeRetired && el.matches('.fw-pill, .fw-panel')),
  );
  if (parts.length === 0) return 0;
  const width = Math.max(...parts.map((el) => el.offsetWidth));
  return width > 0 ? width + HORIZONTAL_PADDING * 2 : 0;
}

/** Height of the widget: from the top of the window to the bottom of its content. */
function measureContentHeight(): number {
  // Once the toolbar has retired the character is all that is left, and the
  // window should shrink to match rather than keep a strip of nothing.
  const chromeRetired = document.querySelector('.fw--chrome-hidden') != null;

  const bottoms = [...document.querySelectorAll<HTMLElement>(VISIBLE_SELECTOR)]
    .filter((el) => !(chromeRetired && el.matches('.fw-pill, .fw-panel')))
    .filter((el) => getComputedStyle(el).visibility !== 'hidden')
    .map(layoutBottom);

  if (bottoms.length === 0) return 0;
  return Math.max(...bottoms) + BOTTOM_PADDING;
}

export default function DesktopPointerBridge() {
  useEffect(() => {
    const bridge = getBridge();
    const root = document.documentElement;
    root.classList.toggle('fw-browser', !bridge);
    root.classList.toggle('fw-desktop', !!bridge);
    if (!bridge) return;

    /*
     * Coalesced through one animation frame: opening a panel mutates a whole
     * subtree at once, and every one of those mutations wants the same answer.
     */
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        bridge.setContentBox({
          width: measureContentWidth(),
          height: measureContentHeight(),
        });
        watch();
      });
    };

    // Aligned before the first measurement so a panel opened on a corner is
    // laid out against that edge from its first frame.
    const unsubscribeEdge = bridge.onHorizontalEdge((side) => {
      // On <html>, not on .fw: the widget's className is owned by React and
      // the next render would drop a class written onto that element.
      root.classList.toggle('fw-edge-left', side === 'left');
      root.classList.toggle('fw-edge-right', side === 'right');
      schedule();
    });

    const sizes = new ResizeObserver(schedule);
    const changes = new MutationObserver(schedule);

    /** Watch the widget and whatever is currently inside it. */
    const watch = () => {
      const root = document.querySelector('.fw');
      if (!root) return;
      sizes.observe(root);
      for (const el of document.querySelectorAll<HTMLElement>(VISIBLE_SELECTOR)) {
        sizes.observe(el);
      }
      // Opening a panel adds a new subtree and retiring the toolbar is a class
      // change on the root; both change how tall the widget is.
      changes.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    };

    bridge.setContentBox({
      width: measureContentWidth(),
      height: measureContentHeight(),
    });
    watch();

    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);

    // A frameless always-on-top window has no title bar and no close button, so
    // right-click is the escape hatch for quitting it.
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      bridge.showContextMenu({ x: event.clientX, y: event.clientY });
    };

    document.addEventListener('contextmenu', onContextMenu);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      sizes.disconnect();
      changes.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('contextmenu', onContextMenu);
      unsubscribeEdge();
    };
  }, []);

  return null;
}
