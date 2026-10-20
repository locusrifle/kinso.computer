import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { WebSocket } from 'ws';
import { createGueyServer } from '../../../../system/server.mjs';
import { createTabHost } from '../tabs.mjs';
import { readUsageHistory } from '../usage-history.mjs';
import { createOwnerTransport } from '../public/js/owner-transport.js';
import { usageOwner } from '../public/js/usage-owner.js';

const inventory = [{ id: 'laptop', self: true }, { id: 'pc', home: true, reachable: false }];
test('usage chooses the configured authority, never whichever owner is reachable', () => {
  assert.equal(usageOwner(inventory, 'pc'), 'pc');
  assert.equal(usageOwner(inventory, 'pc', true), 'laptop');
  assert.equal(usageOwner(inventory, ''), 'pc');
  assert.equal(usageOwner([inventory[0]], ''), 'laptop');
});

test('real server inventory and authenticated owner transport route PC aggregates, limits and resets; outage never routes locally', async t => {
  const root = await mkdtemp(join(tmpdir(), 'usage-owner-'));
  const apps = {}, urls = {}, calls = [];
  let online = true;
  const transports = [];
  t.after(async () => { for (const transport of transports) transport.close(); for (const app of Object.values(apps)) await app.close(); await rm(root, { recursive: true, force: true }); });
  const pcHome = join(root, 'pc-home'), agentDir = join(pcHome, '.pi/agent'), sessionDir = join(pcHome, 'sessions'), memoryDir = join(pcHome, 'memory');
  await mkdir(sessionDir, { recursive: true });
  await mkdir(join(memoryDir, 'raw/laptop/pi'), { recursive: true });
  const row = id => JSON.stringify({ type: 'message', id, timestamp: '2026-10-11T00:00:00Z', message: { role: 'assistant', provider: 'fixture', model: 'rated', content: 'PRIVATE TRANSCRIPT NEVER SENT', usage: { input: 100, output: 10 } } });
  await writeFile(join(sessionDir, 'pc.jsonl'), row('pc-response') + '\n');
  await writeFile(join(memoryDir, 'raw/laptop/pi/old.jsonl.gz'), gzipSync(row('laptop-response') + '\n'));
  for (const id of ['pc', 'laptop', 'renter', 'hosted-member']) {
    const authority = ['laptop', 'hosted-member'].includes(id) ? { id: 'pc', name: 'PC' } : {};
    const runtime = { events: new EventEmitter(), snapshot: () => ({ messages: [], tabs: [] }), close: async () => {}, command: async c => {
      calls.push([id, c]);
      if (c.type === 'usage-history') return id === 'pc' ? readUsageHistory({ home: pcHome, agentDir, sessionDir, memoryDir, thisComputerOnly: c.thisComputerOnly, owner: 'pc', cacheFile: join(pcHome, c.thisComputerOnly ? 'cache-local.json' : 'cache.json'), models: [], now: Date.parse('2026-10-11T12:00:00Z') }) : { owner: id, responses: 0 };
      if (c.type === 'usage') return [{ agent: 'pi', signedIn: true, accountId: `${id}-account`, windows: [] }];
      if (c.type === 'codex-reset-consume') return { outcome: 'reset' };
      return {};
    } };
    const machines = { self: async () => id, selfId: async () => id, origins: async () => [], published: async () => '', list: async () => [{ id, name: id, self: true, reachable: true }, ...(authority.id ? [{ id: 'pc', name: 'PC', reachable: online }] : [])], peer: async asked => asked === 'pc' && online ? { id: 'pc', name: 'PC', url: urls.pc } : null };
    apps[id] = await createGueyServer({ runtime, machines, authority, hosted: id.startsWith('hosted') || id === 'renter', stateDir: join(root, id), sessionToken: `${id}-fixture`, identityOptions: { status: async () => ({ Self: { StableID: id } }) } });
    urls[id] = `http://127.0.0.1:${(await apps[id].listen()).port}`;
  }
  async function connect(base, owner, selfId) {
    const transport = createOwnerTransport({ base, owner, selfId, WebSocketImpl: WebSocket, connectTimeoutMs: 2000, timeoutMs: 2000 }); transports.push(transport);
    const ws = transport.connect(); await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    return transport;
  }
  for (const viewer of ['laptop', 'hosted-member', 'renter']) {
    const data = await (await fetch(`${urls[viewer]}/machines.json`)).json();
    const owner = usageOwner(data.machines, data.authority);
    assert.equal(owner, viewer === 'renter' ? 'renter' : 'pc');
    const transport = await connect(urls[viewer], owner, viewer);
    const history = await transport.command('usage-history');
    if (owner === 'pc') { assert.equal(history.responses, 2); assert.deepEqual(history.devices.map(d => d.key), ['laptop', 'pc']); assert.doesNotMatch(JSON.stringify(history), /PRIVATE|pc-response|jsonl/); }
    assert.equal((await transport.command('usage'))[0].accountId, `${owner}-account`);
    assert.deepEqual(await transport.command('codex-reset-consume', { scope: 'computer', accountId: `${owner}-account`, creditId: 'fixture', operationId: 'fixture-intent', confirmed: true }), { outcome: 'reset' });
    transport.close();
  }
  const pc = await connect(urls.laptop, 'pc', 'laptop');
  assert.equal((await pc.command('usage-history', { thisComputerOnly: true })).responses, 1);
  pc.close(); online = false;
  const offline = await (await fetch(`${urls.laptop}/machines.json`)).json();
  assert.equal(usageOwner(offline.machines, offline.authority), 'pc');
  const ws = new WebSocket(urls.laptop.replace('http:', 'ws:') + '/peer/pc/pi');
  await new Promise(resolve => { ws.once('error', resolve); }); ws.terminate();
  assert.equal(calls.filter(([owner, c]) => owner === 'laptop' && c.type.startsWith('usage')).length, 0);
  assert.equal((await fetch(`${urls.laptop}/machines.json`, { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
});

test('computer-scoped reset reaches Pi with no tab, without relaxing legacy session fences', async () => {
  const calls = [];
  const runtime = { events: new EventEmitter(), snapshot: () => ({ messages: [] }), command: async c => { calls.push(c); return { outcome: 'reset' }; }, close: async () => {} };
  const host = await createTabHost({ createRuntime: async () => runtime, firstTab: null, checkUpdates: false });
  try {
    const c = { type: 'codex-reset-consume', scope: 'computer', accountId: 'fixture', creditId: 'credit', operationId: 'intent', confirmed: true };
    await host.command(c);
    assert.equal(calls.at(-1), c);
    await assert.rejects(host.command({ ...c, scope: undefined }), /Session changed/);
  } finally { await host.close(); }
});
