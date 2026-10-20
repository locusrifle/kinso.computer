import test from 'node:test';
import assert from 'node:assert/strict';
import { mountMessages } from '../public/js/messages.js';

// Just the DOM operations used to render a list; no transport, threads or timers.
class Node {
  children = []; dataset = {}; attrs = {}; style = {}; value = ''; scrollTop = 0;
  classList = { add() {}, toggle() {} };
  setAttribute(key, value) { this.attrs[key] = value; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener() {}
}
const conversations = Array.from({ length: 8 }, (_, i) => ({ key: `fixture-${i}`, name: `Newest ${i + 1}`, source: i % 2 ? 'instagram' : 'gmail', account: i % 2 ? 'ig' : 'mail', at: Date.now() - i * 60_000 }));
const data = { state: 'ready', demo: true, refreshedAt: Date.now(), conversations, accounts: [{ id: 'mail', source: 'gmail' }, { id: 'ig', source: 'instagram' }] };

async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originals = Object.fromEntries(['document', 'ResizeObserver', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  globalThis.document = { querySelector: () => true, createElement: () => new Node(), createDocumentFragment: () => new Node(), addEventListener() {} };
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.fetch = async path => {
    assert.equal(path, '/inbox/list', 'only a list is requested');
    return { ok: true, json: async () => structuredClone(data) };
  };
  const m = mountMessages();
  // load(), response.json(), and its repaint.
  await new Promise(resolve => setImmediate(resolve));
  const chips = () => m.el.children[1].children;
  const keys = () => m.el.children[2].children[0].children[1].children.map(row => row.dataset.key);
  return { m, chips, keys };
}

test('sidebar lists exactly the three newest conversations, then All messages; its redraw key uses the same three', async t => {
  const { m } = await fixture(t);
  const opens = [];
  const parts = m.sidebar({ head: name => ({ heading: name }), row: row => row, open: view => opens.push(view) });
  assert.deepEqual(parts.map(p => p.heading ?? p.name), ['Messages', 'Newest 1', 'Newest 2', 'Newest 3', 'All messages']);
  assert.deepEqual(m.sidebarLook().at(-1).map(c => c[0]), conversations.slice(0, 3).map(c => c.key));
  parts.at(-1).onclick();
  assert.deepEqual(opens, [{}], 'All messages opens the unfiltered list without selecting a thread');
});

test('no All filter: no selection shows all; providers switch and toggle back to the full inbox', async t => {
  const { m, chips, keys } = await fixture(t);
  const all = conversations.map(c => c.key);
  assert.deepEqual(chips().map(c => c.textContent), ['Gmail', 'Instagram']);
  assert.ok(chips().every(c => c.attrs['aria-pressed'] === 'false'));
  assert.deepEqual(keys(), all);
  for (const [index, source] of [[0, 'gmail'], [1, 'instagram']]) {
    chips()[index].onclick();
    assert.deepEqual(keys(), conversations.filter(c => c.source === source).map(c => c.key));
    assert.equal(chips()[index].attrs['aria-pressed'], 'true');
  }
  chips()[1].onclick();
  assert.deepEqual(keys(), all);
  assert.ok(chips().every(c => c.attrs['aria-pressed'] === 'false'));
  m.open({ account: 'mail' });
  assert.deepEqual(keys(), conversations.filter(c => c.account === 'mail').map(c => c.key));
  chips()[0].onclick();
  assert.deepEqual(keys(), all, 'selected account can also be cleared by its provider chip');
  m.open({ source: 'instagram' });
  m.open({});
  assert.deepEqual(keys(), all, 'All messages resets provider filtering');
});
