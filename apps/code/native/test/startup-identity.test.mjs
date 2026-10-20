import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startupIdentity } from '../../../../system/startup-identity.mjs';
import { createGueyServer } from '../../../../system/server.mjs';
import { solitaryMachines } from '../../../../system/machines.mjs';

const authority = { id: 'ng6iZuhwg721CNTRL' };
for (const id of [authority.id, 'known-follower']) {
  test(`transient missing startup identity resolves correct role: ${id}`, async () => {
    let calls = 0;
    const machines = { selfId: async () => calls ? id : null };
    const selfId = await startupIdentity({ machines, authority, timeoutMs: 100, retryMs: 1,
      status: async () => ++calls === 1 ? null : { Self: { ID: id, Online: false } } });
    assert.equal(calls, 2);
    assert.equal(selfId, id);
  });
}

test('verified stable ID wins; hostname-only status is not identity', async () => {
  const machines = { selfId: async () => authority.id };
  assert.equal(await startupIdentity({ machines, authority,
    status: async () => ({ Self: { StableID: 'stable', ID: 'legacy' } }) }), 'stable');
  await assert.rejects(startupIdentity({ machines, authority, timeoutMs: 10, retryMs: 1,
    status: async () => ({ Self: { DNSName: 'desktop.example' } }) }), /startup refused/);
});

test('unavailable or stuck identity fails before ownership, providers or publication', async () => {
  for (const status of [async () => null, () => new Promise(() => {})]) {
    const root = await mkdtemp(join(tmpdir(), 'startup-identity-'));
    try {
      let providerAccess = 0;
      const options = { stateDir: root, authority,
        machines: { selfId: async () => 'desktop', peer: async () => { throw new Error('must not propose'); } },
        identityOptions: { status, timeoutMs: 10, retryMs: 1 },
        get runtime() { providerAccess++; throw new Error('must not start provider'); } };
      await assert.rejects(createGueyServer(options), /startup refused/);
      assert.equal(providerAccess, 0);
      assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('hosted computer retains its identity but an explicit PC authority never silently becomes self', async () => {
  const selfId = await startupIdentity({ machines: { selfId: async () => 'noah' }, authority, hosted: true,
    status: () => { throw new Error('hosted machines have no tailnet'); } });
  assert.equal(selfId, 'noah');
  const root = await mkdtemp(join(tmpdir(), 'hosted-follower-'));
  let app;
  try {
    app = await createGueyServer({ stateDir: root, authority, hosted: true,
      identityOptions: { status: () => { throw new Error('must not query'); }, timeoutMs: 10, retryMs: 1 } });
    const at = await app.listen();
    const res = await fetch(`http://127.0.0.1:${at.port}/health`);
    assert.equal(res.status, 200);
    const { machines } = await fetch(`http://127.0.0.1:${at.port}/machines.json`).then(res => res.json());
    assert.equal(machines.find(machine => machine.self)?.home, false, 'an explicit unavailable authority does not silently become the hosted computer');
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});

test('hosted solitary inventory identifies its own home without an authority or Tailscale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'solitary-home-'));
  let app;
  try {
    app = await createGueyServer({ stateDir: root, hosted: true, machines: solitaryMachines('fixture-host'),
      identityOptions: { status: () => { throw new Error('must not query Tailscale'); } } });
    const at = await app.listen();
    const { authority, machines } = await fetch(`http://127.0.0.1:${at.port}/machines.json`).then(res => res.json());
    assert.equal(authority, '');
    assert.equal(machines.length, 1);
    assert.equal(machines[0].id, 'fixture-host');
    assert.equal(machines[0].self, true);
    assert.equal(machines[0].home, true);
    assert.ok(machines[0].capabilities.includes('files'));
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});

test('unenrolled local mode does not wait for Tailscale', async () => {
  const selfId = await startupIdentity({ machines: { selfId: async () => 'local' },
    status: () => { throw new Error('must not query'); } });
  assert.equal(selfId, 'local');
});
