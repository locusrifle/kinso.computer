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
const EYE = SP0; // + shade 0..1
const EDGE = SP0 + 2; // + shade * 4 + mark
const DASH = EDGE + 12; // + shade 0..2
const DOT = DASH + 3; // + tint * 4 + level
const SPRITES = DOT + 8;

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
    eye: ['#2b2f37', '#666a73'],
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
    eye: ['#d6dbe4', '#8b919c'],
    edge: ['#6a707b', '#4c515a', '#363a41'],
    dash: ['#b9bec7', '#6b7079', '#41454c'],
    dot: ['#4f5560', '#3f6e66'],
  },
};

// Bodies, seen from above. s runs from the snout (0) to the tail tip (1); u is
// the half-width as a fraction of body length. Fins are triangles in (s, u):
// leading root, tip, trailing root, and how dense they read.
const SPECIES = {
  hammerhead: {
    tint: 'blue', weight: 0.4, len: [29, 37], speed: [0.18, 0.27],
    body: [[0, 0.02], [0.04, 0.04], [0.09, 0.05], [0.15, 0.075], [0.23, 0.098], [0.31, 0.105], [0.4, 0.1],
      [0.5, 0.086], [0.6, 0.066], [0.7, 0.045], [0.78, 0.03], [0.86, 0.02], [0.94, 0.012], [1, 0.004]],
    hammer: { span: 0.215, sweep: 0.045, back: 0.088 },
    fins: [[[0.2, 0.09], [0.4, 0.25], [0.33, 0.095], 0.62], [[0.58, 0.06], [0.68, 0.11], [0.65, 0.05], 0.4],
      [[0.82, 0.02], [0.995, 0.065], [0.92, 0.012], 0.4]],
    dorsal: [0.27, 0.45], eyes: null, saddles: 0, spots: 0,
  },
  leopard: {
    tint: 'warm', weight: 0.34, len: [26, 33], speed: [0.2, 0.3],
    body: [[0, 0], [0.015, 0.035], [0.04, 0.06], [0.09, 0.08], [0.17, 0.094], [0.25, 0.097], [0.33, 0.09],
      [0.42, 0.076], [0.5, 0.06], [0.58, 0.046], [0.67, 0.034], [0.77, 0.024], [0.87, 0.016], [0.95, 0.01], [1, 0.003]],
    hammer: null,
    fins: [[[0.15, 0.085], [0.31, 0.2], [0.27, 0.088], 0.6], [[0.45, 0.065], [0.55, 0.115], [0.53, 0.05], 0.42],
      [[0.66, 0.03], [0.9, 0.055], [0.98, 0.014], 0.38]],
    dorsal: [0.3, 0.42], eyes: [0.05, 0.056], saddles: 7.5, spots: 0.07,
  },
  reef: {
    tint: 'grey', weight: 0.26, len: [23, 30], speed: [0.22, 0.33],
    body: [[0, 0], [0.02, 0.02], [0.06, 0.044], [0.12, 0.066], [0.2, 0.082], [0.28, 0.088], [0.36, 0.083],
      [0.46, 0.068], [0.56, 0.05], [0.66, 0.035], [0.74, 0.024], [0.8, 0.017], [0.9, 0.012], [1, 0.003]],
    hammer: null,
    fins: [[[0.2, 0.075], [0.4, 0.235], [0.31, 0.08], 0.6], [[0.56, 0.045], [0.65, 0.09], [0.62, 0.04], 0.4],
      [[0.8, 0.015], [0.99, 0.075], [0.9, 0.01], 0.42]],
    dorsal: [0.3, 0.42], eyes: [0.075, 0.05], saddles: 0, spots: 0,
  },
};

const DEFAULTS = {
  cell: 'auto', // CSS px: the height of a character cell; 'auto' is about 1/76 of the shorter side (12..16, 10..16 on HiDPI)
  aspect: 2 / 3, // cell width / height
  sharks: 4,
  enter: false,
  palette: 'light',
  avoid: null,
  ground: true, // paint the ground and its faint grid; false leaves the canvas transparent
  plankton: true,
  wake: true,
  speed: 1,
  size: 1,
  seed: undefined,
  font: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace',
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
  PREP[name] = { ...sp, name, table, finsP: fins, reach, tintIndex: TINTS.indexOf(sp.tint) };
}

// What a body is at (s, u): its density 0..1 and what kind of cell it is.
const K_NONE = 0, K_BODY = 1, K_FIN = 2, K_EYE = 3, K_EDGE = 4, K_SPOT = 5;
let outD = 0, outK = 0;
function shape(sp, s, t, L, edgeM, eyeR, tex) {
  const u = t < 0 ? -t / L : t / L;
  outD = 0; outK = K_NONE;
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
      if (u > h.span - eyeR * 3.2) { outK = K_EYE; outD = 1; return; }
      const d = 0.74 - 0.24 * r;
      if (d > outD) { outD = d; outK = K_BODY; }
    }
    if (hsd < sd) sd = hsd;
  }
  // eyes
  if (sp.eyes && outK === K_BODY) {
    const es = (s - sp.eyes[0]) * L, eu = (u - sp.eyes[1]) * L;
    if (es * es + eu * eu < eyeR * eyeR * L * L) { outK = K_EYE; outD = 1; return; }
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
  let frameCellCount = 0, stampS = 0, stampF = 0;
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
    stampS = 0; stampF = 0;
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
        sh.x = x; sh.y = y; sh.L = L; sh.base *= scale; sh.step *= scale;
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
      const inkLo = rgb(t.inkLo), inkHi = rgb(t.inkHi), inkFaint = rgb(t.inkFaint), black = rgb(pal.blackInk);
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
    pal.eye.forEach((col, i) => tile(EYE + i, null, col, 'o'));
    pal.edge.forEach((col, sh) => ["'", ',', '.', '`'].forEach((mk, i) => tile(EDGE + sh * 4 + i, null, col, mk)));
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
    for (let i = 0; i < 8; i++) {
      const x = W * (0.08 + 0.84 * rnd()), y = H * (0.08 + 0.84 * rnd());
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
      phase: rnd() * TAU, amp: lerp(0.045, 0.06, rnd()), bold: lerp(0.35, 1, rnd()),
      age: 0, seen: false, outside: 0, boost: 0, hold: 0, dead: false, z: rnd(),
      step: Math.max(1.5, L / 140), back: [0, 0],
    };
    sh.cap = Math.ceil((L * 1.3) / sh.step) + 8;
    sh.trX = new Float32Array(sh.cap); sh.trY = new Float32Array(sh.cap); sh.trN = 0; sh.trH = -1;
    sh.qx = new Float32Array(SPINE); sh.qy = new Float32Array(SPINE);
    sh.px = new Float32Array(SPINE); sh.py = new Float32Array(SPINE);
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

  // Resample the swum path into SPINE points, then add the body wave.
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
    const qx = sh.qx, qy = sh.qy;
    for (let j = 0; j < SPINE; j++) {
      const a = Math.max(0, j - 1), b = Math.min(SPINE - 1, j + 1);
      let tx = px[a] - px[b], ty = py[a] - py[b]; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const s = j / (SPINE - 1);
      const off = L * sh.amp * (0.12 + 0.88 * s * s) * Math.sin(TAU * 0.8 * s - sh.phase);
      qx[j] = px[j] - ty * off; qy[j] = py[j] + tx * off;
    }
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
      const r = radius(sh, k);
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
    const ra = Array.from({ length: SPINE - 1 }, (_, k) => radius(a, k));
    const rb = Array.from({ length: SPINE - 1 }, (_, k) => radius(b, k));
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

  function steer(sh, dt) {
    const L = sh.L;
    if (sh.hold > 0) { sh.hold -= dt; return; }
    sh.legT += dt;
    const dx = sh.tx - sh.x, dy = sh.ty - sh.y, dist = Math.hypot(dx, dy);
    if (!sh.leaving && (dist < L * 0.35 || sh.legT > 16)) {
      sh.legT = 0;
      if (--sh.legs <= 0) {
        let staying = 0;
        for (const o2 of sharks) if (o2 !== sh && !o2.dead && !o2.leaving) staying++;
        if (staying < Math.ceil(slots.length * 0.5)) { sh.legs = 1; pickInterior(sh); }
        else { sh.leaving = true; pickExit(sh); }
      } else pickInterior(sh);
    }
    const ca = Math.cos(sh.a), sa = Math.sin(sh.a);
    let turn = wrap(Math.atan2(sh.ty - sh.y, sh.tx - sh.x) - sh.a) * 0.9;
    turn += 0.26 * Math.sin(time * 0.29 + sh.seed) + 0.14 * Math.sin(time * 0.71 + sh.seed * 0.37);
    // curve around what the page asked to keep clear, but not always
    for (const r of avoidRects) {
      const m = L * 0.1;
      for (const look of [0.3, 0.75]) {
        const lx = sh.x + ca * L * look, ly = sh.y + sa * L * look;
        if (lx > r.left - m && lx < r.right + m && ly > r.top - m && ly < r.bottom + m) {
          const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
          const cr = ca * (cy - sh.y) - sa * (cx - sh.x);
          turn += (cr > 0 ? -1 : 1) * 0.7 * sh.bold * (look < 0.5 ? 1.2 : 0.8);
          break;
        }
      }
    }
    // stay on screen until it is time to go
    if (!sh.leaving && sh.seen) {
      const lx = sh.x + ca * L * 0.6, ly = sh.y + sa * L * 0.6, mx = W * 0.03, my = H * 0.03;
      if (lx < mx || lx > W - mx || ly < my || ly > H - my) turn += wrap(Math.atan2(H / 2 - sh.y, W / 2 - sh.x) - sh.a) * 0.7;
    }
    // Anticipate neighbours before the full-body hard constraint is needed.
    const hx0 = sh.x + ca * L * 0.25, hy0 = sh.y + sa * L * 0.25;
    for (const other of sharks) {
      if (other === sh || other.dead) continue;
      const lim = 0.8 * Math.max(L, other.L);
      let bx = 0, by = 0, bd = 1e9;
      for (let k = 0; k < SPINE; k += 2) { const ex = other.qx[k] - hx0, ey = other.qy[k] - hy0, d = ex * ex + ey * ey; if (d < bd) { bd = d; bx = ex; by = ey; } }
      bd = Math.sqrt(bd);
      if (bd < lim && bd > 1) turn += (ca * by - sa * bx > 0 ? -1 : 1) * 1.2 * (1 - bd / lim);
    }
    const maxTurn = 0.75;
    turn = clamp(turn, -maxTurn, maxTurn);
    sh.av += (turn - sh.av) * Math.min(1, dt * 1.6);
    sh.a = wrap(sh.a + sh.av * dt);
    const boost = 1 + sh.boost * Math.exp(-sh.age / 1.3);
    const v = sh.base * (1 + 0.1 * Math.sin(time * 0.5 + sh.seed)) * (1 - 0.22 * Math.min(1, Math.abs(sh.av) / maxTurn)) * boost;
    sh.x += Math.cos(sh.a) * v * dt; sh.y += Math.sin(sh.a) * v * dt;
    sh.phase += TAU * (0.35 + 1.5 * (v / L)) * dt;
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
    const k = Math.exp(-dt / 0.6);
    for (let i = 0; i < wake.length; i++) if (wake[i] > 0.004) wake[i] *= k; else wake[i] = 0;
    for (const sh of sharks) {
      const r = sh.L * 0.04 + cw * 1.3;
      for (let j = Math.floor(SPINE * 0.84); j < SPINE; j += 2) {
        const x = sh.qx[j], y = sh.qy[j];
        const i0 = Math.max(0, Math.floor(((x - r) * dpr - ox) / cwD)), i1 = Math.min(cols - 1, Math.floor(((x + r) * dpr - ox) / cwD));
        const j0 = Math.max(0, Math.floor(((y - r) * dpr - oy) / chD)), j1 = Math.min(rows - 1, Math.floor(((y + r) * dpr - oy) / chD));
        for (let b = j0; b <= j1; b++) for (let a = i0; a <= i1; a++) {
          const ex = colX[a] - x, ey = rowY[b] - y, d = Math.sqrt(ex * ex + ey * ey);
          if (d < r) { const v = 0.85 * (1 - d / r) + 0.15; const id = b * cols + a; if (wake[id] < v) wake[id] = v; }
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

  function raster(sh, prio) {
    const sp = sh.sp, L = sh.L, qx = sh.qx, qy = sh.qy;
    const stamp = ++stampS;
    let n = 0;
    const margin = cw * 1.2;
    for (let k = 0; k < SPINE - 1; k++) {
      const ax = qx[k], ay = qy[k], dx = qx[k + 1] - ax, dy = qy[k + 1] - ay;
      const len2 = dx * dx + dy * dy || 1e-6, len = Math.sqrt(len2);
      const r = sp.reach[k] * L + margin;
      const minx = Math.min(ax, ax + dx) - r, maxx = Math.max(ax, ax + dx) + r;
      const miny = Math.min(ay, ay + dy) - r, maxy = Math.max(ay, ay + dy) + r;
      const i0 = Math.max(0, Math.floor((minx * dpr - ox) / cwD)), i1 = Math.min(cols - 1, Math.floor((maxx * dpr - ox) / cwD));
      const j0 = Math.max(0, Math.floor((miny * dpr - oy) / chD)), j1 = Math.min(rows - 1, Math.floor((maxy * dpr - oy) / chD));
      if (i0 > i1 || j0 > j1) continue;
      const s0 = k / (SPINE - 1), sd = 1 / (SPINE - 1);
      const first = k === 0, lastSeg = k === SPINE - 2;
      for (let j = j0; j <= j1; j++) {
        const cy = rowY[j], row = j * cols;
        for (let i = i0; i <= i1; i++) {
          const cx = colX[i];
          let tau = ((cx - ax) * dx + (cy - ay) * dy) / len2;
          if (tau < 0 && !first) tau = 0; else if (tau > 1 && !lastSeg) tau = 1;
          const ex = cx - (ax + tau * dx), ey = cy - (ay + tau * dy);
          const d2 = ex * ex + ey * ey;
          if (d2 > r * r) continue;
          const id = row + i;
          if (markS[id] !== stamp) { markS[id] = stamp; bestD[id] = d2; sharkCells[n++] = id; }
          else if (d2 >= bestD[id]) continue;
          bestD[id] = d2;
          bestS[id] = s0 + tau * sd;
          bestT[id] = (dx * ey - dy * ex) > 0 ? Math.sqrt(d2) : -Math.sqrt(d2);
        }
      }
    }
    const edgeM = (cw * 0.75) / L, eyeR = (cw * 0.62) / L, tex = cw * 0.95;
    const tint = sp.tintIndex, epochT = time * 0.7;
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
        sprite = EDGE + (h2 < 0.3 ? 0 : h2 < 0.7 ? 1 : 2) * 4 + ((h1 * 97) | 0) % EDGE_MARKS;
      } else if (outK === K_EYE) {
        sprite = EYE + (h1 < 0.75 ? 0 : 1);
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
        if (outK === K_SPOT) sprite = bodyId(tint, clamp(tone, 2, 6), 1, 13);
        else if (h1 * 1000 % 1 < 0.035 && tone >= 2 && tone <= 7) sprite = accentId(((h2 * 61) | 0) % ACCENTS, tone <= 4 ? 1 : 0, g);
        else if (h3 * 1000 % 1 < 0.03 && tone >= 2 && tone <= 6) sprite = bodyId(tint, tone, 1, g);
        else sprite = bodyId(tint, tone, 0, g);
      }
      if (fbStamp[id] !== stampF) { fbStamp[id] = stampF; fbPrio[id] = -1; frameCells[frameCellCount++] = id; }
      const p = prio + (outK === K_EDGE ? 0 : 10);
      if (p > fbPrio[id]) { fbPrio[id] = p; fbSprite[id] = sprite; }
    }
  }

  // ---------- drawing

  function render() {
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
      slots.forEach((slot, i) => { const sh = spawn(slot, sides[(i + shift) % sides.length]); sh.boost = 1.4; sh.hold = i * 0.22 + rnd() * 0.12; });
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
