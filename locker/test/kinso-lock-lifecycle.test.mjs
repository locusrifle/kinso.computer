import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { logoLock } from '../../website/for-kinso/logo-lock.mjs';
import { FIELD_IN } from '../../website/wordmark.mjs';

// Observe the real adapter with tiny DOM/swim stand-ins; no renderer state is altered.
test('the logo stays through the password wake, sharks avoid its current box, and unlock never brings it back', async () => {
  const properties = new Map(), swims = [];
  const canvas = { className: '', setAttribute() {}, animate: () => ({ finished: Promise.resolve() }), getAnimations: () => [] };
  const source = (await readFile(new URL('../../website/for-kinso/lock-sharks.mjs', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/m, '').replace('export function mountSharks', 'function mountSharks');
  const mount = new vm.Script(`${source}\nmountSharks;`).runInNewContext({
    document: { createElement: () => canvas }, swim: (c, options) => { swims.push(options); return () => {}; }, matchMedia: () => ({ matches: false }),
  });
  let box = { left: 858, top: 418, width: 213, height: 238 };
  const word = { classList: { add() {} }, style: { setProperty: (key, value) => properties.set(key, value) },
    getClientRects: () => [box], getBoundingClientRect: () => box };
  const screen = { prepend() {}, querySelectorAll: () => [] };
  const lock = mount(screen, { word });
  lock.start();
  assert.equal(properties.has('--kinso-word-opacity'), false, 'no password wake fades the logo away');
  assert.deepEqual([...swims[1].avoid()], [box]);
  box = { left: 126, top: 342, width: 140, height: 156 };
  assert.deepEqual([...swims[1].avoid()], [box], 'a phone resize uses the new logo box');
  await lock.fade(250);
  assert.equal(properties.get('--kinso-word-opacity'), '0');
  lock.stop();
  assert.equal(properties.get('--kinso-word-opacity'), '0');
});

// Noah: the words fade, then the page lifts. The live sea moves into the sheet, and the logo (left behind in the
// opener's sky, which the sheet hides) is copied into the lock's words so it fades with them instead of vanishing.
test('cover carries the live sea and a still copy of the logo into the lifting sheet', async () => {
  const properties = new Map(), made = [];
  let swims = 0, stops = 0, parent = null;
  const make = () => { const c = { className: '', style: {}, setAttribute() {}, animate: () => ({ finished: Promise.resolve() }),
    getAnimations: () => [], drawn: null, removed: false, remove() { this.removed = true; },
    getContext: () => ({ drawImage: (source, x, y) => { c.drawn = [source, x, y]; } }) }; made.push(c); return c; };
  const source = (await readFile(new URL('../../website/for-kinso/lock-sharks.mjs', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/m, '').replace('export function mountSharks', 'function mountSharks');
  const mount = new vm.Script(`${source}\nmountSharks;`).runInNewContext({
    document: { createElement: make }, swim: () => { swims++; return () => { stops++; }; }, matchMedia: () => ({ matches: false }),
  });
  const box = { left: 858, top: 418, width: 160, height: 178 };
  const word = { width: 426, height: 476, classList: { add() {} }, style: { setProperty: (key, value) => properties.set(key, value) },
    getClientRects: () => [box], getBoundingClientRect: () => box };
  const content = { children: [], prepend(node) { this.children.unshift(node); } };
  const screen = { dataset: {}, prepend(node) { parent = this; assert.equal(node, made[0]); },
    querySelector: selector => selector === '.macos-lock-content' ? content : null, querySelectorAll: () => [] };
  const lock = mount(screen, { word, backdrop: { prepend() {} } });
  lock.start();
  lock.cover();
  assert.equal(parent, screen, 'the original sea moves into the sheet');
  assert.equal(screen.dataset.sheet, 'true');
  assert.equal(swims, 2, 'lifting never restarts the engine');
  assert.equal(stops, 1, 'the swimming sea stays live through the lift');
  const [logo] = content.children;
  assert.equal(logo, made[1]);
  assert.equal(logo.className, 'kinso-sheet-logo');
  assert.deepEqual(logo.drawn, [word, 0, 0], 'the copy is the logo as it stands, not redrawn');
  assert.deepEqual([logo.width, logo.height], [426, 476]);
  assert.deepEqual(logo.style, { left: '858px', top: '418px', width: '160px', height: '178px' }, 'the copy sits where the held logo stood');
  lock.cover();
  assert.equal(content.children.length, 1, 'a second cover adds no second logo');
  lock.stop();
  assert.equal(stops, 2);
  assert.equal(logo.removed, true);
  assert.equal(lock.state().swimming, false);
});

test('logo and field share FIELD_IN: no second animation clock, responsive to keyboard room', () => {
  const oldWidth = globalThis.innerWidth, oldHeight = globalThis.innerHeight, oldViewport = globalThis.visualViewport;
  try {
    for (const [width, height, logoWidth, logoHeight] of [[1920, 1080, 213, 238], [390, 844, 140, 156]]) {
      globalThis.innerWidth = width; globalThis.innerHeight = height;
      globalThis.visualViewport = { height, offsetTop: 0 };
      const properties = new Map();
      const word = { style: { width: `${logoWidth}px`, height: `${logoHeight}px`, top: `${(height - logoHeight) / 2}px`, left: `${(width - logoWidth) / 2}px` } };
      const lock = logoLock(word, { style: { setProperty: (key, value) => properties.set(key, value) } });
      assert.equal(lock.wakeMs, FIELD_IN * 1000); assert.deepEqual(lock.identity, { logo: true });
      lock.onwake(0); assert.equal(word.style.scale, '1');
      lock.onwake(.5); assert.equal(word.style.scale, '0.875');
      lock.onwake(1); assert.equal(word.style.scale, '0.75');
      const top = parseFloat(properties.get('--kinso-field-top'));
      assert.ok(Math.abs(top - (height / 2 - 24 + logoHeight * .75 / 2 + 22)) < 1e-8);
      globalThis.visualViewport.height = 420; lock.onwake(1);
      assert.ok(parseFloat(properties.get('--kinso-field-top')) + 36 < 420, 'field fits above the keyboard');
    }
  } finally {
    globalThis.innerWidth = oldWidth; globalThis.innerHeight = oldHeight; globalThis.visualViewport = oldViewport;
  }
});
