import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createDictation } from '../../../system/dictate.mjs';
import { createTabHost } from '../native/tabs.mjs';
import { mountVoice } from '../native/public/js/voice.js';
import { createClaudeRuntime } from '../native/claude-runtime.mjs';
import { fixture as durableFixture } from '../native/test/durable-fixture.mjs';

async function endpoint(t, runtime, hear = async () => ({ text: 'first spoken prompt' }), options = {}) {
  const handle = createDictation({ runtime, hear, openAudio: async () => Readable.from(['synthetic recording']), ...options });
  const server = createServer((req, res) => handle(req, res, '/dictate'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async prompt => {
    const url = `http://127.0.0.1:${server.address().port}`;
    return fetch(`${url}/dictate`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ ...prompt, audio: { name: 'fixture-ref' } }) });
  };
}

for (const agent of ['claude', 'pi']) test(`a fresh ${agent} null-session dictation uses the real tab host's lazy prompt path`, async t => {
  const prompts = [];
  let sessionId = null;
  const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId, cwd: '/tmp', messages: [], busy: false }),
    command: async command => { if (command.type === 'prompt') { prompts.push(command); sessionId = 'created'; return { accepted: true }; } }, close: async () => {} };
  const host = await createTabHost({ firstTab: null, checkUpdates: false,
    createRuntime: () => runtime, createClaudeRuntime: () => runtime, claudeAvailable: () => true });
  t.after(() => host.close());
  const made = await host.command({ type: 'tab-new', agent, model: null });
  assert.equal(host.snapshot(made.id).sessionId, null);
  const send = await endpoint(t, host);
  const prompt = { tab: made.id, session: null, instanceId: host.snapshot(made.id).instanceId, requestId: `first-${agent}` };
  assert.equal((await send(prompt)).status, 200);
  assert.equal(host.snapshot(made.id).sessionId, 'created');
  assert.equal((await send(prompt)).status, 200, 'lazy identity upgrade still permits the same request retry');
  assert.equal(prompts.length, agent === 'pi' ? 2 : 1, 'Claude deduplicates at the host; Pi forwards identical IDs to Durable receipts');
  assert.ok(prompts.every(command => command.requestId === prompt.requestId));
});

test('actual Durable receipts deduplicate a dictation retry through the real route and tab host', async t => {
  const { runtime, idle, seen } = await durableFixture(t);
  const host = await createTabHost({ firstTab: null, createRuntime: () => runtime });
  t.after(() => host.close());
  const made = await host.command({ type: 'tab-new', agent: 'pi', model: null });
  const send = await endpoint(t, host);
  const prompt = { tab: made.id, session: host.snapshot(made.id).sessionId, instanceId: host.snapshot(made.id).instanceId, requestId: 'durable-dictation-retry' };
  assert.equal((await send(prompt)).status, 200);
  await idle();
  assert.equal((await send(prompt)).status, 200);
  await idle();
  assert.equal(seen.length, 1, 'retry must never generate another response');
  assert.equal(runtime.snapshot().messages.filter(m => m.role === 'user').length, 1);
});

test('the actual Claude runtime starts with null identity and accepts its first dictation through the server route (SDK mocked)', async t => {
  const inputs = [];
  const queryImpl = ({ prompt }) => ({
    supportedModels: async () => [{ value: 'fixture-opus', displayName: 'Fixture Opus' }],
    close() {},
    async *[Symbol.asyncIterator]() {
      for await (const input of prompt) {
        inputs.push(input);
        yield { type: 'system', subtype: 'init', session_id: 'claude-created', model: 'fixture-opus', tools: [] };
        yield { type: 'result', subtype: 'success', session_id: 'claude-created' };
      }
    },
  });
  const runtime = await createClaudeRuntime({ cwd: '/tmp', queryImpl, authImpl: () => 'fixture-login',
    accountInfoImpl: async () => ({ apiProvider: 'firstParty', tokenSource: 'claude.ai', apiKeySource: 'none' }) });
  assert.equal(runtime.snapshot().sessionId, null, 'actual Claude runtime, not a guessed UI shape');
  const host = await createTabHost({ firstTab: null, checkUpdates: false, claudeAvailable: () => true, createClaudeRuntime: () => runtime });
  t.after(() => host.close());
  const made = await host.command({ type: 'tab-new', agent: 'claude', model: null });
  const send = await endpoint(t, host);
  assert.equal((await send({ tab: made.id, session: null, instanceId: host.snapshot(made.id).instanceId, requestId: 'actual-runtime' })).status, 200);
  for (let i = 0; i < 100 && runtime.snapshot().sessionId !== 'claude-created'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.snapshot().sessionId, 'claude-created');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].message.content[0].text, 'first spoken prompt');
});

test('a target closed while hearing, or a reused tab with another session, cannot fall back to the focused chat', async t => {
  let tabs = [{ id: 'original', sessionId: 's1', focused: true }];
  const commands = [];
  const runtime = { snapshot: () => ({ sessionId: tabs[0]?.sessionId, tabs }), command: async (...args) => commands.push(args) };
  const send = await endpoint(t, runtime, async () => { tabs = [{ id: 'other', sessionId: 's2', focused: true }]; return { text: 'words' }; });
  assert.equal((await send({ tab: 'original', session: 's1' })).status, 409);
  const reused = await endpoint(t, runtime);
  assert.equal((await reused({ tab: 'other', session: 's1' })).status, 409);
  assert.deepEqual(commands, []);
});

async function freshHost(t) {
  const prompts = [];
  const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId: null, cwd: '/tmp', messages: [], busy: false }),
    command: async command => { prompts.push(command); return { accepted: true }; }, close: async () => {} };
  const host = await createTabHost({ createRuntime: () => runtime, checkUpdates: false });
  t.after(() => host.close());
  return { host, prompts };
}

test('actual tab-host lifetimes have distinct UUID stamps even when both allocate t1', async t => {
  const first = await freshHost(t), second = await freshHost(t);
  assert.equal(first.host.snapshot().tabs[0].id, 't1');
  assert.equal(second.host.snapshot().tabs[0].id, 't1');
  assert.match(first.host.snapshot().instanceId, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.host.snapshot().instanceId, second.host.snapshot().instanceId);
  assert.equal(first.host.snapshot('t1').instanceId, first.host.snapshot().instanceId);
});

test('mock host replacement during hearing rejects the captured null target; a new fresh recording works', async t => {
  const first = await freshHost(t), second = await freshHost(t);
  let actual = first.host;
  const runtime = { snapshot: tab => actual.snapshot(tab), command: (command, tab) => actual.command(command, tab) };
  const send = await endpoint(t, runtime, async () => { actual = second.host; return { text: 'words' }; });
  const oldPrompt = { tab: 't1', session: null, instanceId: first.host.snapshot().instanceId, requestId: 'old' };
  const stale = await send(oldPrompt);
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /restarted.*nothing was sent/);
  assert.deepEqual(first.prompts, []);
  assert.deepEqual(second.prompts, []);
  assert.equal((await send({ ...oldPrompt, instanceId: second.host.snapshot().instanceId, requestId: 'new' })).status, 200);
  assert.equal(second.prompts.length, 1);
});

test('null requests without a captured host stamp fail closed even after a real session id appears', async t => {
  const commands = [];
  const runtime = { snapshot: () => ({ instanceId: 'current-host', sessionId: 'existing', tabs: [{ id: 't1', sessionId: 'existing', focused: true }] }),
    command: async command => { commands.push(command); return { accepted: true }; } };
  const send = await endpoint(t, runtime);
  for (const session of [null, undefined]) {
    const res = await send({ tab: 't1', session });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /update imperfect.*typed first message/);
  }
  assert.deepEqual(commands, []);
  assert.equal((await send({ tab: 't1', session: 'existing', instanceId: 'old-host' })).status, 200, 'existing session reconnects use SID, not host lifetime');
  assert.equal((await send({ tab: 't1', session: 'existing' })).status, 200, 'old frontend existing-session body remains supported');
  assert.equal((await send({ tab: 't1', session: 'stale', instanceId: 'current-host' })).status, 409, 'stamp cannot override typed stale-session semantics');
  assert.equal(commands.length, 2);
});

test('fresh null requests to an older unstamped backend fail closed with an actionable error', async t => {
  const commands = [];
  const runtime = { snapshot: () => ({ sessionId: null, tabs: [{ id: 't1', sessionId: null, focused: true }] }), command: async command => commands.push(command) };
  const send = await endpoint(t, runtime);
  const res = await send({ tab: 't1', session: null, instanceId: 'captured-host' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /update imperfect.*typed first message/);
  assert.deepEqual(commands, []);
});

test('mic captures before permission and keeps the exact blob and target across failed retries and navigation', async t => {
  const saved = Object.fromEntries(['document', 'navigator', 'MediaRecorder', 'addEventListener'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  globalThis.document = { createElement: () => ({ dataset: {}, append() {}, setAttribute() {} }) };
  let permit, requested = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => { requested++; return new Promise(resolve => { permit = () => resolve({ getTracks: () => [] }); }); } } } });
  globalThis.addEventListener = () => {};
  globalThis.MediaRecorder = class { static isTypeSupported() { return true; } start() {} stop() { this.ondataavailable({ data: new Blob(['words']) }); this.onstop(); } };
  let target = { owner: 'pc', tab: 'fresh', session: null, requestId: 'one' };
  const captured = target, sent = [], failures = [];
  const voice = mountVoice({ input: {}, captureTarget: () => target, fail: error => failures.push(error.message), send: async (blob, identity) => { sent.push({ blob, identity }); throw new Error('original tab is closed'); } });
  voice.button.onclick();
  target = { owner: 'laptop', tab: 'other', session: 's2', requestId: 'two' };
  voice.button.onclick();
  assert.equal(requested, 1, 'permission pending cannot start another recording');
  permit(); await new Promise(resolve => setTimeout(resolve, 0));
  voice.button.onclick(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(voice.button.dataset.state, 'kept');
  voice.button.onclick(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(sent[0].identity, captured);
  assert.equal(sent[1].identity, captured);
  assert.equal(sent[1].blob, sent[0].blob);
  assert.equal(voice.holding(), true);
  assert.match(failures[1], /original tab is closed/);
});
