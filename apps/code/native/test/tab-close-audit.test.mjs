import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createTabHost } from '../tabs.mjs';
import { createGueyServer } from '../../../../system/server.mjs';
import { solitaryMachines } from '../../../../system/machines.mjs';
import { appendCloseAudit, closeAuditRecord, CLOSE_AUDIT_LIMIT } from '../tab-close-audit.mjs';

const secret = 'fixture-private-prompt-tool-token-header';
const fake = () => ({ events: new EventEmitter(), snapshot: () => ({ sessionId: 'saved', busy: true, messages: [{ role: 'user', content: secret }] }),
  async command() {}, async close() {} });
const records = async root => (await readFile(join(root, 'tab-close.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
async function socket(url, options) {
  const ws = new WebSocket(url, options);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let n = 0;
  return { ws, send(command) {
    const id = String(++n);
    return new Promise(resolve => {
      const on = raw => { const message = JSON.parse(raw); if (message.type === 'response' && message.id === id) { ws.off('message', on); resolve(message); } };
      ws.on('message', on); ws.send(JSON.stringify({ ...command, id }));
    });
  } };
}

test('owner audits rejected/accepted closes from local, viewer, phone and a real peer proxy without private text', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'close-audit-owner-'));
  let owner, relay;
  const sockets = [];
  try {
    const host = await createTabHost({ stateDir: join(root, 'owner'), createRuntime: fake });
    owner = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'owner'), runtime: host });
    const address = await owner.listen(), url = `ws://127.0.0.1:${address.port}/pi`;
    const peerHost = await createTabHost({ firstTab: null });
    relay = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'relay'), runtime: peerHost,
      machines: { ...solitaryMachines('laptop'), peer: async id => id === 'owner' ? { url: `http://127.0.0.1:${address.port}` } : null } });
    const relayAddress = await relay.listen();
    for (const [kind, hello, target] of [
      ['local', null, url], ['viewer', { kind: 'viewer', machine: 'browser' }, url],
      ['phone', { kind: 'phone', machine: 'phone' }, url],
      ['peer', { kind: 'viewer', machine: 'laptop' }, `ws://127.0.0.1:${relayAddress.port}/peer/owner/pi`],
    ]) {
      const client = await socket(target); sockets.push(client.ws);
      if (hello) assert.equal((await client.send({ type: 'hello', ...hello })).success, true);
      // Server rejects busy/stale before runtime dispatch; host rejects unknown,
      // fenced and wrong host identities itself. Every request appears once.
      assert.equal((await client.send({ type: 'tab-close', tabId: 't1', gesture: 'key', text: secret, authorization: secret })).success, false);
      assert.equal((await client.send({ type: 'tab-close', tabId: 't1', expectedSessionId: 'wrong', gesture: 'swipe', closeConfirmed: true })).success, false);
      assert.equal((await client.send({ type: 'tab-close', tabId: 'missing', gesture: secret, closeConfirmed: true })).success, false);
      assert.equal((await client.send({ type: 'tab-close', tabId: 't1', expectedInstanceId: 'old', closeConfirmed: true })).success, false);
      host.requestQuiesce();
      assert.equal((await client.send({ type: 'tab-close', tabId: 't1', closeConfirmed: true })).success, false);
      await host.resumeDelivery();
      const rows = await records(join(root, 'owner'));
      assert.equal(rows.length, (sockets.length) * 5);
      assert.deepEqual(rows.slice(-5).map(r => r.accepted), Array(5).fill(false));
      assert.ok(rows.slice(-5).every(r => r.connection.kind === kind));
      assert.equal(rows.at(-1).connection.machine, hello?.machine ?? null);
      assert.equal(rows.at(-5).sessionId, 'saved');
      assert.equal(rows.at(-5).agent, 'pi');
      assert.equal(rows.at(-5).busy, true);
      assert.equal(rows.at(-5).gesture, 'key');
      assert.equal(rows.at(-3).gesture, 'tool', 'unrecognized gesture is never logged');
    }
    const client = await socket(`ws://127.0.0.1:${relayAddress.port}/peer/owner/pi`); sockets.push(client.ws);
    await client.send({ type: 'hello', kind: 'viewer', machine: 'laptop' });
    assert.equal((await client.send({ type: 'tab-close', tabId: 't1', gesture: 'sidebar-x', closeConfirmed: true })).success, true);
    const rows = await records(join(root, 'owner'));
    assert.equal(rows.length, 21);
    assert.equal(rows.at(-1).accepted, true);
    assert.equal(rows.at(-1).gesture, 'sidebar-x');
    assert.equal(rows.at(-1).closeConfirmed, true);
    assert.deepEqual(rows.at(-1).connection, { kind: 'peer', machine: 'laptop' });
    assert.deepEqual(host.snapshot().tabs, []);
    assert.equal(JSON.parse(await readFile(join(root, 'owner/open-tabs.json'), 'utf8')).length, 0);
    assert.equal((await stat(join(root, 'owner/tab-close.jsonl'))).mode & 0o077, 0);
    assert.ok(!(await readFile(join(root, 'owner/tab-close.jsonl'), 'utf8')).includes(secret));
    await assert.rejects(readFile(join(root, 'relay/tab-close.jsonl')), { code: 'ENOENT' });
  } finally {
    for (const ws of sockets) ws.terminate();
    await relay?.close(); await owner?.close(); await rm(root, { recursive: true, force: true });
  }
});

test('empty-tab model replacement records its reason and the requesting connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'close-audit-model-'));
  const empty = () => ({ events: new EventEmitter(), snapshot: () => ({ sessionId: 'empty', busy: false, messages: [] }), async command() {}, async close() {} });
  const host = await createTabHost({ stateDir: root, createRuntime: empty, createClaudeRuntime: empty, claudeAvailable: () => true });
  try {
    await host.command({ type: 'model', provider: 'claude-agent', modelId: 'opus' }, 't1', { connection: { kind: 'peer', machine: 'laptop' } });
    const rows = await records(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].gesture, 'model-switch-empty');
    assert.equal(rows[0].accepted, true);
    assert.equal(rows[0].busy, false);
    assert.equal(rows[0].agent, 'pi');
    assert.deepEqual(rows[0].connection, { kind: 'peer', machine: 'laptop' });
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('close audit stays bounded and preserves complete recent JSON lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'close-audit-cap-'));
  try {
    const record = closeAuditRecord({ tabId: 't1', gesture: 'tool' }, { agent: 'pi', runtime: fake() });
    const line = JSON.stringify(record) + '\n';
    await writeFile(join(root, 'tab-close.jsonl'), line.repeat(Math.ceil(CLOSE_AUDIT_LIMIT / line.length)));
    appendCloseAudit(root, record);
    assert.ok((await stat(join(root, 'tab-close.jsonl'))).size < CLOSE_AUDIT_LIMIT);
    const rows = await records(root);
    assert.ok(rows.length > 1);
    assert.deepEqual(rows.at(-1), record);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an accepted close stays accepted in the audit even when disposal fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'close-audit-cleanup-'));
  const runtime = fake(); runtime.close = async () => { throw new Error(secret); };
  const host = await createTabHost({ stateDir: root, createRuntime: () => runtime });
  try {
    await assert.rejects(host.command({ type: 'tab-close', tabId: 't1', closeConfirmed: true }), /fixture-private/);
    assert.equal((await records(root))[0].accepted, true);
    assert.ok(!(await readFile(join(root, 'tab-close.jsonl'), 'utf8')).includes(secret));
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
