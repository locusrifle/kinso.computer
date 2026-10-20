// Calibration lives here. A binary symbol establishes a mechanism, never a duration.
// Frames are zero-based in shots/reference; estimates are deliberately labelled.
export const SOURCES = Object.freeze({
  lock: 'https://www.youtube.com/watch?v=z8ZARW9sBeY (Sonoma, 60 fps, section 03:50–04:35)',
  genie: 'https://www.youtube.com/watch?v=TRHFLyzN0QQ (Sonoma, 25 fps; Genie demonstration starts after 79 s, earlier examples are Scale)',
  player: 'https://www.youtube.com/watch?v=MqsiXV0bNsA (QuickTime Player, 30 fps; older UI reference)',
  playback: 'https://support.apple.com/guide/quicktime-player/qtp6cee0761b/10.5/mac/15.0',
  easing: 'https://developer.apple.com/documentation/quartzcore/camediatimingfunctionname/easeineaseout',
  dock: 'reference/strings/Dock.txt:37–38,148,217,361 (WASpringTimingFunction, WAGenieAnimation, genieSpeed)',
  window: 'reference/strings/QuickTime_Player.txt: contentSizeForNaturalContentSize:, setWindowContentSize:centered:onScreen:animate:',
});
export const MEASUREMENTS = Object.freeze({
  wakeMs: [300, 'Estimate: display-wake fade is not isolated in the available recording.'],
  unlockMs: [250, 'Sonoma 59.94 fps clip: clock mask leaves its baseline at frame 595 (9.917 s), reaches background at 608 (10.133 s); 15-frame envelope, ±2 frames. See unlock-luminance.csv.'],
  unlockScale: [1.04, 'Estimate of static-wallpaper zoom; aerial footage also contains camera motion.'],
  wrongMs: [420, 'Estimate: no usable Sequoia wrong-password recording found.'],
  wrongTravel: [14, 'Estimate, points; replace with Noah’s failed-password recording.'],
  reduceMs: [150, 'Estimate: short opacity-only alternative; no measured Reduce Motion recording.'],
  genieMs: [440, 'Sonoma Genie: minimize frames 1999–2010 (79.96–80.40 s), restore 2084–2095 (83.36–83.80 s), 25 fps; ±40 ms.'],
  neckFraction: [.295, 'Least-squares top-edge fit, Sonoma frames 1999–2010: RMSE 6.65 px at 320×206. See shots/reference/genie-sonoma-measurements.csv. Private mesh remains approximate.'],
  genieSlices: [64, 'Browser mesh resolution, not an Apple constant.'],
  restoreDelayMs: [450, 'Editorial pause after unlock, not a macOS behaviour.'],
  hudHideMs: [2000, 'Estimate from QuickTime playback reference; needs Sequoia pointer-idle capture.'],
  hudFadeMs: [200, 'Estimate: QuickTime playback reference.'],
  dateTop: [75, 'Lock reference normalized to 1440×900 points.'],
  dateSize: [26, 'Lock reference normalized to 1440×900 points; SF metrics vary with fallback.'],
  clockSize: [100, 'Lock reference normalized to 1440×900 points.'],
  clockLeading: [112, 'Lock reference normalized to 1440×900 points.'],
  avatarSize: [48, 'Lock reference; bottom user widget.'],
  userBottom: [56, 'Lock reference normalized to 900-point screen.'],
  nameSize: [13, 'Lock reference; SF system text.'],
  fieldWidth: [180, 'Lock reference normalized to points.'],
  fieldHeight: [28, 'Lock reference normalized to points.'],
  fieldRadius: [14, 'Lock reference; capsule password field.'],
  fieldBlur: [20, 'Estimate of vibrancy radius; compositor material is private.'],
  windowWidth: [1120, 'Fit a 1920×1080 video within the existing 1600-point Mac; estimated QuickTime default.'],
  windowRadius: [10, 'QuickTime reference, points.'],
  hudWidth: [440, 'QuickTime reference; estimated on Sequoia.'],
  hudBottom: [48, 'QuickTime reference at 01:12 (frame 2160): HUD bottom 76 px above a 1018 px window edge; inferred 1.5× capture scale.'],
});
export const MACOS = Object.freeze(Object.fromEntries(Object.entries(MEASUREMENTS).map(([key, [value]]) => [key, value])));
// Apple documents these control points. It does not say loginwindow or the Dock use this curve.
export const EASE = Object.freeze([.42, 0, .58, 1]);
export const clamp = x => Math.max(0, Math.min(1, x));
export const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
export function ease(t, [x1, y1, x2, y2] = EASE) {
  t = clamp(t);
  const at = (u, a, b) => 3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u * u * b + u ** 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) { const u = (lo + hi) / 2; if (at(u, x1, x2) < t) lo = u; else hi = u; }
  return t === 0 || t === 1 ? t : at((lo + hi) / 2, y1, y2);
}
export const motionClock = () => globalThis.window?.__macosClock ?? performance.now() / 1000;
export function animate(ms, draw, { clock = motionClock } = {}) {
  const start = clock(); let raf, done = false, resolve;
  const finished = new Promise(ok => { resolve = ok; });
  const finish = cancelled => { if (done) return; done = true; cancelAnimationFrame(raf); resolve(!cancelled); };
  draw(0);
  const tick = () => { if (done) return; const t = ms ? clamp((clock() - start) * 1000 / ms) : 1; draw(t); if (t === 1) finish(false); else raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick);
  return { finished, cancel: () => finish(true) };
}
export function metrics(root = document.documentElement) {
  for (const [name, value] of Object.entries(MACOS)) root.style.setProperty(`--macos-${name}`, `${value}${name.endsWith('Ms') ? 'ms' : 'px'}`);
}
