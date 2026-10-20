import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMachines, solitaryMachines } from '../../../../system/machines.mjs';
import { createGueyServer } from '../../../../system/server.mjs';

const node = id => ({ ID: id, DNSName: `${id}.example.ts.net.`, Online: true, OS: 'linux' });
test('reachable peers carry only a strict hosted health flag, not authority/home guesses', async () => {
  const machines = createMachines({
    status: async () => ({ Self: node('local'), Peer: { cloud: node('cloud'), legacy: node('legacy'), invalid: node('invalid') } }),
    fetchImpl: async url => ({ ok: true, json: async () => ({ protocol: 1, hosted: url.includes('cloud.') ? true : url.includes('invalid.') ? 'true' : undefined, capabilities: ['code', 'files'] }) }),
  });
  const rows = await machines.list();
  assert.equal(rows.find(row => row.id === 'local').hosted, false);
  assert.equal(rows.find(row => row.id === 'cloud').hosted, true);
  assert.equal(rows.find(row => row.id === 'legacy').hosted, false);
  assert.equal(rows.find(row => row.id === 'invalid').hosted, false);
  assert.equal((await machines.peer('cloud')).hosted, true);
});

for (const hosted of [false, true]) test(`the self inventory and health identify ${hosted ? 'cloud' : 'local'} independently of home`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'machine-kind-'));
  const runtime = { events: new EventEmitter(), snapshot: () => ({ tabs: [], messages: [], cwd: root, sessionId: 'fixture', failed: null }), command: async () => ({}), close: async () => {} };
  const app = await createGueyServer({ host: '127.0.0.1', port: 0, stateDir: root, runtime, hosted, machines: solitaryMachines('owner') });
  await app.listen(); t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await (await fetch(base + '/health')).json()).hosted, hosted);
  const inventory = await (await fetch(base + '/machines.json')).json();
  assert.equal(inventory.machines[0].hosted, hosted);
  assert.equal(inventory.machines[0].self, true);
});
