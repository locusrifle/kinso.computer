import test from 'node:test';
import assert from 'node:assert/strict';
import { watchFolder } from '../public/js/files-live.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
class Source {
  static all = [];
  constructor(url) { this.url = url; this.handlers = {}; Source.all.push(this); }
  addEventListener(name, fn) { this.handlers[name] = fn; }
  emit(name, data) { this.handlers[name]?.({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}
function harness(t, refresh) {
  let timer;
  t.mock.method(globalThis, 'setInterval', fn => { timer = fn; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const statuses = [], calls = [];
  const live = watchFolder({ base: '/peer/a%20b', path: '/folder', EventSource: Source,
    status: state => statuses.push(state), refresh: async request => { calls.push(request); await refresh?.(request); } });
  t.after(() => live.stop());
  return { live, calls, statuses, source: Source.all.at(-1), poll: () => timer() };
}
test('ready requires a fresh full validation; scoped peer URL and UUID', async t => {
  const h = harness(t);
  await tick(); assert.equal(h.statuses.at(-1), 'not-live');
  const url = new URL(h.source.url, 'https://test');
  assert.equal(url.pathname, '/peer/a%20b/files/events'); assert.equal(url.searchParams.get('path'), '/folder');
  assert.match(url.searchParams.get('window'), /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  h.source.emit('ready', { path: '/folder', mode: 'watch', version: 1 });
  assert.equal(h.statuses.at(-1), 'not-live'); await tick();
  assert.equal(h.calls.length, 2); assert.equal(h.calls.at(-1).force, true); assert.equal(h.statuses.at(-1), 'live');
  h.poll(); await tick(); assert.equal(h.calls.at(-1).force, false);
});
test('changed bursts coalesce conditional requests', async t => {
  const h = harness(t); await tick(); h.source.emit('ready', { path: '/folder', mode: 'watch' }); await tick();
  const before = h.calls.length;
  for (let i = 0; i < 10; i++) h.source.emit('changed', { path: '/folder', version: i });
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.equal(h.calls.length, before + 1); assert.equal(h.calls.at(-1).force, false);
});
test('disconnect stays quiet/not-live; poll recovery never falsely live before ready', async t => {
  const h = harness(t); await tick(); h.source.emit('ready', { path: '/folder', mode: 'watch' }); await tick();
  h.source.onerror(); assert.equal(h.statuses.at(-1), 'not-live');
  h.poll(); await tick(); assert.equal(h.calls.at(-1).force, true); assert.equal(h.statuses.at(-1), 'not-live');
  h.source.emit('ready', { path: '/folder', mode: 'watch' }); await tick(); assert.equal(h.statuses.at(-1), 'live');
});
test('poll mode, failed listing, and focus full revalidation', async t => {
  let fail = false;
  const h = harness(t, () => { if (fail) throw Error('offline'); });
  await tick(); h.source.emit('ready', { path: '/folder', mode: 'poll' }); await tick(); assert.equal(h.statuses.at(-1), 'polling');
  fail = true; h.live.revalidate(); await tick(); assert.equal(h.statuses.at(-1), 'not-live');
  fail = false; h.live.revalidate(); await tick(); assert.equal(h.calls.at(-1).force, true); assert.equal(h.statuses.at(-1), 'polling');
});
test('stop aborts in-flight requests and closes source; late completion cannot paint', async t => {
  let release;
  const h = harness(t, () => new Promise(resolve => { release = resolve; }));
  const count = h.statuses.length; h.live.stop(); assert.ok(h.source.closed); assert.ok(h.calls[0].signal.aborted);
  release(); await tick(); assert.equal(h.statuses.length, count);
  h.source.emit('ready', { path: '/folder', mode: 'watch' }); h.live.revalidate(); h.poll(); await tick(); assert.equal(h.calls.length, 1);
});
test('permanently closed EventSource retries on the safety tick', async t => {
  const h = harness(t); await tick();
  h.source.readyState = 2; h.source.onerror();
  h.poll(); await tick(); assert.notEqual(Source.all.at(-1), h.source); assert.equal(h.statuses.at(-1), 'not-live');
});
test('heartbeat version mismatches refetch, and poll-mode transitions never claim live', async t => {
  const h = harness(t); await tick();
  h.source.emit('ready', { path: '/folder', mode: 'watch', version: 'v1' }); await tick();
  const before = h.calls.length;
  h.source.emit('heartbeat', { path: '/another', mode: 'watch', version: 'v2' });
  h.source.emit('heartbeat', { path: '/folder', mode: 'watch', version: 'v1' });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(h.calls.length, before, 'matching or foreign heartbeat needs no listing');
  h.source.emit('heartbeat', { path: '/folder', mode: 'watch', version: 'v2' });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(h.calls.length, before + 1); assert.equal(h.calls.at(-1).force, false);
  h.source.emit('heartbeat', { path: '/folder', mode: 'poll', version: 'v2' });
  assert.equal(h.statuses.at(-1), 'not-live'); await tick();
  assert.equal(h.calls.at(-1).force, true); assert.equal(h.statuses.at(-1), 'polling');
});
test('silent stream heartbeat deadline closes and reconnects while polling', async t => {
  let now = 100;
  t.mock.method(Date, 'now', () => now);
  const h = harness(t); await tick(); h.source.emit('ready', { path: '/folder', mode: 'watch' }); await tick();
  now += 16000; h.poll(); await tick(); assert.ok(h.source.closed); assert.notEqual(Source.all.at(-1), h.source); assert.equal(h.statuses.at(-1), 'not-live');
});
