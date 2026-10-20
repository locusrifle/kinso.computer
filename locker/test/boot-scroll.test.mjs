import test from 'node:test';
import assert from 'node:assert/strict';
import { bindLockScroll, createMomentum } from '../../website/boot/scroll.mjs';

const chromium = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36';
const gtk = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 Version/60.5 Safari/605.1.15';
function fixture(ua, viewport = 920, screen = 920) {
  const target = new EventTarget(), momentum = createMomentum(), moves = [];
  target.navigator = { userAgent: ua }; target.screen = { height: screen };
  let now = 0, height = viewport, enabled = true;
  bindLockScroll({ target, active: () => enabled, height: () => height, clock: () => now, momentum,
    move: px => moves.push({ px, progress: px * 5 / height }) });
  return { moves,
    emit(type, data, cancelable = true) { now += .02; const event = new Event(type, { cancelable }); Object.assign(event, data); target.dispatchEvent(event); return event; },
    coast() { now += .3; for (let i = 0; i < 60; i++) { now += 1 / 60; moves.push({ progress: momentum.step(now, 1 / 60) * 5 / height }); } },
    resize(value) { height = value; }, disable() { enabled = false; }
  };
}
const wheel = (deltaY, wheelDeltaY, deltaMode = 0) => ({ deltaY, wheelDeltaY, deltaX: 0, deltaMode });
const touch = y => ({ touches: [{ identifier: 1, clientY: y }] });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('identical Wayland wheel/finger axes keep Chromium full-screen feel in either engine at any panel height, including momentum', () => {
  // Measured on scale-2 headless sway, WebKitGTK 2.54.1 and Electron 44.5.1 / Chromium 152.
  // WebKit's discrete step depends on its viewport; continuous deltas do not.
  for (const height of [920, 600, 390]) for (const source of ['wheel', 'finger']) {
    const reference = fixture(chromium), browser = fixture(chromium, height), lock = fixture(gtk, height);
    for (const axis of source === 'wheel' ? [1, 2, -1] : [1, 5, 10, -5, .125, .001]) {
      const chromePx = axis * (source === 'wheel' ? 120 : 12);
      const gtkPx = axis * (source === 'wheel' ? Math.floor(height ** (2 / 3)) : 2.5);
      reference.emit('wheel', wheel(chromePx, -axis * 120));
      browser.emit('wheel', wheel(chromePx, -axis * 120));
      lock.emit('wheel', wheel(gtkPx, Math.trunc(-axis * 120)));
    }
    reference.coast(); browser.coast(); lock.coast();
    for (const candidate of [browser, lock]) {
      assert.equal(candidate.moves.length, reference.moves.length);
      candidate.moves.forEach((move, i) => close(move.progress, reference.moves[i].progress));
    }
    close(reference.moves[0].px, (source === 'wheel' ? 120 : 12) * .4);
  }
});

test('a direct phone finger stays 1:1, forward and back, irrespective of screen height or engine', () => {
  for (const ua of [chromium, gtk, 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Safari/604.1']) {
    const f = fixture(ua, 600, 920);
    f.emit('touchstart', touch(400)); f.emit('touchmove', touch(350)); f.emit('touchmove', touch(380));
    assert.deepEqual(f.moves.map(m => m.px), [50, -30]);
    f.emit('touchend', { touches: [] }); f.coast();
    assert.ok(f.moves.slice(2).some(m => m.progress < 0));
  }
});

test('wheel line/page modes, resize and absent screen metrics retain their units without changing direct-touch mapping', () => {
  const f = fixture(chromium, 600);
  f.emit('wheel', wheel(3, undefined, 1)); close(f.moves.at(-1).progress, 3 * 16 * .4 * 5 / 920);
  f.emit('wheel', wheel(.1, undefined, 2)); close(f.moves.at(-1).progress, .1 * .4 * 5);
  f.emit('wheel', wheel(120)); const before = f.moves.at(-1).progress;
  f.resize(390); f.emit('wheel', wheel(120)); close(f.moves.at(-1).progress, before);
  const fallback = fixture(chromium, 600, 0); fallback.emit('wheel', wheel(40)); close(fallback.moves[0].px, 16);
});

test('inactive, horizontal and pinch wheel events never move or cancel browser gestures', () => {
  const f = fixture(gtk);
  for (const data of [{ ...wheel(10), deltaX: 20 }, { ...wheel(10), ctrlKey: true }]) assert.equal(f.emit('wheel', data).defaultPrevented, false);
  f.disable(); assert.equal(f.emit('wheel', wheel(10)).defaultPrevented, false);
  assert.deepEqual(f.moves, []);
});
test('embedded Chromium non-cancelable wheels still move the full-screen scene in both directions', () => {
  const f = fixture(chromium);
  assert.equal(f.emit('wheel', wheel(100), false).defaultPrevented, false);
  assert.equal(f.emit('wheel', wheel(-50), false).defaultPrevented, false);
  assert.deepEqual(f.moves.map(m => m.px), [40, -20]);
});
