// The warpy, wobbling bubble (the opener's, from round 30): a closed curve about a centre whose radius breathes with a
// few low harmonics, their phases drifting with time, so it is never a perfect circle.
// r(θ) = R·(1 + Σ a·sin(kθ + φ + ω·t)), [k, a (share of R), φ, ω rad/s]
const WOBBLE = [[2, 0.08, 0.4, 0.31], [3, 0.06, 2.1, -0.42], [4, 0.045, 4.0, 0.55], [5, 0.03, 1.3, -0.37], [6, 0.02, 5.2, 0.48]];
export const DENT = WOBBLE.reduce((s, w) => s + w[1], 0);
const POINTS = 96;

// R that covers a w x h screen from (cx, cy) even at the deepest dent
export const reach = (cx, cy, w, h) => Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy)) / (1 - DENT) + 4;

// an SVG / CSS path() string for a bubble of radius R at time t; wob scales the wobble (0 = a circle)
export function bubblePath(cx, cy, R, t, wob = 1) {
  const pts = [];
  for (let i = 0; i < POINTS; i++) {
    const th = 2 * Math.PI * i / POINTS;
    let f = 1;
    for (const [k, a, ph, w] of WOBBLE) f += wob * a * Math.sin(k * th + ph + w * t + 0.8 * k * Math.sin(0.23 * t));
    const r = Math.max(0, R * f);
    pts.push([cx + r * Math.cos(th), cy + r * Math.sin(th)]);
  }
  const at = i => pts[(i + POINTS) % POINTS], n = x => x.toFixed(1);
  let d = `M${n(pts[0][0])} ${n(pts[0][1])}`;
  for (let i = 0; i < POINTS; i++) { // a smooth closed curve through the points (Catmull-Rom as cubic Béziers)
    const a = at(i - 1), b = at(i), c = at(i + 1), e = at(i + 2);
    d += `C${n(b[0] + (c[0] - a[0]) / 6)} ${n(b[1] + (c[1] - a[1]) / 6)} ${n(c[0] - (e[0] - b[0]) / 6)} ${n(c[1] - (e[1] - b[1]) / 6)} ${n(c[0])} ${n(c[1])}`;
  }
  return d + 'Z';
}
