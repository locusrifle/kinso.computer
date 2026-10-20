// Lock-only gestures. Native wheel tails replace, rather than add to, our release momentum.
export function createMomentum() {
  let velocity = 0, last = -Infinity, previous = 0, falling = 0, nativeTail = false, held = false, convert = px => px;
  return {
    input(px, t, touch = false, map = px => px) {
      if (!Number.isFinite(px) || !px) return 0;
      const gap = t - last, reverse = Math.sign(px) !== Math.sign(previous);
      if (gap > .18 || reverse) { falling = 0; nativeTail = false; }
      if (!touch && gap <= .18 && !reverse) {
        falling = Math.abs(px) < Math.abs(previous) * .97 ? falling + 1 : 0;
        if (falling >= 2) nativeTail = true;
      }
      // Never accumulate velocities; every real event replaces synthetic motion.
      velocity = px / Math.max(.016, Math.min(.08, gap));
      previous = px; last = t; held = touch; convert = map;
      return convert(px);
    },
    release() { held = false; },
    cancel() { velocity = 0; previous = 0; last = -Infinity; nativeTail = false; held = false; },
    step(t, dt) {
      if (held || t - last < .1 || nativeTail || !velocity) return 0;
      const decay = Math.exp(-dt / .26), travel = velocity * .26 * (1 - decay);
      velocity *= decay;
      if (Math.abs(velocity) < .5) velocity = 0;
      return convert(travel);
    },
  };
}
export function bindLockScroll({ active, height, move, momentum, clock, target = window }) {
  const ua = target.navigator?.userAgent || '';
  const gtk = /Linux.*AppleWebKit\//.test(ua) && !/Chrome|Chromium|Android/.test(ua);
  target.addEventListener('wheel', e => {
    if (!active() || e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    // Embedded Chromium can deliver a non-cancelable wheel; the full-screen scene
    // still owns that movement (its document never scrolls).
    if (e.cancelable) e.preventDefault();
    const reference = target.screen?.height || height();
    let px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? reference : 1);
    if (gtk && e.deltaMode === 0 && Number.isFinite(e.wheelDeltaY)) {
      // WebKitGTK: wheel ticks become floor(viewHeight^(2/3)) px, finger axes 2.5 px.
      // wheelDeltaY retains ticks * -120 for both; their ratio identifies the source.
      // Chromium/Wayland uses 120 px per notch and 12 px per continuous axis unit.
      px = e.wheelDeltaY && Math.abs(e.deltaY) > Math.abs(e.wheelDeltaY) * .1 ? -e.wheelDeltaY : e.deltaY * (12 / 2.5);
    }
    // Keep Chromium's full-screen 0.4x desk feel, regardless of window/panel height.
    // move() divides by the viewport; only direct fingers retain that 1:1 mapping.
    // Scale after momentum, so its cutoff and native-tail detection also match across hosts.
    move(momentum.input(px * .4, clock(), false, px => px * height() / reference));
  }, { passive: false });
  let finger = null;
  target.addEventListener('touchstart', e => {
    momentum.cancel();
    finger = active() && e.touches.length === 1 ? { id: e.touches[0].identifier, y: e.touches[0].clientY } : null;
  }, { passive: true });
  target.addEventListener('touchmove', e => {
    if (!active() || !finger || e.touches.length !== 1 || !e.cancelable) { finger = null; momentum.cancel(); return; }
    const touch = e.touches[0];
    if (touch.identifier !== finger.id) return;
    e.preventDefault();
    move(momentum.input(finger.y - touch.clientY, clock(), true)); finger.y = touch.clientY;
  }, { passive: false });
  target.addEventListener('touchend', () => { finger = null; momentum.release(); }, { passive: true });
  target.addEventListener('touchcancel', () => { finger = null; momentum.cancel(); }, { passive: true });
}
