// sharks.mjs: ASCII sharks swimming on a character grid, for Kinso Computer.
//
//   import { swim } from './sharks.mjs';
//   const stop = swim(canvas, { cell: 14, sharks: 4, enter: true, palette: 'light', avoid: () => [rect] });
//   stop();
//
// Canvas 2D, no dependencies. Every shark is a parametric body outline (head,
// pectoral and pelvic fins, tail) laid along a path its head has swum, with a
// travelling wave from head to tail. Each frame the outline is sampled at the
// centre of every character cell it covers; the cell gets a tinted tile and a
// glyph from a pre-rendered sprite atlas, so a frame is one drawImage per cell.
//
// The same sea can be drawn two other ways (render: 'smooth', 'dots'; see
// DEFAULTS); the swimming never depends on how it is drawn.

const TAU = Math.PI * 2;
const SPINE = 36; // samples along a body

// The glyphs, in one row of the atlas per tone.
const GLYPHS = ['@', '8', '%', '#', 'S', 'X', 't', ';', ':', "'", ',', '.', '`', 'o', '-'];
const G = GLYPHS.length;
const gi = c => GLYPHS.indexOf(c);
const set = s => Int8Array.from([...s].map(gi));
const BAND_DARK = set('%8@#8%S@');
const BAND_DENSE = set('SXS%8X%#S@tX');
const BAND_MID = set('S%tXSt%S#X8;');
const BAND_LIGHT = set('t;:%S#t:;X');
const BAND_FAINT = set(";:'%#:;t");
const EDGE_MARKS = 4; // ' , . `

const TONES = 10; // 0 = the dark tile, 1..9 dense to faint
const TINTS = ['blue', 'warm', 'grey'];
const ACCENTS = 6;

// Sprite ids.
const bodyId = (tint, tone, ink, g) => ((tint * TONES + tone) * 2 + ink) * G + g;
const ACC0 = TINTS.length * TONES * 2 * G;
const accentId = (hue, style, g) => ACC0 + (hue * 2 + style) * G + g;
const SP0 = ACC0 + ACCENTS * 2 * G;
// (SP0 and SP0 + 1 were ink eyes; sharks no longer have them)
const EDGE = SP0 + 2; // + shade * 4 + mark
const DASH = EDGE + 12; // + shade 0..2
const DOT = DASH + 3; // + tint * 4 + level
const EDGE_T = DOT + 8; // edges in the body's own colours: + (tint * 3 + shade) * 4 + mark
const SPRITES = EDGE_T + TINTS.length * 12;

const PALETTES = {
  light: {
    ground: '#fcfcfb',
    grid: 'rgba(40,40,30,0.055)',
    tints: {
      blue: { dark: '#151b28', lo: '#5d6572', hi: '#c2c6d0', faint: '#dcdee4', inkLo: '#eef2f9', inkHi: '#eef1f7', inkFaint: '#a7abb5' },
      warm: { dark: '#271f18', lo: '#635d55', hi: '#c8c2bc', faint: '#dfdbd7', inkLo: '#fbf7f1', inkHi: '#f6f2ee', inkFaint: '#ada8a3' },
      grey: { dark: '#202122', lo: '#6c6d6f', hi: '#c9c9ca', faint: '#dfdfdf', inkLo: '#f4f4f4', inkHi: '#f2f2f2', inkFaint: '#ababab' },
    },
    blackInk: '#0e1117',
    accentBase: '#80858e',
    accents: ['#2e8b57', '#24878a', '#8a5bd6', '#d4507c', '#c97a2e', '#5470d8'],
    edge: ['#8e929a', '#aeb1b8', '#cbcdd2'],
    dash: ['#3b3e44', '#8a8e95', '#bdbfc4'],
    dot: ['#a9afb6', '#86aea7'],
  },
  dark: {
    ground: '#0b0c0f',
    grid: 'rgba(255,255,255,0.032)',
    tints: {
      blue: { dark: '#7f8cab', lo: '#3e4759', hi: '#20242d', faint: '#16181d', inkLo: '#e9eef7', inkHi: '#a5aebf', inkFaint: '#474c57' },
      warm: { dark: '#9a8b7b', lo: '#4b443c', hi: '#25221e', faint: '#181715', inkLo: '#f6efe7', inkHi: '#b5aba1', inkFaint: '#4b4741' },
      grey: { dark: '#8b9099', lo: '#44474e', hi: '#232529', faint: '#17181a', inkLo: '#f0f2f5', inkHi: '#acb0b7', inkFaint: '#484b51' },
    },
    blackInk: '#0b0c0f',
    accentBase: '#3e434c',
    accents: ['#47b37a', '#3fb0b3', '#a283ea', '#e7709a', '#e09450', '#7b93ee'],
    edge: ['#6a707b', '#4c515a', '#363a41'],
    dash: ['#b9bec7', '#6b7079', '#41454c'],
    dot: ['#4f5560', '#3f6e66'],
  },
  // Kinso's own colours: its peach, coral and teal (the brand gradient runs
  // peach to coral to teal) and its orange for accents, on its warm white.
  // Nothing is drawn in black: the ink glyphs and the marks along the edges
  // take each body's own darker tone (blackInk and edge null). along: each
  // species' colour turns toward the next along its body, snout to tail, as
  // in the brand gradient.
  kinso: {
    ground: '#fcfcfb',
    grid: 'rgba(115,92,74,0.06)',
    tints: {
      blue: { dark: '#173f3c', lo: '#4ea8a2', hi: '#b6e0dc', faint: '#dcf0ee', inkLo: '#effaf9', inkHi: '#f2faf9', inkFaint: '#8dbcb8' },
      warm: { dark: '#4b2013', lo: '#d2714e', hi: '#f2c4b0', faint: '#f9e5db', inkLo: '#fff3ed', inkHi: '#fff5f0', inkFaint: '#d29884' },
      grey: { dark: '#4e3415', lo: '#d9a463', hi: '#f6dfc0', faint: '#fbf0e1', inkLo: '#fff8ee', inkHi: '#fffaf3', inkFaint: '#cdab82' },
    },
    along: { blue: 'warm', warm: 'blue', grey: 'warm' },
    blackInk: null,
    accentBase: '#737373',
    accents: ['#ff6d33', '#de8363', '#67bcb7', '#edbf86', '#ff6d33', '#67bcb7'],
    edge: null,
    dash: ['#3d3a38', '#737373', '#c4bcb6'],
    dot: ['#cdbbad', '#8ccac5'],
  },
  // The same on Kinso Dark's near-black: lit from within, like the dark palette.
  'kinso-dark': {
    ground: '#0d0d0d',
    grid: 'rgba(255,255,255,0.03)',
    tints: {
      blue: { dark: '#a6e3de', lo: '#3c8984', hi: '#1c3a38', faint: '#121a19', inkLo: '#eefaf9', inkHi: '#9fd3cf', inkFaint: '#2f5755' },
      warm: { dark: '#f7bba3', lo: '#b55f3f', hi: '#47231a', faint: '#1a1210', inkLo: '#fff1ea', inkHi: '#efb49d', inkFaint: '#5c3427' },
      grey: { dark: '#f8dcb4', lo: '#b4874e', hi: '#46341b', faint: '#19140e', inkLo: '#fff7ec', inkHi: '#e8c79a', inkFaint: '#5a4428' },
    },
    along: { blue: 'warm', warm: 'blue', grey: 'warm' },
    blackInk: null,
    accentBase: '#3a3a3a',
    accents: ['#ff6d33', '#de8363', '#67bcb7', '#edbf86', '#ff6d33', '#67bcb7'],
    edge: null,
    dash: ['#cfc8c2', '#737373', '#454545'],
    dot: ['#4a4038', '#2f5c59'],
  },
};

// Bodies, seen from above. s runs from the snout (0) to the tail tip (1); u is
// the half-width as a fraction of body length. Fins are triangles in (s, u):
// leading root, tip, trailing root, and how dense they read. wave is how the
// body swims: the length of its body wave, in body lengths, and how much of
// the tail's swing reaches mid-body. Hammerheads and reef sharks swim with
// the back half (carangiform); the leopard shark bends more of its length.
const SPECIES = {
  hammerhead: {
    tint: 'blue', weight: 0.4, len: [29, 37], speed: [0.18, 0.27],
    body: [[0, 0.02], [0.04, 0.04], [0.09, 0.05], [0.15, 0.075], [0.23, 0.098], [0.31, 0.105], [0.4, 0.1],
      [0.5, 0.086], [0.6, 0.066], [0.7, 0.045], [0.78, 0.03], [0.86, 0.02], [0.94, 0.012], [1, 0.004]],
    hammer: { span: 0.215, sweep: 0.045, back: 0.088 },
    fins: [[[0.2, 0.09], [0.4, 0.25], [0.33, 0.095], 0.62], [[0.58, 0.06], [0.68, 0.11], [0.65, 0.05], 0.4],
      [[0.82, 0.02], [0.995, 0.065], [0.92, 0.012], 0.4]],
    dorsal: [0.27, 0.45], eyes: null, saddles: 0, spots: 0, wave: [0.9, 0.22],
  },
  leopard: {
    tint: 'warm', weight: 0.34, len: [26, 33], speed: [0.2, 0.3],
    body: [[0, 0], [0.015, 0.035], [0.04, 0.06], [0.09, 0.08], [0.17, 0.094], [0.25, 0.097], [0.33, 0.09],
      [0.42, 0.076], [0.5, 0.06], [0.58, 0.046], [0.67, 0.034], [0.77, 0.024], [0.87, 0.016], [0.95, 0.01], [1, 0.003]],
    hammer: null,
    fins: [[[0.15, 0.085], [0.31, 0.2], [0.27, 0.088], 0.6], [[0.45, 0.065], [0.55, 0.115], [0.53, 0.05], 0.42],
      [[0.66, 0.03], [0.9, 0.055], [0.98, 0.014], 0.38]],
    dorsal: [0.3, 0.42], eyes: [0.05, 0.056], saddles: 7.5, spots: 0.07, wave: [0.72, 0.36],
  },
  reef: {
    tint: 'grey', weight: 0.26, len: [23, 30], speed: [0.22, 0.33],
    body: [[0, 0], [0.02, 0.02], [0.06, 0.044], [0.12, 0.066], [0.2, 0.082], [0.28, 0.088], [0.36, 0.083],
      [0.46, 0.068], [0.56, 0.05], [0.66, 0.035], [0.74, 0.024], [0.8, 0.017], [0.9, 0.012], [1, 0.003]],
    hammer: null,
    fins: [[[0.2, 0.075], [0.4, 0.235], [0.31, 0.08], 0.6], [[0.56, 0.045], [0.65, 0.09], [0.62, 0.04], 0.4],
      [[0.8, 0.015], [0.99, 0.075], [0.9, 0.01], 0.42]],
    dorsal: [0.3, 0.42], eyes: [0.075, 0.05], saddles: 0, spots: 0, wave: [0.85, 0.25],
  },
};

const DEFAULTS = {
  cell: 'auto', // CSS px: the height of a character cell; 'auto' is about 1/76 of the shorter side (12..16, 10..16 on HiDPI)
  aspect: 2 / 3, // cell width / height
  sharks: 4,
  enter: false,
  palette: 'light',
  avoid: null,
  ground: true, // paint the ground (and the characters' faint grid); false leaves the canvas transparent
  plankton: true,
  wake: true,
  speed: 1,
  size: 1,
  seed: undefined,
  font: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
  // How the same sea is drawn: 'ascii' (characters on the grid), 'smooth'
  // (outlines and shading at full resolution, no grid) or 'dots' (a still
  // field of identical dots that light up where a shark is under them).
  render: 'ascii',
  pitch: 9, // dots: CSS px from one dot to the next
  dot: 0.66, // dots: a dot's size, as a share of the pitch
  shape: 'round', // dots: 'round' or 'square'
  rest: 0, // dots: how faintly an empty dot shows, 0 (not at all) to 1
  // Eyes: none by default. true marks each eye faintly, one shade darker
  // than the body around it; never in ink.
  eyes: false,
};

// ---------- small helpers

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(a, b, c) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = a => { a %= TAU; return a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a; };
const rgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mixc = (a, b, t) => [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t));
const css = c => `rgb(${c[0]},${c[1]},${c[2]})`;
// Smooth noise in time: random values a unit apart, eased between, so a
// wandering course bends gently and never repeats.
function drift(seed, t) {
  const i = Math.floor(t), f = t - i, e = f * f * f * (f * (f * 6 - 15) + 10);
  return lerp(hash(seed, i, 71), hash(seed, i + 1, 71), e) * 2 - 1;
}

// How sharks swim. Thrust from the tail grows with the square of how hard it
// beats and the water drags back with the square of the speed, so a shark
// settles at its cruising speed, slows through a glide, and takes seconds to
// gather speed again. It turns by a yaw rate that eases in and out, never
// tighter than a radius its speed allows: no pivoting on the spot.
const DRAG_S = 5; // gliding from cruising speed, the speed halves in this many seconds
const TURN_RADIUS = 0.3; // the tightest turn, in body lengths
const TURN_MAX = 0.85; // rad/s, at any speed
const YAW_S = 0.45; // how quickly the yaw rate follows the steering
const STRIDE = 0.6; // body lengths swum per tail beat
const STIFF = 0.8; // how much of its path's bend the body takes up; the rest swings the tail wide
const CANDIDATES = 9, AHEAD = 6; // curves considered at each look ahead, and points along each

function resolvePalette(p) {
  if (p && typeof p === 'object') {
    const base = PALETTES[p.base] || PALETTES.light;
    return { ...base, ...p, tints: { ...base.tints, ...(p.tints || {}) } };
  }
  return PALETTES[p] || PALETTES.light;
}

// Species, prepared: a half-width table, fin edges for distance tests, and how
// far each spine segment can reach sideways.
const PREP = {};
for (const [name, sp] of Object.entries(SPECIES)) {
  const table = new Float32Array(257);
  for (let i = 0; i <= 256; i++) {
    const s = i / 256; const b = sp.body;
    let k = 0; while (k < b.length - 2 && b[k + 1][0] < s) k++;
    const [s0, w0] = b[k], [s1, w1] = b[k + 1];
    table[i] = lerp(w0, w1, clamp((s - s0) / (s1 - s0), 0, 1));
  }
  const fins = sp.fins.map(([a, b, c, d]) => {
    const pts = [a, b, c];
    // make the winding consistent so outward normals point out
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (area < 0) { pts[1] = c; pts[2] = b; }
    const edges = [];
    for (let i = 0; i < 3; i++) {
      const p = pts[i], q = pts[(i + 1) % 3];
      const ex = q[0] - p[0], ey = q[1] - p[1], len = Math.hypot(ex, ey);
      edges.push([p[0], p[1], ey / len, -ex / len]);
    }
    const smin = Math.min(a[0], b[0], c[0]), smax = Math.max(a[0], b[0], c[0]);
    return { edges, smin, smax, root: Math.min(a[1], c[1]), tip: b[1], d };
  });
  const reach = new Float32Array(SPINE - 1);
  for (let k = 0; k < SPINE - 1; k++) {
    const s0 = k / (SPINE - 1), s1 = (k + 1) / (SPINE - 1);
    let r = 0;
    for (let i = Math.floor(s0 * 256); i <= Math.ceil(s1 * 256); i++) r = Math.max(r, table[i]);
    for (const f of fins) if (f.smax >= s0 - 0.03 && f.smin <= s1 + 0.03) r = Math.max(r, f.tip);
    if (sp.hammer && s0 < sp.hammer.back + sp.hammer.sweep + 0.02) r = Math.max(r, sp.hammer.span);
    reach[k] = r;
  }
  // The swing along the body, as a share of the tail's: a parabola from a
  // twentieth at the snout, through the species' share at mid-body, to all
  // of it at the tail tip.
  const mid = sp.wave[1], a2 = 4 * (0.53 - mid);
  const swing = [0.06, 0.94 - a2, a2];
  let front = 0;
  for (let k = 0; k < (SPINE - 1) / 2; k++) front = Math.max(front, reach[k]);
  PREP[name] = { ...sp, name, table, finsP: fins, reach, front, swing, k: TAU / sp.wave[0], tintIndex: TINTS.indexOf(sp.tint) };
}

// How far the body swings sideways at s, in body lengths, for a tail swing A
// and the wave's phase. Toward the tail the wave falls further behind, so the
// caudal fin trails the body by a seventh of a beat more than the wave alone.
function swingAt(sp, A, phase, s) {
  const w = sp.swing;
  return A * (w[0] + s * (w[1] + s * w[2])) * Math.sin(sp.k * s + 0.9 * smooth(0.6, 1, s) - phase);
}

// A tint's colour for a body density d, as the character tiles shade it:
// faint at the thin edge of a fin, through hi and lo, to the dark core along
// the back. Seen from above, a shark is countershaded: darker down its back,
// lighter toward its flanks, and its tail paler than its head.
function tintRamp(t) { return { dark: rgb(t.dark), lo: rgb(t.lo), hi: rgb(t.hi), faint: rgb(t.faint) }; }
function shadeAt(r, d) {
  if (d >= 0.95) return mixc(r.lo, r.dark, Math.min(1, (d - 0.95) / 0.35) * 0.8);
  if (d >= 0.4) return mixc(r.hi, r.lo, (d - 0.4) / 0.55);
  return mixc(r.faint, r.hi, Math.max(0, d) / 0.4);
}
const tailFade = s => 1 - 0.5 * smooth(0.42, 1, s);
const alongMix = s => smooth(0.1, 0.95, s);

// What a body is at (s, u): its density 0..1 and what kind of cell it is. An
// eye (only with an eye radius) keeps the density of the body under it.
const K_NONE = 0, K_BODY = 1, K_FIN = 2, K_EYE = 3, K_EDGE = 4, K_SPOT = 5;
// outSD: the signed distance to the outline, in body lengths (inside < 0).
let outD = 0, outK = 0, outSD = -1;
function shape(sp, s, t, L, edgeM, eyeR, tex) {
  const u = t < 0 ? -t / L : t / L;
  outD = 0; outK = K_NONE; outSD = -1;
  if (s < -0.04 || s > 1.04) return;
  let sd = 9; // signed distance to the outline, in body lengths (approximate)
  // body
  if (s >= 0 && s <= 1) {
    const w = sp.table[(s * 256 + 0.5) | 0];
    const out = u - w;
    if (out <= 0) {
      const q = w > 0 ? u / w : 0;
      let d = 0.98 - 0.52 * q * q;
      if (s > 0.42) d *= 1 - 0.5 * smooth(0.42, 1, s);
      if (s < 0.05) d *= 0.86;
      if (sp.dorsal && s > sp.dorsal[0] && s < sp.dorsal[1] && q < 0.35) d += 0.12;
      if (sp.saddles && s > 0.08 && s < 0.8 && Math.sin(s * TAU * sp.saddles + 1.3) > 0.45) d += 0.2;
      outD = d; outK = K_BODY;
      if (sp.spots && s > 0.07 && s < 0.75 && q < 0.85 && tex < sp.spots) outK = K_SPOT;
    }
    sd = out;
  } else sd = s < 0 ? Math.max(-s, u - 0.02) : Math.max(s - 1, u);
  // the hammer
  const h = sp.hammer;
  if (h && s < h.back + h.sweep + 0.05 && u < h.span + 0.05) {
    const r = u / h.span;
    const front = -0.012 + (h.sweep + 0.012) * r * r, back = h.back + 0.006 * r * r;
    const hsd = Math.max(front - s, s - back, u - h.span);
    if (hsd <= 0) {
      const d = 0.74 - 0.24 * r;
      if (u > h.span - eyeR * 3.2) { outK = K_EYE; outD = Math.max(outD, d); return; }
      if (d > outD) { outD = d; outK = K_BODY; }
    }
    if (hsd < sd) sd = hsd;
  }
  // eyes
  if (sp.eyes && outK === K_BODY) {
    const es = (s - sp.eyes[0]) * L, eu = (u - sp.eyes[1]) * L;
    if (es * es + eu * eu < eyeR * eyeR * L * L) { outK = K_EYE; return; }
  }
  // fins
  const fins = sp.finsP;
  for (let i = 0; i < fins.length; i++) {
    const f = fins[i];
    if (s < f.smin - edgeM || s > f.smax + edgeM || u > f.tip + edgeM) continue;
    let fd = -9;
    for (let e = 0; e < 3; e++) {
      const E = f.edges[e];
      const v = (s - E[0]) * E[2] + (u - E[1]) * E[3];
      if (v > fd) fd = v;
    }
    if (fd <= 0) {
      const frac = clamp((u - f.root) / (f.tip - f.root), 0, 1);
      const d = f.d * (1 - 0.35 * frac);
      if (outK === K_NONE || (outK !== K_BODY && d > outD)) { outD = d; outK = K_FIN; }
    }
    if (fd < sd) sd = fd;
  }
  outSD = sd;
  if (outK === K_NONE && sd < edgeM) { outK = K_EDGE; outD = 1 - sd / edgeM; }
}

// ---------- the module

export function swim(canvas, options = {}) {
  const o = { ...DEFAULTS };
  for (const [k, v] of Object.entries(options || {})) if (v !== undefined) o[k] = v;
  const ctx = canvas.getContext('2d');
  const reduceQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let pal = resolvePalette(o.palette);
  const seed = o.seed ?? ((Math.random() * 2 ** 31) | 0);

  // geometry, in device px unless noted
  let dpr = 1, W = 0, H = 0, Wd = 0, Hd = 0; // W, H in CSS px
  let cwD = 9, chD = 14, cols = 0, rows = 0, ox = 0, oy = 0, cw = 9, ch = 14;
  let colX = new Float32Array(0), rowY = new Float32Array(0); // cell centres, CSS px
  let markS, bestD, bestS, bestT, fbStamp, fbSprite, fbPrio, frameCells, sharkCells, wake;
  let frameCellCount = 0, stampF = 0;
  let cells = null, dots = null; // the character grid, and the dot field (render: 'dots')
  let atlas = null, spriteX = new Int32Array(SPRITES), spriteY = new Int32Array(SPRITES), groundPattern = null;

  // the world
  let rnd, time, sharks, slots, clouds, motes;
  let avoidRects = [], avoidAge = 1e9;
  let raf = 0, last = 0, running = false, stopped = false;
  const stats = { frames: 0, ms: 0 };

  function readAvoid() {
    if (typeof o.avoid !== 'function') { avoidRects = []; return; }
    try {
      const got = o.avoid() || [];
      avoidRects = Array.from(got).filter(Boolean).map(r => ({
        left: r.left ?? r.x, top: r.top ?? r.y,
        right: r.right ?? (r.x + r.width), bottom: r.bottom ?? (r.y + r.height),
      }));
    } catch { avoidRects = []; }
  }

  // ---------- sizing, atlas, ground

  function measure() {
    const r = canvas.getBoundingClientRect();
    return [Math.max(1, r.width || canvas.clientWidth || 300), Math.max(1, r.height || canvas.clientHeight || 150), (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1];
  }

  function resize() {
    const [w, h, d] = measure();
    const cellChanged = d !== dpr || !atlas;
    const oldW = W, oldH = H;
    W = w; H = h; dpr = d;
    Wd = Math.round(W * dpr); Hd = Math.round(H * dpr);
    if (canvas.width !== Wd) canvas.width = Wd;
    if (canvas.height !== Hd) canvas.height = Hd;
    const cell = typeof o.cell === 'number' && o.cell > 0 ? o.cell : clamp(Math.round(Math.min(W, H) / 76), d >= 1.5 ? 10 : 12, 16);
    const nch = Math.max(5, Math.round(cell * dpr)), ncw = Math.max(3, Math.round(cell * o.aspect * dpr));
    const rebuild = cellChanged || nch !== chD || ncw !== cwD;
    chD = nch; cwD = ncw; cw = cwD / dpr; ch = chD / dpr;
    cols = Math.ceil(Wd / cwD) + 1; rows = Math.ceil(Hd / chD) + 1;
    ox = Math.floor((Wd - cols * cwD) / 2); oy = Math.floor((Hd - rows * chD) / 2);
    colX = new Float32Array(cols); rowY = new Float32Array(rows);
    for (let i = 0; i < cols; i++) colX[i] = (ox + (i + 0.5) * cwD) / dpr;
    for (let j = 0; j < rows; j++) rowY[j] = (oy + (j + 0.5) * chD) / dpr;
    const n = cols * rows;
    markS = new Int32Array(n); bestD = new Float32Array(n); bestS = new Float32Array(n); bestT = new Float32Array(n);
    fbStamp = new Int32Array(n); fbSprite = new Int32Array(n); fbPrio = new Float32Array(n);
    frameCells = new Int32Array(n); sharkCells = new Int32Array(n); wake = new Float32Array(n);
    stampF = 0;
    cells = { pw: cwD, ph: chD, cols, rows, ox, oy, colX, rowY, mark: markS, bestD, bestS, bestT, list: sharkCells, stamp: 0 };
    dots = null;
    if (o.render === 'dots') buildDots();
    if (rebuild) buildAtlas();
    buildGround();
    if (sharks && oldW && oldH) {
      for (const sh of sharks) {
        const L = bodyLength(sh.units), scale = L / sh.L;
        const x = sh.x * W / oldW, y = sh.y * H / oldH;
        for (let i = 0; i < sh.trN; i++) {
          sh.trX[i] = x + (sh.trX[i] - sh.x) * scale;
          sh.trY[i] = y + (sh.trY[i] - sh.y) * scale;
        }
        sh.x = x; sh.y = y; sh.L = L; sh.base *= scale; sh.U *= scale; sh.step *= scale;
        sh.tx *= W / oldW; sh.ty *= H / oldH;
        spine(sh);
      }
      separate();
    }
  }

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }

  function buildAtlas() {
    const perRow = 32;
    const c = makeCanvas(perRow * cwD, Math.ceil(SPRITES / perRow) * chD);
    const g = c.getContext('2d');
    const fontPx = Math.max(5, Math.round(chD * 0.66));
    g.font = `600 ${fontPx}px ${o.font}`;
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const m = g.measureText('S');
    const cap = m.actualBoundingBoxAscent || fontPx * 0.72;
    const base = Math.round((chD + cap) / 2);
    const gx = Math.max(1, Math.round(cwD * 0.12)), gy = Math.max(1, Math.round(chD * 0.08));
    const rx = Math.ceil(gx / 2), ry = Math.ceil(gy / 2), rw = cwD - gx, rh = chD - gy;
    for (let id = 0; id < SPRITES; id++) { spriteX[id] = (id % perRow) * cwD; spriteY[id] = Math.floor(id / perRow) * chD; }
    const tile = (id, bg, ink, glyph) => {
      const x = spriteX[id], y = spriteY[id];
      g.save(); g.beginPath(); g.rect(x, y, cwD, chD); g.clip();
      if (bg) { g.fillStyle = bg; g.fillRect(x + rx, y + ry, rw, rh); }
      if (glyph) { g.fillStyle = ink; g.fillText(glyph, x + cwD / 2, y + base); }
      g.restore();
    };
    TINTS.forEach((name, ti) => {
      const t = pal.tints[name];
      const dark = rgb(t.dark), lo = rgb(t.lo), hi = rgb(t.hi), faint = rgb(t.faint);
      const inkLo = rgb(t.inkLo), inkHi = rgb(t.inkHi), inkFaint = rgb(t.inkFaint), black = rgb(pal.blackInk || t.dark);
      // edge marks in this body's own colours, for palettes without edge greys
      [lo, mixc(lo, hi, 0.5), hi].forEach((col, sh) => ["'", ',', '.', '`'].forEach((mk, i) => tile(EDGE_T + (ti * 3 + sh) * 4 + i, null, css(col), mk)));
      for (let k = 0; k < TONES; k++) {
        let bg, ink;
        if (k === 0) { bg = dark; ink = mixc(inkLo, [255, 255, 255], 0.3); }
        else if (k <= 7) { const f = (k - 1) / 6; bg = mixc(lo, hi, f); ink = mixc(inkLo, inkHi, f); }
        else { bg = k === 8 ? mixc(hi, faint, 0.55) : faint; ink = inkFaint; }
        for (let gl = 0; gl < G; gl++) {
          tile(bodyId(ti, k, 0, gl), css(bg), css(ink), GLYPHS[gl]);
          tile(bodyId(ti, k, 1, gl), css(bg), css(k >= 8 ? mixc(black, bg, 0.35) : black), GLYPHS[gl]);
        }
      }
    });
    const abase = rgb(pal.accentBase);
    pal.accents.slice(0, ACCENTS).forEach((hx, h) => {
      const hue = rgb(hx);
      for (let gl = 0; gl < G; gl++) {
        tile(accentId(h, 0, gl), css(mixc(abase, hue, 0.6)), css(mixc(hue, [255, 255, 255], 0.55)), GLYPHS[gl]);
        tile(accentId(h, 1, gl), css(abase), css(hue), GLYPHS[gl]);
      }
    });
    (pal.edge || []).forEach((col, sh) => ["'", ',', '.', '`'].forEach((mk, i) => tile(EDGE + sh * 4 + i, null, col, mk)));
    const dw = Math.max(2, Math.round(cwD * 0.46)), dh = Math.max(1, Math.round(chD * 0.07));
    pal.dash.forEach((col, i) => {
      const x = spriteX[DASH + i], y = spriteY[DASH + i];
      g.fillStyle = col; g.fillRect(x + Math.round((cwD - dw) / 2), y + Math.round(chD / 2 - dh / 2), dw, dh);
    });
    const ds = Math.max(1, Math.round(cwD * 0.3));
    pal.dot.forEach((col, ti) => {
      for (let lv = 0; lv < 4; lv++) {
        const id = DOT + ti * 4 + lv, x = spriteX[id], y = spriteY[id];
        g.globalAlpha = [0.3, 0.5, 0.72, 0.95][lv];
        g.fillStyle = col; g.fillRect(x + Math.round((cwD - ds) / 2), y + Math.round((chD - ds) / 2), ds, ds);
        g.globalAlpha = 1;
      }
    });
    atlas = c;
  }

  function buildGround() {
    groundPattern = null;
    if (!o.ground) return;
    const c = makeCanvas(cwD, chD), g = c.getContext('2d');
    g.fillStyle = pal.ground; g.fillRect(0, 0, cwD, chD);
    g.fillStyle = pal.grid; g.fillRect(0, 0, 1, chD); g.fillRect(1, 0, cwD - 1, 1);
    groundPattern = ctx.createPattern(c, 'repeat');
  }

  // ---------- the world

  function resetWorld() {
    rnd = mulberry32(seed);
    time = 0; sharks = []; clouds = []; motes = [];
    slots = Array.from({ length: Math.max(0, o.sharks | 0) }, (_, i) => ({ shark: null, wait: 0, index: i }));
    if (wake) wake.fill(0);
  }

  function pickSpecies() {
    const live = {};
    for (const s of sharks) if (!s.dead) live[s.sp.name] = (live[s.sp.name] || 0) + 1;
    let best = null, bestScore = -1;
    for (const name of Object.keys(PREP)) {
      const n = live[name] || 0;
      const score = (0.35 + rnd()) * PREP[name].weight / ((1 + n) * (1 + n));
      if (score > bestScore) { bestScore = score; best = PREP[name]; }
    }
    return best;
  }


  function insideAvoid(x, y, m) {
    for (const r of avoidRects) if (x > r.left - m && x < r.right + m && y > r.top - m && y < r.bottom + m) return true;
    return false;
  }

  // Somewhere ahead to swim to: on screen, clear of the page's content, and
  // away from where the other sharks are and are going.
  function pickInterior(sh) {
    let best = null, bestScore = -1e9;
    // far enough in from the edges to turn round there
    const mx = Math.min(Math.max(W * 0.08, sh.L * 0.3), W * 0.35), my = Math.min(Math.max(H * 0.08, sh.L * 0.3), H * 0.35);
    for (let i = 0; i < 8; i++) {
      const x = mx + (W - 2 * mx) * rnd(), y = my + (H - 2 * my) * rnd();
      const dx = x - sh.x, dy = y - sh.y, d = Math.hypot(dx, dy) || 1;
      let score = Math.min(d, sh.L * 2) / sh.L;
      score += 0.5 * ((dx * Math.cos(sh.a) + dy * Math.sin(sh.a)) / d);
      if (d < sh.L * 0.8) score -= 2;
      if (insideAvoid(x, y, sh.L * 0.15)) score -= 3;
      let near = 1e9;
      for (const o2 of sharks) if (o2 !== sh && !o2.dead) near = Math.min(near, Math.hypot(o2.x - x, o2.y - y), Math.hypot(o2.tx - x, o2.ty - y));
      score += Math.min(near, sh.L * 1.5) / sh.L;
      score += 1.4 * Math.hypot((x - W / 2) / W, (y - H / 2) / H); // the edges more than the middle
      if (score > bestScore) { bestScore = score; best = [x, y]; }
    }
    sh.tx = best[0]; sh.ty = best[1];
  }

  function pickExit(sh) {
    const a = sh.a + (rnd() - 0.5) * 1.3;
    const dx = Math.cos(a), dy = Math.sin(a), m = sh.L * 1.3;
    // where the ray leaves the screen, pushed outward
    let t = 1e9;
    if (dx > 1e-3) t = Math.min(t, (W + m - sh.x) / dx); else if (dx < -1e-3) t = Math.min(t, (-m - sh.x) / dx);
    if (dy > 1e-3) t = Math.min(t, (H + m - sh.y) / dy); else if (dy < -1e-3) t = Math.min(t, (-m - sh.y) / dy);
    if (!(t > 0 && t < 1e8)) t = W + H;
    sh.tx = sh.x + dx * t; sh.ty = sh.y + dy * t;
  }

  function bodyLength(units) {
    return Math.min(ch * units * o.size, Math.max(ch * 12, 0.55 * Math.min(W, H) * o.size));
  }

  function spawn(slot, side, forced) {
    const sp = forced || pickSpecies(), units = lerp(sp.len[0], sp.len[1], rnd()), L = bodyLength(units);
    const sh = {
      sp, L, units, seed: (rnd() * 1e9) | 0, base: L * lerp(sp.speed[0], sp.speed[1], rnd()) * o.speed,
      x: 0, y: 0, a: 0, av: 0, tx: 0, ty: 0, legs: 1 + ((rnd() * 2.6) | 0), legT: 0, leaving: false,
      phase: rnd() * TAU, amp: lerp(0.065, 0.08, rnd()), bold: lerp(0.35, 1, rnd()),
      age: 0, seen: false, outside: 0, boost: 0, hold: 0, dead: false, z: rnd(),
      step: Math.max(1.5, L / 140), back: [0, 0],
      // swimming: speed, effort (1 cruises), the tail's swing, the steering
      U: 0, vx: 0, vy: 0, effort: 1, beat: 1, mode: 0, gaitT: 0, planT: 0, want: 0, cmd: 0, danger: 0, blocked: 0, yielding: false, radMax: 0,
    };
    sh.U = sh.base;
    // Its own random choices (glides, bursts), so they never shift the sea's.
    sh.rng = mulberry32(sh.seed ^ 0x5bd1e995);
    sh.gaitT = lerp(3, 9, sh.rng());
    sh.cap = Math.ceil((L * 1.3) / sh.step) + 8;
    sh.trX = new Float32Array(sh.cap); sh.trY = new Float32Array(sh.cap); sh.trN = 0; sh.trH = -1;
    sh.qx = new Float32Array(SPINE); sh.qy = new Float32Array(SPINE);
    sh.px = new Float32Array(SPINE); sh.py = new Float32Array(SPINE);
    sh.rad = new Float32Array(SPINE - 1);
    // enter from an edge, head just outside
    const pickSide = () => { const r = rnd() * 2 * (W + H); return r < W ? 0 : r < W + H ? 1 : r < 2 * W + H ? 2 : 3; };
    const m = cw * 1.5 + L * 0.06;
    let f = 0.08 + 0.84 * rnd(), sd = side ?? pickSide();
    for (let tries = 0; tries < 6 && side === undefined; tries++) {
      const x = sd === 0 || sd === 2 ? W * f : sd === 1 ? W : 0, y = sd === 1 || sd === 3 ? H * f : sd === 2 ? H : 0;
      let clear = true;
      for (const o2 of sharks) if (!o2.dead && Math.hypot(o2.x - x, o2.y - y) < L * 0.8) clear = false;
      if (clear) break;
      sd = pickSide(); f = 0.08 + 0.84 * rnd();
    }
    side = sd;
    if (side === 0) { sh.x = W * f; sh.y = -m; } else if (side === 1) { sh.x = W + m; sh.y = H * f; }
    else if (side === 2) { sh.x = W * f; sh.y = H + m; } else { sh.x = -m; sh.y = H * f; }
    sh.a = Math.atan2(H / 2 - sh.y, W / 2 - sh.x);
    pickInterior(sh);
    sh.a = Math.atan2(sh.ty - sh.y, sh.tx - sh.x) + (rnd() - 0.5) * 0.5;
    sh.back = [-Math.cos(sh.a), -Math.sin(sh.a)];
    pushTrail(sh);
    spine(sh);
    // The *whole* silhouette starts outside, not just its snout. Include
    // raster edge marks and half a tile; an angled hammer/tail can reach in.
    const b = bounds(sh), gap = Math.hypot(cw, ch);
    if (side === 0) translate(sh, 0, -gap - b.bottom);
    else if (side === 1) translate(sh, W + gap - b.left, 0);
    else if (side === 2) translate(sh, 0, H + gap - b.top);
    else translate(sh, -gap - b.right, 0);
    // Spawn clear of existing bodies too. Move only outward: entrance must
    // never be "fixed" by pushing a new shark onto the screen.
    const live = sharks.filter(s => !s.dead);
    const all = live.some(s => contact(sh, s)) ? live.map(bounds) : [];
    if (all.length) {
      if (side === 0) translate(sh, 0, Math.min(0, Math.min(...all.map(b => b.top)) - gap - bounds(sh).bottom));
      else if (side === 1) translate(sh, Math.max(0, Math.max(...all.map(b => b.right)) + gap - bounds(sh).left), 0);
      else if (side === 2) translate(sh, 0, Math.max(0, Math.max(...all.map(b => b.bottom)) + gap - bounds(sh).top));
      else translate(sh, Math.min(0, Math.min(...all.map(b => b.left)) - gap - bounds(sh).right), 0);
    }
    slot.shark = sh; sharks.push(sh);
    return sh;
  }

  function pushTrail(sh) {
    sh.trH = (sh.trH + 1) % sh.cap; sh.trX[sh.trH] = sh.x; sh.trY[sh.trH] = sh.y;
    if (sh.trN < sh.cap) sh.trN++;
  }

  // The body: the path its head swam, resampled into SPINE points, then laid
  // down again segment by segment from the snout, so its length never
  // changes. Each segment takes most of the path's bend at that point, not
  // all of it: a shark is stiffer than its path, so in a turn the body curves
  // in and the tail sweeps wide. On that line runs the swimming wave, from
  // head to tail: the snout barely yaws, the swing grows toward the tail and
  // the caudal fin lags behind the body.
  function spine(sh) {
    const L = sh.L, ds = L / (SPINE - 1), px = sh.px, py = sh.py;
    let cx = sh.x, cy = sh.y, k = 1, need = ds, i = 0, bx = sh.back[0], by = sh.back[1];
    px[0] = cx; py[0] = cy;
    while (k < SPINE && i < sh.trN) {
      const idx = (sh.trH - i + sh.cap) % sh.cap;
      const nx = sh.trX[idx], ny = sh.trY[idx];
      const sx = nx - cx, sy = ny - cy, sl = Math.hypot(sx, sy);
      if (sl < 0.05) { i++; continue; } // float32 trail vs float64 head: not a direction
      if (sl > 0.5) { bx = sx / sl; by = sy / sl; }
      if (sl >= need) { const f = need / sl; cx += sx * f; cy += sy * f; px[k] = cx; py[k] = cy; k++; need = ds; }
      else { need -= sl; cx = nx; cy = ny; i++; }
    }
    for (; k < SPINE; k++) { cx += bx * need; cy += by * need; need = ds; px[k] = cx; py[k] = cy; }
    const qx = sh.qx, qy = sh.qy, A = sh.amp * sh.beat, n = SPINE - 1;
    let h0 = swingAt(sh.sp, A, sh.phase, 0), was = sh.a, turned = 0;
    qx[0] = px[0]; qy[0] = py[0];
    for (let j = 0; j < n; j++) {
      const h1 = swingAt(sh.sp, A, sh.phase, (j + 1) / n);
      // how far the path has turned by here, counted on past half a turn
      const dir = Math.atan2(py[j] - py[j + 1], px[j] - px[j + 1]);
      turned += wrap(dir - was); was = dir;
      const ang = sh.a + STIFF * turned + Math.atan((h1 - h0) * n);
      qx[j + 1] = qx[j] - Math.cos(ang) * ds; qy[j + 1] = qy[j] - Math.sin(ang) * ds;
      h0 = h1;
    }
    sh.radMax = 0;
    for (let j = 0; j < n; j++) { sh.rad[j] = radius(sh, j); if (sh.rad[j] > sh.radMax) sh.radMax = sh.rad[j]; }
  }

  // Conservative capsules around EVERY rendered spine segment, including
  // hammer, fins, tail, edge marks and the tile footprint. The raster only
  // visits cells within reach*L + 1.2*cw of these segments. Padding by half
  // the tile diagonal therefore encloses even its furthest painted corner.
  function radius(sh, k) {
    // shape() also permits s down to -.04 / up to 1.04 on the
    // unclamped end segments. Enclose that longitudinal extension too.
    const end = k === 0 || k === SPINE - 2
      ? 0.04 * (SPINE - 1) * Math.hypot(sh.qx[k + 1] - sh.qx[k], sh.qy[k + 1] - sh.qy[k]) : 0;
    return sh.sp.reach[k] * sh.L + cw * 1.2 + Math.hypot(cw, ch) * 0.5 + end;
  }

  function bounds(sh) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (let k = 0; k < SPINE - 1; k++) {
      const r = sh.rad[k];
      left = Math.min(left, sh.qx[k] - r, sh.qx[k + 1] - r);
      right = Math.max(right, sh.qx[k] + r, sh.qx[k + 1] + r);
      top = Math.min(top, sh.qy[k] - r, sh.qy[k + 1] - r);
      bottom = Math.max(bottom, sh.qy[k] + r, sh.qy[k + 1] + r);
    }
    return { left, top, right, bottom };
  }

  function translate(sh, dx, dy) {
    sh.x += dx; sh.y += dy;
    for (let k = 0; k < sh.trN; k++) { sh.trX[k] += dx; sh.trY[k] += dy; }
    for (let k = 0; k < SPINE; k++) {
      sh.px[k] += dx; sh.py[k] += dy; sh.qx[k] += dx; sh.qy[k] += dy;
    }
  }

  // Closest points on two segments (also handles parallel and zero-length
  // segments). Return the deepest capsule contact, not a head-distance proxy.
  function contact(a, b) {
    const A = bounds(a), B = bounds(b);
    if (A.right < B.left || B.right < A.left || A.bottom < B.top || B.bottom < A.top) return null;
    const ra = a.rad, rb = b.rad; // the radii, kept by spine()
    let best = null, depth = 0;
    for (let i = 0; i < SPINE - 1; i++) for (let j = 0; j < SPINE - 1; j++) {
      const r = ra[i] + rb[j];
      const ax = a.qx[i], ay = a.qy[i], bx = b.qx[j], by = b.qy[j];
      const ux = a.qx[i + 1] - ax, uy = a.qy[i + 1] - ay;
      const vx = b.qx[j + 1] - bx, vy = b.qy[j + 1] - by;
      if (Math.max(ax, ax + ux) + r < Math.min(bx, bx + vx) || Math.max(bx, bx + vx) + r < Math.min(ax, ax + ux) ||
          Math.max(ay, ay + uy) + r < Math.min(by, by + vy) || Math.max(by, by + vy) + r < Math.min(ay, ay + uy)) continue;
      const wx = ax - bx, wy = ay - by;
      const uu = ux * ux + uy * uy, vv = vx * vx + vy * vy, uv = ux * vx + uy * vy;
      const uw = ux * wx + uy * wy, vw = vx * wx + vy * wy, den = uu * vv - uv * uv;
      let s = den > 1e-9 ? clamp((uv * vw - vv * uw) / den, 0, 1) : 0;
      let t = vv > 1e-9 ? (uv * s + vw) / vv : 0;
      if (t < 0) { t = 0; s = uu > 1e-9 ? clamp(-uw / uu, 0, 1) : 0; }
      else if (t > 1) { t = 1; s = uu > 1e-9 ? clamp((uv - uw) / uu, 0, 1) : 0; }
      let dx = wx + s * ux - t * vx, dy = wy + s * uy - t * vy;
      const d = Math.hypot(dx, dy), p = r - d;
      if (p <= depth) continue;
      if (d > 1e-6) { dx /= d; dy /= d; }
      else {
        dx = a.x - b.x; dy = a.y - b.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-6) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }
      }
      depth = p; best = { dx, dy, depth };
    }
    return best;
  }

  function separate() {
    const live = sharks.filter(s => !s.dead);
    // Small symmetric corrections leave path curvature and tail wave intact.
    // Unbounded water outside the viewport makes the hard fallback feasible
    // even after a drastic resize or an overfull/custom-sized school.
    for (let pass = 0; pass < 12; pass++) {
      let clear = true;
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j], c = contact(a, b);
        if (!c) continue;
        clear = false;
        const d = (c.depth + 0.1) * 0.5;
        translate(a, c.dx * d, c.dy * d); translate(b, -c.dx * d, -c.dy * d);
      }
      if (clear) return;
    }
    // Resolve any remaining dense cluster in stable order, outside the bounds
    // of the already placed school. This is exceptional, not normal steering.
    for (let i = 1; i < live.length; i++) {
      if (!live.slice(0, i).some(a => contact(a, live[i]))) continue;
      const b = bounds(live[i]), placed = live.slice(0, i).map(bounds);
      const moves = [
        [Math.min(...placed.map(a => a.left)) - b.right - 1, 0],
        [Math.max(...placed.map(a => a.right)) - b.left + 1, 0],
        [0, Math.min(...placed.map(a => a.top)) - b.bottom - 1],
        [0, Math.max(...placed.map(a => a.bottom)) - b.top + 1],
      ];
      moves.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
      translate(live[i], ...moves[0]);
    }
  }

  // ---------- swimming

  // What a shark would rather avoid at a point its head may reach in t
  // seconds: the page's boxes and a berth around them, the screen's edge
  // while it means to stay, and other sharks' bodies where they will be by
  // then. Squared depths in body lengths, so the cost grows smoothly and a
  // shark starts to bend away well before it is close.
  function hazard(sh, x, y, t) {
    const L = sh.L, soft = L * 0.3;
    let c = 0;
    const m = L * (0.1 + 0.08 * sh.bold) + cw;
    for (let i = 0; i < avoidRects.length; i++) {
      const r = avoidRects[i];
      const dx = Math.max(r.left - x, x - r.right), dy = Math.max(r.top - y, y - r.bottom);
      const sd = dx > 0 || dy > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) : Math.max(dx, dy);
      const p = (m + soft - sd) / L;
      if (p > 0) c += 30 * p * p;
    }
    // the screen's edge, while it means to stay; coming in, a gentler pull
    if (!sh.leaving) {
      const e = Math.min(W, H) * 0.08;
      const out = Math.max(e - x, x - (W - e), e - y, y - (H - e)) / L;
      if (out > 0) c += (sh.seen ? 60 : 15) * out * out;
    }
    // Other sharks: a berth of a fifth of a length, and far more for coming
    // within touch of a body with its own head and fins, or within reach of
    // a tail's swing.
    const touch = sh.sp.front * L + cw * 1.2 + Math.hypot(cw, ch) * 0.5 + L * 0.04, berth = L * 0.2, close = L * 0.06;
    let near = 0;
    for (let i = 0; i < sharks.length; i++) {
      const o2 = sharks[i];
      if (o2 === sh || o2.dead) continue;
      // Where its body will be: each part moves up the body's own path, to
      // where the parts ahead of it are now, and ahead of the snout along
      // its heading.
      const ds = o2.L / (SPINE - 1), shift = ((o2.hold > 0 ? 0 : o2.U) * t) / ds;
      const fx = Math.cos(o2.a) * ds, fy = Math.sin(o2.a) * ds, far = o2.L * 0.55 + o2.radMax + touch + berth;
      let at = (SPINE >> 1) - shift;
      const cx = (at >= 0 ? o2.qx[at | 0] : o2.qx[0] - fx * at) - x, cy = (at >= 0 ? o2.qy[at | 0] : o2.qy[0] - fy * at) - y;
      if (cx * cx + cy * cy > far * far) continue;
      for (let k = 0; k < SPINE - 1; k += 2) {
        at = k - shift;
        const ex = (at >= 0 ? o2.qx[at | 0] : o2.qx[0] - fx * at) - x, ey = (at >= 0 ? o2.qy[at | 0] : o2.qy[0] - fy * at) - y;
        const swing = k > SPINE / 2 ? o2.amp * o2.L : 0;
        const hard = touch + o2.rad[k] + swing, need = hard + berth, d2 = ex * ex + ey * ey;
        if (d2 >= need * need) continue;
        const d = Math.sqrt(d2), p = (need - d) / L;
        near += 20 * p * p;
        if (d < hard + close) { const q = (hard + close - d) / close; near += 10 * q * q; }
      }
    }
    crowd = near;
    return c + near;
  }

  // Cruising, and now and then a glide on the speed it has, or a few harder
  // beats. Never a glide in a tight turn or with something in the way.
  function gait(sh, dt, turnLimit) {
    sh.gaitT -= dt;
    if (sh.gaitT <= 0) {
      const r = sh.rng();
      if (sh.mode) { sh.mode = 0; sh.gaitT = lerp(5, 12, sh.rng()); }
      else if (r < 0.45) { sh.mode = 1; sh.gaitT = lerp(1.2, 2.6, sh.rng()); }
      else if (r < 0.7) { sh.mode = 2; sh.gaitT = lerp(1.5, 3.5, sh.rng()); }
      else sh.gaitT = lerp(3, 8, sh.rng());
    }
    let want = 1 + 0.06 * drift(sh.seed + 2, time / 3);
    if (sh.mode === 1 && sh.age > 5 && !sh.leaving && sh.danger < 0.5 && Math.abs(sh.av) < 0.4 * turnLimit) want = 0.15;
    else if (sh.mode === 2 || sh.leaving) want = 1.25;
    if (sh.yielding) want = Math.min(want, 0.55);
    want *= 1 + sh.boost * Math.exp(-sh.age / 1.3);
    sh.effort += (want - sh.effort) * Math.min(1, dt / 0.7);
  }

  const costs = new Float64Array(2 * CANDIDATES), risks = new Float64Array(2 * CANDIDATES), crowds = new Float64Array(2 * CANDIDATES);
  let crowd = 0; // what hazard() last found of other sharks

  // A shark looks ahead: it imagines the curves it could swim next, each a
  // yaw rate its speed allows, followed a few seconds ahead with the lag it
  // really turns with. It takes the one that keeps clear of what it would
  // rather avoid while staying closest to its course: toward the next place
  // it has in mind, bent by a slow wander.
  function plan(sh, U, limit) {
    const L = sh.L;
    let err = wrap(Math.atan2(sh.ty - sh.y, sh.tx - sh.x) - sh.a);
    // turning right round: keep to the way it is already turning
    if (Math.abs(err) > 2.6 && sh.cmd * err < 0) err -= Math.sign(err) * TAU;
    const wander = 0.65 * drift(sh.seed, time / 5) + 0.35 * drift(sh.seed + 1, time / 2.1);
    const course = clamp(((1.6 * err + 0.7 * wander) / L) * U, -limit, limit);
    const ahead = clamp((1.3 * L) / Math.max(U, 1), 2, 6) / AHEAD, ease = Math.exp(-ahead / (YAW_S + 0.35));
    // The same curves swum slower are considered only when another shark is
    // in the way: then it may ease off and let it pass.
    let best = 0, slower = false;
    for (let c = 0; c < 2 * CANDIDATES; c++) {
      if (c === CANDIDATES) { if (crowds[best] < 0.3) break; slower = true; }
      const yaw = limit * (2 * (c % CANDIDATES) / (CANDIDATES - 1) - 1), v = slower ? U * 0.6 : U;
      let a = sh.a, w = sh.av, x = sh.x, y = sh.y, risk = 0, many = 0;
      for (let i = 1; i <= AHEAD; i++) {
        const w1 = yaw + (w - yaw) * ease, half = a + 0.25 * (w + w1) * ahead;
        a += 0.5 * (w + w1) * ahead; w = w1;
        x += Math.cos(half) * v * ahead; y += Math.sin(half) * v * ahead;
        const fall = 1 / (1 + 0.15 * i);
        risk += hazard(sh, x, y, i * ahead) * fall; many += crowd * fall;
      }
      const off = (yaw - course) / limit, change = (yaw - sh.cmd) / limit;
      costs[c] = risk + 0.6 * off * off + 0.25 * change * change + (slower ? 0.3 : 0); risks[c] = risk; crowds[c] = many;
      if (costs[c] < costs[best]) best = c;
    }
    // between the two neighbouring curves, where the cost is least
    const j = best % CANDIDATES, base = best - j;
    let want = limit * (2 * j / (CANDIDATES - 1) - 1);
    if (j > 0 && j < CANDIDATES - 1) {
      const c0 = costs[base + j - 1], c1 = costs[best], c2 = costs[base + j + 1], den = c0 - 2 * c1 + c2;
      if (den > 1e-9) want += clamp((0.5 * (c0 - c2)) / den, -0.5, 0.5) * ((2 * limit) / (CANDIDATES - 1));
    }
    sh.want = want; sh.danger = risks[best]; sh.yielding = best >= CANDIDATES;
  }

  // One step of swimming: the plan eased into the yaw rate, so the path stays
  // a smooth curve; thrust against drag; the tail's beat.
  function steer(sh, dt) {
    const L = sh.L;
    if (sh.hold > 0) { sh.hold -= dt; return; }
    sh.legT += dt;
    const dx = sh.tx - sh.x, dy = sh.ty - sh.y, dist = Math.hypot(dx, dy);
    // reached, or passed too close to come round to without circling
    const passed = dist < L * 1.1 && dx * Math.cos(sh.a) + dy * Math.sin(sh.a) < -0.2 * dist;
    if (!sh.leaving && (dist < L * 0.45 || passed || sh.legT > 18)) {
      sh.legT = 0;
      if (--sh.legs <= 0) {
        let staying = 0;
        for (const o2 of sharks) if (o2 !== sh && !o2.dead && !o2.leaving) staying++;
        if (staying < Math.ceil(slots.length * 0.5)) { sh.legs = 1; pickInterior(sh); }
        else { sh.leaving = true; pickExit(sh); }
      } else pickInterior(sh);
    }
    // thrust against drag, and a little more drag in a turn
    gait(sh, dt, Math.min(TURN_MAX, sh.U / (TURN_RADIUS * L)));
    const Uc = Math.max(sh.base, 1e-6), e = sh.effort, was = sh.U;
    const U = sh.U = Math.max(0, was + (((e * e * Uc * Uc - was * was) / (DRAG_S * Uc)) - 0.3 * Math.abs(sh.av) * was) * dt);
    const limit = Math.min(TURN_MAX, U / (TURN_RADIUS * L));
    // a fresh look ahead fifteen times a second; the steering eases between
    sh.planT -= dt;
    if (sh.planT <= 0) { sh.planT += 1 / 15; plan(sh, U, limit); }
    // somewhere it cannot get to for long: it thinks of somewhere else
    sh.blocked = sh.danger > 1 ? sh.blocked + dt : Math.max(0, sh.blocked - dt);
    if (sh.blocked > 4 && !sh.leaving) { sh.blocked = 0; pickInterior(sh); }
    sh.cmd += (clamp(sh.want, -limit, limit) - sh.cmd) * Math.min(1, dt / 0.35);
    sh.av = clamp(sh.av + (sh.cmd - sh.av) * Math.min(1, dt / YAW_S), -limit, limit);
    sh.a = wrap(sh.a + sh.av * dt);
    sh.vx = Math.cos(sh.a) * sh.U; sh.vy = Math.sin(sh.a) * sh.U;
    sh.x += sh.vx * dt; sh.y += sh.vy * dt;
    // The tail beats faster and wider the harder it works, and all but stops
    // in a glide; the body straightens while the shark coasts.
    const beat = e <= 1 ? 0.12 + 0.88 * smooth(0.2, 1, e) : Math.min(1.3, 1 + 0.25 * (e - 1));
    sh.beat += (beat - sh.beat) * Math.min(1, dt / 0.6);
    sh.phase += TAU * (0.1 + (e * Uc) / (STRIDE * L)) * dt;
    const hx = sh.trX[sh.trH], hy = sh.trY[sh.trH];
    if ((sh.x - hx) ** 2 + (sh.y - hy) ** 2 >= sh.step * sh.step) pushTrail(sh);
    sh.age += dt;
  }

  function onScreenFraction(sh) {
    let n = 0;
    for (let k = 0; k < SPINE; k += 2) { const x = sh.qx[k], y = sh.qy[k]; if (x > 0 && x < W && y > 0 && y < H) n++; }
    return n / Math.ceil(SPINE / 2);
  }

  function stepSharks(dt) {
    for (const sh of sharks) {
      if (sh.dead) continue;
      steer(sh, dt);
      spine(sh);
      const f = onScreenFraction(sh);
      if (f > 0.3) sh.seen = true;
      // gone when no part of it, fins included, can reach the screen
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (let k = 0; k < SPINE; k++) { const x = sh.qx[k], y = sh.qy[k]; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
      const m = sh.L * 0.22 + cw * 2;
      const off = maxx < -m || minx > W + m || maxy < -m || miny > H + m;
      sh.outside = off ? sh.outside + dt : 0;
      if (off && ((sh.leaving && sh.seen) || sh.outside > 6 || sh.age > 90)) sh.dead = true;
    }
    separate();
    for (const slot of slots) {
      if (slot.shark && slot.shark.dead) { slot.shark = null; slot.wait = lerp(0.4, 2.6, rnd()); }
      if (!slot.shark) { slot.wait -= dt; if (slot.wait <= 0) spawn(slot); }
    }
    sharks = sharks.filter(s => !s.dead);
  }

  // ---------- plankton: drifting clouds of dashes, mostly near the edges

  function newCloud() {
    const edge = rnd() < 0.75;
    const x = edge ? (rnd() < 0.5 ? W * 0.13 * rnd() + W * 0.02 : W * (0.85 + 0.13 * rnd())) : W * (0.1 + 0.8 * rnd());
    const y = H * (0.05 + 0.9 * rnd());
    const ang = rnd() * TAU, sp = lerp(3, 9, rnd());
    return { x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp * 0.6, sx: cw * lerp(4, 11, rnd()), sy: ch * lerp(3, 8, rnd()),
      life: 0, max: lerp(14, 30, rnd()), rate: lerp(3, 8, rnd()), acc: 0 };
  }

  function stepPlankton(dt, warm) {
    if (!o.plankton) { motes.length = 0; return; }
    const want = Math.max(2, Math.round((W * H) / 380000));
    while (clouds.length < want) {
      const c = newCloud(); clouds.push(c);
      if (warm) { c.life = c.max * rnd() * 0.6; const n = (c.rate * Math.min(c.life, 10)) | 0; for (let i = 0; i < n; i++) seedMote(c, lerp(6, 14, rnd()) * rnd()); }
    }
    for (const c of clouds) {
      c.life += dt; c.x += c.vx * dt; c.y += c.vy * dt;
      if (c.life < c.max) { c.acc += c.rate * dt; while (c.acc >= 1) { c.acc -= 1; seedMote(c, 0); } }
    }
    clouds = clouds.filter(c => c.life < c.max + 2);
    const strays = Math.round((W * H) / 60000);
    let nStray = 0; for (const m of motes) if (m.stray) nStray++;
    while (nStray < strays) {
      motes.push({ x: W * rnd(), y: H * rnd(), vx: (rnd() - 0.5) * 6, vy: (rnd() - 0.5) * 3, age: warm ? rnd() * 10 : 0, max: lerp(8, 20, rnd()), shade: rnd() < 0.5 ? 0 : 1, dot: false, ph: rnd() * TAU, stray: true });
      nStray++;
    }
    for (const m of motes) {
      m.age += dt;
      m.x += (m.vx + 2.5 * Math.sin(time * 0.4 + m.ph)) * dt; m.y += (m.vy + 1.5 * Math.cos(time * 0.33 + m.ph)) * dt;
    }
    // sharks part the plankton a little
    for (const sh of sharks) {
      const r = sh.L * 0.13, r2 = r * r;
      for (const m of motes) {
        for (let k = 0; k < SPINE / 2; k += 3) {
          const ex = m.x - sh.qx[k], ey = m.y - sh.qy[k], d2 = ex * ex + ey * ey;
          if (d2 < r2 && d2 > 1) { const d = Math.sqrt(d2), p = (1 - d / r) * 60 * dt; m.x += (ex / d) * p; m.y += (ey / d) * p; }
        }
      }
    }
    motes = motes.filter(m => m.age < m.max && m.x > -50 && m.x < W + 50 && m.y > -50 && m.y < H + 50);
  }

  function seedMote(c, age) {
    const gx = gauss() * c.sx, gy = gauss() * c.sy;
    const m = { x: c.x + gx, y: c.y + gy, vx: c.vx + (rnd() - 0.5) * 4, vy: c.vy + (rnd() - 0.5) * 2, age, max: lerp(6, 14, rnd()), shade: rnd() < 0.35 ? 0 : 1, dot: rnd() < 0.12, ph: rnd() * TAU };
    motes.push(m);
  }
  function gauss() { return (rnd() + rnd() + rnd() + rnd() - 2) * 0.9; }

  // ---------- wake: faint dots where tails have swept

  function stepWake(dt) {
    if (!o.wake) return;
    wakeOn(cells, wake, dt);
    if (dots) wakeOn(dots, dots.wake, dt);
  }

  function wakeOn(g, field, dt) {
    const k = Math.exp(-dt / 0.6), { cols, rows, pw, ph, colX: gx, rowY: gy } = g;
    for (let i = 0; i < field.length; i++) if (field[i] > 0.004) field[i] *= k; else field[i] = 0;
    for (const sh of sharks) {
      const r = sh.L * 0.04 + cw * 1.3;
      for (let j = Math.floor(SPINE * 0.84); j < SPINE; j += 2) {
        const x = sh.qx[j], y = sh.qy[j];
        const i0 = Math.max(0, Math.floor(((x - r) * dpr - g.ox) / pw)), i1 = Math.min(cols - 1, Math.floor(((x + r) * dpr - g.ox) / pw));
        const j0 = Math.max(0, Math.floor(((y - r) * dpr - g.oy) / ph)), j1 = Math.min(rows - 1, Math.floor(((y + r) * dpr - g.oy) / ph));
        for (let b = j0; b <= j1; b++) for (let a = i0; a <= i1; a++) {
          const ex = gx[a] - x, ey = gy[b] - y, d = Math.sqrt(ex * ex + ey * ey);
          if (d < r) { const v = 0.85 * (1 - d / r) + 0.15; const id = b * cols + a; if (field[id] < v) field[id] = v; }
        }
      }
    }
  }

  function step(dt) {
    time += dt;
    stepSharks(dt);
    stepPlankton(dt, false);
    stepWake(dt);
  }

  // ---------- rasterising sharks into cells

  // Every cell of grid g within reach of a shark's body, with the nearest
  // point of its spine: s along it, t across it (signed). They are listed in
  // g.list; returns how many.
  function cover(sh, g, margin) {
    const sp = sh.sp, L = sh.L, qx = sh.qx, qy = sh.qy;
    const { cols, rows, pw, ph, colX: gx, rowY: gy, mark, bestD: bd, bestS: bs, bestT: bt, list } = g;
    const gox = g.ox, goy = g.oy, stamp = ++g.stamp;
    let n = 0;
    for (let k = 0; k < SPINE - 1; k++) {
      const ax = qx[k], ay = qy[k], dx = qx[k + 1] - ax, dy = qy[k + 1] - ay;
      const len2 = dx * dx + dy * dy || 1e-6;
      const r = sp.reach[k] * L + margin;
      const minx = Math.min(ax, ax + dx) - r, maxx = Math.max(ax, ax + dx) + r;
      const miny = Math.min(ay, ay + dy) - r, maxy = Math.max(ay, ay + dy) + r;
      const i0 = Math.max(0, Math.floor((minx * dpr - gox) / pw)), i1 = Math.min(cols - 1, Math.floor((maxx * dpr - gox) / pw));
      const j0 = Math.max(0, Math.floor((miny * dpr - goy) / ph)), j1 = Math.min(rows - 1, Math.floor((maxy * dpr - goy) / ph));
      if (i0 > i1 || j0 > j1) continue;
      const s0 = k / (SPINE - 1), sd = 1 / (SPINE - 1);
      const first = k === 0, lastSeg = k === SPINE - 2;
      for (let j = j0; j <= j1; j++) {
        const cy = gy[j], row = j * cols;
        for (let i = i0; i <= i1; i++) {
          const cx = gx[i];
          let tau = ((cx - ax) * dx + (cy - ay) * dy) / len2;
          if (tau < 0 && !first) tau = 0; else if (tau > 1 && !lastSeg) tau = 1;
          const ex = cx - (ax + tau * dx), ey = cy - (ay + tau * dy);
          const d2 = ex * ex + ey * ey;
          if (d2 > r * r) continue;
          const id = row + i;
          if (mark[id] !== stamp) { mark[id] = stamp; bd[id] = d2; list[n++] = id; }
          else if (d2 >= bd[id]) continue;
          bd[id] = d2;
          bs[id] = s0 + tau * sd;
          bt[id] = (dx * ey - dy * ex) > 0 ? Math.sqrt(d2) : -Math.sqrt(d2);
        }
      }
    }
    return n;
  }

  function raster(sh, prio) {
    const sp = sh.sp, L = sh.L;
    const n = cover(sh, cells, cw * 1.2);
    const edgeM = (cw * 0.75) / L, eyeR = o.eyes ? (cw * 0.62) / L : 0, tex = cw * 0.95;
    const tint = sp.tintIndex, epochT = time * 0.7, along = alongTint(sp);
    for (let c = 0; c < n; c++) {
      const id = sharkCells[c];
      const s = bestS[id], t = bestT[id];
      const ts = Math.floor((s * L) / tex), tt = Math.floor(t / tex) + 4096;
      const h1 = hash(sh.seed, ts, tt), h2 = hash(ts, tt, sh.seed + 7);
      shape(sp, s, t, L, edgeM, eyeR, h2);
      if (outK === K_NONE) continue;
      let sprite = -1;
      if (outK === K_EDGE) {
        if (h1 > 0.42 * outD) continue;
        const mark = (h2 < 0.3 ? 0 : h2 < 0.7 ? 1 : 2) * 4 + ((h1 * 97) | 0) % EDGE_MARKS;
        if (pal.edge) sprite = EDGE + mark;
        else sprite = EDGE_T + (along >= 0 && (h1 * 7919) % 1 < smooth(0.1, 0.95, s) ? along : tint) * 12 + mark;
      } else {
        const epoch = Math.floor(epochT + h2 * 5);
        const h3 = hash(ts * 31 + epoch, tt, sh.seed + 13);
        const d = outD;
        const dd = d + (h1 - 0.5) * 0.38;
        let tone;
        if (outK !== K_FIN && h2 < smooth(0.7, 1.0, d) * 0.3) tone = 0;
        else tone = clamp(1 + Math.floor((1 - dd) * 10), 1, 9);
        const band = tone === 0 ? BAND_DARK : tone <= 3 ? BAND_DENSE : tone <= 5 ? BAND_MID : tone <= 7 ? BAND_LIGHT : BAND_FAINT;
        const g = band[(h3 * band.length) | 0];
        // toward the tail, a palette with along shades into the next colour
        const ti = along >= 0 && (h1 * 7919) % 1 < smooth(0.1, 0.95, s) ? along : tint;
        // an eye: an o one shade darker than the body there, in its own ink
        if (outK === K_EYE) sprite = bodyId(ti, clamp(Math.floor((1 - d) * 10), 1, 8), 0, 13);
        else if (outK === K_SPOT) sprite = bodyId(ti, clamp(tone, 2, 6), 1, 13);
        else if (h1 * 1000 % 1 < 0.035 && tone >= 2 && tone <= 7) sprite = accentId(((h2 * 61) | 0) % ACCENTS, tone <= 4 ? 1 : 0, g);
        else if (h3 * 1000 % 1 < 0.03 && tone >= 2 && tone <= 6) sprite = bodyId(ti, tone, 1, g);
        else sprite = bodyId(ti, tone, 0, g);
      }
      if (fbStamp[id] !== stampF) { fbStamp[id] = stampF; fbPrio[id] = -1; frameCells[frameCellCount++] = id; }
      const p = prio + (outK === K_EDGE ? 0 : 10);
      if (p > fbPrio[id]) { fbPrio[id] = p; fbSprite[id] = sprite; }
    }
  }

  // ---------- drawing

  // The colour a species turns toward along its body, if the palette has one.
  function alongTint(sp) {
    return pal.along && pal.along[sp.tint] ? TINTS.indexOf(pal.along[sp.tint]) : -1;
  }

  // ---------- drawn without the grid (render: 'smooth')
  //
  // Each shark is painted once, lying straight, into its own image at the
  // canvas's resolution: every pixel shaded from the body model the
  // characters use, its edge smoothed by its distance to the outline. Each
  // frame that image is laid along the bending spine in short overlapping
  // slices, a drawImage each: far cheaper than filling shaded paths.

  const SKIN_ALONG = 32, SKIN_LEVELS = 256, SKIN_MAX = 1.5;

  function skin(sh) {
    if (sh.skin && sh.skin.pal === pal && sh.skin.dpr === dpr && sh.skin.L === sh.L && sh.skin.eyes === o.eyes) return sh.skin;
    const sp = sh.sp, L = sh.L, Ld = L * dpr, table = sp.table;
    let R = 0;
    for (let k = 0; k < SPINE - 1; k++) R = Math.max(R, sp.reach[k]);
    const pad = 3, x0 = Math.ceil(0.045 * Ld) + pad, w = Math.ceil(x0 + 1.045 * Ld) + pad, yc = Math.ceil(R * Ld) + pad, h = 2 * yc;
    // its colours, from the palette's tint toward its along tint, hazed
    // toward the ground the deeper it swims
    const A = tintRamp(pal.tints[sp.tint]), al = alongTint(sp), B = al >= 0 ? tintRamp(pal.tints[TINTS[al]]) : A;
    const ground = rgb(pal.ground), haze = (1 - sh.z) * 0.22, lut = new Uint8Array(SKIN_ALONG * SKIN_LEVELS * 3);
    for (let a = 0; a < SKIN_ALONG; a++) for (let lv = 0; lv < SKIN_LEVELS; lv++) {
      const d = (lv / (SKIN_LEVELS - 1)) * SKIN_MAX;
      const c = mixc(mixc(shadeAt(A, d), shadeAt(B, d), a / (SKIN_ALONG - 1)), ground, haze);
      lut.set(c, (a * SKIN_LEVELS + lv) * 3);
    }
    const c = makeCanvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), px = img.data;
    const edgeM = 2 / Ld, dorsal = sp.dorsal, ext = new Float32Array(w);
    for (let i = 0; i < w; i++) {
      const s = (i + 0.5 - x0) / Ld;
      if (s < -0.04 || s > 1.04) continue;
      const k = clamp(Math.floor(s * (SPINE - 1)), 0, SPINE - 2), r = sp.reach[k] * Ld + 3;
      const j0 = Math.max(0, Math.floor(yc - r)), j1 = Math.min(h - 1, Math.ceil(yc + r));
      const sc = clamp(s, 0, 1), wb = table[(sc * 256 + 0.5) | 0], row = Math.round(alongMix(sc) * (SKIN_ALONG - 1)) * SKIN_LEVELS;
      const fade = tailFade(sc), head = lerp(0.86, 1, smooth(0.01, 0.08, s));
      const ridge = dorsal ? 0.12 * Math.sin(Math.PI * clamp((s - dorsal[0]) / (dorsal[1] - dorsal[0]), 0, 1)) : 0;
      const saddle = sp.saddles ? 0.2 * smooth(0.2, 0.7, Math.sin(s * TAU * sp.saddles + 1.3)) * smooth(0.06, 0.1, s) * (1 - smooth(0.78, 0.82, s)) : 0;
      for (let j = j0; j <= j1; j++) {
        const t = (j + 0.5 - yc) / dpr, u = Math.abs(t) / L;
        shape(sp, s, t, L, edgeM, 0, 1);
        const cov = clamp(0.5 - outSD * Ld, 0, 1);
        if (cov <= 0) continue;
        let d;
        if (outK === K_BODY && s >= 0 && s <= 1 && u <= wb) {
          // the same shading as the characters', with its steps smoothed
          const q = wb > 0 ? u / wb : 0;
          d = (0.98 - 0.52 * q * q) * fade * head + ridge * (1 - smooth(0.2, 0.45, q)) + saddle;
        } else if (outK === K_BODY || outK === K_FIN) d = outD;
        else d = 0.46 * fade;
        const o4 = (j * w + i) * 4, l3 = (row + clamp(Math.round((d / SKIN_MAX) * (SKIN_LEVELS - 1)), 0, SKIN_LEVELS - 1)) * 3;
        px[o4] = lut[l3]; px[o4 + 1] = lut[l3 + 1]; px[o4 + 2] = lut[l3 + 2]; px[o4 + 3] = Math.round(cov * 255);
        ext[i] = Math.max(ext[i], Math.abs(j + 0.5 - yc) + 1);
      }
    }
    g.putImageData(img, 0, 0);
    // Spots, and eyes if asked for, in the body's own colour a little darker
    // than it is there: never ink.
    const mark = (s, u, r, more) => {
      const wb = table[(clamp(s, 0, 1) * 256 + 0.5) | 0], q = wb > 0 ? Math.min(1, Math.abs(u) / wb) : 0;
      const d = (0.98 - 0.52 * q * q) * tailFade(s) + more, l3 = (Math.round(alongMix(s) * (SKIN_ALONG - 1)) * SKIN_LEVELS + clamp(Math.round((d / SKIN_MAX) * (SKIN_LEVELS - 1)), 0, SKIN_LEVELS - 1)) * 3;
      g.fillStyle = `rgb(${lut[l3]},${lut[l3 + 1]},${lut[l3 + 2]})`;
      g.beginPath(); g.arc(x0 + s * Ld, yc + u * Ld, r, 0, TAU); g.fill();
    };
    if (sp.spots) {
      const r = Math.max(0.8 * dpr, 0.008 * Ld);
      for (let i = 0; i < 20; i++) {
        const s = 0.08 + 0.66 * hash(sh.seed, i, 11);
        mark(s, (hash(sh.seed, i, 12) * 1.6 - 0.8) * table[(s * 256 + 0.5) | 0], r, 0.35);
      }
    }
    if (o.eyes) {
      const er = Math.max(1.1 * dpr, 0.0095 * Ld), hm = sp.hammer;
      if (hm) for (const side of [1, -1]) mark((hm.sweep + hm.back + 0.006) / 2, hm.span * 0.93 * side, er, 0.1);
      else if (sp.eyes) for (const side of [1, -1]) mark(sp.eyes[0], sp.eyes[1] * side, er, 0.1);
    }
    // how far each slice reaches across, so it is drawn no wider than it is
    const n = SPINE - 1, seg = Ld / n, reach = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const a = k === 0 ? 0 : Math.max(0, Math.floor(x0 + k * seg - seg * 0.5)), b = k === n - 1 ? w : Math.min(w, Math.ceil(x0 + (k + 1) * seg + seg * 0.5));
      for (let i = a; i < b; i++) reach[k] = Math.max(reach[k], ext[i]);
      reach[k] = Math.min(yc, Math.ceil(reach[k]) + 1);
    }
    sh.skin = { pal, dpr, L, eyes: o.eyes, canvas: c, x0, yc, w, h, Ld, reach };
    return sh.skin;
  }

  // The straight image laid along the spine: each slice turned to its
  // segment and overlapping its neighbours just enough that no seam opens
  // where the body bends. Slices off the canvas are skipped.
  function drawShark(sh) {
    const k = skin(sh), n = SPINE - 1, seg = k.Ld / n, qx = sh.qx, qy = sh.qy;
    let was = Math.atan2(qy[1] - qy[0], qx[1] - qx[0]);
    for (let i = 0; i < n; i++) {
      const ax = qx[i] * dpr, ay = qy[i] * dpr, dx = qx[i + 1] * dpr - ax, dy = qy[i + 1] * dpr - ay, l = Math.hypot(dx, dy) || 1;
      const ux = dx / l, uy = dy / l, xk = k.x0 + i * seg, r = k.reach[i];
      if (r <= 0) continue;
      const a = Math.atan2(dy, dx), next = i < n - 1 ? Math.atan2(qy[i + 2] - qy[i + 1], qx[i + 2] - qx[i + 1]) : a;
      const bend = Math.max(Math.abs(wrap(a - was)), Math.abs(wrap(next - a)));
      was = a;
      const ov = Math.min(seg * 0.5, 1 + 0.5 * r * bend);
      if (Math.max(ax, ax + dx) + r + ov < 0 || Math.min(ax, ax + dx) - r - ov > Wd || Math.max(ay, ay + dy) + r + ov < 0 || Math.min(ay, ay + dy) - r - ov > Hd) continue;
      const sx0 = i === 0 ? 0 : xk - ov, sx1 = i === n - 1 ? k.w : xk + seg + ov;
      ctx.setTransform(ux, uy, uy, -ux, ax - xk * ux - k.yc * uy, ay - xk * uy + k.yc * ux);
      ctx.drawImage(k.canvas, sx0, k.yc - r, sx1 - sx0, 2 * r, sx0, k.yc - r, sx1 - sx0, 2 * r);
    }
  }

  function renderSmooth() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    if (o.ground) { ctx.fillStyle = pal.ground; ctx.fillRect(0, 0, W, H); } else ctx.clearRect(0, 0, W, H);
    if (o.plankton) {
      for (const m of motes) {
        const life = Math.min(m.age / 1.5, (m.max - m.age) / 2, 1);
        if (life < 0.15) continue;
        ctx.globalAlpha = life;
        if (m.dot) { ctx.fillStyle = pal.dot[m.shade]; ctx.fillRect(m.x - 1, m.y - 1, 2, 2); }
        else { ctx.fillStyle = pal.dash[life < 0.55 ? 2 : m.shade]; ctx.fillRect(m.x - cw * 0.23, m.y - 0.5, cw * 0.46, 1); }
      }
      ctx.globalAlpha = 1;
    }
    for (const sh of sharks.slice().sort((a, b) => a.z - b.z)) drawShark(sh);
  }

  // ---------- a still field of dots (render: 'dots')
  //
  // Identical dots that never move; one lights up while a shark is under
  // it, in the shark's colour and shade at its centre, and partly at the
  // shark's edge, so the outline stays smooth. Only the dots that change are
  // drawn again, each one sprite.

  const LEVELS = 20, ALONG = 5;
  const D_PLANK = TINTS.length * ALONG * LEVELS, D_WAKE = D_PLANK + 3, D_REST = D_WAKE + 2, D_SPRITES = D_REST + 1;

  function buildDots() {
    const pd = Math.max(3, Math.round(o.pitch * dpr)), dc = Math.ceil(Wd / pd) + 1, dr = Math.ceil(Hd / pd) + 1, n = dc * dr;
    const g = {
      pw: pd, ph: pd, cols: dc, rows: dr, ox: Math.floor((Wd - dc * pd) / 2), oy: Math.floor((Hd - dr * pd) / 2),
      colX: new Float32Array(dc), rowY: new Float32Array(dr), mark: new Int32Array(n), bestD: new Float32Array(n),
      bestS: new Float32Array(n), bestT: new Float32Array(n), list: new Int32Array(n), stamp: 0, wake: new Float32Array(n),
      shown: new Int32Array(n), want: new Int32Array(n), wantA: new Float32Array(n), wantStamp: new Int32Array(n),
      lit: new Int32Array(n), was: new Int32Array(n), wasN: 0, frame: 0, full: true, sprites: null, restFill: null,
    };
    for (let i = 0; i < dc; i++) g.colX[i] = (g.ox + (i + 0.5) * pd) / dpr;
    for (let j = 0; j < dr; j++) g.rowY[j] = (g.oy + (j + 0.5) * pd) / dpr;
    dots = g;
    buildDotSprites();
  }

  function buildDotSprites() {
    const g = dots, pd = g.pw, per = 32;
    const c = makeCanvas(per * pd, Math.ceil(D_SPRITES / per) * pd), x = c.getContext('2d');
    const ground = rgb(pal.ground), dark = (0.2126 * ground[0] + 0.7152 * ground[1] + 0.0722 * ground[2]) / 255 < 0.3;
    const size = clamp(o.dot, 0.1, 1) * pd, square = o.shape === 'square';
    const paint = (id, col) => {
      const x0 = (id % per) * pd, y0 = Math.floor(id / per) * pd, cx = x0 + pd / 2, cy = y0 + pd / 2;
      if (square) {
        const side = Math.max(1, Math.round(size)), off = Math.floor((pd - side) / 2);
        x.fillStyle = css(col); x.fillRect(x0 + off, y0 + off, side, side);
      } else if (dark) {
        // a lit LED: a bright core, its colour, a soft rim, all inside its own cell
        const r = size / 2, outer = Math.min(pd / 2, r * 1.45), gr = x.createRadialGradient(cx, cy, 0, cx, cy, outer);
        gr.addColorStop(0, css(mixc(col, [255, 255, 255], 0.22)));
        gr.addColorStop((r * 0.65) / outer, css(col));
        gr.addColorStop(r / outer, `rgba(${col[0]},${col[1]},${col[2]},0.55)`);
        gr.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
        x.fillStyle = gr; x.fillRect(x0, y0, pd, pd);
      } else {
        x.fillStyle = css(col); x.beginPath(); x.arc(cx, cy, size / 2, 0, TAU); x.fill();
      }
    };
    TINTS.forEach((name, ti) => {
      const A = tintRamp(pal.tints[name]), B = pal.along && pal.along[name] ? tintRamp(pal.tints[pal.along[name]]) : A;
      for (let a = 0; a < ALONG; a++) for (let lv = 0; lv < LEVELS; lv++) {
        const d = 0.1 + (lv / (LEVELS - 1)) * 1.2;
        paint((ti * ALONG + a) * LEVELS + lv, mixc(shadeAt(A, d), shadeAt(B, d), a / (ALONG - 1)));
      }
    });
    pal.dash.slice(0, 3).forEach((col, i) => paint(D_PLANK + i, rgb(col)));
    pal.dot.slice(0, 2).forEach((col, i) => paint(D_WAKE + i, rgb(col)));
    paint(D_REST, mixc(ground, rgb(pal.dash[0]), clamp(o.rest, 0, 1)));
    g.sprites = c; g.full = true;
  }

  function renderDots() {
    if (!dots) buildDots();
    const g = dots, stamp = ++g.frame, pd = g.pw, pitch = pd / dpr, cols = g.cols;
    let litN = 0;
    const light = (id, sprite, alpha) => {
      const st = sprite * 16 + Math.round(alpha * 15);
      if (g.wantStamp[id] !== stamp) { g.wantStamp[id] = stamp; g.want[id] = st; g.wantA[id] = alpha; g.lit[litN++] = id; }
      else if (alpha > g.wantA[id]) { g.want[id] = st; g.wantA[id] = alpha; }
    };
    for (const sh of sharks.slice().sort((a, b) => a.z - b.z)) {
      const sp = sh.sp, L = sh.L, n = cover(sh, g, pitch * 0.8);
      const edgeM = (pitch * 0.55) / L, eyeR = o.eyes ? Math.max(L * 0.011, pitch * 0.45) / L : 0, tex = cw * 0.95;
      const tint = sp.tintIndex, along = alongTint(sp) >= 0;
      for (let c = 0; c < n; c++) {
        const id = g.list[c], s = g.bestS[id], t = g.bestT[id];
        shape(sp, s, t, L, edgeM, eyeR, hash(Math.floor((s * L) / tex), Math.floor(t / tex) + 4096, sh.seed + 7));
        if (outK === K_NONE) continue;
        // an eye lights its dot a shade darker than the body there
        const d = outK === K_EDGE ? 0.46 * tailFade(s) : outK === K_SPOT ? outD + 0.45 : outK === K_EYE ? outD + 0.1 : outD;
        const lv = clamp(Math.round(((d - 0.1) / 1.2) * (LEVELS - 1)), 0, LEVELS - 1);
        const a = along ? Math.round(alongMix(s) * (ALONG - 1)) : 0;
        const alpha = clamp(0.5 - (outSD * L) / (pitch * 0.85), 0, 1);
        if (alpha >= 1 / 30) light(id, (tint * ALONG + a) * LEVELS + lv, alpha);
      }
    }
    if (o.wake) {
      for (let id = 0; id < g.wake.length; id++) {
        const v = g.wake[id];
        if (v < 0.12 || g.wantStamp[id] === stamp) continue;
        const hh = hash(id % cols, (id / cols) | 0, 991);
        if (hh < 0.7) light(id, D_WAKE + (hh < 0.28 ? 1 : 0), Math.min(1, v) * 0.55);
      }
    }
    if (o.plankton) {
      for (const m of motes) {
        const i = Math.floor((m.x * dpr - g.ox) / pd), j = Math.floor((m.y * dpr - g.oy) / pd);
        if (i < 0 || j < 0 || i >= cols || j >= g.rows) continue;
        const life = Math.min(m.age / 1.5, (m.max - m.age) / 2, 1), id = j * cols + i;
        if (life < 0.15 || (g.wantStamp[id] === stamp && g.want[id] < D_PLANK * 16)) continue;
        light(id, D_PLANK + (m.dot ? 2 : life < 0.55 ? 2 : m.shade), life * 0.4);
      }
    }
    // draw what changed
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    const sx = g.sprites, rest = o.rest > 0, per = 32;
    ctx.fillStyle = pal.ground;
    const clearDot = id => {
      const x = g.ox + (id % cols) * pd, y = g.oy + ((id / cols) | 0) * pd;
      if (o.ground) ctx.fillRect(x, y, pd, pd); else ctx.clearRect(x, y, pd, pd);
      if (rest) ctx.drawImage(sx, (D_REST % per) * pd, Math.floor(D_REST / per) * pd, pd, pd, x, y, pd, pd);
    };
    if (g.full) {
      g.full = false; g.wasN = 0; g.shown.fill(-1);
      if (o.ground) ctx.fillRect(0, 0, Wd, Hd); else ctx.clearRect(0, 0, Wd, Hd);
      if (rest) for (let id = 0; id < g.shown.length; id++) clearDot(id);
    }
    for (let k = 0; k < g.wasN; k++) {
      const id = g.was[k];
      if (g.wantStamp[id] !== stamp && g.shown[id] !== -1) { clearDot(id); g.shown[id] = -1; }
    }
    for (let k = 0; k < litN; k++) {
      const id = g.lit[k], st = g.want[id];
      if (g.shown[id] === st) continue;
      clearDot(id);
      const sprite = st >> 4, alpha = (st & 15) / 15;
      if (alpha > 0) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(sx, (sprite % per) * pd, Math.floor(sprite / per) * pd, pd, pd, g.ox + (id % cols) * pd, g.oy + ((id / cols) | 0) * pd, pd, pd);
        ctx.globalAlpha = 1;
      }
      g.shown[id] = st;
    }
    const was = g.was; g.was = g.lit; g.lit = was; g.wasN = litN;
  }

  function render() {
    if (o.render === 'smooth') { renderSmooth(); return; }
    if (o.render === 'dots') { renderDots(); return; }
    stampF++; frameCellCount = 0;
    const order = sharks.slice().sort((a, b) => a.z - b.z);
    order.forEach((sh, i) => raster(sh, i));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    if (groundPattern) {
      ctx.save();
      ctx.translate(((ox % cwD) + cwD) % cwD - cwD, ((oy % chD) + chD) % chD - chD);
      ctx.fillStyle = groundPattern; ctx.fillRect(0, 0, Wd + 2 * cwD, Hd + 2 * chD);
      ctx.restore();
    } else ctx.clearRect(0, 0, Wd, Hd);
    if (o.wake) {
      for (let id = 0; id < wake.length; id++) {
        const v = wake[id];
        if (v < 0.12 || fbStamp[id] === stampF) continue;
        const i = id % cols, j = (id / cols) | 0;
        const hh = hash(i, j, 991);
        if (hh > 0.7) continue;
        const lv = v > 0.6 ? 3 : v > 0.36 ? 2 : v > 0.18 ? 1 : 0;
        const sp = DOT + (hh < 0.28 ? 4 : 0) + lv;
        ctx.drawImage(atlas, spriteX[sp], spriteY[sp], cwD, chD, ox + i * cwD, oy + j * chD, cwD, chD);
      }
    }
    if (o.plankton) {
      for (const m of motes) {
        const i = Math.floor((m.x * dpr - ox) / cwD), j = Math.floor((m.y * dpr - oy) / chD);
        if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
        const id = j * cols + i;
        if (fbStamp[id] === stampF) continue;
        const life = Math.min(m.age / 1.5, (m.max - m.age) / 2, 1);
        if (life < 0.15) continue;
        const sp = m.dot ? DOT + 4 * (m.shade) + (life > 0.6 ? 2 : 1) : DASH + (life < 0.55 ? 2 : m.shade);
        ctx.drawImage(atlas, spriteX[sp], spriteY[sp], cwD, chD, ox + i * cwD, oy + j * chD, cwD, chD);
      }
    }
    for (let c = 0; c < frameCellCount; c++) {
      const id = frameCells[c], sp = fbSprite[id];
      const i = id % cols, j = (id / cols) | 0;
      ctx.drawImage(atlas, spriteX[sp], spriteY[sp], cwD, chD, ox + i * cwD, oy + j * chD, cwD, chD);
    }
  }

  // ---------- running

  function simulate(seconds, warm) {
    const dt = 1 / 30, n = Math.round(seconds * 30);
    for (let i = 0; i < n; i++) {
      time += dt;
      stepSharks(dt);
      stepPlankton(dt, warm && i === 0);
    }
  }

  // How good a moment looks as a still: sharks wholly on screen, clear of the
  // page's content and of each other.
  function score() {
    let s = 0;
    for (const sh of sharks) {
      const f = onScreenFraction(sh);
      s += f > 0.8 ? 1 : f * 0.5;
      let under = 0;
      for (let k = 0; k < SPINE; k += 3) if (insideAvoid(sh.qx[k], sh.qy[k], sh.L * 0.05)) under++;
      s -= 0.9 * under / Math.ceil(SPINE / 3);
      for (const other of sharks) {
        if (other === sh) continue;
        let near = 1e9;
        for (let a = 0; a < SPINE; a += 5) for (let b = 0; b < SPINE; b += 5) near = Math.min(near, Math.hypot(sh.qx[a] - other.qx[b], sh.qy[a] - other.qy[b]));
        if (near < sh.L * 0.3) s -= 0.35;
      }
    }
    return s;
  }


  // Sharks placed by hand (options.pose): a still for checking shapes.
  function posed() {
    resetWorld();
    slots = [];
    for (const p of o.pose) {
      const sp = PREP[p.species] || PREP.hammerhead;
      const slot = { shark: null, wait: 0 };
      const keep = rnd;
      rnd = () => 0.5;
      spawnAt(slot, sp, p);
      rnd = keep;
    }
    separate();
  }

  function spawnAt(slot, sp, p) {
    const forced = { ...sp, len: [p.length ?? 28, p.length ?? 28] };
    const sh = spawn(slot, 0, forced);
    sh.x = p.x; sh.y = p.y; sh.a = p.angle ?? 0; sh.phase = p.phase ?? 0; sh.amp = p.amp ?? 0.04;
    sh.trN = 0; sh.trH = -1; sh.back = [-Math.cos(sh.a), -Math.sin(sh.a)];
    if (p.bend) { // swim it along an arc so it is curved
      const v = sh.L / 60;
      sh.x -= Math.cos(sh.a) * sh.L; sh.y -= Math.sin(sh.a) * sh.L; sh.a -= p.bend;
      sh.back = [-Math.cos(sh.a), -Math.sin(sh.a)];
      for (let i = 0; i < 60; i++) { sh.a += p.bend / 60; sh.x += Math.cos(sh.a) * v; sh.y += Math.sin(sh.a) * v; pushTrail(sh); }
    } else pushTrail(sh);
    sh.tx = sh.x + Math.cos(sh.a) * 1e4; sh.ty = sh.y + Math.sin(sh.a) * 1e4;
    spine(sh);
    return sh;
  }

  // Start the world: swimming in from the edges, or already under way.
  function start(still) {
    if (o.pose) { posed(); return; }
    resetWorld();
    readAvoid();
    if (o.enter && !still) {
      const sides = [3, 1, 2, 0, 3, 1, 0, 2];
      const shift = (rnd() * 4) | 0;
      // They come in already under way, fast, and ease to cruising.
      slots.forEach((slot, i) => { const sh = spawn(slot, sides[(i + shift) % sides.length]); sh.boost = 1.4; sh.U = sh.base * 2.4; sh.hold = i * 0.22 + rnd() * 0.12; });
      stepPlankton(0, true);
      for (const m of motes) m.age = -rnd() * 1.5; // plankton fades in too
      return;
    }
    // already swimming: run the sea for a while and keep its best-looking moment
    let bestT = 8, best = -1e9;
    for (let t = 0; t <= 26; t += 0.5) {
      if (t > 0) simulate(0.5, t === 0.5);
      else slots.forEach((slot, i) => { slot.wait = i * lerp(1.2, 2.6, rnd()); });
      if (t >= 6) { const sc = score(); if (sc > best + 0.01) { best = sc; bestT = t; } }
      if (!still && t >= 8 && best >= Math.min(o.sharks, 3) * 0.95) break;
    }
    resetWorld();
    slots.forEach((slot, i) => { slot.wait = i * lerp(1.2, 2.6, rnd()); });
    simulate(bestT, true);
    if (o.wake) for (let i = 0; i < 30; i++) stepWake(1 / 30);
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const [w, h, d] = measure();
    if (Math.round(w * d) !== Wd || Math.round(h * d) !== Hd || d !== dpr) resize();
    let dt = last ? (now - last) / 1000 : 0;
    last = now;
    if (!(dt >= 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    const t0 = performance.now();
    avoidAge += dt;
    if (avoidAge > 0.25) { avoidAge = 0; readAvoid(); }
    while (dt > 0) { const s = Math.min(dt, 1 / 30); step(s); dt -= s; }
    render();
    stats.frames++; stats.ms += performance.now() - t0;
  }

  function play() {
    if (running || stopped) return;
    if (o.pose) { render(); return; }
    if (reduceQuery && reduceQuery.matches) { render(); return; }
    if (typeof document !== 'undefined' && document.hidden) return;
    running = true; last = 0;
    raf = requestAnimationFrame(frame);
  }
  function pause() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; }

  const onVisibility = () => { if (document.hidden) pause(); else play(); };
  const onReduce = () => {
    pause();
    if (reduceQuery.matches) { start(true); render(); } else play();
  };
  let ro = null;
  const onResize = () => {
    if (stopped) return;
    resize();
    if (!running) render();
  };

  resize();
  start(Boolean(reduceQuery && reduceQuery.matches));
  render();
  play();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  reduceQuery?.addEventListener?.('change', onReduce);
  if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(onResize); ro.observe(canvas); }
  else if (typeof window !== 'undefined') window.addEventListener('resize', onResize);
  if (typeof document !== 'undefined' && document.fonts?.ready) document.fonts.ready.then(() => { if (!stopped) { buildAtlas(); if (!running) render(); } });

  function stop() {
    stopped = true;
    pause();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    reduceQuery?.removeEventListener?.('change', onReduce);
    if (ro) ro.disconnect(); else if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
  }
  // Change the look or the keep-clear areas without restarting the sea.
  stop.set = (changes = {}) => {
    if (stopped) return;
    Object.assign(o, changes);
    if ('cell' in changes || 'aspect' in changes) { atlas = null; resize(); }
    if ('palette' in changes || 'font' in changes) { pal = resolvePalette(o.palette); buildAtlas(); buildGround(); }
    if ('ground' in changes) buildGround();
    // the dot field is drawn afresh: rebuilt for a new pitch, repainted otherwise
    if ('pitch' in changes) dots = null;
    else if (dots && ('palette' in changes || 'ground' in changes || 'dot' in changes || 'shape' in changes || 'rest' in changes || 'eyes' in changes)) buildDotSprites();
    else if (dots && 'render' in changes) dots.full = true;
    if ('avoid' in changes) readAvoid();
    if ('sharks' in changes) {
      const n = Math.max(0, changes.sharks | 0);
      while (slots.length < n) slots.push({ shark: null, wait: rnd() * 2, index: slots.length });
      while (slots.length > n) { const s = slots.pop(); if (s.shark) { s.shark.leaving = true; pickExit(s.shark); } }
    }
    if (!running) render();
  };
  stop.stats = stats;
  return stop;
}

export default swim;
