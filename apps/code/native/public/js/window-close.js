// A window closing on a desk, as Omarchy closes one: Hyprland's windowsOut
// (speed 1.49, linear, popin 87%) and fadeOut (1.46, almostLinear), a unit
// of speed being 100ms. The window shrinks to 87% about its centre in 149ms
// while it fades out in 146ms, then done() takes it away. It is inert
// meanwhile: what it showed stays only as it was, in the page, never captured.
// finish() (another layout wanting the strip) ends it at once; reduced
// motion, or animate false (a phone), is done at once.
export const CLOSE = { scale: 0.87, scaleMs: 149, fadeMs: 146, fade: 'cubic-bezier(0.5, 0.5, 0.75, 1)' };

export function windowClose(el, done, { animate = true, reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  wait = setTimeout, clear = clearTimeout } = {}) {
  let over = false, timer = 0, motion = [];
  function finish() {
    if (over) return;
    over = true;
    clear(timer);
    done();
    for (const one of motion) one.cancel();
  }
  if (!animate || reduced() || !el.animate) { finish(); return finish; }
  el.inert = true;
  el.setAttribute('aria-hidden', 'true');
  el.classList.remove('wm-arriving');
  el.classList.add('wm-closing');
  motion = [
    el.animate([{ transform: 'scale(1)' }, { transform: `scale(${CLOSE.scale})` }], { duration: CLOSE.scaleMs, easing: 'linear', fill: 'forwards' }),
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE.fadeMs, easing: CLOSE.fade, fill: 'forwards' }),
  ];
  // Time, not animation events, ends it: a hidden page still closes.
  timer = wait(finish, CLOSE.scaleMs);
  return finish;
}
