import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLive } from '../../../../desktop/electron/live.mjs';
import { createLive as client } from '../public/js/live.js';

function page(id) {
  return Object.assign(new EventEmitter(), {
    id, url: 'about:blank', loading: false, destroyed: false,
    getTitle: () => '', getURL() { return this.url; }, isDestroyed() { return this.destroyed; }, isLoading() { return this.loading; }, reload() {},
    debugger: Object.assign(new EventEmitter(), { commands: [], isAttached: () => true, async sendCommand(method) { this.commands.push(method); } }),
  });
}
function fixture(t, options = {}) {
  const one = page(1), two = page(2), tabs = new Map([[1, one], [2, two]]);
  let front = 1, made = 2;
  const closed = [], heard = [];
  const live = createLive({ tabs: () => tabs, front: () => front, toFront: id => { front = id; },
    create: async () => { const fresh = page(++made); tabs.set(fresh.id, fresh); front = fresh.id; },
    close: async id => { closed.push(id); tabs.delete(id); if (front === id) front = tabs.keys().next().value ?? null; },
    ...options,
  });
  live.observe(one); live.observe(two);
  const watcher = live.watch({}, said => heard.push(said));
  t.after(async () => { watcher.stop(); for (const tab of tabs.values()) tab.emit('destroyed'); await live.changed(); });
  return { one, two, tabs, live, watcher, heard, closed, front: () => front };
}

test('portal can close background and front tabs, rejects stale ids, and new never reuses a blank tab', async t => {
  const { tabs, live, watcher, heard, closed, front } = fixture(t);
  await watcher.hear({ do: 'close', tab: 2 });
  assert.deepEqual(closed, [2]); assert.equal(front(), 1);
  await watcher.hear({ do: 'close', tab: 2 });
  assert.match(heard.at(-1).error, /closed/); assert.deepEqual(closed, [2]);
  for (const tab of [undefined, null, 0, -1, 1.5, true, false, '1', [], [1], {}, 'no', Number.MAX_SAFE_INTEGER + 1]) {
    await watcher.hear({ do: 'close', tab }); assert.match(heard.at(-1).error, /closed/);
  }
  await watcher.hear({ do: 'new' }); await watcher.hear({ do: 'new' });
  assert.equal(tabs.size, 3); assert.equal(front(), 4);
  assert.ok([...tabs.values()].every(tab => tab.getURL() === 'about:blank'));
  await watcher.hear({ do: 'close', tab: 4 }); assert.equal(front(), 1);
  await watcher.hear({ do: 'close', tab: 1 }); await watcher.hear({ do: 'close', tab: 3 });
  assert.equal(tabs.size, 0);
  await watcher.hear({ do: 'new' }); assert.equal(tabs.size, 1); assert.equal(front(), 5);
  await live.changed();
  assert.equal(heard.filter(said => said.tabs).at(-1).tabs[0].tab, 5);
});

test('fixed watches cannot create or close any tab, even their own, or claim a size with those actions', async t => {
  const fits = [];
  const { one, two, live, tabs, closed, front } = fixture(t, { fit: async (page, size) => fits.push([page.id, size]) });
  const heard = [];
  const fixed = live.watch({ tab: two.id }, said => heard.push(said));
  t.after(() => fixed.stop()); await live.changed();
  for (const action of ['new', 'close']) for (const tab of [undefined, one.id, two.id]) {
    await fixed.hear({ do: action, tab, size: { width: 300, height: 600, scale: 2 } });
    assert.match(heard.at(-1).error, /fixed watch cannot create or close/);
  }
  await fixed.hear({ do: 'reload', tab: two.id });
  assert.deepEqual(fits, [], 'rejected sizes cannot leak into a later valid input');
  assert.equal(tabs.size, 2); assert.deepEqual(closed, []); assert.equal(front(), 1);
});

test('favicon, loading and driving updates reach watchers without restarting a cast; driving expires and destruction clears timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { one, two, live, heard } = fixture(t);
  await live.changed();
  const latest = id => heard.filter(said => said.tabs).at(-1).tabs.find(tab => tab.tab === id);
  two.emit('page-favicon-updated', {}, ['https://example.com/icon.png']);
  two.loading = true; two.emit('did-start-loading'); live.driving(two);
  await live.changed();
  assert.equal(latest(2).favicon, 'https://example.com/icon.png');
  assert.equal(latest(2).loading, true); assert.equal(latest(2).driving, true);
  assert.equal(latest(1).driving, false);
  live.observe(two); assert.equal(two.listenerCount('page-favicon-updated'), 1, 'observe is idempotent');
  assert.deepEqual(one.debugger.commands, ['Page.startScreencast'], 'metadata changes do not restart the portal cast');
  assert.deepEqual(two.debugger.commands, [], 'background metadata does not start a cast');
  t.mock.timers.tick(3000); live.driving(two); await live.changed();
  t.mock.timers.tick(3999); await live.changed(); assert.equal(latest(2).driving, true);
  t.mock.timers.tick(1); await live.changed(); assert.equal(latest(2).driving, false);
  two.loading = false; two.emit('did-stop-loading'); two.emit('did-navigate');
  await live.changed(); assert.equal(latest(2).loading, false); assert.equal(latest(2).favicon, '');
  live.driving(one); one.destroyed = true; one.emit('destroyed'); await live.changed();
  t.mock.timers.tick(4000); await live.changed();
  assert.equal(latest(1), undefined);
});

test('fixed live clients drop tab lifecycle commands; portal clients send new and background close without queueing', () => {
  for (const tab of [null, 2]) {
    const ws = { readyState: 1, sent: [], send(text) { this.sent.push(JSON.parse(text)); }, close() {} };
    const live = client({ connect: () => ws, tab }); live.show(true); ws.onopen();
    live.send({ do: 'new' }); live.send({ do: 'close', tab: 1 }); live.send({ do: 'close', tab: 2 });
    assert.deepEqual(ws.sent, tab == null ? [{ do: 'watch' }, { do: 'new' }, { do: 'close', tab: 1 }, { do: 'close', tab: 2 }] : [{ do: 'watch', tab: 2 }]);
    live.stop();
  }
});
