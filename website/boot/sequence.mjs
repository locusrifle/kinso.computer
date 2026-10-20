// One boot picture and sound for the public website and the native lock.
// Hosts own authentication and what comes afterwards; neither keys nor passwords belong here.
import * as T from '../vendor/three.module.js';
import manifest from '../opener/assets/manifest.mjs';
import { LOCUS, VAITA } from '../opener/cast.mjs';
import { createPainting, sharpen } from '../opener/rig.mjs';
import { timeline, CONTACT } from '../opener/timeline.mjs';
import { KX, KY, FOV, clamp, smooth, pairBoxOf, frame as frameOf, lens, liftAt, cameraAt, placeWorld, offsetAt, solveApproach } from '../opener/framing.mjs?v=portrait-corners1';
import { pOfPos, posOfP } from '../opener/scroll.mjs';
import { bindLockScroll, createMomentum } from './scroll.mjs?v=embedded-wheel2';
import { bubblePath } from '../bubble.mjs';
import { BURST, createPlayer } from '../bootup.mjs';
import { revealAt } from '../reveal.mjs?v=plain-1';
import { soundMotion } from '../bubble-sound.mjs';
import { WORD, createWordmark, wordmarkAt, placeWordmark, metalSilver } from '../wordmark.mjs?v=kinso-lift-2';
import { opticalWordmark } from '../intro/goat.mjs?v=kinso-lift-2';

export function createSequence({
  clock = () => performance.now() / 1000, fixed = () => false, wall = () => Date.now() / 1000,
  epoch = Date.now() / 1000, bg = '#000000', ink = '#ffffff', world = 'dragon',
  profile = null, tell = () => {}, onFrame = () => {}, onMove = () => {}, keepAlive = () => false,
} = {}) {
const momentum = createMomentum();
const SOONEST = 0.8;
profile?.mark('module-ready');
const art = { locus: manifest.locus, vaita: manifest.vaitas[manifest.worlds[world].vaita] };
const pairBox = pairBoxOf(art);
// The launch page's contact frame: the touch at the very middle of the screen, where the word then comes (framing.mjs centred).
const frame = (vw, vh, box) => frameOf(vw, vh, box, { centred: true });
const file = entry => new URL('../opener/' + entry.hd, import.meta.url).href;
const BG = bg, INK = ink;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const $ = id => document.getElementById(id);
const stage = $('stage'), canvas = $('scene'), sky = $('sky');
const wallpaper = document.createElement('div'); wallpaper.className = 'macos-wallpaper';
sky.insertBefore(wallpaper, $('wordmark'));
sky.dataset.backdrop = 'wallpaper';
let arrival = 0;
const rim = $('rim'), rimPath = $('rimPath'), glow = $('glow'), markEl = $('wordmark');
rimPath.style.stroke = metalSilver(INK);
const sound = createPlayer({ clock, fixed });
document.documentElement.style.setProperty('--sky-bg', BG);
document.documentElement.style.setProperty('--sky-ink', INK);
const FLOAT = {
  locus: { x: 6, y: 11, r: 0.8, wx: 0.53, wy: 0.83, wr: 0.47, px: 0.3, py: 1.2 },
  vaita: { x: 8, y: 14, r: 1.0, wx: 0.47, wy: 0.71, wr: 0.39, px: 2.1, py: 0.2 },
};

const TOUCH = posOfP(CONTACT);
const S = { phase: 'scene', scrolled: 0, shown: 1, auto: null, started: false };
const rv = { t0: 0, wall: null, at: [0, 0], popAt: null, fade: false, open: false };
let view = null, renderer = null, scene, camera, plate, rigs = null, mode = 'loading', kind = null;
const plates = {};
const motion = () => !reduced.matches && mode === 'webgl';
let mark = null, markState = null, bubbleState = null, suspended = false;
// Hosts may pause the opener after handing over to their next surface.
let quieted = false, asleep = false, moved = false, frames = 0, soundAt = null;
let locking = false, marksOn = true;
// The aperture keeps its original size and sound-driven deformation.
const GROW = 1.05; // Noah's: the bubble 30% smaller than its old 1.5, a portal onto the wallpaper and the word
const intro = {
  start({ auto = true } = {}) { if (S.started || suspended) return; S.started = true; sound.prime(); if (auto) approach(); else wake(); },
  // Inside a gesture (the unlock, or any press after a remembered one): the boot sound's audio resumed. Plays nothing.
  prime() { sound.prime(); },
  // The wallpaper can stand on its own when the opener is skipped.
  lockSky(on, ms = 0) {
    if (on) { locking = true; sky.dataset.lock = 'on'; wake(); return; }
    if (!locking) return;
    locking = false; sky.dataset.lock = 'off';
    setTimeout(() => { if (sky.dataset.lock === 'off') delete sky.dataset.lock; }, ms);
    wake();
  },
  approach() { if (S.started && !quieted && !suspended) approach(); },
  nudge(screens) { if (S.started && S.phase === 'scene' && !S.auto) move(Number(screens) * innerHeight || 0); },
  marks(on) { marksOn = Boolean(on); },
  // Only the wallpaper dissolves. No second scene is painted during native unlock.
  arrival(amount) { arrival = clamp(amount); wallpaper.style.opacity = String(1 - arrival); wake(); },
  reset() {
    marksOn = true; arrival = 0; wallpaper.style.opacity = '1';
    sound.stop(); momentum.cancel(); bubbleState = markState = null;
    Object.assign(S, { phase: 'scene', scrolled: 0, shown: 1, auto: null });
    Object.assign(rv, { wall: null, popAt: null, open: false });
    mark?.draw({ opacity: 0, blur: 0, scale: 1, formed: 1 });
    sky.style.visibility = 'hidden'; sky.style.opacity = ''; sky.style.clipPath = sky.style.webkitClipPath = '';
    stage.style.visibility = ''; rim.setAttribute('hidden', ''); glow.style.opacity = '0';
    drawnAt = drawnP = -1;
    if (mode === 'webgl') { render(clock(), 0); drawnAt = clock(); drawnP = 0; }
    wake();
  },
  setMuted(value) { sound.setMuted(value); },
  quiet() { quieted = true; sound.setMuted(true); momentum.cancel(); S.auto = null; },
  sky(on) { asleep = !on; if (on) wake(); },
  suspend() { suspended = true; sound.stop(); momentum.cancel(); },
  state() {
    return { phase: S.phase, tau: sound.elapsed(), bubble: bubbleState, wordmark: markState, world, mode, reduced: reduced.matches, suspended,
      sky: 'wallpaper', started: S.started, auto: Boolean(S.auto), scrolled: S.scrolled, shown: S.shown, moved, quiet: quieted, asleep, frames, soundAt, burst: null,
      locking, mark: markEl.style.left ? [parseFloat(markEl.style.left), parseFloat(markEl.style.top)] : null,
      p: +pOfPos(S.shown).toFixed(4), touched: rv.wall, pop: rv.popAt === null ? null : +(rv.popAt - rv.t0).toFixed(3),
      epoch, contact: view && [view.kx, view.ky], figures: figureBoxes(),
      backdrop: 'wallpaper', arrival, audible: sound.audible,
      source: null, lens: null };
  }
};
function noticeMove() { onMove(); if (!moved) { moved = true; tell('move'); } }
// The lock's scroll, both ways: forward brings them together, back moves them apart again, until they touch (from the
// touch nothing moves them: the scene is over).
function move(px) {
  if (!px) return;
  const was = S.scrolled;
  // in screens, not px, so a resize (or full screen) keeps them exactly as far apart as they were
  S.scrolled = clamp(S.scrolled + px * 5 / innerHeight, 0, TOUCH - 1);
  if (S.scrolled === was) return; // already apart as far as they go
  noticeMove();
  wake();
}
// a key before the touch: the rest of the way, quicker the less there is of it
function approach() {
  if (S.phase !== 'scene' || S.auto) return;
  noticeMove();
  momentum.cancel();
  if (!motion()) { S.scrolled = TOUCH - 1; wake(); return; }
  const from = 1 + S.scrolled;
  S.auto = { from, at: clock(), length: 0.35 + 1.5 * (TOUCH - from) / 4.2 };
  wake();
}


const screenOf = v3 => { const p = v3.clone().project(camera); return [(p.x + 1) * view.vw / 2, (1 - p.y) * view.vh / 2]; };
const at = (rig, pose, x, y) => { const [dx, dy] = rig.deform(pose, x, y); return screenOf(rig.group.localToWorld(new T.Vector3(...rig.local(dx, dy), 0))); };
const XAXIS = new T.Vector3(1, 0, 0);
// Each figure's box on screen as last drawn ([left, top, right, bottom], CSS px), for the page's state (checks only).
const posed = {};
function figureBoxes() {
  if (mode !== 'webgl' || !posed.locus) return null;
  const out = {};
  for (const [name, rig] of Object.entries(rigs)) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const i of rig.outline) {
      const [x, y] = at(rig, posed[name], rig.rest[2 * i], rig.rest[2 * i + 1]);
      b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
    }
    out[name] = b.map(Math.round);
  }
  return out;
}
function layout() {
  const vw = innerWidth, vh = innerHeight;
  view = frame(vw, vh, pairBox);
  if (view.kind !== kind && plates[view.kind]?.img) usePlate(view.kind);
  if (mode === 'webgl') solveApproach(view, rigs);
  view.world = placeWorld(view, manifest.worlds[world][kind || view.kind]);
  if (mode === 'webgl') {
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 3, Math.sqrt(9e6 / (vw * vh))));
    renderer.setSize(vw, vh, false);
    camera.aspect = vw / vh; camera.near = 10; camera.far = (view.world.D0 / view.z0 - view.world.Zp) * 1.5; camera.updateProjectionMatrix();
  } else if (mode === 'still') placeStill();
  // the wordmark alone at the very centre, as on the website; the field comes to the same centre once it has gone
  // on its optical centre: its ink's mass, not its box, on the centre line (goat.mjs)
  const word = opticalWordmark(placeWordmark(vw, vh)), [wx, wy, ww] = word;
  Object.assign(markEl.style, { left: `${wx}px`, top: `${wy}px` });
  mark?.size(ww, devicePixelRatio || 1);
  const size = Math.max(120, 300 * view.s);
  Object.assign(glow.style, { width: `${size}px`, height: `${size}px`, left: `${view.kx - size / 2}px`, top: `${view.ky - size / 2}px` });
  if (S.phase !== 'scene') {
    rv.at = [view.kx, view.ky];
    if (mode === 'webgl' && !rv.open) render(clock(), CONTACT); // one fresh frozen contact after resize
  }
  wake();
}
function render(t, p) {
  renderer.resetState();
  const tl = timeline(p, motion() ? t : 0);
  const zoom = 1 - (1 - view.z0) * tl.dolly, fov = lens(p), C = cameraAt(view, zoom, fov, liftAt(p));
  const alive = motion() ? 1 - smooth(clamp(p / CONTACT)) : 0;
  for (const [name, rig] of Object.entries(rigs)) {
    const st = tl[name], f = FLOAT[name], off = offsetAt(view, name, st);
    rig.pose({ chains: st.chains, sway: st.sway }); posed[name] = { chains: st.chains, sway: st.sway };
    rig.place({ x: off[0] + alive * f.x * Math.sin(f.wx * t + f.px), y: off[1] + alive * f.y * Math.sin(f.wy * t + f.py), roll: st.roll + alive * f.r * Math.sin(f.wr * t), yaw: st.yaw });
  }
  camera.position.set(...C.pos); camera.quaternion.setFromAxisAngle(XAXIS, C.tilt);
  camera.fov = fov; camera.updateProjectionMatrix(); scene.updateMatrixWorld(); camera.updateMatrixWorld();
  // the plate where the opener puts it, made a little larger only if it would not cover the screen
  const w = view.world, [x0, y0, x1, y1] = w.rect;
  let k = 1;
  const placePlate = () => { plate.scale.set((x1 - x0) * k, (y0 - y1) * k, 1); plate.position.set(w.A[0] + ((x0 + x1) / 2 - w.A[0]) * k, w.A[1] + ((y0 + y1) / 2 - w.A[1]) * k, w.Zp); plate.updateMatrixWorld(); };
  placePlate();
  const corners = [[-0.5, 0.5], [0.5, 0.5], [0.5, -0.5], [-0.5, -0.5]].map(([u, v]) => screenOf(plate.localToWorld(new T.Vector3(u, v, 0))));
  const As = screenOf(new T.Vector3(w.A[0], w.A[1], w.Zp));
  const L = Math.max(corners[0][0], corners[3][0]), R = Math.min(corners[1][0], corners[2][0]), Tp = Math.max(corners[0][1], corners[1][1]), B = Math.min(corners[2][1], corners[3][1]);
  const need = Math.max(1, L > 0 ? As[0] / (As[0] - L) : 1, R < view.vw ? (view.vw - As[0]) / (R - As[0]) : 1, Tp > 0 ? As[1] / (As[1] - Tp) : 1, B < view.vh ? (view.vh - As[1]) / (B - As[1]) : 1);
  if (need > 1) { k = need * 1.004; placePlate(); }
  const submitAt = profile ? performance.now() : 0;
  renderer.render(scene, camera);
  profile?.sample('webgl-submit', performance.now() - submitAt);

}


function openReveal(t) {
  momentum.cancel();
  S.phase = 'bubble'; S.auto = null; S.shown = TOUCH;
  Object.assign(rv, { t0: t, at: [view.kx, view.ky], popAt: null, fade: !motion(), open: false });
  rv.wall = rv.fade ? null : Math.round(wall() * 1000) / 1000;
  profile?.phase('contact'); tell(rv.wall === null ? 'touch' : 'touch:' + Math.round(rv.wall * 1000));
  // Freeze the contact painting once. Its poses are stationary here; submitting it behind
  // a second full-DPR canvas every bubble frame needlessly doubles the GPU's work.
  sound.start(t); soundAt = t;
  if (mode === 'webgl') render(t, CONTACT);
  locking = false; delete sky.dataset.lock; // the lock's sky has long gone; the bubble's is its own
  sky.style.visibility = 'visible';
  // The same wobbly aperture now looks directly onto the desktop's cover crop.
}
// Keep the opening on its original sound mark.
function pop(t, dt) {
  rv.popAt = t; S.phase = 'opening';
}
function stepReveal(t, dt) {
  if (S.phase === 'bubble') { if (sound.elapsed(t) >= BURST) { pop(t, dt); if (rv.fade) rv.open = true; } else return; }
  if (t - rv.popAt < (rv.fade ? 0 : SOONEST)) return;

  // The lock follows the lettering's original fade, on the shared contact clock.
  const tau = sound.elapsed(t);
  if (tau < WORD.gone) return;
  S.phase = 'ready'; tell('complete');
  profile?.phase('ready');
}
function drawReveal(t) {
  const at = profile ? performance.now() : 0;
  const tau = sound.elapsed(t);
  if (rv.fade) {
    sky.style.opacity = tau >= BURST ? '1' : '0';
    sky.style.clipPath = sky.style.webkitClipPath = 'none';
    rim.setAttribute('hidden', ''); glow.style.opacity = '0';
  } else if (!rv.open) {
    const b = revealAt(tau, { at: rv.at, width: innerWidth, height: innerHeight, scale: view.s, grow: GROW, motion: soundMotion });
    bubbleState = { ...b, tau: +tau.toFixed(3) };
    const d = bubblePath(...rv.at, Math.max(0.01, b.R), b.wt, b.wob, b); // the sound's ripples and grain on the rim
    sky.style.clipPath = sky.style.webkitClipPath = `path('${d}')`;
    rimPath.setAttribute('d', d); rim.removeAttribute('hidden'); rim.style.opacity = String(b.rim);
    glow.style.opacity = String(b.glow); glow.style.transform = `scale(${b.glowScale.toFixed(4)})`;
    if (b.done) { rv.open = true; sky.style.clipPath = sky.style.webkitClipPath = ''; rim.setAttribute('hidden', ''); glow.style.opacity = '0'; }
  }
  frames++;
  const m = wordmarkAt(tau, { still: reduced.matches || rv.fade });
  // Keep the lettering's own condense, shine, hold and fade, on its original clock.
  markState = m.on && marksOn ? m : { ...m, opacity: 0 };
  mark?.draw(markState);
  profile?.sample('world-submit', performance.now() - at);
}
// One frame loop for the painting, aperture and lettering.
let running = false, lastTick = null, drawnAt = -1, drawnP = -1;
function tick() {
  if (suspended || (asleep && S.phase === 'ready')) { running = false; return; }
  const tickAt = profile ? performance.now() : 0;
  const t = clock(), dt = lastTick === null ? 0 : clamp(t - lastTick, 0, 0.1);
  lastTick = t;
  if (S.phase === 'scene') {
    if (S.auto) {
      const u = clamp((t - S.auto.at) / S.auto.length);
      S.scrolled = S.auto.from + (TOUCH - S.auto.from) * u * u * (3 - 2 * u) - 1;
    }
    if (!S.auto && motion()) move(momentum.step(t, dt)); else momentum.cancel();
    const goal = 1 + S.scrolled;
    if (!motion()) S.shown = goal;
    else { S.shown += (goal - S.shown) * (1 - Math.exp(-dt / 0.085)); if (Math.abs(goal - S.shown) < 1e-4) S.shown = goal; }
    if (S.started && (pOfPos(S.shown) >= CONTACT - 0.002 || (!motion() && S.shown > 1))) openReveal(t);
  }
  if (S.phase === 'bubble' || S.phase === 'opening') stepReveal(t, dt);
  const p = S.phase === 'scene' ? pOfPos(S.shown) : CONTACT;
  const calm = S.phase === 'scene' && !S.auto && drawnP === p;
  if (mode === 'webgl' && S.phase === 'scene' && (motion() || drawnAt < 0 || drawnP !== p)
    && !(fixed() && drawnAt === t && drawnP === p)
    && !(calm && !fixed() && t - drawnAt < 1 / 30 - 0.004)) {
    const paintAt = profile ? performance.now() : 0;
    if (drawnAt >= 0) profile?.sample('painting-gap', (t - drawnAt) * 1000);
    render(t, p);
    profile?.sample('painting-cpu', performance.now() - paintAt);
    drawnAt = t; drawnP = p;
  }
  if (mode === 'still' && drawnP !== p) { placeStill(); drawnP = p; }
  if (S.phase !== 'scene') drawReveal(t);
  onFrame(t, intro.state());
  profile?.sample('tick-cpu', performance.now() - tickAt);
  const busy = keepAlive() || (S.started && (S.phase !== 'ready' && (motion() || S.phase !== 'scene' || S.auto || S.shown !== 1 + S.scrolled)));
  if (!document.hidden && busy) requestAnimationFrame(tick); else running = false;
}
function wake() { if (!suspended && !running && view) { running = true; lastTick = null; requestAnimationFrame(tick); } }
const images = {};
function placeStill() {
  const el = $('still'), [img, locus, vaita] = el.children;
  if (!img || !view) return;
  const w = view.world, s = view.s;
  Object.assign(img.style, { left: '0px', top: '0px', width: `${w.size[0]}px`, height: `${w.size[1]}px`, transform: `translate(${w.wx}px, ${w.wy}px) scale(${w.sW})` });
  for (const [im, m] of [[locus, art.locus], [vaita, art.vaita]]) {
    Object.assign(im.style, { left: '0px', top: '0px', width: `${m.crop[2]}px`, height: `${m.crop[3]}px`, transform: `translate(${view.kx + (m.crop[0] - KX) * s}px, ${view.ky + (m.crop[1] - KY) * s}px) scale(${s})` });
  }
}
function stillMode() {
  mode = 'still'; canvas.hidden = true;
  const el = $('still'); el.hidden = false;
  el.replaceChildren(plates[kind].img.cloneNode(), images.vaita.cloneNode(), images.locus.cloneNode());
  placeStill();
}

const load = src => new Promise((ok, fail) => {
  const img = new Image(); img.alt = ''; img.decoding = 'async';
  img.onload = () => (img.decode ? img.decode() : Promise.resolve()).then(() => ok(img), () => ok(img));
  img.onerror = () => fail(new Error(`could not load ${src}`));
  img.src = src;
});
function usePlate(k) {
  kind = k;
  const e = plates[k];
  if (mode === 'webgl') {
    if (!e.tex) { e.tex = new T.Texture(e.img); e.tex.colorSpace = T.SRGBColorSpace; e.tex.anisotropy = 4; e.tex.needsUpdate = true; }
    plate.material.map = e.tex; plate.material.needsUpdate = true;
  }
}
// The wallpaper is immediately available while the paintings load (skyReady).
let skyMade;
const skyReady = new Promise(ok => { skyMade = ok; });
async function start() {
  const k0 = innerWidth < innerHeight ? 'port' : 'land';
  const paintings = Promise.all([load(file(art.locus)), load(file(art.vaita)), load(file(manifest.worlds[world][k0]))]);
  paintings.catch(() => {}); // awaited below; a failure is ready's
  sky.style.background = BG;
  mark = createWordmark(markEl, { ink: INK });
  layout();
  addEventListener('resize', layout);
  reduced.addEventListener?.('change', wake);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  skyMade(true);
  const [locus, vaita, img] = await paintings;
  profile?.mark('assets-decoded');
  images.locus = locus; images.vaita = vaita; plates[k0] = { img };
  const contextAt = profile ? performance.now() : 0;
  let gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' });
  if (gl?.isContextLost()) gl = null; // Safari without working WebGL hands out a lost context, and three.js throws on it
  profile?.mark('context-ready', { ms: performance.now() - contextAt, webgl: !!gl });
  if (gl) {
    if (profile) {
      for (const name of ['compileShader', 'linkProgram']) {
        const original = gl[name].bind(gl);
        gl[name] = (...args) => {
          const at = performance.now();
          try { return original(...args); }
          finally { profile.sample(name + '-cpu', performance.now() - at); }
        };
      }
    }
    mode = 'webgl';
    renderer = new T.WebGLRenderer({ canvas, context: gl, antialias: false });
    renderer.outputColorSpace = T.SRGBColorSpace; renderer.setClearColor('#07060c');
    scene = new T.Scene();
    camera = new T.PerspectiveCamera(FOV[0], 1, 10, 1e5);
    plate = new T.Mesh(new T.PlaneGeometry(1, 1), sharpen(new T.MeshBasicMaterial({ depthTest: false, depthWrite: false })));
    plate.renderOrder = 0; plate.frustumCulled = false; scene.add(plate);
    rigs = { vaita: createPainting(VAITA, vaita, art.vaita.crop), locus: createPainting(LOCUS, locus, art.locus.crop) };
    for (const rig of Object.values(rigs)) scene.add(rig.group);
    usePlate(k0);
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); stillMode(); });
  } else { kind = k0; stillMode(); }
  renderer?.resetState();
  layout();
  profile?.mark('painting-ready', { mode, paintingPixels: canvas.width * canvas.height });
  if (mode === 'webgl') {
    const firstAt = profile ? performance.now() : 0;
    render(clock(), 0);
    profile?.mark('first-paint-submit', { ms: performance.now() - firstAt, programs: renderer.info.programs.length });
    drawnAt = clock(); drawnP = 0;
  }

  if (profile) requestAnimationFrame(() => requestAnimationFrame(() => profile.mark('first-presentation-opportunity')));
  bindLockScroll({ active: () => S.started && S.phase === 'scene' && !S.auto && !suspended && !quieted, height: () => innerHeight, move: px => move(px), momentum, clock });
  // the other orientation's plate, if a turned or another screen wants it
  addEventListener('resize', () => {
    const k = innerWidth < innerHeight ? 'port' : 'land';
    if (!plates[k]) { plates[k] = {}; load(file(manifest.worlds[world][k])).then(img => { plates[k].img = img; layout(); }, () => {}); }
  });
  wake();
  return true;
}

const ready = start().then(async value => {
  // Ready must include the lettering: do not lose its brief appearance to loading.
  if (!await mark.ready) throw new Error('Wordmark could not load');
  await sound.ready; // A failed sound still advances the original visual clock.
  tell('ready');
  return value;
}).catch(error => { tell('failed'); throw error; });
return { intro, ready, skyReady };
}
