// The single seam after authentication and after the three variations. player: what plays on the desktop after the
// unlock, QuickTime's film unless the site has its own (kinso.computer's film window, for-kinso/film.mjs).
import { createQuickTime } from './quicktime.mjs?v=kinso-lift-2';
import { MACOS, animate, ease } from './timings.mjs?v=sequoia-4';

export function createMacLaunch({ stage, introScreen, intro, mac, reduced, film, onphase, ondesktop, onfinish, wallpaperImage = null, player: makePlayer = createQuickTime }) {
  const player = makePlayer({ stage, film, reduced, onphase, onended: onfinish });
  let generation = 0, entered = false, transition;
  return {
    prime: () => player.prime(),
    async enter({ leave, sheet = false } = {}) {
      if (entered) return; entered = true; const id = ++generation;
      onphase('mac-unlocking'); intro()?.quiet(); intro()?.marks(false);
      const wallpaper = document.createElement('div'); wallpaper.className = 'macos-wallpaper launch-wallpaper'; wallpaper.setAttribute('aria-hidden', 'true');
      if (wallpaperImage) wallpaper.style.backgroundImage = wallpaperImage;
      stage.before(wallpaper); stage.dataset.player = 'true';
      mac.enter(); player.prepare(); ondesktop?.();
      if (sheet) {
        // Kinso's desktop is already full size. Its film waits until the lock has lifted clear.
        await leave?.();
      } else {
        leave?.();
        transition = animate(reduced.matches ? MACOS.reduceMs : MACOS.unlockMs, t => {
          const p = ease(t); stage.style.opacity = String(p); introScreen.style.opacity = String(1 - p);
        });
        await transition.finished;
      }
      if (id !== generation) return;
      stage.style.opacity = ''; introScreen.style.opacity = ''; introScreen.hidden = true; intro()?.suspend();
      await player.play();
    },
    stop() { ++generation; transition?.cancel(); stage.style.opacity = ''; introScreen.style.opacity = ''; player.stop(); },
    state: () => ({ entered, ...player.state() }),
  };
}
