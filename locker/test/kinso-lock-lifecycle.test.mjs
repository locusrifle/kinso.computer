import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Observe the real adapter with tiny DOM/RAF/swim stand-ins; no renderer state is altered.
test('an immediate unlock cancels the word wake instead of fading KINSO back in with the leaving password', async () => {
  const frames = new Map(), microtasks = [], properties = new Map();
  let serial = 0;
  const canvas = { className: '', setAttribute() {}, animate: () => ({ finished: Promise.resolve() }), getAnimations: () => [] };
  const source = (await readFile(new URL('../../website/for-kinso/lock-sharks.mjs', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/m, '').replace('export function mountSharks', 'function mountSharks');
  const mount = new vm.Script(`${source}\nmountSharks;`).runInNewContext({
    document: { createElement: () => canvas }, swim: () => () => {}, matchMedia: () => ({ matches: false }),
    requestAnimationFrame: callback => { frames.set(++serial, callback); return serial; },
    cancelAnimationFrame: id => frames.delete(id), queueMicrotask: callback => microtasks.push(callback),
  });
  const content = { style: { opacity: '.2' } };
  const screen = { prepend() {}, querySelector: () => content, querySelectorAll: () => [] };
  const word = { classList: { add() {} }, style: { setProperty: (key, value) => properties.set(key, value) } };
  const lock = mount(screen, { word });
  lock.start(); microtasks.shift()();
  assert.equal(properties.get('--kinso-word-opacity'), '0.8');
  assert.equal(frames.size, 1);
  await lock.fade(250);
  content.style.opacity = '.1'; // the actual lock is now leaving, before its wake finished
  for (const callback of frames.values()) callback();
  assert.equal(frames.size, 0);
  assert.equal(properties.get('--kinso-word-opacity'), '0');
  lock.stop();
});
