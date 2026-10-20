import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createGueyServer } from '../../../../system/server.mjs';
import { HandsClient } from '../../../../desktop/client/hands.mjs';
import { mcpSession } from '../mcp.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => { for (let i = 0; i < 300 && !await check(); i++) await sleep(10); assert.ok(await check(), 'condition reached'); };
async function setup(t, enabled = true, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-account-hands-'));
  const token = 'test-only-hands-token-0123456789abcdef', tokenFile = join(root, 'token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId: 's', cwd: '/tmp', messages: [], tabs: [] }), command: async () => ({}), close: async () => {} };
  const app = await createGueyServer({ stateDir: join(root, 'state'), runtime, ...(enabled ? { deviceHandsTokenFile: tokenFile } : {}), ...options });
  const { port } = await app.listen(), url = `http://127.0.0.1:${port}`, clients = [];
  t.after(async () => { for (const hands of clients) hands.close(); await app.close(); await rm(root, { force: true, recursive: true }); });
  return { app, url, root, token, client: (options = {}) => { const hands = new HandsClient({ url, token, deviceId: 'test-device', name: 'Fixture', ...options }); clients.push(hands); return hands; },
    permit: async (hands, name) => { hands.setPermission(name, true); await until(() => app.deviceHands.list()[0]?.permissions[name]); } };
}
function ask(config, method, params) { return fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); }
const toolCall = async (config, args) => (await (await ask(config, 'tools/call', { name: 'device_hands', arguments: args })).json()).result;
const request = (env, action, args = {}) => env.app.deviceHands.request(env.deviceId, { action, ...args });
async function childJob(env) {
  const pidFile = join(env.root, 'pid');
  const result = request(env, 'command', { command: `sleep 30 & echo $! > '${pidFile}'; wait` }).then(value => ({ value }), error => ({ error }));
  await until(async () => (await stat(pidFile).catch(() => null))?.size > 0);
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'recorded a real native child PID');
  return { pid, result };
}
async function dead(pid) { try { process.kill(pid, 0); return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z'; } catch { return true; } }

const ACCOUNT_DEVICE = '01234567-89ab-4cde-8fab-0123456789ab';
async function accountSetup(t) {
  let mode = 'active', overrides = {}, calls = 0, env;
  const broker = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, '/account/desktop/introspect');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers.authorization, `Bearer ${env.token}`);
    let body = ''; for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { computerId: 'fixture-computer', owner: 'fixture-owner' });
    if (mode === 'timeout') return;
    if (mode === 'outage') { res.writeHead(503).end(); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: '/never' }).end(); return; }
    res.writeHead(mode === 'revoked' ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(mode === 'oversize' ? 'x'.repeat(9000) : JSON.stringify(mode === 'revoked' ? { active: false } : {
      active: true, computerId: 'fixture-computer', owner: 'fixture-owner', computerOrigin: env.url,
      deviceId: ACCOUNT_DEVICE, expiresAt: Date.now() + 300_000, ...overrides,
    }));
  });
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  t.after(() => { broker.closeAllConnections(); broker.close(); });
  env = await setup(t, true, { deviceHandsAccount: { store: `http://127.0.0.1:${broker.address().port}`, computerId: 'fixture-computer', owner: 'fixture-owner' }, deviceHandsTestInsecure: true, deviceHandsTokenFile: '/never/read/this/private/file' });
  return { ...env, deviceId: ACCOUNT_DEVICE, mode: value => { mode = value; }, overrides: value => { overrides = value; }, calls: () => calls };
}

test('both harnesses hide device_hands without a paired device, expose it only while paired, cached calls stay guarded', async t => {
  const env = await setup(t);
  const callers = ['pi', 'claude'].map(harness => mcpSession({ cwd: () => '/tmp', session: () => harness, harness, ui: null }));
  t.after(() => callers.forEach(caller => caller.close()));
  const visible = async caller => (await (await ask(caller.config(), 'tools/list')).json()).result.tools.some(tool => tool.name === 'device_hands');
  for (const caller of callers) assert.equal(await visible(caller), false);
  const hands = env.client(); await hands.connect();
  for (const caller of callers) assert.equal(await visible(caller), true);
  hands.close(); await until(() => !env.app.deviceHands.list().length);
  for (const caller of callers) {
    assert.equal(await visible(caller), false);
    assert.equal((await toolCall(caller.config(), { action: 'command', device: 'test-device', command: 'echo no' })).isError, true);
  }
});

test('real account introspection binds registration ID, checks every action and never falls back to a file', async t => {
  const env = await accountSetup(t);
  await assert.rejects(env.client().connect(), /disconnected/);
  const hands = env.client({ deviceId: ACCOUNT_DEVICE }); await hands.connect(); await env.permit(hands, 'commands');
  const before = env.calls();
  assert.equal((await request(env, 'command', { command: 'printf introspected' })).stdout, 'introspected');
  assert.ok(env.calls() > before);
  env.mode('revoked');
  const path = join(env.root, 'must-not-execute');
  await assert.rejects(request(env, 'command', { command: `touch '${path}'` }), /authentication_lost|not_connected/);
  await until(() => !env.app.deviceHands.list().length);
  await assert.rejects(stat(path), /ENOENT/);
});

test('account upgrades refuse wrong owner/computer/expiry/UUID, redirects, oversized and unavailable introspection', async t => {
  const env = await accountSetup(t);
  for (const overrides of [{ owner: 'wrong' }, { computerId: 'wrong' }, { active: false }, { deviceId: 'wrong' }, { expiresAt: Date.now() - 1 }, { computerOrigin: 'https://user:pass@evil.test' }]) {
    env.overrides(overrides);
    await assert.rejects(env.client({ deviceId: ACCOUNT_DEVICE }).connect(), /connection_failed/);
  }
  env.overrides({});
  for (const mode of ['revoked', 'outage', 'timeout', 'redirect', 'oversize']) {
    env.mode(mode);
    await assert.rejects(env.client({ deviceId: ACCOUNT_DEVICE }).connect(), /connection_failed/);
  }
  env.mode('active');
  for (const path of ['/device-hands?x=1', '/device-hands/foo', '/pi']) {
    const status = await new Promise(resolve => {
      const ws = new WebSocket(`${env.url.replace('http:', 'ws:')}${path}`, { headers: { Authorization: `Bearer ${env.token}`, ...(path === '/pi' ? { Origin: 'https://untrusted.test' } : {}) } });
      ws.on('error', () => {});
      ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); ws.terminate(); });
    });
    assert.ok([401, 403].includes(status));
  }
});

test('periodic revocation, expiry, binding change and broker outage cancel real native child work fail-closed', async t => {
  for (const mode of ['revoked', 'outage', 'timeout', 'binding', 'expiry']) {
    await t.test(mode, async t => {
      const env = await accountSetup(t);
      if (mode === 'expiry') env.overrides({ expiresAt: Date.now() + 1500 });
      const hands = env.client({ deviceId: ACCOUNT_DEVICE }); await hands.connect(); await env.permit(hands, 'commands');
      const { pid, result } = await childJob(env);
      const start = Date.now();
      if (mode === 'binding') env.overrides({ deviceId: '11234567-89ab-4cde-8fab-0123456789ab' });
      else if (mode !== 'expiry') env.mode(mode);
      assert.match((await result).error.message, /authentication_lost|disconnected/);
      assert.ok(Date.now() - start < 2600, 'disconnect within periodic check + bounded request');
      await until(() => dead(pid));
      assert.equal(env.app.deviceHands.list().length, 0);
    });
  }
});
