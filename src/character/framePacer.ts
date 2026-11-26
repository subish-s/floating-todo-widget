'use client';

/**
 * Frame pacing that does not depend on the compositor.
 *
 * Chromium aligns a renderer's timers to the compositor's frame clock, so
 * anything paced from the main thread inherits whatever the compositor feels
 * like doing. On this machine that clock is unreliable — see the note on
 * `disableHardwareAcceleration` in `electron/main.js` — and when it stalls, the
 * main thread's `setTimeout` chain drops to 2.2 fps and `requestAnimationFrame`
 * to 1.3.
 *
 * A worker's timers run off the worker's own task queue rather than the page's
 * frame clock, so they keep time even then: a worker `setInterval(41)` holds
 * 24.6 fps in a renderer whose main-thread timer manages 2.2. The worker only
 * posts a tick; deciding whether that tick advances a frame stays with the
 * player, which gates drawing on elapsed time. That way the pacer can tick at
 * 60 Hz, faster than any clip needs, and one pacer serves every state: idle at
 * 24 fps. A fast drag asks for a higher rate and the player skips frames to
 * get there; the pacer itself stays at 60 so a flick does not cost more timers.
 *
 * If workers are unavailable the caller falls back to `setTimeout`, which is
 * slower under a stalled frame clock but still correct.
 */

/** Fast enough for the fastest clip, which adapts to 60 fps during a fast drag. */
const PACER_HZ = 60;

const WORKER_SOURCE = `
let id = null;
self.onmessage = (event) => {
  if (event.data === 'stop') {
    if (id !== null) clearInterval(id);
    id = null;
    return;
  }
  if (id !== null) clearInterval(id);
  id = setInterval(() => self.postMessage(0), event.data);
};
`;

type Tick = (now: number) => void;

const subscribers = new Set<Tick>();
let worker: Worker | null = null;
let objectUrl: string | null = null;
/** Set once workers prove unusable, so we stop retrying on every state change. */
let workersBroken = false;

function ensureWorker(): Worker | null {
  if (worker || workersBroken) return worker;
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || !URL.createObjectURL) {
    workersBroken = true;
    return null;
  }
  try {
    objectUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    worker = new Worker(objectUrl);
    worker.onmessage = () => {
      const now = performance.now();
      // Copy first: a callback may unsubscribe while we are iterating.
      for (const tick of [...subscribers]) tick(now);
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      workersBroken = true;
    };
    worker.postMessage(Math.round(1000 / PACER_HZ));
  } catch {
    worker = null;
    workersBroken = true;
  }
  return worker;
}

function stopWorker() {
  if (!worker) return;
  worker.postMessage('stop');
  worker.terminate();
  worker = null;
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

/** `null` when no worker could be started, which asks the caller to self-pace. */
export function subscribeToFrames(callback: Tick): Worker | null {
  subscribers.add(callback);
  return ensureWorker();
}

export function unsubscribeFromFrames(callback: Tick) {
  subscribers.delete(callback);
  if (subscribers.size === 0) stopWorker();
}
