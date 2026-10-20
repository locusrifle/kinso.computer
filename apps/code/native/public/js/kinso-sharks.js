// Kinso's window only: ASCII sharks swimming behind its fresh session, as on
// Kinso's lock screen (Noah). imperfect itself never mounts a background
// renderer (arrival.js); this is the one exception, and only for ?for=kinso.
// They swim round the question and the input bar, which blurs what passes
// under it. When the first prompt is sent they fade as the bar goes down,
// and stop: the session has the plain ground. A fresh session brings them
// back.

// As long as the bar's move down (harness.js FRESH_MOVE_MS), and the fade with it (kinso.css).
export const SHARKS_FADE_MS = 420;

// host: the middle window, where the question’s soft glow stays.
// canvasHost: the whole window strip, so the sea continues under its panels.
// avoid(): the rectangles (in the page's pixels) the sharks curve around; they
// may still pass under. The renderer (sharks.js) is loaded the first time
// they are shown; a computer without it shows the window without sharks.
// Under reduced motion the renderer draws one still sea.
export function mountSharks({ host, canvasHost = host, avoid = () => [], load = () => import('./sharks.js') }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'kinso-sharks';
  canvas.setAttribute('aria-hidden', 'true');
  const veil = document.createElement('div');
  veil.className = 'kinso-veil';
  veil.setAttribute('aria-hidden', 'true');
  host.prepend(veil);
  canvasHost.prepend(canvas);
  let renderer = null, stop = null, shown = false, gone = false, fading = 0, ready = null;
  const begin = () => {
    if (stop || !shown || gone || !renderer) return;
    stop = renderer.swim(canvas, {
      sharks: 4,
      enter: true,
      palette: 'light',
      // In the canvas' own pixels.
      avoid: () => {
        const at = canvas.getBoundingClientRect();
        return avoid().map(rect => ({ x: rect.left - at.left, y: rect.top - at.top, width: rect.width, height: rect.height }));
      },
    });
  };
  const end = () => {
    try { stop?.(); } catch { /* already still */ }
    stop = null;
  };
  const loaded = () => (ready ??= Promise.resolve().then(load).then(module => {
    if (typeof module?.swim !== 'function') throw new Error('no sharks');
    renderer = module;
    begin();
  }).catch(() => { canvas.remove(); veil.remove(); }));
  return {
    canvas,
    veil,
    get ready() { return ready ?? Promise.resolve(); },
    get swimming() { return Boolean(stop); },
    // Shown on a fresh session; hidden, they fade with the bar's move and stop.
    show(on) {
      on = Boolean(on);
      if (on === shown || gone) return;
      shown = on;
      clearTimeout(fading);
      if (on) { void loaded(); begin(); }
      else fading = setTimeout(end, SHARKS_FADE_MS + 60);
    },
    stop() {
      gone = true;
      clearTimeout(fading);
      end();
      canvas.remove();
      veil.remove();
    },
  };
}
