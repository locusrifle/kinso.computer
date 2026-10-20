// Kinso's lock uses the app's own light sea, not the desktop wallpaper.
// Prepare an empty grid for the burst; only spawn the entering sharks when the password wakes.
import { swim } from './sharks.mjs?v=kinso-pale-grid-1';

export function mountSharks(screen, { word = null, backdrop = screen } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'kinso-sharks'; canvas.setAttribute('aria-hidden', 'true');
  backdrop.prepend(canvas);
  let stop = null, started = false, swimming = false, fading = null, wordFrame = 0;
  word?.classList.add('kinso-lock-word');
  // Follow the password's actual rendered wake, not a second animation clock.
  const syncWord = () => {
    if (!started || !word) return;
    const opacity = Number(screen.querySelector('.macos-lock-content')?.style.opacity || 0);
    word.style.setProperty('--kinso-word-opacity', String(1 - opacity));
    if (opacity < 1) wordFrame = requestAnimationFrame(syncWord);
  };
  const keepClear = () => [...screen.querySelectorAll('.macos-lock-clock, .macos-user')]
    .filter(el => el && !el.hidden && el.getClientRects().length).map(el => el.getBoundingClientRect());
  const sea = { cell: 14, palette: 'light', ground: true };
  // The very same renderer paints both the empty grid and the swimming sea: no CSS approximation.
  try { stop = swim(canvas, { ...sea, sharks: 0, plankton: false, wake: false }); } catch { /* authentication still works */ }
  return {
    canvas,
    start() {
      if (started) return; started = true;
      // Prepare the off-screen bodies before starting either fade, so atlas work cannot
      // consume the password's wake. The first simulation frame follows the synchronous wake.
      // Reduce Motion keeps the quiet grid, without popping pre-rolled static sharks into it.
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        stop?.(); stop = null;
        try { stop = swim(canvas, { ...sea, sharks: 4, enter: true, avoid: keepClear }); swimming = true; } catch { /* the grid/lock remains usable */ }
      }
      // mountLock.show runs synchronously after this. Register after its frame loop,
      // then read each freshly rendered opacity; this also follows its short Reduce Motion wake.
      queueMicrotask(syncWord);
    },
    fade(ms) {
      // A fast/autofilled unlock may interrupt wake. Never mirror its leaving fade back into KINSO.
      cancelAnimationFrame(wordFrame); wordFrame = 0;
      word?.style.setProperty('--kinso-word-opacity', '0');
      fading ||= canvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
      return fading;
    },
    stop() {
      started = swimming = false; stop?.(); stop = null; fading = null;
      cancelAnimationFrame(wordFrame); wordFrame = 0;
      for (const a of canvas.getAnimations()) a.cancel();
    },
    state: () => ({ swimming }),
  };
}
