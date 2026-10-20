import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOSE, windowClose } from '../public/js/window-close.js';

// An element that records its animations, and a clock run by hand.
function rig({ reduced = false } = {}) {
  const timers = new Map(); let id = 0;
  const motion = [], classes = new Set(['wm-window', 'wm-arriving']), attributes = {};
  const el = {
    inert: false,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c) },
    setAttribute: (k, v) => { attributes[k] = v; },
    animate: (frames, options) => { const one = { frames, options, cancelled: false, cancel() { one.cancelled = true; } }; motion.push(one); return one; },
  };
  let done = 0;
  const options = { reduced: () => reduced, wait: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clear: n => timers.delete(n) };
  return { el, motion, classes, attributes, timers, options, get done() { return done; }, finish: () => { done++; },
    run: () => { const batch = [...timers.values()]; timers.clear(); batch.forEach(({ fn }) => fn()); } };
}

test('Omarchy\'s close: Hyprland windowsOut 1.49 linear popin 87% and fadeOut 1.46 almostLinear, at 100ms a unit', () => {
  assert.deepEqual(CLOSE, { scale: 0.87, scaleMs: 149, fadeMs: 146, fade: 'cubic-bezier(0.5, 0.5, 0.75, 1)' });
  const r = rig();
  windowClose(r.el, r.finish, r.options);
  const [scale, fade] = r.motion;
  assert.deepEqual(scale.frames, [{ transform: 'scale(1)' }, { transform: 'scale(0.87)' }]);
  assert.deepEqual(scale.options, { duration: 149, easing: 'linear', fill: 'forwards' });
  assert.deepEqual(fade.frames, [{ opacity: 1 }, { opacity: 0 }]);
  assert.deepEqual(fade.options, { duration: 146, easing: 'cubic-bezier(0.5, 0.5, 0.75, 1)', fill: 'forwards' });
  assert.equal(r.motion.length, 2, 'no slide, no wipe: only scale and opacity');
  assert.equal(r.el.inert, true);
  assert.equal(r.attributes['aria-hidden'], 'true');
  assert.ok(r.classes.has('wm-closing') && !r.classes.has('wm-arriving'));
  assert.equal(r.done, 0, 'it stays in place while it closes');
  assert.deepEqual([...r.timers.values()].map(t => t.ms), [149]);
  r.run();
  assert.equal(r.done, 1);
  assert.ok(r.motion.every(one => one.cancelled));
});

test('ended early, it is done at once and only once', () => {
  const r = rig();
  const end = windowClose(r.el, r.finish, r.options);
  end(); end();
  assert.equal(r.done, 1);
  assert.equal(r.timers.size, 0, 'its timer is cleared');
  r.run();
  assert.equal(r.done, 1);
});

test('reduced motion, or no animation (a phone), is done at once without touching the window', () => {
  for (const [r, animate] of [[rig({ reduced: true }), true], [rig(), false]]) {
    windowClose(r.el, r.finish, { ...r.options, animate });
    assert.equal(r.done, 1);
    assert.equal(r.motion.length, 0);
    assert.equal(r.el.inert, false);
    assert.equal(r.timers.size, 0);
  }
});
