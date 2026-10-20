import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const native = new URL('../public/js/sharks.js', import.meta.url);
const website = new URL('../../../../website/for-kinso/sharks.mjs', import.meta.url);
const source = readFileSync(native, 'utf8');

// Compile the actual module with lexical fixture browser globals, without a
// production debug API, global mutation or a second simulation. No providers.
function sea(options = {}, width = 1440, height = 900, reduced = false, dpr = 1) {
  let size = { width, height };
  const noop = () => {};
  const context = new Proxy({ measureText: () => ({ actualBoundingBoxAscent: 8 }), createPattern: () => ({}) }, {
    get: (o, k) => o[k] ?? noop,
  });
  const canvas = { width, height, getContext: () => context, getBoundingClientRect: () => size };
  const code = source.replace('export function swim', 'function swim').replace('export default swim;', 'return swim;')
    .replace('      const b = bounds(live[i]), placed', '      stats.fallbacks = (stats.fallbacks || 0) + 1; const b = bounds(live[i]), placed')
    .replace('  return stop;\n}', `  stop.probe = {
      get sharks() { return sharks; }, get dims() { return [cw, ch, W, H]; },
      step(dt) { time += dt; stepSharks(dt); }, resize,
      separate, bounds, contact, steer, spine, readAvoid,
      cells(sh) { stampF++; frameCellCount = 0; raster(sh, 0); return Array.from(frameCells.slice(0, frameCellCount)); },
    };\n  return stop;\n}`);
  const env = {
    devicePixelRatio: dpr, requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
    matchMedia: () => ({ matches: reduced, addEventListener: noop, removeEventListener: noop }),
    OffscreenCanvas: class { getContext() { return context; } },
  };
  const swim = vm.compileFunction(code, Object.keys(env))(...Object.values(env));
  const stop = swim(canvas, { seed: 17, enter: true, plankton: false, wake: false, ...options });
  return { stop, probe: stop.probe, resize(w, h) { size = { width: w, height: h }; stop.probe.resize(); } };
}

// Independent geometric oracle: endpoint projections plus a proper segment
// intersection test, rather than the solver's closest-points formula.
function pointSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}
function distance(ax, ay, bx, by, cx, cy, dx, dy) {
  const cross = (x, y, u, v) => x * v - y * u;
  const abx = bx - ax, aby = by - ay, cdx = dx - cx, cdy = dy - cy;
  const den = cross(abx, aby, cdx, cdy);
  if (Math.abs(den) > 1e-9) {
    const t = cross(cx - ax, cy - ay, cdx, cdy) / den;
    const u = cross(cx - ax, cy - ay, abx, aby) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(pointSegment(ax, ay, cx, cy, dx, dy), pointSegment(bx, by, cx, cy, dx, dy),
    pointSegment(cx, cy, ax, ay, bx, by), pointSegment(dx, dy, ax, ay, bx, by));
}
function assertClear(probe, label, pixels = false) {
  const { sharks, dims: [cw, ch] } = probe;
  const pad = 1.2 * cw + Math.hypot(cw, ch) / 2;
  const radii = sharks.map(sh => Array.from({ length: 35 }, (_, k) => sh.sp.reach[k] * sh.L + pad +
    ((k === 0 || k === 34) ? 1.4 * Math.hypot(sh.qx[k + 1] - sh.qx[k], sh.qy[k + 1] - sh.qy[k]) : 0)));
  for (let a = 0; a < sharks.length; a++) {
    const A = sharks[a];
    assert.ok(Number.isFinite(A.x + A.y + A.L), `${label}: finite`);
    for (let b = a + 1; b < sharks.length; b++) {
      const B = sharks[b];
      for (let i = 0; i < 35; i++) for (let j = 0; j < 35; j++) {
        const r = radii[a][i] + radii[b][j];
        if (Math.max(A.qx[i], A.qx[i + 1]) + r < Math.min(B.qx[j], B.qx[j + 1]) ||
            Math.max(B.qx[j], B.qx[j + 1]) + r < Math.min(A.qx[i], A.qx[i + 1]) ||
            Math.max(A.qy[i], A.qy[i + 1]) + r < Math.min(B.qy[j], B.qy[j + 1]) ||
            Math.max(B.qy[j], B.qy[j + 1]) + r < Math.min(A.qy[i], A.qy[i + 1])) continue;
        const d = distance(A.qx[i], A.qy[i], A.qx[i + 1], A.qy[i + 1], B.qx[j], B.qy[j], B.qx[j + 1], B.qy[j + 1]);
        assert.ok(d + 0.002 >= r, `${label}: bodies ${a}/${b}, segments ${i}/${j}: ${d} < ${r}`);
      }
    }
  }
  if (pixels) {
    const seen = new Set();
    for (const sh of sharks) for (const id of probe.cells(sh)) {
      assert.ok(!seen.has(id), `${label}: shared painted cell ${id}`); seen.add(id);
    }
  }
}

test('native and website renderers stay byte-identical', () => {
  assert.equal(readFileSync(website, 'utf8'), source);
});

test('enter starts every whole body/tile off-frame, including angled tails', () => {
  for (const [w, h] of [[1440, 900], [390, 844], [240, 320], [844, 390]]) for (const seed of [1, 17, 852]) {
    const { probe, stop } = sea({ seed, sharks: 6 }, w, h);
    assert.equal(probe.sharks.length, 6);
    for (const sh of probe.sharks) {
      const b = probe.bounds(sh);
      assert.ok(b.right < 0 || b.left > w || b.bottom < 0 || b.top > h);
      assert.equal(probe.cells(sh).length, 0);
    }
    assertClear(probe, `entrance ${w}/${seed}`);
    stop();
  }
});

test('full-body constraints separate crossing tails, parallel bodies and dense clusters', () => {
  const { probe, stop } = sea({ sharks: 8 }, 390, 844);
  for (const [i, sh] of probe.sharks.entries()) {
    sh.x = 200 + i * 2; sh.y = 300; sh.a = i * Math.PI / 2;
    sh.trN = 0; sh.back = [-Math.cos(sh.a), -Math.sin(sh.a)]; probe.spine(sh);
  }
  probe.separate();
  assertClear(probe, 'dense crossing', true);
  stop();
});

test('long swimming, late arrivals, obstacle changes, phone/narrow resizes and count changes', () => {
  let samples = 0, fallbacks = 0;
  for (const seed of [1, 17, 852, 92105]) {
    let rects = [{ left: 480, right: 960, top: 360, bottom: 520 }];
    const { probe, stop, resize } = sea({ seed, cell: seed === 852 ? 'auto' : 14, avoid: () => rects });
    const sizes = [[1440, 900], [390, 844], [240, 320], [844, 390], [1920, 1080], [320, 900]];
    for (let frame = 0; frame < 10800; frame++) { // six minutes/seed at 30 Hz
      if (frame % 1800 === 0) {
        resize(...sizes[frame / 1800]);
        assertClear(probe, `resize ${seed}/${frame}`, true);
        rects = [{ x: 40, y: 100, width: 180, height: 90 }];
        stop.set({ avoid: () => rects });
      }
      if (frame === 2400) stop.set({ sharks: 6 });
      if (frame === 7200) stop.set({ sharks: 4 });
      probe.step(1 / 30);
      if (frame % 15 === 0) { assertClear(probe, `${seed}/${frame}`, frame % 300 === 0); samples++; }
    }
    assert.ok(probe.sharks.length >= 4, 'requested count retained');
    fallbacks += stop.stats.fallbacks || 0;
    stop();
  }
  console.log(`independent geometry checked ${samples} time samples (24 simulated minutes), plus resizes; ${fallbacks} dense-cluster fallbacks`);
});

test('warm starts and reduced-motion stills are nonintersecting', () => {
  for (const reduced of [false, true]) {
    const { probe, stop } = sea({ enter: false }, 390, 844, reduced);
    assertClear(probe, `warm/reduced ${reduced}`, true);
    stop();
  }
});

test('obstacle steering is preserved and actually affects motion', () => {
  const a = sea({ seed: 42, sharks: 1 });
  const b = sea({ seed: 42, sharks: 1, avoid: () => [{ left: -2000, right: 3000, top: -2000, bottom: 3000 }] });
  for (let i = 0; i < 120; i++) { a.probe.step(1 / 30); b.probe.step(1 / 30); }
  assert.notEqual(a.probe.sharks[0].a, b.probe.sharks[0].a);
  a.stop(); b.stop();
});

test('HiDPI auto cells, every-frame narrow contacts, repeated rotations without shrinking away', () => {
  const { probe, stop, resize } = sea({ seed: 852, cell: 'auto', sharks: 6 }, 320, 640, false, 3);
  const lengths = probe.sharks.map(sh => sh.L);
  for (let turn = 0; turn < 8; turn++) {
    resize(640, 320); assertClear(probe, `landscape ${turn}`, true);
    resize(320, 640); assertClear(probe, `portrait ${turn}`, true);
  }
  probe.sharks.forEach((sh, i) => assert.ok(Math.abs(sh.L - lengths[i]) < 1e-9));
  for (let frame = 0; frame < 600; frame++) {
    probe.step(1 / 30);
    assertClear(probe, `narrow every-frame ${frame}`, frame % 30 === 0);
  }
  stop();
});

test('posed diagnostic stills respect body separation too', () => {
  const { probe, stop } = sea({ pose: [
    { species: 'hammerhead', x: 240, y: 320 },
    { species: 'reef', x: 230, y: 300, angle: Math.PI / 2 },
    { species: 'leopard', x: 220, y: 310, angle: Math.PI },
  ] }, 480, 640);
  assertClear(probe, 'posed crossing', true);
  stop();
});
