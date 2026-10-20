import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// How the sharks swim, on the actual module compiled with fixture browser
// globals (as sharks-spacing.test.mjs does): bodies that bend like a shark's,
// speed with momentum, turns no tighter than the speed allows, and steering
// that keeps clear of the page's boxes and of each other instead of being
// pushed apart.
const source = readFileSync(new URL('../public/js/sharks.js', import.meta.url), 'utf8');
const pushLine = '        translate(a, c.dx * d, c.dy * d); translate(b, -c.dx * d, -c.dy * d);';
assert.ok(source.includes(pushLine), 'the separation step this test counts');

function sea(options = {}, width = 1440, height = 900) {
  const noop = () => {};
  const context = new Proxy({ measureText: () => ({ actualBoundingBoxAscent: 8 }), createPattern: () => ({}) }, {
    get: (o, k) => o[k] ?? noop,
  });
  const size = { width, height };
  const canvas = { width, height, getContext: () => context, getBoundingClientRect: () => size };
  const code = source.replace('export function swim', 'function swim').replace('export default swim;', 'return swim;')
    .replace(pushLine, `        stats.pushed = (stats.pushed || 0) + 2 * d; ${pushLine.trim()}`)
    .replace('  return stop;\n}', `  stop.probe = { get sharks() { return sharks; }, step(dt) { time += dt; stepSharks(dt); } };\n  return stop;\n}`);
  const env = {
    devicePixelRatio: 1, requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    OffscreenCanvas: class { getContext() { return context; } },
  };
  const swim = vm.compileFunction(code, Object.keys(env))(...Object.values(env));
  const stop = swim(canvas, { seed: 17, enter: true, plankton: false, wake: false, cell: 14, ...options });
  return { stop, probe: stop.probe };
}

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const segment = (sh, k) => Math.atan2(sh.qy[k] - sh.qy[k + 1], sh.qx[k] - sh.qx[k + 1]);

test('the swimming wave runs from head to tail: the snout barely yaws, the tail swings most and the fin lags', () => {
  // One reef shark on a straight path, through one tail beat.
  const beat = [];
  for (let i = 0; i < 48; i++) {
    const { stop, probe } = sea({ pose: [{ species: 'reef', x: 900, y: 450, angle: 0, phase: (i * Math.PI) / 24, amp: 0.07 }] });
    const sh = probe.sharks[0];
    beat.push({ y: Array.from(sh.qy, y => (y - sh.y) / sh.L), yaw: Math.abs(segment(sh, 0)) });
    stop();
  }
  const swing = k => Math.max(...beat.map(b => Math.abs(b.y[k])));
  assert.ok(swing(0) < 1e-9, 'the snout keeps to its path');
  assert.ok(Math.max(...beat.map(b => b.yaw)) < (3 * Math.PI) / 180, 'the head yaws less than three degrees');
  assert.ok(swing(9) < swing(26) && swing(26) < swing(35), 'the swing grows toward the tail');
  assert.ok(swing(35) > 5 * swing(9), `most of it at the tail: ${swing(35)} vs ${swing(9)} a quarter back`);
  assert.ok(swing(35) > 0.05 && swing(35) < 0.09, `a tail swing of a tenth of a length or so: ${swing(35)}`);
  // Each point peaks a little after the one in front: the wave travels back.
  const peak = k => beat.reduce((best, b, i) => (b.y[k] > beat[best].y[k] ? i : best), 0) * (Math.PI / 24);
  for (const [a, b] of [[17, 26], [26, 31], [31, 35]]) {
    const lag = wrap(peak(b) - peak(a));
    assert.ok(lag > 0 && lag < Math.PI, `the swing at ${b} follows ${a}: ${lag}`);
  }
});

test('bodies keep their length and bend smoothly; speed has momentum; turns are never tighter than speed allows', () => {
  const bar = { left: 411, right: 1029, top: 406, bottom: 494 };
  let samples = 0, glides = 0, surges = 0, under = 0, seen = 0;
  const beats = { glide: [0, 0], surge: [0, 0] }; // tail beats a second: sum, samples
  for (const seed of [17, 852]) {
    const { stop, probe } = sea({ seed, avoid: () => [bar] });
    const last = new Map();
    for (let frame = 0; frame < 90 * 30; frame++) {
      probe.step(1 / 30);
      for (const sh of probe.sharks) {
        let length = 0;
        for (let k = 0; k < 35; k++) {
          length += Math.hypot(sh.qx[k + 1] - sh.qx[k], sh.qy[k + 1] - sh.qy[k]);
          if (k < 34) assert.ok(Math.abs(wrap(segment(sh, k) - segment(sh, k + 1))) < (25 * Math.PI) / 180, 'no kinks');
        }
        assert.ok(Math.abs(length / sh.L - 1) < 1e-3, `a body keeps its length: ${length / sh.L}`);
        if (sh.hold > 0) continue;
        // turning: a radius of at least 0.3 lengths, the yaw rate eased in
        assert.ok(Math.abs(sh.av) <= Math.min(0.85, sh.U / (0.3 * sh.L)) + 1e-9, 'no tighter than its speed allows');
        const was = last.get(sh);
        if (was && sh.age > 0.1) {
          assert.ok(Math.abs(sh.U - was.U) * 30 < 0.35 * sh.L, `speed changes gradually: ${(Math.abs(sh.U - was.U) * 30) / sh.L} lengths/s²`);
          assert.ok(Math.abs(sh.av - was.av) * 30 < 3, `yaw rate eases in: ${Math.abs(sh.av - was.av) * 30} rad/s²`);
          samples++;
        }
        const rate = was ? ((sh.phase - was.phase) * 30) / (2 * Math.PI) : 0;
        last.set(sh, { U: sh.U, av: sh.av, phase: sh.phase });
        if (sh.age > 6 && sh.effort < 0.25) { glides++; beats.glide[0] += rate; beats.glide[1]++; assert.ok(sh.beat < 0.5, 'a gliding tail all but stops'); }
        if (sh.age > 6 && sh.effort > 1.15) { surges++; beats.surge[0] += rate; beats.surge[1]++; }
        if (sh.seen) {
          seen++;
          for (let k = 0; k < 36; k += 3) {
            if (sh.qx[k] > bar.left && sh.qx[k] < bar.right && sh.qy[k] > bar.top && sh.qy[k] < bar.bottom) { under++; break; }
          }
        }
      }
    }
    stop();
  }
  assert.ok(samples > 10000);
  assert.ok(glides > 0 && surges > 0, `now and then a glide and a few harder beats: ${glides}, ${surges}`);
  const [glide, surge] = [beats.glide[0] / beats.glide[1], beats.surge[0] / beats.surge[1]];
  assert.ok(surge > 2 * glide && surge < 1.5, `the tail beats faster the harder it works: ${glide} to ${surge} a second`);
  assert.ok(under / seen < 0.12, `seldom under the input bar: ${under / seen}`);
});

test('sharks steer clear of each other rather than being pushed apart', () => {
  const bar = { left: 411, right: 1029, top: 406, bottom: 494 };
  let pushed = 0, minutes = 0;
  for (const seed of [1, 17, 852]) {
    const { stop, probe } = sea({ seed, avoid: () => [bar] });
    for (let frame = 0; frame < 120 * 30; frame++) probe.step(1 / 30);
    pushed += stop.stats.pushed || 0; minutes += 2;
    stop();
  }
  // Before steering looked ahead, bodies were nudged apart nearly every frame
  // (about 4800 px a minute here); now only rare, shallow touches are.
  assert.ok(pushed / minutes < 800, `pushed ${pushed / minutes} px a minute`);
});

test('a box ahead is seen early and swum around', () => {
  const { stop, probe } = sea({ seed: 852, sharks: 1 });
  let sh;
  for (let i = 0; i < 600 && !(sh && sh.seen && sh.age > 6); i++) { probe.step(1 / 30); sh = probe.sharks[0]; }
  // A box straddling its course, a length ahead.
  const L = sh.L, cx = sh.x + Math.cos(sh.a) * L * 1.1, cy = sh.y + Math.sin(sh.a) * L * 1.1;
  const box = { left: cx - L * 0.3, right: cx + L * 0.3, top: cy - L * 0.3, bottom: cy + L * 0.3 };
  stop.set({ avoid: () => [box] });
  const dist = () => Math.hypot(Math.max(box.left - sh.x, 0, sh.x - box.right), Math.max(box.top - sh.y, 0, sh.y - box.bottom));
  let turnedAt = null;
  for (let i = 0; i < 300; i++) {
    probe.step(1 / 30);
    if (turnedAt === null && Math.abs(sh.av) > 0.1) turnedAt = dist();
    assert.ok(!(sh.x > box.left && sh.x < box.right && sh.y > box.top && sh.y < box.bottom), 'its head never goes under the box');
  }
  assert.ok(turnedAt > L * 0.4, `it starts to turn well before the box: ${turnedAt / L} lengths away`);
  stop();
});

test('the same seed swims the same way', () => {
  const a = sea({ seed: 92105 }), b = sea({ seed: 92105 });
  for (let i = 0; i < 900; i++) { a.probe.step(1 / 30); b.probe.step(1 / 30); }
  assert.deepEqual(a.probe.sharks.map(sh => [sh.x, sh.y, sh.a, sh.U]), b.probe.sharks.map(sh => [sh.x, sh.y, sh.a, sh.U]));
  a.stop(); b.stop();
});
