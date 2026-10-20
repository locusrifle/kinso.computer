// Live website/reveal.mjs as of d6bb7372 (before the follow-up), its imports pointed at the site: the lock's reveal, to
// prove the staged one gives the lock exactly what it had.
// The website's contact reveal, also drawn by the lock. Both are only renderers
// of this result: same recording, bubble, edge, touch light and burst clock.
import { BURST, bubbleMotion } from '../../../website/bootup.mjs';
import { reach } from './bubble-before-sound.mjs';
export const REVEAL = Object.freeze({ breathe: BURST, open: 0.8, length: BURST + 0.8, fade: BURST, small: 0.095, light: 0.45 });
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
// grow (opt-in, the launch page's): a larger breathing bubble before the pop; 1 is the lock's.
export function revealAt(tau, { at, width, height, scale = width / 1536, grow = 1 }) {
  const b = bubbleMotion(tau, REVEAL.open), small = Math.max(14, REVEAL.small * grow * Math.min(width, height));
  const r = small * b.radius, full = reach(...at, width, height), R = r + (full - r) * b.ex;
  const light = smooth(tau / REVEAL.light);
  return { ...b, R, at, small, pop: tau >= BURST,
    rim: clamp(R / (0.5 * small)) * (1 - smooth((b.ex - 0.7) / 0.3)),
    // The site's existing warm cream/gold radial touch glow, not a new flash.
    // It builds over .45s, stays behind the bubble and fades over .4s at pop.
    glow: light * (1 - smooth((tau - BURST) / 0.4)),
    glowScale: (0.3 + 0.7 * light) * (1 + 0.6 * b.ex),
    glowSize: Math.max(120, 300 * scale),
  };
}
