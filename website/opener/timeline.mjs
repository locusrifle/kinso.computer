// The opener as a pure function of scroll progress p (0..1); t (seconds) drives the coat and robe's slow sway.
//   0    .. 0.75  approach: both drift in and their limbs ease from the start pose into the painted pose
//                 (the start pose is the one the figures used to reach 40% of the way in, POSE_FROM: Noah's wand arm
//                 level, his front knee up, Locus's arm where it was then; Noah chose it 12 Oct)
//   0.75 .. 0.8   contact held; a soft light grows where the wand touches her fingertip
//   0.8  .. 1     the galaxy opens in a warpy bubble from the contact
// Every offset and angle is exactly 0 at p = 0.75, so the contact frame is the painting.
import { START } from './cast.mjs';

export const CONTACT = 0.75, HOLD = 0.8;
// Limbs, lean and turn start this far along their old way in (p = 0.4 of the original approach) and run from there to
// the painting; the drift, bob and sway still run from the very first scroll.
export const POSE_FROM = 0.4 / CONTACT;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = t => t * t * (3 - 2 * t);
// 1 until q reaches a, then eases to 0 by q = b
const left = (q, a, b) => 1 - smooth(clamp((q - a) / (b - a)));

export function timeline(p, t = 0) {
  p = clamp(Number(p) || 0);
  const q = clamp(p / CONTACT);                    // approach progress
  const travel = (1 - q) ** 2;                     // share of each start offset still to travel: moving from the
                                                   // first scroll, settling softly onto the contact
  const settle = (1 - q) ** 2;                     // bob, roll, yaw and sway die away into the contact
  const k = POSE_FROM + (1 - POSE_FROM) * q;       // pose progress: limbs, lean and turn
  const TAU = 2 * Math.PI;
  const locus = {
    travel,
    bob: [3 * Math.sin(TAU * 0.9 * q + 0.6) * settle, 13 * Math.sin(TAU * 1.4 * q) * settle],
    roll: -7 * left(k, 0, 0.94) + 1.6 * Math.sin(TAU * 1.1 * q) * settle,
    yaw: 9 * left(k, 0, 0.9),
    chains: {
      arm: [START.locus.arm[0] * left(k, 0.04, 0.86), START.locus.arm[1] * left(k, 0.1, 0.92), START.locus.arm[2] * left(k, 0.16, 0.96)],
      leg: [START.locus.leg[0] * left(k, 0, 0.82), START.locus.leg[1] * left(k, 0.05, 0.86)],
    },
    sway: { amp: 4.5 * (1 - smooth(q)), t },
  };
  const vaita = {
    travel,
    bob: [-3 * Math.sin(TAU * 0.8 * q + 1.9) * settle, 10 * Math.sin(TAU * 1.2 * q + 1.0) * settle],
    roll: 6 * left(k, 0, 0.94) - 1.4 * Math.sin(TAU * 0.9 * q + 0.4) * settle,
    yaw: -9 * left(k, 0, 0.9),
    chains: {
      arm: [START.vaita.arm[0] * left(k, 0.08, 0.9), START.vaita.arm[1] * left(k, 0.14, 0.94), START.vaita.arm[2] * left(k, 0.2, 0.97)],
    },
    sway: { amp: 7 * (1 - smooth(q)), t },
  };
  const light = p < CONTACT ? 0 : p < HOLD ? smooth((p - CONTACT) / (HOLD - CONTACT)) : 1 - smooth(clamp((p - HOLD) / 0.1));
  const open = smooth(clamp((p - HOLD) / (1 - HOLD)));
  return { p, q, dolly: travel, locus, vaita, light, open, contact: p >= CONTACT };
}
