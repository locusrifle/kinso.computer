import test from 'node:test';
import assert from 'node:assert/strict';
import { readBrand } from '../public/js/brand.js';
import { mountSharks } from '../public/js/kinso-sharks.js';
import { applyKinsoTheme, kinsoThemeOptions, setKinsoTheme } from '../public/js/kinso-theme.js';

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
  assert.equal(readBrand(windowFor(), 'kinso').id, 'kinso', 'Kinso installs use their own appearance too');
});
test('storage refusal still respects a known address', () => {
  const win = { location: { search: '?for=kinso' }, get sessionStorage() { throw new Error('denied'); } };
  assert.equal(readBrand(win).id, 'kinso');
  win.location.search = '';
  assert.equal(readBrand(win).id, 'imperfect');
});
test('the shark renderer runs for the whole mount and stops only on disposal', async t => {
  const old = globalThis.document;
  globalThis.document = { createElement: () => ({ setAttribute() {}, remove() {} }) };
  t.after(() => { globalThis.document = old; });
  let starts = 0, stops = 0;
  const sea = mountSharks({ host: { prepend() {} }, load: async () => ({ swim: () => { starts++; return () => stops++; } }) });
  await sea.ready;
  assert.equal(starts, 1); assert.equal(sea.swimming, true);
  assert.equal(stops, 0, 'no fresh-session fade or timer');
  sea.stop(); sea.stop();
  assert.equal(stops, 1); assert.equal(sea.swimming, false);
});

test('the sea fills the shared strip while its veil and bar avoidance stay with the middle', async t => {
  const old = globalThis.document, nodes = [];
  globalThis.document = { createElement: () => { const node = { setAttribute() {}, remove() {}, getBoundingClientRect: () => ({ left: 248, top: 16 }) }; nodes.push(node); return node; } };
  t.after(() => { globalThis.document = old; });
  const middle = [], strip = [];
  let options, starts = 0, stops = 0;
  const sea = mountSharks({ host: { prepend: n => middle.unshift(n) }, canvasHost: { prepend: n => strip.unshift(n) },
    avoid: () => [{ left: 552, top: 561, width: 618, height: 88 }],
    load: async () => ({ swim: (canvas, settings) => { assert.equal(canvas, nodes[0]); options = settings; starts++; return () => stops++; } }) });
  assert.deepEqual(strip, [sea.canvas]); assert.deepEqual(middle, [sea.veil]);
  await sea.ready;
  assert.equal(starts, 1, 'a conversation starts the renderer too');
  assert.deepEqual(options.avoid(), [{ x: 304, y: 545, width: 618, height: 88 }], 'page rectangles are relative to the full sea, not its former clipped host');
  sea.stop(); assert.equal(stops, 1);
});

test('Kinso defaults to Automatic and updates the swimming palette without a restart', async t => {
  const old = globalThis.document;
  const root = new EventTarget(); root.dataset = { brand: 'kinso' };
  const media = new EventTarget(); media.matches = true;
  const saved = new Map([['imperfect.theme', 'mac-light']]);
  const win = new EventTarget();
  win.matchMedia = () => media;
  win.localStorage = { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v) };
  const doc = { documentElement: root, defaultView: win, createElement: () => ({ setAttribute() {}, remove() {} }) };
  root.ownerDocument = doc; globalThis.document = doc;
  t.after(() => { globalThis.document = old; });
  applyKinsoTheme(doc);
  assert.equal(root.dataset.kinsoTheme, 'auto');
  assert.equal(root.dataset.kinsoAppearance, 'dark');
  assert.deepEqual(kinsoThemeOptions().themes.map(t => t.name), ['Kinso Light', 'Kinso Dark']);
  const updates = []; let starts = 0, stops = 0;
  const sea = mountSharks({ host: { prepend() {} }, load: async () => ({ swim: (_, options) => {
    starts++; assert.equal(options.palette, 'dark');
    return Object.assign(() => stops++, { set: options => updates.push(options.palette) });
  } }) });
  await sea.ready;
  media.matches = false; media.dispatchEvent(new Event('change'));
  assert.equal(root.dataset.kinsoAppearance, 'light');
  setKinsoTheme('kinso-dark');
  media.dispatchEvent(new Event('change'));
  assert.equal(root.dataset.kinsoAppearance, 'dark', 'an explicit choice ignores the system');
  assert.equal(saved.get('kinso.appearance'), 'kinso-dark');
  assert.equal(saved.get('imperfect.theme'), 'mac-light');
  assert.throws(() => setKinsoTheme('mac-dark'), /No such Kinso theme/);
  assert.equal(starts, 1); assert.equal(stops, 0);
  assert.deepEqual(updates, ['light', 'dark']);
  sea.stop(); setKinsoTheme('kinso-light');
  assert.equal(updates.length, 2, 'disposal removes the palette listener');
  assert.equal(stops, 1);
});

test('a late or missing shark module cannot revive a disposed mount or break the window', async t => {
  const old = globalThis.document;
  globalThis.document = { createElement: () => ({ setAttribute() {}, remove() { this.removed = true; } }) };
  t.after(() => { globalThis.document = old; });
  let resolve, starts = 0;
  const host = { prepend() {} };
  const sea = mountSharks({ host, load: () => new Promise(done => { resolve = done; }) });
  await Promise.resolve();
  sea.stop();
  resolve({ swim() { starts++; } });
  await sea.ready;
  assert.equal(starts, 0); assert.equal(sea.swimming, false);
  assert.equal(sea.canvas.removed, true); assert.equal(sea.veil.removed, true);
  const missing = mountSharks({ host, load: async () => { throw new Error('offline'); } });
  await missing.ready;
  assert.equal(missing.canvas.removed, true); assert.equal(missing.veil.removed, true);
});
