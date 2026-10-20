// The native lock owns the secure surface. Hide the app while it holds; on release,
// fade the UI in over its own plain theme ground. Never mount a background renderer.
import { still } from './turn.js';
import { demoParentOrigin } from './demo-ready.js';

export const ARRIVAL = Object.freeze({ duration: 600, easing: 'ease-in-out' });
export const arrivalFrames = () => [{ opacity: 0 }, { opacity: 1 }];

// The authenticated launch frame shares demo-ready's exact origin rules.
export function framedByLaunch(win = globalThis.window, doc = globalThis.document) {
  try { return Boolean(win && doc && win.parent !== win && demoParentOrigin(win.location.origin, doc.referrer, win.location.ancestorOrigins)); } catch { return false; }
}
// A second authenticated launch frame can demonstrate the phone's own layout.
// The query is a presentation hint only inside the same exact trusted frame boundary.
export function phoneByLaunch(win = globalThis.window, doc = globalThis.document) {
  try { return framedByLaunch(win, doc) && new URLSearchParams(win.location.search || '').get('launch') === 'phone'; }
  catch { return false; }
}

export function mountArrival(desk = globalThis.imperfectDesk) {
  if (!desk?.onLock) return null;
  const root = document.documentElement;
  let locked = false, turning = [];
  function hold() {
    locked = true;
    for (const a of turning.splice(0)) a.cancel();
    root.classList.add('locked-away');
  }
  function arrive() {
    if (!locked) return;
    locked = false;
    root.classList.remove('locked-away');
    if (still()) return;
    for (const el of document.body.children) {
      if (el.localName === 'script') continue;
      const box = el.getBoundingClientRect();
      if (box.width && box.height) turning.push(el.animate(arrivalFrames(), ARRIVAL));
    }
    for (const a of turning) a.finished.catch(() => {}).finally(() => { turning = turning.filter(b => b !== a); });
  }
  desk.onLock(state => (state && Number.isFinite(state.epoch) ? hold() : arrive()));
  return { hold, arrive };
}
