import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createGueyServer } from '../../../system/server.mjs';
import { createTabHost } from '../native/tabs.mjs';
import { solitaryMachines } from '../../../system/machines.mjs';

async function app(t, name, machines = solitaryMachines(name)) {
  const root = await mkdtemp(join(tmpdir(), 'attachment-routing-'));
  const prompts = [];
  const runtime = { events: new EventEmitter(), snapshot: () => ({ cwd: root, sessionId: 'colliding-session', busy: false, messages: [] }),
    command: async c => { if (c.type === 'prompt') prompts.push(c); return { accepted: true }; }, close: async () => {} };
  const host = await createTabHost({ sessionToken: `fixture-only-${name}`, createRuntime: () => runtime });
  const server = await createGueyServer({ port: 0, stateDir: join(root, 'state'), runtime: host, machines, sessionToken: `fixture-only-${name}` });
  const address = await server.listen();
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { root, prompts, host, base: `http://127.0.0.1:${address.port}` };
}

// Two actual HTTP servers, same tab/session ids: no route can silently fall
// back to the serving computer, and references cannot be restamped for it.
test('remote uploads land only at the captured execution owner; reference routes retain origin and ownership checks', async t => {
  const remote = await app(t, 'remote');
  const machines = { ...solitaryMachines('serving'), peer: async id => id === 'remote' ? { id, name: 'remote', url: remote.base } : null };
  const local = await app(t, 'serving', machines);
  const upload = (path, origin = local.base, extra = {}) => fetch(`${local.base}${path}`, { method: 'POST', headers: {
    ...(origin ? { origin } : {}), 'x-tab-id': 't1', 'x-session-id': 'colliding-session', 'x-filename': 'note.txt', ...extra,
  }, body: 'original audio or file bytes' });
  for (const origin of [null, 'https://foreign.example']) {
    assert.equal((await upload('/peer/remote/upload', origin)).status, 403);
  }
  assert.equal((await upload('/peer/missing/upload')).status, 404);
  assert.equal((await upload('/peer/remote/peer/serving/upload')).status, 400);
  const response = await upload('/peer/remote/upload');
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.ok(saved.path.startsWith(join(remote.root, 'uploads') + '/'));
  assert.equal(await readFile(saved.path, 'utf8'), 'original audio or file bytes');
  assert.deepEqual(await readdir(join(local.root, 'uploads')).catch(() => []), []);
  const command = { type: 'prompt', text: 'read', attachments: [{ kind: 'file', reference: saved.reference }] };
  await assert.rejects(local.host.command(command, 't1'), /seal does not match/);
  assert.deepEqual(local.prompts, []);
  await remote.host.command(command, 't1');
  assert.match(remote.prompts[0].text, /uploaded file:/);
  assert.deepEqual(remote.prompts[0].images, []);

  // These JSON endpoints must open only uploads belonging to their own
  // captured session; arbitrary paths and altered identities never reach ASR.
  for (const action of ['dictate', 'transcribe']) {
    const use = (prefix, audio, origin = local.base) => fetch(`${local.base}${prefix}/${action}`, { method: 'POST',
      headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json' },
      body: JSON.stringify({ tab: 't1', session: 'colliding-session', audio }) });
    assert.equal((await use('/peer/remote', saved.reference, null)).status, 403);
    assert.equal((await use('', saved.reference)).status, 409, 'foreign owner reference rejected locally');
    assert.equal((await use('/peer/remote', { ...saved.reference, name: '/etc/passwd' })).status, 400);
    assert.equal((await use('/peer/remote', { ...saved.reference, sessionId: 'forged' })).status, 409);
    const old = await fetch(`${local.base}/peer/remote/${action}`, { method: 'POST', headers: { origin: local.base }, body: new FormData() });
    assert.equal(old.status, 400, 'superseded multipart/raw endpoint is not accepted');
  }
});

test('closing a captured tab while its attachment is being prepared never sends to another chat', async t => {
  const owner = await app(t, 'owner');
  const response = await fetch(`${owner.base}/upload`, { method: 'POST', headers: {
    origin: owner.base, 'x-session-id': 'colliding-session', 'x-filename': 'plan.txt',
  }, body: 'plan' });
  const { reference } = await response.json();
  const sending = owner.host.command({ type: 'prompt', attachments: [{ kind: 'file', reference }] }, 't1');
  const rejected = assert.rejects(sending, /Session changed while preparing attachments/);
  await owner.host.command({ type: 'tab-close', tabId: 't1' });
  await rejected;
  assert.deepEqual(owner.prompts, []);
});
