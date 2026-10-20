import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShown } from '../../../../system/shown.mjs';
import { loadTabs, saveTabs } from '../public/js/workbench-tabs.js';

test('preview persistence keeps owner and stable app identity, never executable URLs or transient ports', () => {
  const tabs = [{ owner: 'peer', path: '/fixture', file: null, app: { project: 'Dacre', url: 'javascript:bad' } }, { owner: '', path: '/fixture', app: { service: { cwd: '/fixture', name: 'dev', rest: '/game?level=2' }, port: 5173 } }];
  const saved = saveTabs(tabs, 1);
  assert.ok(!saved.includes('5173') && !saved.includes('javascript'));
  assert.deepEqual(loadTabs(saved).tabs.map(tab => tab.app), [{ project: 'Dacre' }, { service: { cwd: '/fixture', name: 'dev', rest: '/game?level=2' } }]);
  assert.equal(loadTabs(saveTabs([{ owner: '', path: '/', app: { service: { cwd: '/fixture', name: 'dev', rest: '//evil.test/' } } }], 0)).tabs[0].app, undefined);
});

test('owned preview resolution and HTTP/websocket proxy never carry host credentials or expose an API origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preview-security-'));
  const seen = [];
  const app = createServer((req, res) => { seen.push(req.headers); res.setHeader('set-cookie', 'fixture=synthetic'); res.end('app'); });
  const wss = new WebSocketServer({ server: app });
  wss.on('connection', (socket, req) => { seen.push(req.headers); socket.send('ok'); });
  await new Promise(done => app.listen(0, '127.0.0.1', done));
  const port = app.address().port;
  let services = [{ running: true, cwd: '/fixture', name: 'dev', url: `http://localhost:${port}/` }];
  const shown = createShown({ stateDir: dir, servers: () => ({ list: () => services }) });
  await shown.listen();
  const control = createServer(async (req, res) => { if (!await shown.handle(req, res, new URL(req.url, 'http://fixture').pathname)) { res.statusCode = 404; res.end(); } });
  await new Promise(done => control.listen(0, '127.0.0.1', done));
  const at = `http://127.0.0.1:${control.address().port}`;
  const resolve = body => fetch(`${at}/shown/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const resolved = await (await resolve({ target: `http://localhost:${port}/game` })).json();
    assert.equal(resolved.local, true);
    assert.deepEqual(resolved.service, { cwd: '/fixture', name: 'dev', rest: '/game' });
    assert.notEqual(new URL(resolved.url).origin, at);
    assert.deepEqual(await (await resolve({ target: `https://external.invalid/port/${port}/` })).json(), { local: false });
    assert.equal((await resolve({ target: at })).status, 503, 'host API is not a registered app');
    assert.equal((await resolve({ service: { cwd: '/fixture', name: 'dev', rest: '//external.invalid/' } })).status, 503);
    const result = await fetch(resolved.url, { headers: { cookie: 'host=synthetic', authorization: 'Bearer synthetic-fixture' } });
    assert.equal(result.headers.get('set-cookie'), null);
    assert.match(result.headers.get('content-security-policy'), /sandbox/);
    assert.equal(await result.text(), 'app');
    const status = await fetch(resolved.url, { method: 'HEAD' });
    assert.equal(status.headers.get('access-control-allow-origin'), '*');
    const socket = new WebSocket(resolved.url.replace(/^http/, 'ws'), { headers: { cookie: 'host=synthetic', authorization: 'Bearer synthetic-fixture' } });
    await new Promise((done, reject) => { socket.once('message', data => { assert.equal(String(data), 'ok'); socket.close(); done(); }); socket.once('error', reject); });
    for (const headers of seen) { assert.equal(headers.cookie, undefined); assert.equal(headers.authorization, undefined); }
    services = [{ ...services[0], running: false }];
    assert.equal((await resolve({ service: resolved.service })).status, 503);
    assert.equal((await fetch(resolved.url)).status, 404, 'a disappeared service cannot leak a port occupant');
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await shown.close(); await new Promise(done => control.close(done)); await new Promise(done => wss.close(done)); await new Promise(done => app.close(done)); await rm(dir, { recursive: true, force: true });
  }
});
