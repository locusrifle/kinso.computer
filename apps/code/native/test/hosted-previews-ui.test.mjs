import test from 'node:test';
import assert from 'node:assert/strict';
import { createLive } from '../public/js/live.js';
import { viewFor } from '../public/js/pages.js';

test('fixed previews watch and act on their target and expire without reconnecting', async () => {
  const sockets = [], frames = [], lists = [];
  let expired = 0;
  const live = createLive({ tab: 42, retry: 1, connect: base => {
    const socket = { base, readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; this.onclose?.(); } };
    sockets.push(socket); return socket;
  }, onFrame: frame => frames.push(frame), onTabs: tabs => lists.push(tabs), onExpired: () => expired++ });
  live.watch('/peer/owner'); live.show(true);
  const socket = sockets[0]; socket.onopen();
  assert.deepEqual(socket.sent[0], { do: 'watch', tab: 42 });
  const hear = said => socket.onmessage({ data: JSON.stringify(said) });
  hear({ watching: 42, tabs: [{ tab: 1, front: true }, { tab: 42, front: false }] });
  assert.deepEqual(lists[0], [{ tab: 42, front: false }]);
  hear({ watching: 42, frame: 'preview', tab: 42 });
  assert.equal(frames[0].frame, 'preview');
  live.send({ do: 'tap', tab: 1, x: 3, y: 4 });
  assert.deepEqual(socket.sent.at(-1), { do: 'tap', tab: 42, x: 3, y: 4 });
  const count = socket.sent.length;
  live.launch(); live.send({ do: 'front', tab: 1 });
  assert.equal(socket.sent.length, count, 'fixed previews never front or launch tabs');
  hear({ watching: 42, expired: true, error: 'Preview expired' });
  assert.equal(expired, 1); assert.equal(socket.readyState, 3);
  live.show(false); live.show(true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets.length, 1, 'Retry must resolve a fresh target before connecting again');
  live.stop();
});

test('fixed previews reject old same-front unmarked replies and mismatches with no frames, input or reconnect', async t => {
  for (const reply of [
    { tabs: [{ tab: 42, front: true }] },
    { frame: 'old same-front pixels', tab: 42 },
    { watching: 1, tabs: [{ tab: 42, front: true }] },
    { watching: 1, frame: 'wrong watcher', tab: 42 },
    { watching: 42, frame: 'wrong tab', tab: 1 },
  ]) await t.test(JSON.stringify(reply), async () => {
    const sockets = [], frames = [], lists = [], notes = [];
    let expired = 0;
    const live = createLive({ tab: 42, retry: 1, connect: () => {
      const socket = { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); }, close() { this.readyState = 3; this.onclose?.(); } };
      sockets.push(socket); return socket;
    }, onFrame: frame => frames.push(frame), onTabs: tabs => lists.push(tabs), onNote: note => notes.push(note), onExpired: () => expired++ });
    live.show(true);
    const socket = sockets[0]; socket.onopen();
    const hear = said => socket.onmessage({ data: JSON.stringify(said) });
    hear(reply);
    assert.deepEqual(frames, []);
    assert.deepEqual(lists, [[]]);
    assert.deepEqual(notes, ['The open browser predates hosted previews. Stop watching for five idle minutes, then Retry.']);
    assert.equal(expired, 1);
    assert.equal(socket.readyState, 3);
    assert.equal(live.connected, false);
    hear({ watching: 42, frame: 'late pixels', tab: 42 });
    live.send({ do: 'tap', x: 1, y: 1 }); live.resize(); live.launch();
    live.show(false); live.watch('/peer/other'); live.show(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(sockets.length, 1);
    assert.deepEqual(frames, []);
    assert.deepEqual(socket.sent, [{ do: 'watch', tab: 42 }], 'no input or acknowledgement reaches the old browser');
    live.stop();
  });
});

test('invalid fixed watches still terminate on unmarked expired responses', async () => {
  const sockets = [], notes = [];
  let expired = 0;
  const live = createLive({ tab: 'invalid', retry: 1, connect: () => {
    const socket = { readyState: 1, send() {}, close() { this.readyState = 3; this.onclose?.(); } };
    sockets.push(socket); return socket;
  }, onNote: note => notes.push(note), onExpired: () => expired++ });
  live.show(true);
  sockets[0].onmessage({ data: JSON.stringify({ expired: true, error: 'Invalid preview tab' }) });
  live.show(false); live.show(true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(notes, ['Invalid preview tab']);
  assert.equal(expired, 1);
  assert.equal(sockets[0].readyState, 3);
  assert.equal(sockets.length, 1);
  live.stop();
});

test('viewFor delegates carried URLs and reload to the explicit owning computer', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const requests = [];
  let answer = { stream: true, tab: 9, url: 'http://localhost:5173/deep?x=1' };
  globalThis.fetch = async (url, options) => { requests.push([url, JSON.parse(options.body)]); return { ok: true, json: async () => answer }; };
  const target = 'https://owner.example/port/5173/deep?x=1';
  assert.deepEqual(await viewFor(target, '/peer/owner', { reload: true }), answer);
  assert.deepEqual(requests, [['/peer/owner/shown/view', { target, reload: true }]]);
  answer = { stream: false, url: 'https://desktop.tail:8443/shown/w/page.html' };
  assert.deepEqual(await viewFor('/w/page.html', ''), answer, 'no global hosted assumption');
  answer = { url: 'https://desktop.tail:8443/shown/w/page.html' };
  await assert.rejects(viewFor('/w/page.html'), /Invalid preview response/);
  globalThis.fetch = async url => {
    requests.push(url);
    return url.endsWith('/view') ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, json: async () => ({ url: 'http://desktop:5068/shown/w/page.html' }) };
  };
  assert.deepEqual(await viewFor('/w/page.html'), { stream: false, url: 'http://desktop:5068/shown/w/page.html' });
  assert.deepEqual(requests.slice(-2), ['/shown/view', '/shown/add'], 'only a missing endpoint falls back for older peers');
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'Hosted browser failed' }) });
  await assert.rejects(viewFor('/w/page.html'), /Hosted browser failed/);
});
