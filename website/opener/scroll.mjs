import { CONTACT, HOLD } from './timeline.mjs';

// 4.2 viewport heights to contact: 30% less travel than the six-screen approach.
// Equal scroll steps still move progressively less:
// the final slope is 1/7 of the initial slope, but never zero (contact stays reachable).
export const RUN = [[4.2, CONTACT], [0.25, HOLD]];
export const TOTAL = RUN.reduce((sum, [length]) => sum + length, 0);
// More glide: 80% of the original smoothing half-life, with gesture travel still capped.
export const scrollBlend = dt => 1 - 0.5 ** (Math.max(0, dt) * 60 / 0.8);
const ease = x => 1.75 * x - 0.75 * x * x;
const unease = q => 2 * q / (1.75 + Math.sqrt(3.0625 - 3 * q));

export function pOfPos(pos) {
  let x = pos - 1, p0 = 0;
  if (x <= 0) return 0;
  for (const [i, [length, p1]] of RUN.entries()) {
    if (x <= length) {
      const u = x / length;
      return p0 + (p1 - p0) * (i === 0 ? ease(u) : u);
    }
    x -= length; p0 = p1;
  }
  return 1;
}

export function posOfP(p) {
  let pos = 1, p0 = 0;
  if (p <= 0) return pos;
  for (const [i, [length, p1]] of RUN.entries()) {
    if (p <= p1) {
      const q = (p - p0) / (p1 - p0);
      return pos + length * (i === 0 ? unease(q) : q);
    }
    pos += length; p0 = p1;
  }
  return pos;
}
