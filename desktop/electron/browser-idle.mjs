// Inactivity means no agent request in flight and nobody watching. Static
// pages and frame acknowledgments are not activity; an open live view is.
export const BROWSER_IDLE_MS = 5 * 60_000;
export function createBrowserIdle({ watching, stop, wait = BROWSER_IDLE_MS, now = Date.now,
  every = setInterval, clear = clearInterval } = {}) {
  let at = now(), busy = 0;
  const touch = () => { at = now(); };
  const timer = every(() => {
    if (busy || watching()) return touch();
    if (now() - at >= wait) stop();
  }, Math.min(1000, wait));
  timer.unref?.();
  return { touch, begin() { busy++; touch(); return () => { busy--; touch(); }; }, stop() { clear(timer); } };
}
