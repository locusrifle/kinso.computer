// Kinso's window only: sharks swim underneath the input and outputs (Noah).
// imperfect itself never mounts a background renderer (arrival.js).
// The engine pauses while hidden and draws a still sea under reduced motion.

// canvasHost fills the frame, including under the rail and floating panels.
// host keeps a quiet veil under the conversation so words stay legible.
// avoid() gives page rectangles; the renderer expects canvas-relative pixels.
export function mountSharks({ host, canvasHost = host, avoid = () => [], load = () => import('./sharks.js') }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'kinso-sharks';
  canvas.setAttribute('aria-hidden', 'true');
  const veil = document.createElement('div');
  veil.className = 'kinso-veil';
  veil.setAttribute('aria-hidden', 'true');
  host.prepend(veil);
  canvasHost.prepend(canvas);
  let stop = null, gone = false;
  const root = document.documentElement;
  const palette = () => root?.dataset.kinsoAppearance === 'dark' ? 'dark' : 'light';
  const repaint = () => {
    canvas.setAttribute('data-palette', palette());
    stop?.set?.({ palette: palette() });
  };
  root?.addEventListener('kinso-appearance', repaint);
  const ready = Promise.resolve().then(load).then(renderer => {
    if (gone) return;
    if (typeof renderer?.swim !== 'function') throw new Error('no sharks');
    stop = renderer.swim(canvas, {
      sharks: 4,
      enter: true,
      palette: palette(),
      avoid: () => {
        const at = canvas.getBoundingClientRect();
        return avoid().map(rect => ({ x: rect.left - at.left, y: rect.top - at.top, width: rect.width, height: rect.height }));
      },
    });
    canvas.setAttribute('data-palette', palette());
  }).catch(() => { root?.removeEventListener('kinso-appearance', repaint); canvas.remove(); veil.remove(); });
  return {
    canvas,
    veil,
    ready,
    get swimming() { return Boolean(stop); },
    stop() {
      gone = true;
      root?.removeEventListener('kinso-appearance', repaint);
      try { stop?.(); } catch { /* already still */ }
      stop = null;
      canvas.remove();
      veil.remove();
    },
  };
}
