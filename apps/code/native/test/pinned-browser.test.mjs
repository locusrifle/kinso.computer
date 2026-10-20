import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLive } from '../../../../desktop/electron/live.mjs';
import { createLive as client } from '../public/js/live.js';

function page(id) {
  return Object.assign(new EventEmitter(), {
    id, url: `https://example.test/${id}`, input: [],
    getTitle() { return `Page ${id}`; }, getURL() { return this.url; }, isDestroyed: () => false,
    reload() { this.input.push('reload'); }, async loadURL(url) { this.url = url; },
    debugger: Object.assign(new EventEmitter(), { isAttached: () => true, async sendCommand() {} }),
    frame(n) { this.debugger.emit('message', null, 'Page.screencastFrame', { data: `${id}:${n}`, sessionId: n, metadata: { deviceWidth: 600, deviceHeight: 700 } }); },
  });
}
function fixture(t, { create: make, fit = null } = {}) {
  const tabs = new Map([1, 2, 3].map(id => [id, page(id)]));
  let front = 1, next = 3;
  const viewers = [];
  const live = createLive({ tabs: () => tabs, front: () => front, toFront: id => { front = id; }, fit,
    create: async () => { const fresh = page(++next); fresh.url = 'about:blank'; tabs.set(fresh.id, fresh); front = fresh.id; await make?.(fresh, id => { front = id; }); return fresh; },
    close: async id => { tabs.delete(id); if (front === id) front = tabs.keys().next().value ?? null; },
  });
  const watch = args => { const heard = []; const viewer = live.watch(args, said => heard.push(said)); viewers.push(viewer); return { viewer, heard, last: () => heard.at(-1) }; };
  t.after(async () => { viewers.forEach(viewer => viewer.stop()); await live.changed(); });
  return { live, tabs, watch, front: () => front };
}

test('browser-scoped pins list all tabs and retarget independently of portal, agent and other panel fronts', async t => {
  const { live, tabs, watch, front } = fixture(t);
  const portal = watch({}), a = watch({ tab: 2, scope: 'browser' }), b = watch({ tab: 3, scope: 'browser' });
  await live.changed();
  assert.deepEqual(a.heard[0].tabs.map(one => one.tab), [1, 2, 3]); assert.equal(front(), 1);
  tabs.get(2).frame(1); assert.equal(a.last().tab, 2); assert.equal(a.last().watching, 2); assert.equal(a.last().scope, 'browser');
  await a.viewer.hear({ ack: true });
  await portal.viewer.hear({ do: 'front', tab: 3 });
  tabs.get(2).frame(2); assert.equal(a.last().tab, 2); await a.viewer.hear({ ack: true });
  await a.viewer.hear({ do: 'front', tab: 1 });
  assert.equal(front(), 1); assert.equal(a.viewer.tab, 1); assert.equal(b.viewer.tab, 3);
  tabs.get(1).frame(3); assert.equal(a.last().tab, 1);
  await b.viewer.hear({ do: 'front', tab: 2 }); assert.equal(a.viewer.tab, 1);
  for (const reply of a.heard) { assert.equal(reply.scope, 'browser'); assert.ok(Object.hasOwn(reply, 'watching')); }
});

test('scoped close preserves a background pin, selects a neighbor, leaves last empty and can create again', async t => {
  const { live, tabs, watch } = fixture(t);
  const a = watch({ tab: 2, scope: 'browser' }); await live.changed();
  await a.viewer.hear({ do: 'close', tab: 3 }); assert.equal(a.viewer.tab, 2);
  await a.viewer.hear({ do: 'close', tab: 2 }); assert.equal(a.viewer.tab, 1);
  await a.viewer.hear({ do: 'close', tab: 1 }); assert.equal(a.viewer.tab, null); assert.equal(live.watching(), 1);
  assert.deepEqual(a.last().tabs, []); assert.equal(a.last().watching, null); assert.equal(a.last().expired, undefined);
  const empty = watch({ tab: null, scope: 'browser' }); assert.equal(empty.last().expired, undefined);
  await a.viewer.hear({ do: 'reload', tab: null }); assert.ok(a.last().error); assert.equal(live.watching(), 2);
  await a.viewer.hear({ do: 'new' }); assert.equal(a.viewer.tab, 4); assert.equal(tabs.get(4).url, 'about:blank');
  tabs.delete(4); await live.changed(); assert.equal(a.viewer.tab, null); assert.equal(a.last().expired, undefined);
});

test('scoped resumed watches recover vanished and empty pins, while initial and embedded stale pins fail closed', async t => {
  const { live, watch, tabs } = fixture(t);
  const missing = watch({ tab: 99, scope: 'browser', resume: true }); await live.changed();
  assert.equal(missing.viewer.tab, 1); assert.equal(missing.last().expired, undefined);
  const empty = watch({ tab: null, scope: 'browser', resume: true }); await live.changed(); assert.equal(empty.viewer.tab, 1);
  for (const tab of [undefined, 0, -1, '1', true]) assert.equal(watch({ tab, scope: 'browser', resume: true }).last().expired, true);
  assert.equal(watch({ tab: 99 }).last().expired, true);
  assert.equal(watch({ tab: 99, scope: 'browser' }).last().expired, true);
  assert.equal(watch({ tab: 1, resume: true }).last().expired, true);
  tabs.clear(); const nothing = watch({ tab: 99, scope: 'browser', resume: true }); await live.changed();
  assert.equal(nothing.viewer.tab, null); assert.equal(nothing.last().expired, undefined);
});

test('scoped new pins the created object even if another connection selects a different front while creation awaits', async t => {
  const { live, watch, front } = fixture(t, { create: async (_, select) => { await Promise.resolve(); select(1); } });
  const a = watch({ tab: 2, scope: 'browser' }); await a.viewer.hear({ do: 'new' });
  assert.equal(a.viewer.tab, 4); assert.equal(front(), 1);
});

test('scope is exact, needs a valid initial pin, and stale/bad scoped actions cannot resize or act on another page', async t => {
  const { live, watch, tabs } = fixture(t);
  for (const scope of ['', true, {}, ['browser'], 'Browser', 'browser ']) {
    const bad = watch({ tab: 2, scope }); assert.equal(bad.last().expired, true);
  }
  for (const tab of [undefined, '2', 0, -1, 2.5, 99]) {
    const bad = watch({ tab, scope: 'browser' }); assert.equal(bad.last().expired, true);
  }
  const empty = watch({ tab: null, scope: 'browser' }); await live.changed();
  assert.equal(empty.viewer.tab, null); assert.equal(empty.last().expired, undefined);
  assert.deepEqual(empty.last().tabs.map(one => one.tab), [1, 2, 3]);
  assert.equal(empty.last().scope, 'browser'); assert.equal(empty.last().watching, null);
  const a = watch({ tab: 2, scope: 'browser' }); await live.changed();
  for (const id of [undefined, null, true, '1', 0, -1, 1.5, 99]) for (const action of ['front', 'close']) {
    await a.viewer.hear({ do: action, tab: id }); assert.ok(a.last().error); assert.equal(a.viewer.tab, 2);
  }
  await a.viewer.hear({ do: 'front', tab: 3 });
  await a.viewer.hear({ do: 'reload', tab: 2, size: { width: 800, height: 600, scale: 1 } });
  assert.match(a.last().error, /fixed to another tab/); assert.deepEqual(tabs.get(2).input, []);
  await a.viewer.hear({ do: 'navigate', tab: 3, url: 'about:blank' }); assert.equal(tabs.get(3).url, 'about:blank');
  await a.viewer.hear({ do: 'navigate', tab: 3, url: 'file:///tmp/no' }); assert.match(a.last().error, /web address/);
});

function socket() { return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() {}, hear(said) { this.onmessage({ data: JSON.stringify(said) }); } }; }
test('scoped clients require scope/watching proof, derive selected flags from their pin, keep stale input ids and reconnect to chosen tab', () => {
  const sockets = [], lists = [], frames = [];
  const live = client({ tab: 2, browser: true, connect: () => { const ws = socket(); sockets.push(ws); return ws; }, onTabs: tabs => lists.push(tabs), onFrame: said => frames.push(said) });
  live.show(true); const ws = sockets[0]; ws.onopen(); assert.deepEqual(ws.sent[0], { do: 'watch', tab: 2, scope: 'browser' });
  ws.hear({ scope: 'browser', watching: 2, tabs: [{ tab: 1, front: true }, { tab: 2, front: false }] });
  assert.deepEqual(lists.at(-1).map(one => one.front), [false, true]);
  live.send({ do: 'front', tab: 1 }); ws.hear({ scope: 'browser', watching: 1, tabs: [{ tab: 1 }, { tab: 2 }] });
  live.send({ do: 'reload', tab: 2 }); assert.deepEqual(ws.sent.at(-1), { do: 'reload', tab: 2 });
  live.show(false); live.show(true); sockets[1].onopen(); assert.equal(sockets[1].sent[0].tab, 1); assert.equal(sockets[1].sent[0].resume, true);
  sockets[1].hear({ scope: 'browser', watching: 1, frame: 'pixels', tab: 1 }); assert.equal(frames.length, 1);
  sockets[1].hear({ watching: 1, frame: 'old protocol', tab: 1 }); assert.equal(frames.length, 1);
  live.stop();
});

test('scoped clients reject mismatched frames; embedded clients retain no lifecycle authority', () => {
  for (const reply of [{ scope: 'browser', watching: 2, frame: 'wrong', tab: 1 }, { scope: true, watching: 2, tabs: [{ tab: 2 }] }, { scope: 'browser', watching: '2', tabs: [{ tab: 2 }] }]) {
    const ws = socket(); let expired = false;
    const live = client({ tab: 2, browser: true, connect: () => ws, onExpired: () => { expired = true; } });
    live.show(true); ws.onopen(); ws.hear(reply); assert.equal(expired, true); live.stop();
  }
  const ws = socket(), fixed = client({ tab: 2, connect: () => ws }); fixed.show(true); ws.onopen();
  for (const action of ['new', 'close', 'front', 'launch']) fixed.send({ do: action, tab: 2 });
  assert.deepEqual(ws.sent, [{ do: 'watch', tab: 2 }]); fixed.stop();
});

test('invalid scoped commands cannot resize a valid pinned page or store a future viewport', async t => {
  const fitted = [];
  const { live, watch, tabs } = fixture(t, { fit: async (page, size) => fitted.push({ tab: page.id, ...size }) });
  const a = watch({ tab: 2, scope: 'browser', size: { width: 600, height: 700, scale: 1 } }); await live.changed();
  assert.equal(fitted.length, 1);
  for (const command of [
    { do: 'unknown', tab: 2 }, { do: 'navigate', tab: 2, url: 'file:///tmp/no' },
    { do: 'navigate', tab: 2, url: 'about:config' }, { do: 'navigate', tab: 2, url: 'http://' },
    { do: 'reload', tab: 1 }, { do: 'front', tab: '3' }, { do: 'close', tab: 99 },
  ]) {
    await a.viewer.hear({ ...command, size: { width: 900, height: 800, scale: 2 } });
    assert.ok(a.last().error); assert.equal(a.viewer.tab, 2); assert.equal(fitted.length, 1);
  }
  await a.viewer.hear({ do: 'reload', tab: 2 }); await live.changed();
  assert.deepEqual(tabs.get(2).input, ['reload']); assert.equal(fitted.length, 1, 'invalid requests never save a later viewport');
  // The pin may vanish just before the owner's changed() observer runs.
  // Reject its stale page command before recovery can claim the supplied
  // size for an unrelated surviving page.
  tabs.delete(2);
  await a.viewer.hear({ do: 'reload', tab: 2, size: { width: 900, height: 800, scale: 2 } });
  assert.match(a.last().error, /No tab is open/); assert.equal(fitted.length, 1);
  await live.changed();
  assert.equal(a.viewer.tab, 1); assert.deepEqual(fitted.at(-1), { tab: 1, width: 600, height: 700, scale: 1 });
});

test('only human new intentions queue until scoped proof; hidden reconnect recovers while stale input is never replayed', () => {
  const sockets = [];
  const live = client({ tab: 2, browser: true, connect: () => { const ws = socket(); sockets.push(ws); return ws; } });
  live.newTab(); live.send({ do: 'type', tab: 2, text: 'never replay' });
  live.show(true); const ws = sockets[0]; ws.onopen();
  assert.deepEqual(ws.sent, [{ do: 'watch', tab: 2, scope: 'browser' }]);
  ws.hear({ scope: 'browser', watching: 2, tabs: [{ tab: 2 }, { tab: 3 }] });
  assert.deepEqual(ws.sent.at(-1), { do: 'new' }); assert.equal(ws.sent.filter(one => one.do === 'new').length, 1);
  ws.hear({ scope: 'browser', watching: 4, tabs: [{ tab: 2 }, { tab: 3 }, { tab: 4, url: 'about:blank' }] });
  live.show(false); live.newTab(); live.show(true); sockets[1].onopen();
  assert.deepEqual(sockets[1].sent[0], { do: 'watch', tab: 4, scope: 'browser', resume: true });
  sockets[1].hear({ scope: 'browser', watching: 3, tabs: [{ tab: 3 }] });
  assert.equal(sockets[1].sent.filter(one => one.do === 'new').length, 1);
  assert.equal(sockets.flatMap(one => one.sent).some(one => one.do === 'type'), false);
  live.show(false); live.newTab(); live.watch('/peer/other'); live.show(true); sockets[2].onopen();
  sockets[2].hear({ scope: 'browser', watching: 3, tabs: [{ tab: 3 }] });
  assert.equal(sockets[2].sent.some(one => one.do === 'new'), false, 'owner change cancels intentions');
  live.show(false); live.newTab(); live.stop(); live.show(true); sockets[3].onopen();
  sockets[3].hear({ scope: 'browser', watching: 3, tabs: [{ tab: 3 }] });
  assert.equal(sockets[3].sent.some(one => one.do === 'new'), false, 'stop cancels intentions');
  live.stop();
});
