'use client';

/**
 * Gives clipped task text back on hover.
 *
 * The task list is a two-column grid inside a 300px panel, so anything past
 * roughly 25 characters is ellipsised and the rest of the sentence is simply
 * gone. Marking the text with a `title` hands it back: the desktop draws the
 * tooltip, so it is not clipped by the list's `overflow-y: auto`, the panel, or
 * the 340px window the way an in-panel popup would be. It is also the same
 * native tooltip the delete and undo buttons already use, so it looks like part
 * of the widget rather than a foreign overlay.
 *
 * The attribute is only set on text that is *actually* clipped. A tooltip that
 * repeats a sentence already readable on screen is noise, and hover would then
 * mean nothing at all for the short tasks.
 *
 * Truncation depends on the rendered width, so the measurement is redone
 * whenever the list changes and whenever the window is resized, rather than
 * being computed once from an assumed panel width.
 */
import { useEffect, useLayoutEffect } from 'react';

const CANDIDATE = '[data-full-text]';

function refresh(root: ParentNode) {
  for (const el of root.querySelectorAll<HTMLElement>(CANDIDATE)) {
    const full = el.dataset.fullText ?? '';
    // Two different clipping modes are in play, so both have to be tested. The
    // task and history lists clamp to two lines with `-webkit-line-clamp`, which
    // clips vertically; the reminder list keeps one line and ellipsises, which
    // clips horizontally. scrollHeight covers the first, scrollWidth the second.
    const clipped = el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
    if (full && clipped) el.title = full;
    else el.removeAttribute('title');
  }
}

/**
 * @param deps whatever changes the rendered list: the open panel, the tasks in
 *   it, and the deadlines shown in the reminder panel.
 */
export function useClippedTextTitles(deps: readonly unknown[]) {
  useLayoutEffect(() => {
    refresh(document);
  }, deps);

  useEffect(() => {
    const onResize = () => refresh(document);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
}
