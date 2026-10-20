import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFiles } from '../../../system/files.mjs';
import { createFileFeed } from '../../../system/file-feed.mjs';
import { createGueyServer } from '../../../system/server.mjs';
import { createTabHost } from '../native/tabs.mjs';

async function until(check, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const found = check(); if (found) return found; await sleep(10); }
  assert.fail('timed out waiting for directory event');
}
async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), 'files-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function serve(t, options) {
  const handle = createFiles(options), asked = [];
  const server = createServer(async (req, res) => {
    asked.push({ url: req.url, headers: req.headers });
    const url = new URL(req.url, 'http://x');
    if (!await handle(req, res, url.pathname, url.search)) res.writeHead(418).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { handle.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, handle, asked };
}
const listUrl = (base, path) => `${base}/files/list?${new URLSearchParams({ path })}`;
const eventsUrl = (base, path, window = randomUUID()) => `${base}/files/events?${new URLSearchParams({ path, window })}`;
async function stream(t, url, headers) {
  const stop = new AbortController();
  const response = await fetch(url, { signal: stop.signal, headers });
  assert.equal(response.status, 200, await (response.status !== 200 ? response.text() : Promise.resolve('')));
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader(), decoder = new TextDecoder(), messages = [];
  let text = '', done = false, fault = null;
  const pump = (async () => {
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        text += decoder.decode(item.value, { stream: true });
        let cut;
        while ((cut = text.indexOf('\n\n')) >= 0) {
          const block = text.slice(0, cut); text = text.slice(cut + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (name && data) messages.push({ name, data: JSON.parse(data), at: Date.now() });
        }
      }
    } catch (error) { if (!stop.signal.aborted) fault = error; }
    finally { done = true; }
  })();
  const close = async () => { stop.abort(); await pump; };
  t.after(close);
  return { messages, close, pump, fault: () => fault, done: () => done, wait: (name, from = 0) => until(() => messages.slice(from).find(event => event.name === name), name === 'heartbeat' ? 7000 : 4000) };
}
function fakeWatch() {
  const watchers = [];
  let active = 0;
  const watch = (path, options, change) => {
    assert.equal(options.recursive, false);
    const watcher = new EventEmitter();
    watcher.path = path;
    watcher.change = change;
    watcher.closed = false;
    watcher.close = () => { if (!watcher.closed) { watcher.closed = true; active--; watcher.emit('close'); } };
    watchers.push(watcher); active++;
    return watcher;
  };
  return { watch, watchers, active: () => active };
}

test('real directory create, modify, rename and delete invalidate; list ETags revalidate', async t => {
  const root = await folder(t), { base } = await serve(t);
  const initial = await fetch(listUrl(base, root));
  const emptyTag = initial.headers.get('etag');
  assert.ok(emptyTag);
  assert.deepEqual((await initial.json()).entries, []);
  const same = await fetch(listUrl(base, root), { headers: { 'if-none-match': emptyTag } });
  assert.equal(same.status, 304); assert.equal(await same.text(), '');
  const feed = await stream(t, eventsUrl(base, root));
  const ready = await feed.wait('ready');
  assert.equal(ready.data.path, root); assert.equal(ready.data.mode, 'watch');
  let tag = emptyTag, version = ready.data.version;
  const mutate = async (run, names) => {
    const from = feed.messages.length;
    await run();
    const changed = await feed.wait('changed', from);
    assert.equal(changed.data.path, root); assert.notEqual(changed.data.version, version);
    version = changed.data.version;
    const response = await fetch(listUrl(base, root), { headers: { 'if-none-match': tag } });
    assert.equal(response.status, 200);
    const next = response.headers.get('etag'); assert.notEqual(next, tag); tag = next;
    assert.deepEqual((await response.json()).entries.map(e => e.name).sort(), names);
    assert.equal((await fetch(listUrl(base, root), { headers: { 'if-none-match': `"other", W/${tag}` } })).status, 304);
  };
  await mutate(() => writeFile(join(root, 'a'), 'one'), ['a']);
  await mutate(() => writeFile(join(root, 'a'), 'longer changed contents'), ['a']);
  await mutate(() => rename(join(root, 'a'), join(root, 'b')), ['b']);
  await mutate(() => rm(join(root, 'b')), []);
  const beat = await feed.wait('heartbeat');
  assert.equal(beat.data.path, root);
  assert.ok(beat.at - ready.at >= 4500, 'production heartbeat is about five seconds');
});

test('bursts coalesce, unchanged watch listings avoid child stats, safety finds silent same-size modifications', async t => {
  const root = await folder(t), fake = fakeWatch();
  await writeFile(join(root, 'a'), 'old');
  let stats = 0;
  const { base } = await serve(t, { feedOptions: { watch: fake.watch, safetyMs: 300, heartbeatMs: 80, childStat: async path => { stats++; return stat(path); } } });
  const feed = await stream(t, eventsUrl(base, root));
  await feed.wait('ready');
  const response = await fetch(listUrl(base, root));
  let tag = response.headers.get('etag'); await response.json();
  const before = stats;
  for (let i = 0; i < 5; i++) assert.equal((await fetch(listUrl(base, root), { headers: { 'if-none-match': tag } })).status, 304);
  assert.equal(stats, before, 'recent valid watch ETag is cheap');
  const from = feed.messages.length, started = Date.now();
  for (let i = 0; i < 30; i++) fake.watchers[0].change('change', 'a');
  const changed = await feed.wait('changed', from);
  assert.ok(changed.at - started >= 120, 'the burst waits for its ~150ms debounce');
  await sleep(180);
  assert.equal(feed.messages.slice(from).filter(e => e.name === 'changed').length, 1);
  // First clear the watch invalidation, then modify without calling watch.
  await (await fetch(listUrl(base, root))).json();
  const silent = feed.messages.length;
  await writeFile(join(root, 'a'), 'new');
  await utimes(join(root, 'a'), 1000, 2000);
  await feed.wait('changed', silent);
  const modified = await fetch(listUrl(base, root), { headers: { 'if-none-match': tag } });
  assert.equal(modified.status, 200); tag = modified.headers.get('etag'); await modified.json();
  assert.equal((await fetch(listUrl(base, root), { headers: { 'if-none-match': '*' } })).status, 304);
  assert.ok(tag);
});

test('watch startup and runtime errors fall back to polling; fallback GET never uses a stale 304', async t => {
  const root = await folder(t), fake = fakeWatch();
  await writeFile(join(root, 'a'), 'x');
  const { base } = await serve(t, { feedOptions: { watch: fake.watch, pollMs: 100, heartbeatMs: 80 } });
  const feed = await stream(t, eventsUrl(base, root));
  await feed.wait('ready');
  const initial = await fetch(listUrl(base, root)), tag = initial.headers.get('etag'); await initial.json();
  const from = feed.messages.length;
  fake.watchers[0].emit('error', new Error('watch exhausted'));
  assert.equal((await feed.wait('ready', from)).data.mode, 'poll');
  await until(() => fake.active() === 0);
  await writeFile(join(root, 'a'), 'fallback modification');
  const modified = await fetch(listUrl(base, root), { headers: { 'if-none-match': tag } });
  assert.equal(modified.status, 200); await modified.json();
  const polling = feed.messages.length;
  await writeFile(join(root, 'b'), 'new child');
  await feed.wait('changed', polling);
  const failed = await serve(t, { feedOptions: { watch: () => { throw new Error('not supported'); }, pollMs: 80 } });
  const fallback = await stream(t, eventsUrl(failed.base, root));
  assert.equal((await fallback.wait('ready')).data.mode, 'poll');
  const missing = await fetch(eventsUrl(failed.base, join(root, 'missing')));
  assert.equal(missing.status, 404);
});

test('a deleted watched folder falls back without crashing and polling detects its recreation', async t => {
  const root = await folder(t), path = join(root, 'watched'), fake = fakeWatch();
  await mkdir(path); await writeFile(join(path, 'a'), 'x');
  const { base } = await serve(t, { feedOptions: { watch: fake.watch, safetyMs: 80, pollMs: 80 } });
  const feed = await stream(t, eventsUrl(base, path)); await feed.wait('ready');
  const from = feed.messages.length;
  await rm(path, { recursive: true });
  await feed.wait('changed', from);
  assert.equal((await feed.wait('ready', from)).data.mode, 'poll');
  assert.equal((await fetch(listUrl(base, path))).status, 404);
  const recovered = feed.messages.length;
  await mkdir(path); await writeFile(join(path, 'b'), 'recreated');
  await feed.wait('changed', recovered);
  const listed = await (await fetch(listUrl(base, path))).json();
  assert.deepEqual(listed.entries.map(entry => entry.name), ['b']);
});

test('a silently replaced directory switches to polling even when its empty listing ETag is unchanged', async t => {
  const root = await folder(t), fake = fakeWatch(), away = `${root}-away`;
  t.after(() => rm(away, { recursive: true, force: true }));
  const { base } = await serve(t, { feedOptions: { watch: fake.watch, safetyMs: 80, pollMs: 60 } });
  const feed = await stream(t, eventsUrl(base, root));
  assert.equal((await feed.wait('ready')).data.mode, 'watch');
  const response = await fetch(listUrl(base, root)), tag = response.headers.get('etag'); await response.json();
  const from = feed.messages.length;
  // No missing-path scan and no fake watcher event: this is the inode-loss
  // case that a watcher can otherwise continue calling live indefinitely.
  await rename(root, away); await mkdir(root);
  await until(() => feed.messages.slice(from).find(event => event.name === 'ready' && event.data.mode === 'poll'));
  assert.equal(fake.active(), 0, 'the old inode watcher is released');
  assert.equal((await fetch(listUrl(base, root), { headers: { 'if-none-match': tag } })).status, 304);
  const changed = feed.messages.length;
  await writeFile(join(root, 'replacement-file'), 'new inode');
  await feed.wait('changed', changed);
  assert.deepEqual((await (await fetch(listUrl(base, root))).json()).entries.map(entry => entry.name), ['replacement-file']);
});

test('16 unique directories per stable window; shared watchers are reference counted and released on close', async t => {
  const root = await folder(t), fake = fakeWatch(), window = randomUUID();
  const paths = Array.from({ length: 17 }, (_, i) => join(root, String(i)));
  for (const path of paths) await mkdir(path);
  const { base, handle } = await serve(t, { feedOptions: { watch: fake.watch } });
  const streams = [];
  for (const path of paths.slice(0, 16)) streams.push(await stream(t, eventsUrl(base, path, window)));
  assert.equal(fake.active(), 16);
  assert.equal((await fetch(eventsUrl(base, paths[16], window))).status, 429);
  const duplicate = await stream(t, eventsUrl(base, paths[0], window));
  assert.equal(fake.active(), 16);
  await streams[0].close();
  await sleep(40);
  assert.equal(fake.active(), 16, 'duplicate holds the watcher and window slot');
  assert.equal((await fetch(eventsUrl(base, paths[16], window))).status, 429);
  await duplicate.close(); await until(() => fake.active() === 15);
  await stream(t, eventsUrl(base, paths[16], window));
  assert.equal(fake.active(), 16);
  assert.equal((await fetch(eventsUrl(base, root, 'not-a-uuid'))).status, 400);
  handle.close();
  await until(() => fake.active() === 0);
  assert.equal((await fetch(eventsUrl(base, root))).status, 503);
});

test('global directory and stream limits also apply across windows, and slots can be reused', async t => {
  const root = await folder(t), fake = fakeWatch();
  const paths = [join(root, 'a'), join(root, 'b'), join(root, 'c')];
  for (const path of paths) await mkdir(path);
  const { base } = await serve(t, { feedOptions: { watch: fake.watch, maxDirectories: 2, maxStreams: 3 } });
  const a = await stream(t, eventsUrl(base, paths[0]));
  const b = await stream(t, eventsUrl(base, paths[1]));
  assert.equal((await fetch(eventsUrl(base, paths[2]))).status, 429);
  await stream(t, eventsUrl(base, paths[0]));
  assert.equal((await fetch(eventsUrl(base, paths[1]))).status, 429, 'stream bound counts duplicate directories');
  await b.close(); await until(() => fake.active() === 1);
  await stream(t, eventsUrl(base, paths[2]));
  await a.close();
});

test('large directory child stats have bounded concurrency; safety never descends and follows symlink metadata', async t => {
  const root = await folder(t), fake = fakeWatch();
  for (let i = 0; i < 200; i++) await writeFile(join(root, `file-${i}`), 'x');
  await mkdir(join(root, 'sub')); await writeFile(join(root, 'sub', 'nested'), 'not walked');
  await symlink(join(root, 'sub', 'nested'), join(root, 'linked'));
  let active = 0, max = 0;
  const { base } = await serve(t, { feedOptions: { watch: fake.watch, safetyMs: 400,
    childStat: async path => {
      assert.notEqual(path, join(root, 'sub', 'nested'), 'no recursive stat walk');
      max = Math.max(max, ++active);
      try { await sleep(1); return await stat(path); } finally { active--; }
    } } });
  const feed = await stream(t, eventsUrl(base, root)); await feed.wait('ready');
  const res = await fetch(listUrl(base, root)), tag = res.headers.get('etag');
  assert.equal((await res.json()).entries.length, 202);
  assert.ok(max <= 16); assert.ok(max > 1);
  const from = feed.messages.length;
  await writeFile(join(root, 'sub', 'nested'), 'symlink target changed outside the watch');
  await feed.wait('changed', from);
  assert.equal((await fetch(listUrl(base, root), { headers: { 'if-none-match': tag } })).status, 200);
});

test('a blocked SSE consumer has bounded writes and is dropped, releasing its watcher', async t => {
  const root = await folder(t), fake = fakeWatch();
  const feed = createFileFeed({ watch: fake.watch, heartbeatMs: 10, stalledMs: 80, debounceMs: 10 });
  t.after(() => feed.close());
  const res = new EventEmitter();
  let writes = 0;
  res.writeHead = () => {};
  res.write = () => { writes++; res.writableNeedDrain = true; return false; };
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  await feed.events({}, res, root, randomUUID());
  for (let i = 0; i < 100; i++) fake.watchers[0].change('change', String(i));
  await until(() => res.destroyed);
  assert.equal(writes, 1, 'only ready enters the blocked response buffer');
  assert.equal(fake.active(), 0);
});

test('overlapping safety scans coalesce rather than concurrently walking one directory', async t => {
  const root = await folder(t), fake = fakeWatch();
  await writeFile(join(root, 'a'), 'x');
  let active = 0, maximum = 0;
  const { base } = await serve(t, { feedOptions: { watch: fake.watch, safetyMs: 20, childStat: async path => {
    maximum = Math.max(maximum, ++active);
    try { await sleep(70); return await stat(path); } finally { active--; }
  } } });
  const feed = await stream(t, eventsUrl(base, root));
  await feed.wait('ready');
  await sleep(200);
  const foreground = await fetch(listUrl(base, root), { signal: AbortSignal.timeout(2000) });
  assert.equal(foreground.status, 200, 'slow periodic scans do not starve a list GET');
  await foreground.json();
  await feed.close();
  assert.equal(maximum, 1, 'a slow scan plus many timer ticks shares a single scan');
});

test('list/events reject cross-origin reads locally and through the peer streaming relay; owner change streams and 304s survive it', async t => {
  const root = await folder(t), { base: owner, asked } = await serve(t);
  const runtime = await createTabHost({
    stateDir: join(root, 'tabs'), listPiSessions: async () => [],
    createRuntime: () => ({ events: new EventEmitter(), snapshot: () => ({ sessionId: 's', cwd: '/', messages: [], busy: false, streaming: false, failed: null }), command: async () => ({ ok: true }), close: async () => {} }),
  });
  const machines = {
    self: async () => 'laptop', selfId: async () => 'node-laptop', origins: async () => [],
    list: async () => [{ id: 'node-laptop', name: 'laptop', self: true, online: true, reachable: true, protocol: 1, capabilities: ['code', 'files'] }],
    peer: async id => id === 'desktop' ? { id, name: 'desktop', url: owner, reachable: true } : null,
  };
  const app = await createGueyServer({ port: 0, stateDir: join(root, 'server'), runtime, machines, sessionToken: 'test-only' });
  let closed = false;
  t.after(() => closed ? undefined : app.close());
  const address = await app.listen(), base = `http://127.0.0.1:${address.port}`, peer = `${base}/peer/desktop`;
  for (const target of [owner, peer]) for (const site of ['same-site', 'cross-site']) {
    const before = asked.length;
    for (const url of [listUrl(target, root), eventsUrl(target, root), `${target}/files/%6cist?path=${encodeURIComponent(root)}`, `${target}/files/%65vents?path=${encodeURIComponent(root)}`]) {
      if (target === owner && url.includes('%6')) continue; // Stand-in router, unlike production, does not decode routes.
      assert.equal((await fetch(url, { headers: { 'sec-fetch-site': site } })).status, 403);
    }
    if (target === peer) assert.equal(asked.length, before, 'refused before owner receives the request');
  }
  assert.equal((await fetch(eventsUrl(base, root), { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  const local = await stream(t, eventsUrl(base, root), { 'sec-fetch-site': 'same-origin' });
  await local.wait('ready');
  const feed = await stream(t, eventsUrl(peer, root), { 'sec-fetch-site': 'same-origin' });
  assert.equal((await feed.wait('ready')).data.path, root);
  const initial = await fetch(listUrl(peer, root)), tag = initial.headers.get('etag'); await initial.json();
  const unchanged = await fetch(listUrl(peer, root), { headers: { 'if-none-match': tag } });
  assert.equal(unchanged.status, 304); assert.equal(unchanged.headers.get('etag'), tag);
  const from = feed.messages.length;
  await writeFile(join(root, 'remote-owner-file'), 'desktop contents');
  await feed.wait('changed', from);
  const response = await fetch(listUrl(peer, root), { headers: { 'if-none-match': tag } });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).entries.some(e => e.name === 'remote-owner-file'));
  const ownerRequest = asked.find(entry => entry.url.startsWith('/files/events') && !entry.headers['sec-fetch-site']);
  assert.ok(ownerRequest, 'relay strips browser-origin metadata only after enforcing its own read guard');
  // Shutdown must end a relayed SSE, rather than waiting forever in server.close.
  await app.close(); closed = true;
  await until(() => feed.done() && local.done());
});
