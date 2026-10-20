// The website's contact reveal, also drawn by the lock. Both are only renderers
// of this result: same recording, bubble, edge, touch light and burst clock.
import { BURST, bubbleMotion } from './bootup.mjs';
import { reach } from './bubble.mjs';
export const REVEAL = Object.freeze({ breathe: BURST, open: 0.8, length: BURST + 0.8, fade: BURST, small: 0.095, light: 0.45 });
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
// grow (opt-in, the launch page's): a larger breathing bubble before the pop; 1 is the lock's. motion (opt-in, the
// launch page's): the bubble's motion, bubble-sound.mjs's soundMotion; bootup.mjs's bubbleMotion is the lock's.
export function revealAt(tau, { at, width, height, scale = width / 1536, grow = 1, motion = bubbleMotion }) {
  const b = motion(tau, REVEAL.open), small = Math.max(14, REVEAL.small * grow * Math.min(width, height));
  const r = small * b.radius, full = reach(...at, width, height), R = r + (full - r) * b.ex;
  const light = smooth(tau / REVEAL.light);
  // shine (soundMotion's only): the touch light brightens with the sound's loudness, brightness and hits.
  // The rim stays fully opaque; only its shape moves with the sound.
  const lit = b.shine ?? null;
  return { ...b, R, at, small, pop: tau >= BURST,
    rim: 1,
    // The site's existing warm cream/gold radial touch glow, not a new flash.
    // It builds over .45s, stays behind the bubble and fades over .4s at pop.
    glow: light * (1 - smooth((tau - BURST) / 0.4)) * (lit === null ? 1 : 0.8 + 0.2 * lit),
    glowScale: (0.3 + 0.7 * light) * (1 + 0.6 * b.ex) * (lit === null ? 1 : 1 + 0.12 * b.kick),
    glowSize: Math.max(120, 300 * scale),
  };
}
