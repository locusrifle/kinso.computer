// The launch page's bubble, mapped to the sound (opt-in). soundMotion(t, open) is a drop-in for bootup.mjs's
// bubbleMotion: pass it as revealAt(tau, { motion: soundMotion }) and the motion object as bubblePath's 6th argument.
// Only the launch page uses it (intro/intro.mjs). The lock and imperfect OS keep bootup.mjs's HITS/BUBBLE/bubbleMotion
// as they are (bootup.mjs is untouched and imports nothing new). The measurements and the comparison are in
// ~/workbench/bootup/bubble-bench/ (bootup-sound.mjs is generated there by tools/soundmap.py).
//
// The membrane: its body follows the sound's perceived loudness (fast attack, slow release, no synthetic beat); each
// salient hit leaps it, the leap's peak on the hit's transient peak, by the hit's strength; the hit also strikes the rim,
// a bump that runs round it both ways. The surface's wobble and its speed follow the texture's agitation (dull and slow
// in the steady engine, rough and quick in the crescendo and the burst). The burst's opening is driven by the loudness
// after it.
import { BURST, envelope } from './bootup.mjs';
import { SOUND_FPS, BODY, PUSH, AGIT, BRIGHT, HITS2 } from './bootup-sound.mjs';
export { HITS2 };
// The hits the bubble leaps on, at their transient peaks (the maximum of the 4 ms K-weighted level): the recording's
// salient cracks and thumps up to the burst (HITS2 kinds 0 and 1; their echoes move it less).
export const HITS = Object.freeze(HITS2.filter(([t, , kind]) => t <= BURST && kind < 2).map(([t]) => t));
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
const at = (a, t) => {
  const f = Math.max(0, Math.min(a.length - 1, t * SOUND_FPS)), i = Math.floor(f);
  return a[i] + ((a[i + 1] ?? a[i]) - a[i]) * (f - i);
};
//   seed: the sound's first breath (the bubble is born there and swells with the rising whistle to seedSize of its body)
//   size: radius (x the small bubble) per unit of body loudness: ~0.54 in the steady engine, ~0.95 at the burst
//   gain: a full-strength hit's leap, share of the radius; attack: its rise, ending on the transient peak (a quarter
//   sine: it starts as a strike and arrives without a corner); release: its settle's time constant (critically damped,
//   ~250 ms to rest, never below it); echo: an echo's weight
//   ripple: a full-strength hit's rim bump (share of R); life: how long it runs; fade: its decay time constant
//   calm/rough/shake: the wobble's scale in the engine, added by agitation, added by a hit; drift/whirl/jolt: the
//   wobble's speed in the engine, added by agitation, and the twist a full-strength hit gives it
//   open: the opening's ease (velocity ~ (1-u)^open x loudness^drive); fine: the surface's grain, x agitation
export const BUBBLE = Object.freeze({ seed: 0.035, seedSize: 0.5, size: 1.0, gain: 0.65, attack: 0.016, release: 0.07, echo: 0.6,
  ripple: 0.11, life: 0.5, fade: 0.2, calm: 0.9, rough: 1.0, shake: 0.4, drift: 1.4, whirl: 3.6, jolt: 0.5, open: 3.5, drive: 2,
  fine: 1 });
const A = BUBBLE.attack, RL = BUBBLE.release;
// one hit's leap: 0 before, rising to 1 on its transient peak (s = 0), settling back to 0
const leap = s => s <= -A ? 0 : s <= 0 ? Math.sin(Math.PI / 2 * (s + A) / A) : Math.exp(-s / RL);
const weight = ([, a, kind]) => a * (kind === 2 ? BUBBLE.echo : 1);
// kick: 0 at rest, up to 1. Hits combine without exceeding 1 (an echo on a primary's settle is a shoulder, not a leap).
export function kickAt(t) {
  let rest = 1;
  for (const h of HITS2) { const s = t - h[0]; if (s <= -A) break; if (s < 1.5) rest *= 1 - weight(h) * leap(s); }
  return 1 - rest;
}
// the rim's ripples: [amplitude share of R, angle, age], for bubblePath (bubble.mjs)
const GOLD = Math.PI * (3 - Math.sqrt(5));
export function ripplesAt(t) {
  const out = [];
  for (let i = 0; i < HITS2.length; i++) {
    const h = HITS2[i], s = t - h[0];
    if (s <= -A) break;
    if (s > BUBBLE.life) continue;
    const a = BUBBLE.ripple * weight(h) * (s <= 0 ? Math.sin(Math.PI / 2 * (s + A) / A) : Math.exp(-s / BUBBLE.fade));
    out.push([a, Math.PI + i * GOLD, s]);
  }
  return out;
}
// the bubble's birth: from a point at the seed, swelling with the seed's rising whistle; the first thump completes it
const THUMP = HITS2[0][0];
function bornAt(t) {
  if (t <= BUBBLE.seed) return 0;
  const seed = BUBBLE.seedSize * (1 - (1 - clamp((t - BUBBLE.seed) / (THUMP - A - BUBBLE.seed))) ** 2);
  return seed + (1 - seed) * smooth((t - THUMP + A) / A);
}
// the wobble's time: the integral of its speed (slow in the engine, quicker with agitation), and each hit's twist
const movement = [0];
for (let i = 0; i < AGIT.length; i++) movement.push(movement[i] + (BUBBLE.drift + BUBBLE.whirl * AGIT[i]) / SOUND_FPS);
const twist = t => { let j = 0; for (const h of HITS2) { const s = t - h[0] + A; if (s <= 0) break; j += weight(h) * smooth(s / 0.12); } return j * BUBBLE.jolt; };
// the opening after the burst: its velocity ~ (1-u)^open (a pop that slows) x loudness^drive (the burst's roar pushes
// it, the decay lets it coast), normalised to reach 1 at BURST + open. Tabulated per opening length.
const opening = new Map();
function exAt(t, open) {
  if (t <= BURST) return 0;
  if (t >= BURST + open) return 1;
  let c = opening.get(open);
  if (!c) {
    const n = 400; c = new Float64Array(n + 1);
    const v = u => (1 - u) ** BUBBLE.open * at(PUSH, BURST + u * open) ** BUBBLE.drive;
    for (let i = 1; i <= n; i++) c[i] = c[i - 1] + (v((i - 1) / n) + v(i / n)) / 2;
    for (let i = 1; i <= n; i++) c[i] /= c[n];
    opening.set(open, c);
  }
  const f = (t - BURST) / open * (c.length - 1), i = Math.floor(f);
  return c[i] + ((c[i + 1] ?? 1) - c[i]) * (f - i);
}
// Radius in units of the small bubble, as bubbleMotion's. body: the loudness (1 = the loudest stretch), agit: the
// texture's agitation, shine: how bright the rim and the touch light are (loudness, brightness and the hits), 0..1;
// ripples and fine: for bubblePath.
export function soundMotion(t, open = 0.8) {
  const a = envelope(t), ex = exAt(t, open), kick = kickAt(t);
  const body = at(BODY, t), agit = at(AGIT, t), bright = at(BRIGHT, t);
  const full = bornAt(t) * BUBBLE.size * body;
  const radius = full * (1 + BUBBLE.gain * kick);
  const f = Math.max(0, Math.min(movement.length - 1, t * SOUND_FPS)), i = Math.floor(f);
  const wt = movement[i] + ((movement[i + 1] ?? movement[i]) - movement[i]) * (f - i) + twist(t);
  return { ...a, kick, full, radius, ex, body, agit,
    wob: (BUBBLE.calm + BUBBLE.rough * agit + BUBBLE.shake * kick) * (1 - ex) + ex,
    wt, ripples: ex < 1 ? ripplesAt(t).map(([amp, th, age]) => [amp * (1 - ex), th, age]) : [], fine: BUBBLE.fine * agit * (1 - ex),
    shine: clamp(0.12 + 0.6 * (body - 0.4) / 0.65 + 0.25 * bright + 0.45 * kick),
    done: t >= BURST + open };
}
