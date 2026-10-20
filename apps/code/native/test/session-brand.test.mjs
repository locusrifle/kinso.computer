import test from 'node:test';
import assert from 'node:assert/strict';
import { readBrand } from '../public/js/brand.js';
import { mountSharks, SHARKS_FADE_MS } from '../public/js/kinso-sharks.js';

function windowFor(search = '', saved) {
  const values = new Map(saved ? [['imperfect.for', saved]] : []);
  return { location: { search }, sessionStorage: { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) } };
}
test('a known address chooses the brand, kept for the tab; unknown names cannot become brands', () => {
  const win = windowFor('?for=kinso', 'imperfect');
  assert.equal(readBrand(win).id, 'kinso');
  win.location.search = '';
  assert.equal(readBrand(win).id, 'kinso');
  win.location.search = '?for=imperfect';
  assert.equal(readBrand(win).id, 'imperfect');
  assert.equal(readBrand(windowFor('?for=unknown', 'unknown')).id, 'imperfect');
  assert.equal(readBrand(windowFor('?for=__proto__')).id, 'imperfect');
  assert.equal(readBrand(windowFor('?for=constructor')).id, 'imperfect');
});
test('storage refusal still respects a known address', () => {
  const win = { location: { search: '?for=kinso' }, get sessionStorage() { throw new Error('denied'); } };
  assert.equal(readBrand(win).id, 'kinso');
  win.location.search = '';
  assert.equal(readBrand(win).id, 'imperfect');
});
test('the shark renderer starts once, stops after the fade, and restarts only for a fresh screen', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = globalThis.document;
  globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {} }) };
  t.after(() => { globalThis.document = old; });
  let starts = 0, stops = 0;
  const sea = mountSharks({ host: { prepend() {} }, load: async () => ({ swim: () => { starts++; return () => stops++; } }) });
  sea.show(true); sea.show(true); await sea.ready;
  assert.equal(starts, 1); assert.equal(sea.swimming, true);
  sea.show(false); t.mock.timers.tick(SHARKS_FADE_MS - 1);
  assert.equal(stops, 0, 'keeps swimming behind the fade');
  t.mock.timers.tick(61);
  assert.equal(stops, 1); assert.equal(sea.swimming, false);
  sea.show(true); assert.equal(starts, 2);
  sea.show(false); sea.show(true); t.mock.timers.tick(1000);
  assert.equal(starts, 2); assert.equal(stops, 1, 'returning mid-fade keeps the same renderer');
  sea.stop(); assert.equal(stops, 2);
  sea.show(true); assert.equal(starts, 2);
});

test('the sea can fill the shared strip while its glow and avoidance stay with the middle', async t => {
  const old = globalThis.document, nodes = [];
  globalThis.document = { createElement: () => { const node = { setAttribute() {}, remove() {}, getBoundingClientRect: () => ({ left: 248, top: 16 }) }; nodes.push(node); return node; } };
  t.after(() => { globalThis.document = old; });
  const middle = [], strip = [];
  let options, starts = 0, stops = 0;
  const sea = mountSharks({ host: { prepend: n => middle.unshift(n) }, canvasHost: { prepend: n => strip.unshift(n) },
    avoid: () => [{ left: 552, top: 561, width: 618, height: 88 }],
    load: async () => ({ swim: (canvas, settings) => { assert.equal(canvas, nodes[0]); options = settings; starts++; return () => stops++; } }) });
  assert.deepEqual(strip, [sea.canvas]); assert.deepEqual(middle, [sea.veil]);
  assert.equal(starts, 0, 'a conversation never starts the renderer');
  sea.show(true); await sea.ready;
  assert.deepEqual(options.avoid(), [{ x: 304, y: 545, width: 618, height: 88 }], 'page rectangles are relative to the full sea, not its former clipped host');
  sea.stop(); assert.equal(stops, 1);
});
