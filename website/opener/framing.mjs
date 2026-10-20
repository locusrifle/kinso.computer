// The opener's framing and camera, as pure functions of the screen: where the contact frame puts the pair, the camera
// along its line through the contact, the world plate deep behind them, and how far each may start from the contact
// so both stay in frame through the approach. Shared by the launch page (intro/intro.mjs) and imperfect OS's lock
// screen (desktop/lock/). Painted canvas pixels throughout (x right, y down); the scene's y is up.
import manifest from './assets/manifest.mjs';
import { deformPoint } from './rig.mjs';
import { timeline, CONTACT } from './timeline.mjs';

export const [CW, CH] = manifest.canvas, [KX, KY] = manifest.contact;
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const smooth = t => t * t * (3 - 2 * t);
export const D2R = Math.PI / 180;
export const FOV = [25, 22];      // vertical field of view, degrees: 25 at the top of the scroll, narrowing to 22 at its end
export const DEPTH = 1.6;         // the world plate sits this many (top-of-scroll) camera distances behind the characters
export const START_ZOOM = [0.9, 0.86];   // at p = 0 the camera is this much further out: [portrait, landscape]
export const MAX_DRIFT = { locus: [760, 460], vaita: [640, 380] };  // painted px each may start from its contact place
export const GROW = 1.06;         // the plate starts this much past covering, so it can grow through the intro and slide under the pointer
export const LIFT = 0.02;         // mid-approach the camera's aim lifts by this share of the screen height (back to 0 at the contact)

// The contact frame: the pair fully in view with room around them, as large as fits but no larger than 0.75 of
// the world's covering scale (a deep scene, not edge to edge); the contact in the upper middle. Portrait screens
// recompose on their own portrait plates: the cast as wide as fits, the contact about a third of the way down.
// pairBox: the box round both paintings shown (pairBoxOf)
// centred (opt-in, the launch page's): the contact at the very middle of the screen on every screen. The pair stays
// whole, as large as fits about that middle: each half of the screen holds the pair's longer reach from the contact,
// sideways with the same room at the edges as above, downwards to within 5 % of the bottom edge.
export const pairBoxOf = art => [Math.min(art.locus.box[0], art.vaita.box[0]), Math.min(art.locus.box[1], art.vaita.box[1]),
  Math.max(art.locus.box[2], art.vaita.box[2]), Math.max(art.locus.box[3], art.vaita.box[3])];
export function frame(vw, vh, pairBox, { centred = false } = {}) {
  const cover = Math.max(vw / CW, vh / CH);
  const pw = pairBox[2] - pairBox[0], ph = pairBox[3] - pairBox[1];
  const land = smooth(clamp((vw / vh - 0.62) / (1.25 - 0.62)));
  const reachX = Math.max(KX - pairBox[0], pairBox[2] - KX), reachY = Math.max(KY - pairBox[1], pairBox[3] - KY);
  const s = centred ? Math.min(0.75 * cover, (0.94 - 0.04 * land) * vw / (2 * reachX), 0.9 * vh / (2 * reachY))
    : Math.min(0.75 * cover, (0.94 - 0.04 * land) * vw / pw, 0.74 * vh / ph);
  const kx = centred ? vw / 2 : vw / 2 + (KX - (pairBox[0] + pairBox[2]) / 2) * s;
  const ky = centred ? vh / 2 : (0.4 + 0.1 * land) * vh + (KY - (pairBox[1] + pairBox[3]) / 2) * s;
  const cam = [KX - (kx - vw / 2) / s, -KY + (ky - vh / 2) / s]; // the camera's x, y at the contact frame
  const reach = Math.max(Math.hypot(kx, ky), Math.hypot(vw - kx, ky), Math.hypot(kx, vh - ky), Math.hypot(vw - kx, vh - ky)) + 2;
  return { vw, vh, cover, land, s, kx, ky, cam, reach, centred, kind: vw < vh ? 'port' : 'land', z0: 1, drift: { locus: [0, 0], vaita: [0, 0] }, dir: {}, world: null };
}
export const focal = (v, fov) => (v.vh / 2) / Math.tan(fov / 2 * D2R);
export const lens = p => FOV[0] + (FOV[1] - FOV[0]) * smooth(clamp(p));
export const liftAt = p => (p < CONTACT ? LIFT * Math.sin(Math.PI * p / CONTACT) ** 2 : 0); // gentle early, while the plate has least to spare
// The camera for a zoom (1 = the contact frame), field of view and lift: it moves along the line through the contact,
// so the contact stays put on screen while it eases in; the characters' scale is s·zoom whatever the lens.
export function cameraAt(v, zoom, fov, lift = 0) {
  const f = focal(v, fov), D = f / v.s;
  return { pos: [KX + (v.cam[0] - KX) / zoom, -KY + (v.cam[1] + KY) / zoom, D / zoom], f, D, tilt: Math.atan(lift * v.vh / f) };
}
export function project(v, C, X, Y, Z) {
  const dx = X - C.pos[0], dy = Y - C.pos[1], dz = Z - C.pos[2], c = Math.cos(C.tilt), sn = Math.sin(C.tilt);
  const yc = dy * c + dz * sn, k = C.f / -(-dy * sn + dz * c);
  return [v.vw / 2 + dx * k, v.vh / 2 - yc * k];
}
// The world plate sits deep behind the characters. It is placed to cover the screen at the top of the scroll (the
// widest lens, the start zoom), focused on its own focus point where the screen allows, then made GROW larger about
// the contact's line of sight; from there the dolly, the narrowing lens and the intro only make it grow. Returns its
// rectangle in the scene and how it shows at the contact frame.
export function placeWorld(v, plate) {
  const [PW, PH] = plate.size, [FX, FY] = plate.focus;
  const C0 = cameraAt(v, v.z0, FOV[0]), Zp = -DEPTH * C0.D, k0 = C0.f / (C0.pos[2] - Zp);
  const sW0 = Math.max(v.vw / PW, v.vh / PH), wx0 = clamp(v.kx - FX * sW0, v.vw - PW * sW0, 0), wy0 = clamp(v.ky - FY * sW0, v.vh - PH * sW0, 0);
  const X = sx => C0.pos[0] + (sx - v.vw / 2) / k0, Y = sy => C0.pos[1] - (sy - v.vh / 2) / k0;
  const t = -Zp / C0.pos[2], A = [KX + (KX - C0.pos[0]) * t, -KY + (-KY - C0.pos[1]) * t]; // the contact's line of sight at the plate
  const rect = [X(wx0), Y(wy0), X(wx0 + PW * sW0), Y(wy0 + PH * sW0)].map((n, i) => A[i % 2] + (n - A[i % 2]) * GROW); // left, top, right, bottom (y up)
  const C1 = cameraAt(v, 1, lens(CONTACT)), [left, top] = project(v, C1, rect[0], rect[1], Zp), [right] = project(v, C1, rect[2], rect[3], Zp);
  return { rect, Zp, A, D0: C0.D, size: [PW, PH], sW: (right - left) / PW, wx: left, wy: top, m: (right - left) / PW / sW0 };
}

// project a deformed painted point of a character to the screen, for a state (offset, roll, yaw) and camera;
// the same transform the scene graph applies (group: rotation z then y, then position), done by hand for speed
export function projector(v, def, C, st, off) {
  const [px, py] = def.pivot, r = -st.roll * D2R, cr = Math.cos(r), sr = Math.sin(r), cy = Math.cos(st.yaw * D2R), sy = Math.sin(st.yaw * D2R);
  return (x, y) => {
    const lx = x - px, ly = -(y - py), x1 = lx * cr - ly * sr, y1 = lx * sr + ly * cr;
    return project(v, C, px + off[0] + x1 * cy, -(py + off[1]) + y1, -x1 * sy);
  };
}
export const offsetAt = (v, name, st, spread = 1) => {
  // Bow away from the nearest edge: vertically on wide screens, sideways on tall ones. A wide-screen bow on a phone
  // would push the figures off its narrow sides and force the solver to shorten their vertical travel.
  const d = v.drift[name], a = st.travel * spread, bend = (v.centred ? 0.12 * (1 - 2 * v.land) : 0.12) * Math.sin(Math.PI * Math.min(1, a));
  return [d[0] * a + d[1] * bend + st.bob[0], d[1] * a - d[0] * bend + st.bob[1]];
};

// Solve the approach for this screen: how far out the camera starts and how far each character drifts in, so
// that both stay fully inside the frame (with a margin) at every moment of the approach.
// rigs: the posed paintings (rig.mjs createPainting), by name
export function solveApproach(v, rigs) {
  // a margin all round (plus the robe sway's reach), never more than the contact frame itself leaves
  const rb = [Infinity, Infinity, -Infinity, -Infinity]; // the meshes' own extent at rest (a little past the alpha box)
  for (const rig of Object.values(rigs)) for (const i of rig.outline) {
    const x = rig.rest[2 * i], y = rig.rest[2 * i + 1];
    rb[0] = Math.min(rb[0], x); rb[1] = Math.min(rb[1], y); rb[2] = Math.max(rb[2], x); rb[3] = Math.max(rb[3], y);
  }
  const margin = Math.min(Math.max(6, 0.025 * Math.min(v.vw, v.vh)) + 7 * v.s,
    v.kx - (KX - rb[0]) * v.s - 0.5, v.vw - v.kx - (rb[2] - KX) * v.s - 0.5, v.ky - (KY - rb[1]) * v.s - 0.5, v.vh - v.ky - (rb[3] - KY) * v.s - 0.5);
  const samples = [];
  for (let i = 0; i <= 30; i++) {
    const p = CONTACT * i / 30, tl = timeline(p, 0);
    const shapes = {};
    for (const [name, rig] of Object.entries(rigs)) shapes[name] = rig.outline.map(i => deformPoint(rig.def, rig.weights[i], 0, { chains: tl[name].chains }, rig.rest[2 * i], rig.rest[2 * i + 1]));
    samples.push({ p, tl, shapes });
  }
  const fits = (name, zoomAt0, drift) => {
    const vv = { ...v, drift: { ...v.drift, [name]: drift } };
    for (const { p, tl, shapes } of samples) {
      const st = tl[name], C = cameraAt(vv, 1 - (1 - zoomAt0) * tl.dolly, lens(p), liftAt(p)), P = projector(vv, rigs[name].def, C, st, offsetAt(vv, name, st));
      for (const [x, y] of shapes[name]) { const [sx, sy] = P(x, y); if (sx < margin || sy < margin || sx > v.vw - margin || sy > v.vh - margin) return false; }
    }
    return true;
  };
  // Centred (the launch page and lock), start from opposite corners on every screen, as far out as the frame
  // holds them whole. Legacy rig names: locus is Noah (bottom-left), vaita is Locus (top-right).
  // The non-centred opener keeps its original, more vertical portrait approach.
  const mix = (a, b) => { const x = a[0] + (b[0] - a[0]) * v.land, y = a[1] + (b[1] - a[1]) * v.land, l = Math.hypot(x, y); return [x / l, y / l]; };
  const corner = v.centred ? [v.vw, v.vh] : null;
  const diagonal = corner && Math.hypot(...corner);
  v.dir = corner ? { locus: [-corner[0] / diagonal, corner[1] / diagonal], vaita: [corner[0] / diagonal, -corner[1] / diagonal] }
    : { locus: mix([-0.12, 1], [-1, 0.55]), vaita: mix([0.12, -1], [0.95, -0.6]) };
  const lerp = ([a, b]) => a + (b - a) * v.land;
  const FAR = 6000; // painted px: past any screen, so the search stops where the frame does
  let z0 = lerp(START_ZOOM);
  while (z0 > 0.6 && !(fits('locus', z0, [0, 0]) && fits('vaita', z0, [0, 0]))) z0 -= 0.02;
  v.z0 = z0;
  for (const name of ['locus', 'vaita']) {
    let lo = 0, hi = v.centred ? FAR : lerp(MAX_DRIFT[name]);
    const at = m => [v.dir[name][0] * m, v.dir[name][1] * m];
    if (fits(name, z0, at(hi))) lo = hi;
    else for (let k = 0; k < 18; k++) { const mid = (lo + hi) / 2; if (fits(name, z0, at(mid))) lo = mid; else hi = mid; }
    v.drift[name] = at(lo);
    // Having met one edge, continue along it into the corner, including on tall phones.
    if (v.centred) for (const axis of [0, 1]) {
      const d = v.drift[name], sign = Math.sign(v.dir[name][axis]), push = m => { const e = [...d]; e[axis] += sign * m; return e; };
      let a = 0, b = FAR;
      if (!sign || !(b > 0)) continue;
      if (fits(name, z0, push(b))) a = b;
      else for (let k = 0; k < 16; k++) { const mid = (a + b) / 2; if (fits(name, z0, push(mid))) a = mid; else b = mid; }
      v.drift[name] = push(a);
    }
  }
  v.margin = margin;
}
