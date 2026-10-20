import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { answer, createLive } from '../../../../desktop/electron/live.mjs';

const until = async ok => {
  for (const end = Date.now() + 3000; !ok(); await new Promise(resolve => setTimeout(resolve, 5))) {
    if (Date.now() > end) throw new Error('Live stream did not settle');
  }
};
function page(id) {
  const debug = Object.assign(new EventEmitter(), {
    attached: false, commands: [],
    isAttached() { return this.attached; }, attach() { assert.equal(this.attached, false); this.attached = true; }, detach() { this.attached = false; },
    async sendCommand(method, params) { this.commands.push({ method, ...params }); },
  });
  return {
    id, debugger: debug, destroyed: false, input: [], typed: [], urls: [], zoom: 1,
    isDestroyed() { return this.destroyed; }, getTitle() { return `Page ${id}`; }, getURL() { return `https://example.com/${id}`; },
    getZoomFactor() { return this.zoom; }, sendInputEvent(input) { this.input.push(input); },
    async insertText(text) { this.typed.push(text); }, async executeJavaScriptInIsolatedWorld() { return 'text'; },
    async loadURL(url) { this.urls.push(url); }, reload() { this.reloaded = true; },
    navigationHistory: { canGoBack: () => true, goBack() {}, canGoForward: () => true, goForward() {} },
    frame(n) { debug.emit('message', null, 'Page.screencastFrame', { data: `${id}:${n}`, sessionId: n, metadata: { deviceWidth: 800, deviceHeight: 600 } }); },
    count(method) { return debug.commands.filter(command => command.method === `Page.${method}`).length; },
  };
}
function browser(t, options = {}) {
  const pages = [page(101), page(202), page(303)], tabs = new Map(pages.map(one => [one.id, one]));
  const at = { front: 101, switches: [], launches: 0 };
  const live = createLive({ tabs: () => tabs, front: () => at.front, toFront: id => { at.front = id; at.switches.push(id); }, launch: async () => { at.launches++; }, ...options });
  const viewers = [];
  const watch = args => { const heard = []; const viewer = live.watch(args, said => heard.push(said)); viewers.push(viewer); return { viewer, heard, frames: () => heard.filter(said => said.frame) }; };
  t.after(async () => { viewers.forEach(viewer => viewer.stop()); await live.changed(); });
  return { live, at, tabs, pages, watch };
}

test('fixed tabs and portal front stream concurrently, with independent cast acknowledgements', async t => {
  const { live, at, pages: [one, two, three], watch } = browser(t);
  const portal = watch({}), second = watch({ tab: two.id }), third = watch({ tab: three.id });
  await live.changed();
  assert.deepEqual(at.switches, []);
  for (const page of [one, two, three]) assert.equal(page.count('startScreencast'), 1);
  one.frame(1); two.frame(2); three.frame(3);
  assert.deepEqual([portal.frames()[0].tab, second.frames()[0].tab, third.frames()[0].tab], [101, 202, 303]);
  assert.equal(portal.frames()[0].watching, undefined);
  assert.equal(second.frames()[0].watching, 202);
  assert.equal(third.frames()[0].watching, 303);
  await second.viewer.hear({ ack: true });
  assert.equal(two.count('screencastFrameAck'), 1);
  assert.equal(one.count('screencastFrameAck'), 0);
  assert.equal(three.count('screencastFrameAck'), 0);
  await portal.viewer.hear({ do: 'front', tab: three.id });
  assert.equal(at.front, three.id);
  assert.equal(one.count('stopScreencast'), 1);
  assert.equal(three.count('startScreencast'), 1, 'portal joins existing fixed cast');
  two.frame(4);
  assert.equal(second.frames().at(-1).frame, '202:4');
  assert.ok(portal.frames().every(frame => frame.tab !== 202));
  second.viewer.stop(); await live.changed();
  assert.equal(two.count('stopScreencast'), 1);
  assert.equal(three.count('stopScreencast'), 0);
});

test('same-tab fixed panels and portal share one cast, keep its latest frame, and release only their own backpressure', async t => {
  const { live, pages: [one], watch } = browser(t);
  const first = watch({ tab: one.id }); await live.changed();
  one.frame(1); await first.viewer.hear({ ack: true });
  const second = watch({ tab: one.id }), portal = watch({});
  assert.equal(second.frames()[0].frame, '101:1');
  assert.equal(portal.frames()[0].frame, '101:1');
  await live.changed(); assert.equal(one.count('startScreencast'), 1);
  one.frame(2);
  await second.viewer.hear({ ack: true });
  assert.equal(second.frames().at(-1).frame, '101:2');
  assert.equal(one.count('screencastFrameAck'), 1, 'portal still holds this page, not another cast');
  portal.viewer.stop();
  await first.viewer.hear({ ack: true }); await second.viewer.hear({ ack: true });
  assert.equal(one.count('screencastFrameAck'), 2);
  assert.equal(one.count('stopScreencast'), 0);
  first.viewer.stop(); await live.changed();
  one.frame(3); assert.equal(second.frames().at(-1).frame, '101:3');
  assert.equal(one.count('startScreencast'), 1);
  second.viewer.stop(); await live.changed(); assert.equal(one.count('stopScreencast'), 1);
});

test('fixed input and navigation cannot target another tab or alter portal front', async t => {
  const { live, at, pages: [one, two], watch } = browser(t);
  const fixed = watch({ tab: two.id }); await live.changed();
  await fixed.viewer.hear({ do: 'tap', tab: two.id, x: 12, y: 34 });
  await fixed.viewer.hear({ do: 'type', tab: two.id, text: 'private input' });
  await fixed.viewer.hear({ do: 'navigate', tab: two.id, url: 'https://example.org/new' });
  await fixed.viewer.hear({ do: 'reload', tab: two.id });
  await fixed.viewer.hear({ do: 'front', tab: two.id });
  assert.deepEqual(two.typed, ['private input']); assert.deepEqual(two.urls, ['https://example.org/new']); assert.ok(two.reloaded);
  assert.equal(two.input.at(-1).x, 12); assert.equal(two.input.at(-1).y, 34);
  for (const action of ['tap', 'scroll', 'type', 'key', 'navigate', 'back', 'forward', 'reload', 'front']) {
    await fixed.viewer.hear({ do: action, tab: one.id, text: 'wrong', url: 'https://wrong.example/' });
    assert.match(fixed.heard.at(-1).error, /fixed to another tab/);
  }
  await fixed.viewer.hear({ do: 'launch' }); assert.match(fixed.heard.at(-1).error, /cannot launch/);
  assert.equal(at.front, one.id); assert.deepEqual(at.switches, []); assert.equal(at.launches, 0);
  assert.deepEqual(one.input, []); assert.deepEqual(one.typed, []); assert.deepEqual(one.urls, []);
});

test('missing, malformed, destroyed and replaced durable tabs fail closed without stale or fallback frames', async t => {
  const { live, tabs, pages: [one, two], watch } = browser(t);
  const portal = watch({}), fixed = watch({ tab: two.id }); await live.changed();
  two.frame(1); await fixed.viewer.hear({ ack: true });
  tabs.delete(two.id);
  // A late renderer frame is rejected even before the tab-change callback.
  two.frame(2); await live.changed();
  assert.equal(fixed.frames().length, 1);
  assert.deepEqual(fixed.heard.at(-1), { error: 'The watched tab is closed or expired', tab: two.id, expired: true, closed: true, watching: two.id });
  one.frame(3); assert.equal(portal.frames().at(-1).frame, '101:3');
  assert.equal(fixed.frames().length, 1);
  await fixed.viewer.hear({ do: 'tap', tab: one.id }); assert.deepEqual(one.input, []);
  for (const tab of [0, -1, null, '101', 1.5, Number.MAX_SAFE_INTEGER + 1, 999]) {
    const stale = watch({ tab }); await live.changed();
    assert.ok(stale.heard.at(-1).closed); assert.ok(stale.heard.at(-1).error); assert.deepEqual(stale.frames(), []);
  }
  tabs.set(two.id, two); two.destroyed = true;
  const destroyed = watch({ tab: two.id }); assert.ok(destroyed.heard.at(-1).closed);
  two.destroyed = false;
  const replaced = watch({ tab: two.id }); await live.changed();
  tabs.set(two.id, page(two.id)); await live.changed();
  assert.ok(replaced.heard.at(-1).closed, 'same numeric id cannot replace the pinned page');
});

test('screenless sizes, coordinate remapping and wake draws belong to each watched page', async t => {
  const fitted = [], drawn = [];
  const { live, at, pages: [one, two], watch } = browser(t, {
    fit: async (page, size) => { fitted.push([page.id, size]); page.zoom = size.scale; },
    draw: async page => { drawn.push(page.id); },
  });
  const portrait = { width: 390, height: 844, scale: 2 }, landscape = { width: 1000, height: 700, scale: 1 };
  const portal = watch({ size: landscape }), fixed = watch({ tab: two.id, size: portrait }); await live.changed();
  await until(() => drawn.includes(one.id) && drawn.includes(two.id));
  assert.deepEqual(fitted, [[one.id, landscape], [two.id, portrait]]);
  await fixed.viewer.hear({ do: 'tap', tab: two.id, x: 400, y: 300, page: { width: 800, height: 600 } });
  assert.deepEqual([two.input.at(-1).x, two.input.at(-1).y], [390, 844]);
  await fixed.viewer.hear({ size: { width: 844, height: 390, scale: 2 } });
  assert.equal(fitted.filter(([id]) => id === one.id).length, 1, 'fixed resize leaves portal alone');
  assert.equal(at.front, one.id);
  fixed.viewer.stop(); await live.changed();
  const count = drawn.filter(id => id === two.id).length;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(drawn.filter(id => id === two.id).length, count);
  assert.ok(drawn.filter(id => id === one.id).length > 1);
  assert.equal(one.count('stopScreencast'), 0); portal.viewer.stop();
});

test('disconnect during an asynchronous resize cannot start an orphan cast', async t => {
  let release, fitting = false;
  const { live, pages: [one], watch } = browser(t, { fit: async () => { fitting = true; await new Promise(resolve => { release = resolve; }); } });
  const fixed = watch({ tab: one.id, size: { width: 390, height: 844, scale: 2 } });
  await until(() => fitting); fixed.viewer.stop(); release(); await live.changed();
  assert.equal(one.count('startScreencast'), 0); assert.equal(one.debugger.attached, false);
});

test('a fast disconnect/reconnect waits for old debugger cleanup before sharing the new cast', async t => {
  const { live, pages: [one], watch } = browser(t);
  const old = watch({ tab: one.id }); await live.changed();
  const send = one.debugger.sendCommand.bind(one.debugger);
  let release;
  one.debugger.sendCommand = async (method, params) => { await send(method, params); if (method === 'Page.stopScreencast') await new Promise(resolve => { release = resolve; }); };
  old.viewer.stop(); await until(() => release);
  const next = watch({ tab: one.id });
  release(); await live.changed();
  assert.equal(one.count('startScreencast'), 2); assert.equal(one.debugger.attached, true);
  one.frame(2); assert.equal(next.frames()[0].frame, '101:2');
  one.debugger.sendCommand = send;
});

test('answer forwards fixed watch target and its following input lines without a tool request', async t => {
  const { live, at, pages: [one, two] } = browser(t);
  const socket = Object.assign(new EventEmitter(), { destroyed: false, heard: [], setEncoding() {}, write(line) { this.heard.push(JSON.parse(line)); }, end() {} });
  answer(socket, { live, drive: () => assert.fail('not a tool request') });
  socket.emit('data', '{"do":"watch","tab":202,"width":800,');
  socket.emit('data', '"height":600}\n{"do":"reload","tab":202}\n');
  await live.changed(); await until(() => two.reloaded);
  two.frame(1);
  assert.equal(socket.heard.find(said => said.frame).tab, two.id);
  assert.equal(one.count('startScreencast'), 0); assert.equal(at.front, one.id);
  socket.emit('close'); await live.changed(); assert.equal(live.watching(), 0);
});
