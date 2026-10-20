import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTabHost } from '../tabs.mjs';

function fakeRuntime({ sessionId = 'saved', sessionFile = '/tmp/saved.jsonl', staleBusy = false } = {}) {
  const calls = [], events = new EventEmitter();
  const state = { sessionId, sessionFile, cwd: '/tmp', messages: [{ role: 'user', content: 'keep this history' }],
    busy: false, streaming: false, queue: { items: [] }, ui: { dialogs: [] } };
  let running = false, disposed = false;
  return {
    calls, events, snapshot: () => state,
    start() { running = true; Object.assign(state, { busy: true, streaming: true, queue: { items: [{ id: 'q', text: 'never send' }] }, ui: { dialogs: [{ id: 'question' }] } }); },
    get running() { return running; }, get disposed() { return disposed; },
    drop() { calls.push('drop'); state.queue.items = []; state.ui.dialogs = []; },
    async command(c) {
      assert.equal(disposed, false, 'shared API must stay usable');
      calls.push(c.type);
      if (c.type === 'abort') { running = false; state.streaming = false; state.busy = staleBusy; }
      if (c.type === 'auth_providers') return ['fake'];
      if (c.type === 'prompt') return { accepted: true };
    },
    async close() { calls.push('close'); disposed = true; state.busy = false; },
  };
}

for (const agent of ['pi', 'claude', 'codex']) test(`confirmed busy ${agent} close aborts only its turn, drops questions/queue and keeps saved history`, { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-close-'));
  const history = join(root, `${agent}.jsonl`), content = 'saved transcript\n';
  await writeFile(history, content);
  const target = fakeRuntime({ sessionFile: history }), other = fakeRuntime({ sessionId: 'other' });
  let made = 0;
  const make = () => made++ ? other : target;
  const host = await createTabHost({ firstTab: agent, createRuntime: make, createClaudeRuntime: make, createCodexRuntime: make, claudeAvailable: () => true, codexAvailable: () => true, stateDir: root, checkUpdates: false });
  try {
    await host.command({ type: 'tab-new', agent });
    target.start(); other.start();
    await assert.rejects(host.command({ type: 'tab-close', tabId: 't1' }), /unfinished work/);
    assert.deepEqual(target.calls, []);
    assert.equal((await host.command({ type: 'tab-close', tabId: 't1', closeConfirmed: true })).ok, true);
    assert.deepEqual(target.calls, ['drop', 'abort', 'close']);
    assert.equal(target.running, false);
    assert.deepEqual(target.snapshot().queue.items, []);
    assert.deepEqual(target.snapshot().ui.dialogs, []);
    assert.equal(other.running, true);
    assert.deepEqual(other.calls, []);
    assert.deepEqual(host.snapshot().tabs.map(tab => tab.id), ['t2']);
    assert.equal(await readFile(history, 'utf8'), content);
    assert.equal(JSON.parse(await readFile(join(root, 'open-tabs.json'), 'utf8')).length, 1);
  } finally { await other.command({ type: 'abort' }); await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('confirmed close does not wait on a stale busy snapshot', { timeout: 3000 }, async () => {
  const target = fakeRuntime({ staleBusy: true });
  const host = await createTabHost({ claudeAvailable: () => false, createRuntime: () => target, checkUpdates: false });
  target.start();
  await host.command({ type: 'tab-close', tabId: 't1', closeConfirmed: true });
  assert.deepEqual(target.calls, ['drop', 'abort', 'close']);
  assert.deepEqual(host.snapshot().tabs, []);
  await host.close();
});

test('closing an authenticated Pi tab disposes its writer, not the machine sign-in console', { timeout: 3000 }, async () => {
  const target = fakeRuntime({ staleBusy: true }), auth = fakeRuntime({ sessionId: 'console' }), other = fakeRuntime({ sessionId: 'other' });
  const runtimes = [target, auth, other];
  const host = await createTabHost({ createRuntime: () => runtimes.shift(), claudeAvailable: () => false, codexAvailable: () => false, authentication: true, checkUpdates: false });
  await host.command({ type: 'tab-new' });
  target.start(); other.start();
  try {
    await host.command({ type: 'tab-close', tabId: 't1', closeConfirmed: true });
    assert.deepEqual(target.calls, ['drop', 'abort', 'close']);
    assert.equal(target.running, false);
    assert.equal(target.disposed, true);
    assert.equal(auth.disposed, false);
    assert.deepEqual(await host.command({ type: 'auth_providers' }), ['fake']);
    await assert.rejects(host.command({ type: 'auth_login', provider: 'openai-codex', method: 'oauth' }), /busy/);
    assert.deepEqual(await host.command({ type: 'prompt', text: 'other tab still usable' }, 't2'), { accepted: true });
    assert.equal(other.running, true);
    assert.deepEqual(other.calls, ['prompt']);
  } finally { await other.command({ type: 'abort' }); await host.close(); }
  assert.deepEqual(auth.calls, ['auth_providers', 'close']);
});

test('backend revalidates the actual close target, not the selected tab; stale SID/host/tab reject before abort', async () => {
  const target = fakeRuntime({ sessionId: null }), other = fakeRuntime({ sessionId: 'other' });
  let made = 0;
  const host = await createTabHost({ createRuntime: () => made++ ? other : target, claudeAvailable: () => false, checkUpdates: false });
  await host.command({ type: 'tab-new' });
  target.start();
  try {
    const close = { type: 'tab-close', tabId: 't1', closeConfirmed: true, expectedTabId: 't1', expectedSessionId: null, expectedInstanceId: host.snapshot().instanceId };
    for (const wrong of [{ expectedSessionId: 'replacement' }, { expectedInstanceId: 'old-host' }, { expectedTabId: 't2' }]) {
      await assert.rejects(host.command({ ...close, ...wrong }, 't2'), /Session changed/);
      assert.deepEqual(target.calls, []);
      assert.equal(host.snapshot().tabs.length, 2);
    }
    await host.command(close, 't2');
    assert.deepEqual(target.calls, ['drop', 'abort', 'close']);
    assert.deepEqual(other.calls, []);
    // Direct legacy idle closes without metadata still work.
    await host.command({ type: 'tab-close', tabId: 't2' });
    assert.deepEqual(other.calls, ['drop', 'close']);
  } finally { target.snapshot().busy = false; await host.close(); }
});

test('a captured null-session tab from another host cannot close a reused t1', async () => {
  const old = await createTabHost({ claudeAvailable: () => false, createRuntime: () => fakeRuntime({ sessionId: null }), checkUpdates: false });
  const target = fakeRuntime({ sessionId: null });
  const replacement = await createTabHost({ claudeAvailable: () => false, createRuntime: () => target, checkUpdates: false });
  try {
    await assert.rejects(replacement.command({ type: 'tab-close', tabId: 't1', closeConfirmed: true,
      expectedSessionId: null, expectedInstanceId: old.snapshot().instanceId }), /Session changed/);
    assert.deepEqual(target.calls, []);
  } finally { await old.close(); await replacement.close(); }
});

test('confirmed close clears host-held prompts as well as runtime steering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'held-close-'));
  const target = fakeRuntime({ sessionFile: join(root, 'saved.jsonl') });
  await writeFile(target.snapshot().sessionFile, 'saved history\n');
  await writeFile(join(root, 'open-tabs.json'), JSON.stringify([{ agent: 'pi', session: target.snapshot().sessionFile, held: [{ id: 'held', text: 'do not deliver', images: [] }] }]));
  const host = await createTabHost({ claudeAvailable: () => false, createRuntime: () => target, stateDir: root, checkUpdates: false });
  try {
    assert.equal(host.snapshot().queue.items.length, 1);
    await assert.rejects(host.command({ type: 'tab-close', tabId: 't1' }), /unfinished/);
    await host.command({ type: 'tab-close', tabId: 't1', closeConfirmed: true });
    await host.resumeDelivery();
    assert.deepEqual(target.calls, ['drop', 'abort', 'close']);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'open-tabs.json'), 'utf8')), []);
    assert.equal(await readFile(target.snapshot().sessionFile, 'utf8'), 'saved history\n');
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('a fresh captured tab can gain its first session id during a swipe in the same host', async () => {
  const target = fakeRuntime({ sessionId: null });
  const host = await createTabHost({ claudeAvailable: () => false, createRuntime: () => target, checkUpdates: false });
  const close = { type: 'tab-close', tabId: 't1', closeConfirmed: true, expectedSessionId: null, expectedInstanceId: host.snapshot().instanceId };
  target.start(); target.snapshot().sessionId = 'first-created-session';
  try {
    await host.command(close);
    assert.deepEqual(target.calls, ['drop', 'abort', 'close']);
    assert.equal(target.running, false);
  } finally { await host.close(); }
});

test('a failed queue cleanup cannot skip cancellation and disposal on confirmed close', async () => {
  const calls = [];
  const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId: 'saved', busy: true }),
    drop: async () => { calls.push('drop'); throw new Error('queue cleanup failed'); },
    command: async c => { calls.push(c.type); }, close: async () => { calls.push('close'); } };
  const host = await createTabHost({ claudeAvailable: () => false, createRuntime: () => runtime, checkUpdates: false });
  await assert.rejects(host.command({ type: 'tab-close', tabId: 't1', closeConfirmed: true }), /queue cleanup failed/);
  assert.deepEqual(calls, ['drop', 'abort', 'close']);
  assert.deepEqual(host.snapshot().tabs, []);
  await host.close();
});

test('a cancellation failure cannot restore a closed tab or its held prompt on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'failed-close-'));
  const history = join(root, 'saved.jsonl');
  await writeFile(history, 'saved history\n');
  const target = fakeRuntime({ sessionFile: history });
  target.command = async c => { target.calls.push(c.type); throw new Error('abort failed'); };
  const host = await createTabHost({ claudeAvailable: () => false, createRuntime: () => target, stateDir: root, checkUpdates: false });
  target.start();
  try {
    await assert.rejects(host.command({ type: 'tab-close', tabId: 't1', closeConfirmed: true }), /abort failed/);
    assert.deepEqual(target.calls, ['drop', 'abort', 'close']);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'open-tabs.json'), 'utf8')), []);
    assert.equal(await readFile(history, 'utf8'), 'saved history\n');
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

test('a private confirmed close still disposes if its abort hook rejects', async () => {
  const calls = [];
  const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId: 'saved', busy: true }),
    drop: async () => { calls.push('drop'); },
    command: async c => { calls.push(c.type); throw new Error('abort hook failed'); },
    close: async () => { calls.push('close'); } };
  const host = await createTabHost({ claudeAvailable: () => false, createRuntime: () => runtime, checkUpdates: false });
  await assert.rejects(host.command({ type: 'tab-close', tabId: 't1', closeConfirmed: true }), /abort hook failed/);
  assert.deepEqual(calls, ['drop', 'abort', 'close']);
  assert.deepEqual(host.snapshot().tabs, []);
  await host.close();
});
