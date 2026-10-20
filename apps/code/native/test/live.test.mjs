// The phone's live view of the agents' browser: the window's side
// (desktop/electron/live.mjs), the computer's relay (browser.mjs, relayLive,
// at /browser/live and /peer/<id>/browser/live) and the phone's side
// (public/js/live.js), with stand-ins for Electron's pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer as createSocketServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { answer, createLive } from '../../../../desktop/electron/live.mjs';
import { createLive as createPhoneLive, pagePoint, pageScroll } from '../public/js/live.js';
import { createGueyServer } from '../../../../system/server.mjs';

const until = async (ok, what = 'it', wait = 3000) => {
  for (const end = Date.now() + wait; !ok(); await new Promise(done => setTimeout(done, 5))) if (Date.now() > end) throw new Error(`${what} did not happen`);
};

// A tab of the window, as Electron's webContents are to live.mjs.
function tab(id, title, url) {
  const debug = Object.assign(new EventEmitter(), {
    attached: false, sent: [],
    isAttached() { return this.attached; },
    attach(version) { assert.equal(version, '1.3'); this.attached = true; },
    detach() { this.attached = false; },
    async sendCommand(method, params) { this.sent.push(params === undefined ? [method] : [method, params]); return {}; },
  });
  const page = {
    id, title, url, debugger: debug, input: [], typed: [], reloads: 0, destroyed: false, zoom: 1,
    isDestroyed() { return this.destroyed; }, getTitle() { return this.title; }, getURL() { return this.url; },
    getZoomFactor() { return this.zoom; }, sendInputEvent(event) { this.input.push(event); },
    async insertText(text) { this.typed.push(text); }, reload() { this.reloads++; },
    field: 'text', async executeJavaScriptInIsolatedWorld() { return this.field; },
    navigationHistory: { canGoBack: () => true, goBack() { page.went = 'back'; }, canGoForward: () => false },
    frame(n, width = 1280, height = 800) { debug.emit('message', {}, 'Page.screencastFrame', { data: `jpeg${n}`, sessionId: n, metadata: { deviceWidth: width, deviceHeight: height } }); },
    methods: () => debug.sent.map(([method]) => method),
  };
  return page;
}
function window(pages, more = {}) {
  const tabs = new Map(pages.map(page => [page.id, page]));
  const at = { front: pages[0]?.id ?? null };
  const live = createLive({ tabs: () => tabs, front: () => at.front, toFront: id => { at.front = id; }, ...more });
  return { tabs, at, live };
}

test('the window sends pictures of the tab in front only while a phone watches, as fast as the phone draws them', async () => {
  const one = tab(1, 'Pi', 'https://pi.dev/'), two = tab(2, 'Example', 'https://example.com/');
  const { live } = window([one, two]);
  // Nobody watching: nothing is pictured.
  await live.changed();
  assert.deepEqual(one.debugger.sent, []);
  assert.equal(one.debugger.attached, false);

  const heard = [];
  const phone = live.watch({ width: 780, height: 2400 }, said => heard.push(said));
  await until(() => one.methods().includes('Page.startScreencast'), 'the screencast');
  assert.deepEqual(one.debugger.sent[0], ['Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 780, maxHeight: 1600, everyNthFrame: 1 }], 'no larger than the phone, nor a window');
  assert.equal(one.debugger.attached, true);
  assert.deepEqual(heard[0], { tabs: [{ tab: 1, title: 'Pi', url: 'https://pi.dev/', front: true, favicon: '', loading: false, driving: false }, { tab: 2, title: 'Example', url: 'https://example.com/', front: false, favicon: '', loading: false, driving: false }] });
  assert.deepEqual(two.debugger.sent, [], 'only the tab in front');

  // A picture goes to the phone; the next waits until the phone has drawn it.
  one.frame(1);
  assert.deepEqual(heard.at(-1), { frame: 'jpeg1', tab: 1, width: 1280, height: 800 });
  assert.ok(!one.methods().includes('Page.screencastFrameAck'), 'not asked for the next before this one is drawn');
  one.frame(2);
  assert.equal(heard.filter(said => said.frame).length, 1, 'one picture at a time on the link');
  await phone.hear({ ack: true });
  assert.deepEqual(heard.at(-1).frame, 'jpeg2', 'the newest, once the last is drawn');
  await phone.hear({ ack: true });
  assert.deepEqual(one.debugger.sent.at(-1), ['Page.screencastFrameAck', { sessionId: 2 }], 'and only then the next');

  // The phone looks away: the pictures stop, and the page is let go.
  phone.stop();
  await until(() => !one.debugger.attached, 'letting go');
  assert.equal(one.methods().at(-1), 'Page.stopScreencast');
  assert.equal(live.watching(), 0);
  const count = heard.length;
  one.frame(3);
  assert.equal(heard.length, count, 'nothing after it stopped');
});

test('a backend without a viewport adapter ignores panel size reports, including on interaction', async () => {
  const one = tab(1, 'PC', 'https://example.com/');
  const { live } = window([one]);
  const heard = [];
  const phone = live.watch({ width: 780, height: 1688, size: { width: 390, height: 844, scale: 2 } }, said => heard.push(said));
  await until(() => one.methods().includes('Page.startScreencast'));
  one.frame(1);
  await phone.hear({ ack: true });
  const before = [...one.debugger.sent];
  await phone.hear({ size: { width: 844, height: 390, scale: 2 } });
  assert.deepEqual(one.debugger.sent, before, 'neither resize nor restart');
  await phone.hear({ do: 'tap', tab: 1, x: 640, y: 400, page: { width: 1280, height: 800 } });
  assert.equal(one.debugger.sent.at(-1)[1].x, 640);
  assert.equal(one.debugger.sent.at(-1)[1].y, 400);
  assert.ok(!heard.some(said => said.error));
  assert.ok(!one.methods().includes('Emulation.setDeviceMetricsOverride'));
  phone.stop();
});

test('screenless panel reports and interactions choose the last watcher; sizes clamp and survive disconnects', async () => {
  const one = tab(1, 'Cloud', 'https://example.com/');
  const fitted = [], heard = [];
  const { live } = window([one], { fit: async (_, size) => fitted.push(size) });
  const phone = live.watch({ size: { width: 390, height: 844, scale: 3 } }, said => heard.push(said));
  await live.changed();
  assert.deepEqual(fitted.at(-1), { width: 390, height: 844, scale: 2 });
  assert.deepEqual(one.debugger.sent.at(-1)[1], { format: 'jpeg', quality: 60, maxWidth: 780, maxHeight: 1688, everyNthFrame: 1 });
  const laptop = live.watch({ size: { width: 1000, height: 700, scale: 1 } }, () => {});
  await live.changed();
  assert.deepEqual(fitted.at(-1), { width: 1000, height: 700, scale: 1 });
  // A phone acting on the landscape frame reclaims its portrait viewport;
  // map the shared frame's point into the viewport now taking the input.
  await phone.hear({ do: 'tap', tab: 1, x: 500, y: 350, page: { width: 1000, height: 700 } });
  assert.deepEqual(fitted.at(-1), { width: 390, height: 844, scale: 2 });
  assert.deepEqual([one.debugger.sent.at(-1)[1].x, one.debugger.sent.at(-1)[1].y], [390, 844]);
  one.zoom = 2;
  await phone.hear({ do: 'scroll', tab: 1, x: 390, y: 844, dy: 200, page: { width: 780, height: 1688 } });
  assert.deepEqual(one.debugger.sent.at(-1), ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 195, y: 422, deltaX: 0, deltaY: 200 }], 'wheel coordinates are CSS pixels; Chromium itself scales wheel distance by zoom');
  await phone.hear({ size: { width: 1, height: 10000, scale: 10 } });
  assert.deepEqual(fitted.at(-1), { width: 1, height: 1920, scale: 2 });
  const count = fitted.length;
  for (const size of [{ width: 0, height: 844, scale: 2 }, { width: '390', height: 844, scale: 2 }, { width: 390, height: 844, scale: Infinity }]) await phone.hear({ size });
  assert.equal(fitted.length, count, 'invalid sizes ignored');
  await phone.hear({ ack: true });
  assert.equal(fitted.length, count, 'frame acknowledgements do not steal control');
  phone.stop();
  await live.changed();
  assert.equal(fitted.length, count, 'departing winner does not resize to remaining watcher');
  laptop.stop();
  await live.changed();
  assert.equal(fitted.length, count, 'last size retained without watchers');
  assert.ok(!heard.some(said => said.error));
});

test('headed native density preserves existing zoom and restores only the watched viewport', async () => {
  const one = tab(1, 'Native', 'https://example.com/'); one.zoom = 2;
  const fitted = [], heard = []; let restored = 0;
  const { live } = window([one], { maxScale: 1, nativeScale: page => page.getZoomFactor(), fit: async (_, size) => { fitted.push(size); return () => { restored++; }; } });
  const phone = live.watch({ size: { width: 390, height: 844, scale: 2 } }, said => heard.push(said));
  await live.changed();
  assert.deepEqual(fitted.at(-1), { width: 390, height: 844, scale: 1 });
  assert.deepEqual(one.debugger.sent.at(-1)[1], { format: 'jpeg', quality: 60, maxWidth: 780, maxHeight: 1688, everyNthFrame: 1 });
  one.frame(1, 780, 1688);
  await phone.hear({ do: 'tap', tab: 1, x: 80, y: 80, page: { width: 780, height: 1688 } });
  assert.deepEqual(one.debugger.sent.at(-1), ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 40, y: 40, button: 'left', clickCount: 1 }]);
  assert.equal(one.zoom, 2, 'no shared-origin zoom change');
  phone.stop(); await live.changed();
  assert.equal(restored, 1);
});

test('a second watcher of a still page is shown its latest picture at once', async () => {
  // A page that does not change sends one screencast frame. The laptop's
  // portal joining while the phone (or its own earlier connection) watches
  // would otherwise wait for a change that never comes.
  const one = tab(1, 'Health', 'http://127.0.0.1:5067/health');
  const { live } = window([one]);
  const first = [], second = [];
  const phone = live.watch({ width: 400, height: 800 }, said => first.push(said));
  await until(() => one.methods().includes('Page.startScreencast'), 'the screencast');
  one.frame(1, 639, 396);
  await phone.hear({ ack: true });
  assert.ok(one.methods().includes('Page.screencastFrameAck'));

  const laptop = live.watch({ width: 1600, height: 1400 }, said => second.push(said));
  assert.deepEqual(second.filter(said => said.frame), [{ frame: 'jpeg1', tab: 1, width: 639, height: 396 }], 'the picture already drawn for the first');
  assert.ok(second.some(said => said.tabs), 'and the tabs');
  assert.equal(one.methods().filter(method => method === 'Page.startScreencast').length, 1, 'the same screencast');
  assert.equal(first.filter(said => said.frame).length, 1, 'nothing again to the first');

  // The next picture waits for the newcomer to draw the old one, then reaches both.
  one.frame(2, 639, 396);
  assert.equal(second.filter(said => said.frame).length, 1);
  await laptop.hear({ ack: true });
  assert.equal(second.at(-1).frame, 'jpeg2');
  assert.equal(first.at(-1).frame, 'jpeg2');

  // Once nobody watches, nothing is kept for the next.
  phone.stop(); laptop.stop();
  const later = [];
  live.watch({}, said => later.push(said));
  await until(() => one.methods().filter(method => method === 'Page.startScreencast').length === 2, 'a new screencast');
  assert.ok(!later.some(said => said.frame), 'no picture from before');
});

test('a window out of sight is made to draw while a phone watches, and left alone after', async () => {
  // Under a full-screen screensaver, or on another workspace, the window
  // draws nothing and the screencast sends nothing, unless asked to draw.
  const one = tab(1, 'Pi', 'https://pi.dev/');
  let draws = 0, busy = 0, most = 0;
  const draw = async () => { draws++; most = Math.max(most, ++busy); await new Promise(done => setTimeout(done, 150)); busy--; };
  const { live } = window([one], { draw });
  await live.changed();
  assert.equal(draws, 0, 'not while nobody watches');
  const phone = live.watch({ width: 400, height: 800 }, () => {});
  await until(() => one.methods().includes('Page.startScreencast'), 'the screencast');
  assert.equal(draws, 1, 'at once, for the first picture');
  await until(() => draws >= 3, 'drawing again and again');
  assert.equal(most, 1, 'one at a time, never piling up');
  phone.stop();
  await new Promise(done => setTimeout(done, 200));
  const after = draws;
  await new Promise(done => setTimeout(done, 300));
  assert.equal(draws, after, 'no more once the phone looks away');
});

test('the pictures follow the tab in front, chosen in the window or from the phone\'s list', async () => {
  const one = tab(1, 'Pi', 'https://pi.dev/'), two = tab(2, 'Example', 'https://example.com/');
  const { live, at } = window([one, two]);
  const heard = [];
  const phone = live.watch({ width: 400, height: 800 }, said => heard.push(said));
  await until(() => one.methods().includes('Page.startScreencast'));
  // A tap on the second tab in the phone's list.
  await phone.hear({ do: 'front', tab: 2 });
  assert.equal(at.front, 2);
  await until(() => two.methods().includes('Page.startScreencast'), 'the second tab pictured');
  assert.equal(one.methods().at(-1), 'Page.stopScreencast');
  assert.deepEqual(heard.filter(said => said.tabs).at(-1).tabs.map(t => [t.tab, t.front]), [[1, false], [2, true]], 'the list says which is in front');
  one.frame(9);
  assert.ok(!heard.some(said => said.frame === 'jpeg9'), 'the tab behind sends nothing');
  // The person turns to the first in the window: the phone follows.
  at.front = 1;
  await live.changed();
  await until(() => one.methods().filter(m => m === 'Page.startScreencast').length === 2);
  // A title changing is a new list; one already said is not said again.
  const lists = heard.filter(said => said.tabs).length;
  two.title = 'Example Domain';
  await live.changed();
  await live.changed();
  assert.equal(heard.filter(said => said.tabs).length, lists + 1);
  await phone.hear({ do: 'front', tab: 7 });
  assert.deepEqual(heard.at(-1), { error: 'That tab is closed' });
  // A page with DevTools open on it is shown, and left attached.
  const three = tab(3, 'Dev', 'https://dev.example/');
  three.debugger.attached = true;
  const { live: other } = window([three]);
  const watcher = other.watch({}, () => {});
  await until(() => three.methods().includes('Page.startScreencast'));
  watcher.stop();
  await until(() => three.methods().includes('Page.stopScreencast'));
  await new Promise(done => setTimeout(done, 10));
  assert.equal(three.debugger.attached, true, 'not ours to detach');
  phone.stop();
});

test('a tap, a scroll, typing and the bar\'s buttons reach the tab in front as the person\'s own', async () => {
  const one = tab(1, 'Pi', 'https://pi.dev/'), two = tab(2, 'Example', 'https://example.com/');
  const { live, at } = window([one, two]);
  const heard = [];
  const phone = live.watch({}, said => heard.push(said));
  one.field = { editable: true, kind: 'text', token: 'fixture-text' };
  await phone.hear({ do: 'tap', tab: 1, x: 100.4, y: 50.6, gesture: 1 });
  assert.deepEqual(one.debugger.sent.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params), [
    { type: 'mouseMoved', x: 100, y: 51 },
    { type: 'mousePressed', x: 100, y: 51, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', x: 100, y: 51, button: 'left', clickCount: 1 },
  ]);
  assert.deepEqual(heard.at(-1), { field: one.field, gesture: 1 }, 'only the human tap authorizes a truthful editable reply');
  one.field = { editable: true, kind: 'password', token: 'fixture-password' };
  await phone.hear({ do: 'tap', tab: 1, x: 1, y: 1, gesture: 2 });
  assert.deepEqual(heard.at(-1), { field: one.field, gesture: 2 }, 'a password field returns metadata, never its existing value');
  one.input.length = 0;
  one.zoom = 2;
  await phone.hear({ do: 'scroll', tab: 1, x: 200, y: 100, dy: 300 });
  assert.deepEqual(one.debugger.sent.at(-1), ['Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 50, deltaX: 0, deltaY: 300 }], 'the wheel where the finger was, in the page\'s own pixels');
  one.input.length = 0;
  await phone.hear({ do: 'type', tab: 1, text: 'hello', enter: true });
  assert.deepEqual(one.typed, ['hello']);
  assert.deepEqual(one.input.map(e => [e.type, e.keyCode]), [['keyDown', 'Enter'], ['char', '\r'], ['keyUp', 'Enter']]);
  await phone.hear({ do: 'back', tab: 1 });
  assert.equal(one.went, 'back');
  await phone.hear({ do: 'reload', tab: 1 });
  assert.equal(one.reloads, 1);
  // Another tab came to the front since the phone's last picture: what was
  // meant for the first reaches neither.
  at.front = 2;
  one.input.length = 0;
  for (const said of [{ do: 'tap', tab: 1, x: 5, y: 5 }, { do: 'type', tab: 1, text: 'secret' }, { do: 'tap', x: 5, y: 5 }]) {
    await phone.hear(said);
    assert.deepEqual(heard.at(-1), { error: 'The tab in front changed; look again' });
  }
  assert.deepEqual([one.input, two.input, two.typed], [[], [], []]);
  assert.deepEqual(one.typed, ['hello']);
  await phone.hear({ do: 'open', tab: 2, url: 'https://example.com/' });
  assert.deepEqual(heard.at(-1), { error: 'The live browser does not know how to open' }, 'the phone opens nothing of its own here');
  phone.stop();
});

// The window's socket as main.mjs answers it, and the computer's relay.
async function windowAt(path, live, drive = async asked => ({ asked })) {
  const server = createSocketServer({ allowHalfOpen: true }, socket => answer(socket, { drive, live }));
  await new Promise(resolve => server.listen(path, resolve));
  return () => new Promise(resolve => server.close(resolve));
}

test('the window\'s socket still answers the tool\'s requests, one at a time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-live-'));
  const close = await windowAt(join(dir, 'w.sock'), window([]).live);
  try {
    const { askWindow } = await import('../browser.mjs');
    assert.deepEqual(await askWindow({ do: 'tabs', session: 's' }, { sockets: async () => [join(dir, 'w.sock')] }), { asked: { do: 'tabs', session: 's' } });
  } finally { await close(); await rm(dir, { recursive: true, force: true }); }
});

test('the phone watches a computer\'s browser on its own connection to it, and through /peer/ to another', async t => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-live-'));
  const one = tab(1, 'Pi', 'https://pi.dev/');
  const { live } = window([one]);
  const closeWindow = await windowAt(join(root, 'pc.sock'), live);
  const urls = {}, apps = {};
  t.after(async () => { for (const app of Object.values(apps)) await app.close(); await closeWindow(); await rm(root, { recursive: true, force: true }); });
  for (const id of ['pc', 'laptop']) {
    const other = id === 'pc' ? 'laptop' : 'pc';
    const machines = {
      self: async () => id, selfId: async () => id, origins: async () => [], published: async () => '',
      list: async () => [{ id, name: id, url: urls[id], self: true, reachable: true }, { id: other, name: other, url: urls[other], self: false, reachable: true }],
      peer: async asked => (asked === other ? { id: other, name: other, url: urls[other] } : null),
    };
    const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId: `${id}-session`, messages: [], tabs: [] }), command: async () => ({}), close: async () => {} };
    apps[id] = await createGueyServer({
      stateDir: join(root, id), runtime, machines, sessionToken: `${id}-token`, identityOptions: { status: async () => ({ Self: { StableID: id } }) },
      browser: { sockets: async () => (id === 'pc' ? [join(root, 'pc.sock')] : []), open: async () => { throw new Error("imperfect's window could not be opened here: no screen in a test"); } },
    });
    urls[id] = `http://127.0.0.1:${(await apps[id].listen()).port}`;
  }
  const watch = async url => {
    const ws = new WebSocket(url.replace(/^http/, 'ws'));
    const heard = [];
    ws.on('message', raw => heard.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise(resolve => ws.once('close', resolve));
    return { ws, heard, closed, say: said => ws.send(JSON.stringify(said)) };
  };
  for (const url of [`${urls.pc}/browser/live`, `${urls.laptop}/peer/pc/browser/live`]) {
    const phone = await watch(url);
    phone.say({ do: 'watch', width: 390, height: 700 });
    await until(() => phone.heard.some(said => said.tabs), `the list, at ${url}`);
    await until(() => one.debugger.attached && one.methods().at(-1) === 'Page.startScreencast');
    one.frame(5);
    await until(() => phone.heard.some(said => said.frame === 'jpeg5'), 'a picture');
    phone.say({ ack: true });
    await until(() => one.debugger.sent.some(([m, p]) => m === 'Page.screencastFrameAck' && p.sessionId === 5), 'the next asked for');
    phone.say({ do: 'tap', tab: 1, x: 10, y: 20 });
    await until(() => one.debugger.sent.some(([method, e]) => method === 'Input.dispatchMouseEvent' && e.type === 'mouseReleased' && e.x === 10 && e.y === 20), 'the tap');
    one.input.length = 0;
    one.debugger.sent.length = 0;
    // The panel out of sight closes the connection: the pictures stop.
    phone.ws.close();
    await until(() => live.watching() === 0 && !one.debugger.attached, 'stopping');
  }
  // A computer with no window and none to be opened says so.
  const lonely = await watch(`${urls.laptop}/browser/live`);
  lonely.say({ do: 'watch' });
  await lonely.closed;
  assert.match(lonely.heard[0].error, /could not be opened here/);
  // Only this computer's own origins may watch, as for /pi.
  const refused = new WebSocket(`${urls.pc.replace(/^http/, 'ws')}/browser/live`, { headers: { origin: 'https://evil.example' } });
  await assert.rejects(new Promise((resolve, reject) => { refused.once('open', resolve); refused.once('error', reject); }), /403/);
});

test('a tap on the phone is a click at the same place on the page, however the picture is fitted', () => {
  const page = { width: 1280, height: 800 };
  // A phone's panel, 390 wide and 600 tall: the page fitted to its width, centred.
  const box = { left: 0, top: 100, width: 390, height: 600 };
  const scale = 390 / 1280, top = 100 + (600 - 800 * scale) / 2;
  assert.deepEqual(pagePoint({ x: 195, y: top + 400 * scale }, box, page), { x: 640, y: 400 }, 'the middle is the middle');
  assert.deepEqual(pagePoint({ x: 0, y: top }, box, page), { x: 0, y: 0 });
  assert.deepEqual(pagePoint({ x: 390, y: top + 800 * scale }, box, page), { x: 1280, y: 800 });
  assert.equal(pagePoint({ x: 100, y: 110 }, box, page), null, 'above the picture is not the page');
  // Full screen on its side: fitted to the height, with bars either side.
  const wide = { left: 0, top: 0, width: 2000, height: 800 };
  assert.deepEqual(pagePoint({ x: 360 + 1280, y: 800 }, wide, page), { x: 1280, y: 800 });
  assert.equal(pagePoint({ x: 100, y: 400 }, wide, page), null);
  assert.equal(pagePoint({ x: 1, y: 1 }, box, null), null, 'before any picture, nothing to tap');
  // A finger drawn up 39 screen pixels scrolls the page down 128 of its own.
  assert.equal(pageScroll(-39, box, page), 128);
  assert.equal(pageScroll(39, box, page), -128);
  assert.equal(pageScroll(10, box, null), 0);
});

// The phone's side, with a stand-in WebSocket.
function sockets() {
  const made = [];
  const connect = base => {
    const ws = { base, sent: [], readyState: 0, close() { this.readyState = 3; this.onclose?.(); }, send(text) { this.sent.push(JSON.parse(text)); } };
    ws.opened = () => { ws.readyState = 1; ws.onopen(); };
    ws.hear = said => ws.onmessage({ data: JSON.stringify(said) });
    made.push(ws);
    return ws;
  };
  return { made, connect };
}

test('the phone connects only while the view is in sight, acks each picture once drawn, and follows the computer', async () => {
  const { made, connect } = sockets();
  const frames = [], lists = [], notes = [], fields = [];
  const live = createPhoneLive({ connect, size: () => ({ width: 780, height: 1200 }), onFrame: (said, drawn) => frames.push([said, drawn]), onTabs: tabs => lists.push(tabs), onNote: note => notes.push(note), onField: (field, gesture) => fields.push({ field, gesture }), retry: 5 });
  live.watch('/peer/pc');
  // Nothing done out of sight is kept for later.
  live.send({ do: 'tap', tab: 4, x: 1, y: 1 });
  assert.equal(made.length, 0, 'nothing while out of sight');
  live.show(true);
  assert.equal(made.length, 1);
  assert.equal(made[0].base, '/peer/pc');
  made[0].opened();
  assert.deepEqual(made[0].sent, [{ do: 'watch', width: 780, height: 1200 }], 'a tap made out of sight is not kept');
  made[0].hear({ tabs: [{ tab: 4, title: 'Pi', front: true }] });
  made[0].hear({ frame: 'abc', tab: 4, width: 1280, height: 800 });
  assert.deepEqual(lists, [[{ tab: 4, title: 'Pi', front: true }]]);
  assert.equal(frames.length, 1);
  assert.equal(made[0].sent.length, 1, 'no ack before it is drawn');
  frames[0][1]();
  assert.deepEqual(made[0].sent.at(-1), { ack: true });
  live.send({ do: 'front', tab: 4 });
  assert.deepEqual(made[0].sent.at(-1), { do: 'front', tab: 4 });
  made[0].hear({ error: 'That tab is closed' });
  assert.deepEqual(notes, ['That tab is closed']);
  made[0].hear({ field: { editable: true, kind: 'password', token: 'private', mirror: false }, gesture: 4 });
  assert.deepEqual(fields, [{ field: { editable: true, kind: 'password', token: 'private', mirror: false }, gesture: 4 }]);
  // Out of sight: the connection closes, and no more is asked for.
  live.show(false);
  assert.equal(made[0].readyState, 3);
  frames[0][1]();
  assert.equal(made[0].sent.filter(said => said.ack).length, 1, 'a late draw asks nothing of a closed connection');
  await new Promise(done => setTimeout(done, 20));
  assert.equal(made.length, 1, 'and it is not tried again');
  // Back in sight: a new connection, watching afresh.
  live.show(true);
  assert.equal(made.length, 2);
  made[1].opened();
  assert.deepEqual(made[1].sent, [{ do: 'watch', width: 780, height: 1200 }]);
  // Another computer's browser: the old connection goes, a new one comes.
  live.watch('');
  assert.equal(made[1].readyState, 3);
  assert.equal(made.length, 3);
  assert.equal(made[2].base, '');
  // A window that goes away is tried again while the view is in sight.
  made[2].opened();
  made[2].close();
  await until(() => made.length === 4, 'trying again');
  live.stop();
  assert.equal(made[3].readyState, 3);
});

test('the client reports CSS panel sizes on connect and resize, without reconnecting', () => {
  const { made, connect } = sockets();
  let panel = { width: 390, height: 844, scale: 2 };
  const live = createPhoneLive({ connect, size: () => ({ width: panel.width * panel.scale, height: panel.height * panel.scale, size: panel }) });
  live.show(true); made[0].opened();
  assert.deepEqual(made[0].sent[0], { do: 'watch', width: 780, height: 1688, size: panel });
  panel = { width: 844, height: 390, scale: 2 };
  live.resize();
  assert.deepEqual(made[0].sent.at(-1), { size: panel });
  assert.equal(made.length, 1);
  live.stop(); live.resize();
  assert.equal(made[0].sent.length, 2, 'no report while hidden');
});

test('the client says its own light or dark appearance with its watch, and again on a size line when it turns', () => {
  const { made, connect } = sockets();
  const panel = { width: 390, height: 844, scale: 2 };
  const scheme = Object.assign(new EventTarget(), { matches: true });
  const live = createPhoneLive({ connect, scheme, size: () => ({ width: 780, height: 1688, size: panel }) });
  live.show(true); made[0].opened();
  assert.deepEqual(made[0].sent[0], { do: 'watch', width: 780, height: 1688, size: panel, appearance: 'dark' });
  scheme.matches = false; scheme.dispatchEvent(new Event('change'));
  assert.deepEqual(made[0].sent.at(-1), { size: panel, appearance: 'light' }, 'a browser from before takes it as the same size');
  assert.equal(made.length, 1, 'turning never reconnects');
  live.stop();
  scheme.matches = true; scheme.dispatchEvent(new Event('change'));
  assert.equal(made[0].sent.length, 2, 'nothing said once it stops watching');
  // Without a way to know (a test, an old webview), it says nothing of it.
  const quiet = sockets();
  const plain = createPhoneLive({ connect: quiet.connect, scheme: null, size: () => ({ width: 780, height: 1688, size: panel }) });
  plain.show(true); quiet.made[0].opened();
  assert.equal('appearance' in quiet.made[0].sent[0], false);
  plain.stop();
});

test('a browser with no screen of its own draws its pages in its watcher\'s appearance; one with a screen keeps its own', async () => {
  const one = tab(1, 'Shop', 'https://imperfect.computer/shop');
  const looks = [], heard = [];
  const { live } = window([one], { appearance: scheme => looks.push(scheme), fit: async () => {} });
  const phone = live.watch({ size: { width: 400, height: 700, scale: 2 }, appearance: 'dark' }, said => heard.push(said));
  await live.changed();
  assert.deepEqual(looks, ['dark'], 'from the first line');
  await phone.hear({ size: { width: 400, height: 700, scale: 2 }, appearance: 'light' });
  await phone.hear({ appearance: 'dark' });
  await phone.hear({ appearance: 'sepia' });
  await phone.hear({ appearance: { dark: true } });
  assert.deepEqual(looks, ['dark', 'light', 'dark'], 'only light or dark');
  assert.ok(!heard.some(said => said.error), 'an appearance is not an action on the page');
  phone.stop();

  const two = tab(2, 'Shop', 'https://imperfect.computer/shop'), seen = [];
  const { live: headed } = window([two]);
  const viewer = headed.watch({ width: 780, height: 1600, appearance: 'dark' }, said => seen.push(said));
  await viewer.hear({ size: { width: 400, height: 700, scale: 2 }, appearance: 'light' });
  await viewer.hear({ appearance: 'dark' });
  assert.ok(!seen.some(said => said.error), 'a window with its own screen hears it and does nothing');
  viewer.stop();
});

test('a window opened before its browser could be watched says nothing, and the phone is told to have it reopened; nothing said early is kept', async () => {
  const { relayLive, OLD_WINDOW } = await import('../browser.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-live-'));
  const lines = [];
  // The window as it was: it answers a request only once the request ends.
  const held = [];
  const old = createSocketServer({ allowHalfOpen: true }, socket => { held.push(socket); socket.setEncoding('utf8'); socket.on('data', chunk => lines.push(chunk)); });
  await new Promise(resolve => old.listen(join(dir, 'old.sock'), resolve));
  try {
    const ws = Object.assign(new EventEmitter(), { readyState: 1, said: [], send(text) { this.said.push(JSON.parse(text)); }, close() { this.readyState = 3; this.emit('close'); } });
    relayLive(ws, { sockets: async () => [join(dir, 'old.sock')], open: async () => assert.fail('a window is open'), wait: 200 });
    ws.emit('message', JSON.stringify({ do: 'watch', width: 10, height: 10 }));
    ws.emit('message', JSON.stringify({ do: 'type', tab: 1, text: 'early' }));
    await until(() => ws.readyState === 3, 'giving up on the old window');
    assert.deepEqual(ws.said, [{ error: OLD_WINDOW }]);
    assert.match(OLD_WINDOW, /close it and open it again/);
    assert.ok(!lines.join('').includes('early'), 'what was said before the window answered is dropped');
  } finally { for (const socket of held) socket.destroy(); await new Promise(resolve => old.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
