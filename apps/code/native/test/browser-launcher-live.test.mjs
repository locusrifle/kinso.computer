import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLive as client } from '../public/js/live.js';
import { createLive as native } from '../../../../desktop/electron/live.mjs';

test('explicit live launch waits for relay handshake and targets the selected computer', () => {
  const sockets = [];
  const live = client({ connect: base => { const ws = { base, readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {} }; sockets.push(ws); return ws; } });
  live.watch('/peer/pc'); live.launch(); live.show(true);
  const ws = sockets[0]; ws.onopen();
  assert.deepEqual(ws.sent, [{ do: 'watch' }]);
  ws.onmessage({ data: JSON.stringify({ tabs: [] }) });
  assert.deepEqual(ws.sent.at(-1), { do: 'launch' });
  live.launch(); assert.equal(ws.sent.filter(s => s.do === 'launch').length, 2);
  assert.equal(ws.base, '/peer/pc'); live.stop();
});

test('live launch is explicit; watching does not launch, and navigation validates tab and URL', async () => {
  let launches = 0;
  const heard = [];
  const live = native({ tabs: () => new Map(), front: () => null, toFront() {}, launch: async () => { launches++; } });
  const watcher = live.watch({}, said => heard.push(said));
  assert.equal(launches, 0);
  await watcher.hear({ do: 'launch' }); await watcher.hear({ do: 'launch' });
  assert.equal(launches, 2);
  await watcher.hear({ do: 'navigate', tab: 9, url: 'file:///etc/passwd' });
  assert.match(heard.at(-1).error, /Use a web address/);
  await watcher.hear({ do: 'navigate', tab: 9, url: 'https://example.com/' });
  assert.match(heard.at(-1).error, /No tab is open/);
  watcher.stop();
});

test('live navigation permits exactly about:blank and web addresses, but rejects other schemes and stale tabs', async () => {
  const loaded = [], heard = [];
  const page = Object.assign(new EventEmitter(), {
    id: 1, url: 'https://example.com/', getURL() { return this.url; }, getTitle: () => 'Example', isDestroyed: () => false,
    async loadURL(url) { loaded.push(url); this.url = url; },
    debugger: Object.assign(new EventEmitter(), { isAttached: () => true, async sendCommand() {} }),
  });
  const live = native({ tabs: () => new Map([[1, page]]), front: () => 1, toFront() {} });
  const watcher = live.watch({}, said => heard.push(said));
  await live.changed();
  try {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,no', 'about:config', 'about:blank#no']) {
      await watcher.hear({ do: 'navigate', tab: 1, url });
      assert.match(heard.at(-1).error, /Use a web address/, url);
    }
    await watcher.hear({ do: 'navigate', tab: 9, url: 'https://example.com/other' });
    assert.match(heard.at(-1).error, /tab in front changed/);
    assert.deepEqual(loaded, []);
    await watcher.hear({ do: 'navigate', tab: 1, url: 'about:blank' });
    assert.deepEqual(loaded, ['about:blank']);
    assert.equal(heard.at(-1).tabs[0].url, 'about:blank', 'navigation updates chrome metadata');
    await watcher.hear({ do: 'navigate', tab: 1, url: 'https://example.com/new' });
    assert.deepEqual(loaded, ['about:blank', 'https://example.com/new']);
    assert.equal(heard.at(-1).tabs[0].url, 'https://example.com/new');
  } finally { watcher.stop(); await live.changed(); }
});
