// Kinso's lock uses the app's own light sea, not the desktop wallpaper.
// Prepare an empty grid for the burst; only spawn the entering sharks when the password wakes.
import { swim } from './sharks.mjs?v=kinso-lift-2';

export function mountSharks(screen, { word = null, backdrop = screen } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'kinso-sharks'; canvas.setAttribute('aria-hidden', 'true');
  backdrop.prepend(canvas);
  let stop = null, started = false, swimming = false, fading = null, logo = null;
  word?.classList.add('kinso-lock-word');
  // Keep the logo through the password wake; the sea follows its actual resized box, not the old word's width.
  const keepClear = () => [word, ...screen.querySelectorAll('.macos-lock-clock, .macos-user')]
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
    },
    cover() {
      // The same live sea becomes the lock's sheet, without restarting or redrawing its sharks. The logo lives in
      // the opener's sky, which the sheet now hides, so a still copy of it joins the lock's words and fades with them.
      const content = screen.querySelector('.macos-lock-content'), box = word?.getBoundingClientRect?.();
      if (content && box?.width && box.height && !logo) {
        logo = document.createElement('canvas');
        logo.className = 'kinso-sheet-logo'; logo.setAttribute('aria-hidden', 'true');
        logo.width = word.width; logo.height = word.height;
        try { logo.getContext('2d').drawImage(word, 0, 0); } catch { /* an empty copy only skips the logo's fade */ }
        Object.assign(logo.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
        content.prepend(logo);
      }
      word?.style.setProperty('--kinso-word-opacity', '0');
      screen.dataset.sheet = 'true'; screen.prepend(canvas);
    },
    fade(ms) {
      // The logo leaves with the sea, never reappearing during the password's leaving fade.
      word?.style.setProperty('--kinso-word-opacity', '0');
      fading ||= canvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
      return fading;
    },
    stop() {
      started = swimming = false; stop?.(); stop = null; fading = null; logo?.remove(); logo = null;
      for (const a of canvas.getAnimations()) a.cancel();
    },
    state: () => ({ swimming }),
  };
}
