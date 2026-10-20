import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// How the sea is drawn, on the actual module with a canvas that records what
// it is asked to draw: the new looks are optional and leave the default
// alone, eyes are never ink, the dots never move and stay invisible when
// empty, and the smooth sharks are laid along their spines.
const source = readFileSync(new URL('../public/js/sharks.js', import.meta.url), 'utf8');

function sea(options = {}, width = 960, height = 600) {
  const calls = [];
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const context = record => new Proxy({
    measureText: () => ({ actualBoundingBoxAscent: 8 }), createPattern: () => ({}),
    createLinearGradient: () => gradient, createRadialGradient: () => gradient,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  }, {
    get: (o, k) => o[k] ?? ((...a) => { if (record) calls.push([k, ...a.map(v => (typeof v === 'object' ? 'image' : v))]); }),
    set: (o, k, v) => { if (record) calls.push(['=' + k, v]); o[k] = v; return true; },
  });
  const size = { width, height };
  const canvas = { width, height, getContext: () => context(true), getBoundingClientRect: () => size };
  const code = source.replace('export function swim', 'function swim').replace('export default swim;', 'return swim;')
    .replace('  return stop;\n}', `  stop.probe = { get sharks() { return sharks; }, get dots() { return dots; }, get cells() { return cells; }, step, render };\n  return stop;\n}`);
  const env = {
    devicePixelRatio: 1, requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    OffscreenCanvas: class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return context(false); } },
  };
  const swim = vm.compileFunction(code, Object.keys(env))(...Object.values(env));
  const stop = swim(canvas, { seed: 17, cell: 14, ...options });
  return { stop, probe: stop.probe, calls };
}

const frames = (s, n) => { for (let i = 0; i < n; i++) { s.probe.step(1 / 30); s.probe.render(); } };

test('the new looks are optional: by default the sea is characters in the light palette, eyeless, with no resting dots', () => {
  const plain = sea({ enter: true }), spelled = sea({ enter: true, render: 'ascii', palette: 'light', eyes: false, rest: 0 });
  frames(plain, 120); frames(spelled, 120);
  assert.ok(plain.calls.filter(c => c[0] === 'drawImage').length > 1000);
  assert.deepEqual(plain.calls, spelled.calls);
  plain.stop(); spelled.stop();
});

test('no eyes unless asked for, and then only an o a shade darker than the body, never in ink', () => {
  // The sprite atlas: 32 tiles a row; body tiles are ((tint * 10 + tone) * 2 + ink) * 15 + glyph, glyph 13 an o.
  const pose = [{ species: 'hammerhead', x: 300, y: 300, angle: 0, length: 30 }, { species: 'reef', x: 700, y: 300, angle: Math.PI, length: 30 }];
  const tiles = eyes => {
    const s = sea({ pose, plankton: false, wake: false, eyes });
    const [cw, ch] = [Math.round(14 * 2 / 3), 14];
    const ids = s.calls.filter(c => c[0] === 'drawImage').map(c => (c[3] / ch) * 32 + c[2] / cw);
    s.stop();
    return ids;
  };
  // Tiles 1080 and 1081 were the eyes in ink.
  const o = id => id < 900 && id % 15 === 13, ink = id => id === 1080 || id === 1081;
  assert.equal(tiles(false).filter(id => o(id) || ink(id)).length, 0, 'eyeless by default');
  assert.equal(tiles(true).filter(ink).length, 0, 'never the old ink eyes');
  const marked = tiles(true).filter(o);
  assert.ok(marked.length >= 2, 'eyes when asked for');
  for (const id of marked) {
    const tone = Math.floor(id / 30) % 10, ink = Math.floor(id / 15) % 2;
    assert.equal(ink, 0, 'in the tile\'s own ink, not black');
    assert.ok(tone >= 1, 'never the darkest tile');
  }
});

test('dots never move and an empty sea of dots shows nothing but its ground', () => {
  const lit = sea({ render: 'dots', palette: 'kinso', enter: true });
  frames(lit, 240);
  const { ox, oy, pw, cols, rows } = lit.probe.dots;
  const drawn = lit.calls.filter(c => c[0] === 'drawImage');
  assert.ok(drawn.length > 1000, 'sharks light the dots');
  for (const c of drawn) {
    assert.equal((c[6] - ox) % pw, 0, 'on the grid'); assert.equal((c[7] - oy) % pw, 0, 'on the grid');
    assert.equal(c[8], pw); assert.equal(c[9], pw);
  }
  assert.ok(pw === 9 && cols * rows > 7000);
  lit.stop();
  // No sharks, plankton or wake: after the first frame's ground, nothing is drawn at all.
  const empty = sea({ render: 'dots', sharks: 0, plankton: false, wake: false });
  frames(empty, 30);
  assert.equal(empty.calls.filter(c => c[0] === 'drawImage').length, 0, 'no resting dots by default');
  assert.equal(empty.calls.filter(c => c[0] === 'fillRect').length, 1, 'the ground, once');
  empty.stop();
  const resting = sea({ render: 'dots', sharks: 0, plankton: false, wake: false, rest: 0.15 });
  const { cols: c2, rows: r2 } = resting.probe.dots;
  assert.equal(resting.calls.filter(c => c[0] === 'drawImage').length, c2 * r2, 'faint resting dots when asked for');
  resting.stop();
});

test('smooth sharks are their bodies laid along the spine, slice by slice, with no grid', () => {
  const s = sea({ render: 'smooth', palette: 'kinso', enter: false, plankton: false, wake: false });
  s.calls.length = 0;
  frames(s, 1);
  assert.deepEqual(s.calls.filter(c => /^fill|^stroke/.test(c[0])), [['fillRect', 0, 0, 960, 600]], 'one fill, the plain ground: no grid, no outlines');
  const slices = s.calls.filter(c => c[0] === 'drawImage');
  assert.ok(slices.length >= 10 * s.probe.sharks.length && slices.length <= 35 * s.probe.sharks.length, `${slices.length} slices`);
  // Each slice is turned to its segment: a rotation (or its mirror), nothing stretched.
  for (const c of s.calls.filter(c => c[0] === 'setTransform').slice(1)) {
    const [, a, b, cc, d, e, f] = c;
    assert.ok(Math.abs(Math.hypot(a, b) - 1) < 1e-6 && Math.abs(Math.hypot(cc, d) - 1) < 1e-6 && Math.abs(a * cc + b * d) < 1e-6);
    assert.ok(Number.isFinite(e) && Number.isFinite(f));
  }
  s.stop();
});
