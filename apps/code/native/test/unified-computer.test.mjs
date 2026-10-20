import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createGueyServer } from '../../../../system/server.mjs';
import { createTabHost } from '../tabs.mjs';

function fakeRuntime(log, options = {}) {
  const events = new EventEmitter();
  const session = options.sessionPath || `new-${log.length + 1}`;
  let snap = { sessionId: session, sessionFile: session, cwd: options.cwd || '/work', messages: [], busy: false, streaming: false, failed: null };
  return {
    events,
    snapshot: () => snap,
    async command(command) {
      log.push({ session, command });
      if (command.type === 'prompt') {
        snap = { ...snap, messages: [...snap.messages, { role: 'user', content: command.text }] };
        events.emit('change');
      }
      return { ok: true };
    },
    async close() {},
  };
}

function machine(id, urls, other) {
  return {
    self: async () => id,
    selfId: async () => id,
    origins: async () => [],
    list: async () => [
      { id, name: id, url: urls[id] || '', self: true, online: true, reachable: true, protocol: 1, capabilities: ['code', 'files'] },
      { id: other, name: other, url: urls[other] || '', self: false, online: true, reachable: true, protocol: 1, capabilities: ['code', 'files'] },
    ],
    peer: async asked => asked === other ? { id: other, name: other, url: urls[other], reachable: true } : null,
  };
}

function talk(ws, command) {
  return new Promise((resolve, reject) => {
    const id = `c${Math.random()}`;
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'response' || message.id !== id) return;
      ws.off('message', onMessage);
      message.success ? resolve(message.data) : reject(new Error(message.error));
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ ...command, id }));
  });
}

async function openWs(url) {
  const ws = new WebSocket(url.replace(/^http/, 'ws') + '/pi');
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await talk(ws, { type: 'hello', kind: 'desktop' });
  return ws;
}

test('two owners attach exact sessions while viewers keep independent selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unified-two-server-'));
  const urls = {};
  const logs = { laptop: [], desktop: [] };
  const hosts = {};
  const apps = {};
  try {
    for (const [id, other] of [['laptop', 'desktop'], ['desktop', 'laptop']]) {
      const work = join(root, id, 'work');
      await mkdir(work, { recursive: true });
      hosts[id] = await createTabHost({
        cwd: work, stateDir: join(root, id),
        createRuntime: options => fakeRuntime(logs[id], options),
        createClaudeRuntime: options => fakeRuntime(logs[id], options),
        claudeAvailable: () => true, codexAvailable: () => false,
        listPiSessions: async () => [{ id: `${id}-history`, path: `${id}-history`, cwd: '/work', name: `${id} work`, modified: 10, agent: 'pi' }],
        listClaudeSessions: async () => [],
      });
      // Two live runtimes on each owner.
      await hosts[id].command({ type: 'tab-new', agent: 'claude' });
      apps[id] = await createGueyServer({
        host: '127.0.0.1', port: 0, stateDir: join(root, `${id}-server`), runtime: hosts[id],
        machines: machine(id, urls, other),
      });
      const address = await apps[id].listen();
      urls[id] = `http://127.0.0.1:${address.port}`;
    }

    const a = await openWs(urls.desktop);
    const b = await openWs(urls.desktop);
    const tabs = hosts.desktop.snapshot().tabs;
    await talk(a, { type: 'tab-focus', tabId: tabs[0].id });
    await talk(b, { type: 'tab-focus', tabId: tabs[1].id });
    await talk(a, { type: 'prompt', text: 'from viewer a', expectedSessionId: tabs[0].sessionId });
    await talk(b, { type: 'prompt', text: 'from viewer b', expectedSessionId: tabs[1].sessionId });
    assert.ok(logs.desktop.some(row => row.session === tabs[0].sessionId && row.command.text === 'from viewer a'));
    assert.ok(logs.desktop.some(row => row.session === tabs[1].sessionId && row.command.text === 'from viewer b'));
    await talk(a, { type: 'settings', key: 'thinkingLevel', value: 'high' });
    await talk(b, { type: 'settings', key: 'thinkingLevel', value: 'low' });
    assert.ok(logs.desktop.some(row => row.session === tabs[0].sessionId && row.command.type === 'settings' && row.command.value === 'high'));
    assert.ok(logs.desktop.some(row => row.session === tabs[1].sessionId && row.command.type === 'settings' && row.command.value === 'low'));

    const upload = await fetch(`${urls.desktop}/upload`, {
      method: 'POST',
      headers: { Origin: urls.desktop, 'X-Filename': 'owner.txt', 'X-Session-Id': tabs[0].sessionId },
      body: 'owned',
    });
    assert.equal(upload.status, 200);
    assert.match((await upload.json()).path, /desktop\/work\/uploads/);
    assert.equal((await fetch(`${urls.desktop}/upload`, {
      method: 'POST',
      headers: { Origin: urls.desktop, 'X-Filename': 'wrong.txt', 'X-Session-Id': 'other-owner-session' },
      body: 'no',
    })).status, 409, 'an upload is never reassigned to another selected runtime');

    // Closing one viewer neither closes nor moves either runtime.
    a.close();
    await new Promise(resolve => a.once('close', resolve));
    assert.equal(hosts.desktop.snapshot().tabs.length, 2);

    const laptopView = await openWs(urls.laptop);
    const rows = await talk(laptopView, { type: 'sessions' });
    const remote = rows.find(row => row.owner === 'desktop' && row.id === 'desktop-history');
    assert.ok(remote, 'remote history is owner-qualified');

    // The laptop reaches the desktop's agents the way it reaches its files:
    // `/peer/<id>/pi`, answered by the desktop itself, never chained.
    const peerSocket = `${urls.laptop.replace(/^http/, 'ws')}/peer/desktop/pi`;
    const through = new WebSocket(peerSocket);
    const [raw] = await once(through, 'message');
    const first = JSON.parse(String(raw));
    assert.equal(first.type, 'snapshot');
    await talk(through, { type: 'hello', kind: 'viewer' });
    await talk(through, { type: 'prompt', text: 'through the laptop', expectedSessionId: first.data.sessionId });
    assert.ok(logs.desktop.some(row => row.command.text === 'through the laptop'));
    assert.ok(!logs.laptop.some(row => row.command.text === 'through the laptop'));
    through.close();
    const refusal = path => new Promise(resolve => {
      const ws = new WebSocket(`${urls.laptop.replace(/^http/, 'ws')}${path}`);
      ws.once('unexpected-response', (request, response) => { resolve(response.statusCode); request.destroy(); });
    });
    assert.equal(await refusal('/peer/desktop/peer/laptop/pi'), 403);
    assert.equal(await refusal('/pi?owner=desktop'), 403);
    assert.equal(await refusal('/peer/elsewhere/pi'), 404);

    // A real client navigates to desktop then sends this opaque locator. The
    // owner resolves it locally; no path/body or release command crosses.
    const attached = await talk(b, { type: 'session-attach', owner: 'desktop', sessionId: remote.id, agent: remote.agent });
    assert.equal(attached.sessionId, 'desktop-history');
    await assert.rejects(talk(b, { type: 'session-attach', owner: 'laptop', sessionId: remote.id, agent: remote.agent }), /owner/);
    assert.ok(!logs.laptop.some(row => row.session === 'desktop-history'));
    // A running session is authoritative even if the archive cannot list it.
    const count = hosts.desktop.snapshot().tabs.length;
    hosts.desktop.command = new Proxy(hosts.desktop.command, { apply(target, self, args) {
      if (args[0].type === 'sessions') return Promise.reject(new Error('archive unavailable'));
      return Reflect.apply(target, self, args);
    } });
    const running = await talk(b, { type: 'session-attach', owner: 'desktop', sessionId: tabs[1].sessionId, agent: 'claude' });
    assert.equal(running.id, tabs[1].id, 'same ID in Pi must not steal a Claude attachment');
    assert.equal(hosts.desktop.snapshot().tabs.length, count);
    await assert.rejects(talk(b, { type: 'session-attach', owner: 'desktop', sessionId: 'absent', agent: 'claude' }), /not on this machine/);
    assert.equal(hosts.desktop.snapshot().tabs.length, count);

    // Losing the owner keeps only its qualified index row. The transcript was
    // never copied and the row is explicitly unavailable.
    b.close();
    await apps.desktop.close();
    delete apps.desktop;
    const offlineRows = await talk(laptopView, { type: 'sessions' });
    const offlineRemote = offlineRows.find(row => row.owner === 'desktop' && row.id === 'desktop-history');
    assert.equal(offlineRemote?.offline, true);

    laptopView.close();
  } finally {
    for (const app of Object.values(apps)) await app.close().catch(() => {});
    // createGueyServer closes the provided host; only close hosts that were not
    // handed to a server after a partial setup failure.
    for (const [id, host] of Object.entries(hosts)) if (!apps[id]) await host.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('offline owners remain listed and proxy requests fail instead of rerouting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unified-offline-'));
  const runtime = await createTabHost({ stateDir: join(root, 'tabs'), createRuntime: options => fakeRuntime([], options), listPiSessions: async () => [] });
  const machines = {
    self: async () => 'laptop', selfId: async () => 'node-laptop', origins: async () => [],
    list: async () => [
      { id: 'node-laptop', name: 'laptop', self: true, online: true, reachable: true, protocol: 1, capabilities: ['code', 'files'] },
      { id: 'node-desktop', name: 'desktop', self: false, online: false, reachable: false, protocol: null, capabilities: [] },
    ],
    peer: async () => null,
  };
  const app = await createGueyServer({ host: '127.0.0.1', port: 0, stateDir: join(root, 'server'), runtime, machines });
  try {
    const address = await app.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const inventory = await (await fetch(`${base}/machines.json`)).json();
    assert.equal(inventory.machines.find(row => row.id === 'node-desktop').reachable, false);
    const proxied = await fetch(`${base}/peer/node-desktop/files/list`);
    assert.equal(proxied.status, 404);
    assert.match(await proxied.text(), /not reachable/);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
