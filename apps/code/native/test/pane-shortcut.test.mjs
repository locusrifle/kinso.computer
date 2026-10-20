import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { hearPaneShortcut, withPaneShortcut } from '../public/js/pane-shortcut.js';

test('isolated page bridge accepts only trusted plain Alt arrows (panes and sessions), consumes repeats, and respects held UI', () => {
  let listener, held = false;
  const sent = [];
  const window = { parent: { postMessage: (...args) => sent.push(args) }, addEventListener: (type, fn, capture) => { assert.equal(type, 'keydown'); assert.equal(capture, true); listener = fn; } };
  vm.runInNewContext(`(${hearPaneShortcut.toString()})()`, { window, document: { querySelector: () => held } });
  const event = extra => ({ isTrusted: true, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, code: 'ArrowRight', preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra });
  for (const extra of [{ isTrusted: false }, { code: 'Comma' }, { code: 'Period' }, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: false }]) {
    const e = event(extra); listener(e); assert.equal(e.prevented, undefined);
  }
  held = true; listener(event({})); held = false;
  assert.equal(sent.length, 0);
  const e = event({}); listener(e); assert.equal(e.prevented, true); assert.equal(e.stopped, true);
  assert.equal(JSON.stringify(sent[0]), JSON.stringify([{ type: 'imperfect-pane-step', step: 1 }, '*']));
  const repeat = event({ repeat: true }); listener(repeat); assert.equal(repeat.prevented, true); assert.equal(sent.length, 1);
  listener(event({ code: 'ArrowLeft' })); assert.equal(sent[1][0].step, -1);
  listener(event({ code: 'KeyB', shiftKey: true }));
  assert.equal(JSON.stringify(sent[2]), JSON.stringify([{ type: 'imperfect-browser-launch' }, '*']));
  listener(event({ code: 'KeyB', shiftKey: true, repeat: true }));
  held = true; listener(event({ code: 'KeyB', shiftKey: true }));
  assert.equal(sent.length, 3);
  held = false;
  // Alt+Up and Alt+Down: the session before and after.
  listener(event({ code: 'ArrowUp' })); listener(event({ code: 'ArrowDown' }));
  assert.equal(JSON.stringify(sent.slice(3).map(([said]) => said)), JSON.stringify([{ type: 'imperfect-session-step', step: -1 }, { type: 'imperfect-session-step', step: 1 }]));
  const shifted = event({ code: 'ArrowUp', shiftKey: true }); listener(shifted);
  assert.equal(shifted.prevented, undefined, 'Shift with them is the page\'s');
  assert.equal(sent.length, 5);
});

test('bridge script precedes app scripts and preserves the doctype', () => {
  const html = withPaneShortcut('<!DOCTYPE html><head><script>app()</script></head>');
  assert.ok(html.startsWith('<!DOCTYPE html><script>'));
  assert.ok(html.indexOf('imperfect-pane-step') < html.indexOf('app()'));
});
