import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createGueyServer } from '../../../system/server.mjs';
import * as controls from '../native/code-control.mjs';
const { SESSION_TOOL, openSession, provideSessions, runSessionTool } = controls;

test('outside imperfect, code_session says it cannot', async () => {
  provideSessions(undefined);
  await assert.rejects(runSessionTool({ prompt: 'hi' }), /not running inside imperfect/);
});

test('code_session advertises only explicitly requested interactive work', async () => {
  assert.equal(Object.hasOwn(SESSION_TOOL.parameters.properties, 'headless'), false);
  assert.equal(SESSION_TOOL.parameters.properties.computer.type, 'string');
  assert.match(SESSION_TOOL.description, /only when the person explicitly requests/);
  assert.match(SESSION_TOOL.description, /Not for delegation: use your own subagents instead/);
  assert.doesNotMatch(JSON.stringify(SESSION_TOOL), /headless|session_message|hand a task to another agent/);
  assert.equal(Object.hasOwn(controls, 'MESSAGE_TOOL'), false);
  assert.equal(Object.hasOwn(controls, 'runSessionMessage'), false);
  const { TOOLS } = await import('../native/tools.mjs');
  assert.equal(TOOLS.some(([tool]) => tool.name === 'session_message'), false);
});

test('stale headless requests fail with subagent guidance before invoking the opener', async () => {
  const opened = [];
  provideSessions(args => { opened.push(args); return { id: 'unexpected' }; });
  try {
    for (const headless of [true, 'true']) {
      await assert.rejects(runSessionTool({ headless, prompt: 'delegate this' }), /Use your own subagents/);
      assert.throws(() => openSession({ headless }), /Use your own subagents/);
    }
    assert.deepEqual(opened, []);
  } finally { provideSessions(undefined); }
});

test('code_session opens a named session in a folder, sends its first message, and puts its page beside it in every window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-session-'));
  const asked = [];
  const runtime = {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', cwd: root, busy: false, failed: null, messages: [], tabs: [] }),
    async command(c, selected) {
      asked.push([c, selected]);
      return c.type === 'tab-new' ? { id: 'tab-2' } : {};
    },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime });
  try {
    const { port } = await app.listen();
    const window = new WebSocket(`ws://127.0.0.1:${port}/pi`);
    await new Promise(resolve => window.once('open', resolve));
    const said = await runSessionTool({ cwd: root, agent: 'claude', name: 'screensaver', prompt: 'make it glow' });
    assert.match(said, /Opened a Claude Code session named "screensaver"/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(asked.map(([c, selected]) => [c.type, selected ?? null]), [['tab-new', null], ['name', 'tab-2'], ['prompt', 'tab-2']]);
    assert.equal(asked[0][0].cwd, root);
    assert.equal(asked[0][0].agent, 'claude');
    assert.equal(Object.hasOwn(asked[0][0], 'headless'), false);
    assert.equal(asked[2][0].text, 'make it glow');
    window.close();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const synchronous of [true, false]) test(`code_session catches ${synchronous ? 'synchronous' : 'asynchronous'} first-prompt failures without rejecting the opener`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'code-session-failure-'));
  const logged = [];
  t.mock.method(console, 'error', text => logged.push(text));
  const runtime = {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', cwd: root, busy: false, messages: [], tabs: [] }),
    command(c) {
      if (c.type !== 'prompt') return Promise.resolve(c.type === 'tab-new' ? { id: 'tab-2' } : {});
      if (synchronous) throw new Error('prompt refused');
      return Promise.reject(new Error('prompt refused'));
    },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime });
  try {
    await app.listen();
    assert.match(await runSessionTool({ name: 'separate work', prompt: 'hello' }), /Opened a Pi session/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(logged, ['code_session: first message: prompt refused']);
  } finally {
    await app.close();
    provideSessions(undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// A session opened with the session token, on Pi, with a model and thinking
// level of its own that leave the person's defaults alone.
test('/sessions/open takes a Pi session\'s own model and thinking level, without making them the default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-session-model-'));
  const asked = [];
  const runtime = {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', cwd: root, busy: false, failed: null, messages: [], tabs: [] }),
    async command(c, selected) { asked.push([c, selected]); return c.type === 'tab-new' ? { id: 'tab-3' } : {}; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime, sessionToken: 'tok' });
  try {
    const { port } = await app.listen();
    const open = (body, token = 'tok') => fetch(`http://127.0.0.1:${port}/sessions/open`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await open({ agent: 'pi' }, 'nope')).status, 403);
    const res = await open({ agent: 'pi', cwd: root, name: 'nightly review 2026-09-30', prompt: 'look back', model: 'openai-codex/gpt-6.1-sol', thinking: 'high' });
    assert.deepEqual(await res.json(), { id: 'tab-3' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(asked.map(([c, selected]) => [c.type, selected ?? null]), [['tab-new', null], ['name', 'tab-3'], ['model', 'tab-3'], ['thinking', 'tab-3'], ['prompt', 'tab-3']]);
    assert.deepEqual(asked[2][0], { type: 'model', provider: 'openai-codex', modelId: 'gpt-6.1-sol', persist: false });
    assert.deepEqual(asked[3][0], { type: 'thinking', level: 'high' });
  } finally {
    await app.close();
    provideSessions(undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('/sessions/open answers when a harness cannot start, and imperfect keeps running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-session-blocked-'));
  const runtime = {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', cwd: root, busy: false, failed: null, messages: [], tabs: [] }),
    async command(c) { if (c.type === 'tab-new') throw new Error('Sign in to Claude Code in imperfect to use your Claude subscription on this machine'); return {}; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime, sessionToken: 'tok' });
  try {
    const { port } = await app.listen();
    const res = await fetch(`http://127.0.0.1:${port}/sessions/open`, { method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'claude', cwd: root, prompt: 'draft a reply' }) });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /Sign in to Claude Code/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    await app.close();
    provideSessions(undefined);
    await rm(root, { recursive: true, force: true });
  }
});

 test('code_session defaults to its caller harness, with explicit choice taking precedence', async () => {
  const opened = [];
  provideSessions(args => { opened.push(args); return { id: 'new' }; });
  try {
    for (const harness of ['pi', 'claude', 'codex']) await runSessionTool({ harness });
    await runSessionTool({ harness: 'claude', agent: 'codex' });
    assert.deepEqual(opened.map(args => args.agent), ['pi', 'claude', 'codex', 'codex']);
  } finally { provideSessions(undefined); }
});


test('code_session chooses a verified computer by name or id over the peer transport, never a local fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-session-computer-'));
  const runtimeFor = owner => {
    let tabs = [];
    const asked = [];
    return { asked, events: new EventEmitter(),
      snapshot: () => ({ instanceId: `${owner}-host`, sessionId: tabs[0]?.sessionId ?? null, cwd: root, messages: [], tabs }),
      async command(c, selected) {
        asked.push([c, selected]);
        if (c.type === 'tab-new') { const tab = { id: `${owner}-tab`, sessionId: `${owner}-session`, focused: true, agent: c.agent }; tabs = [tab]; return tab; }
        return {};
      }, async close() {},
    };
  };
  const remote = runtimeFor('desktop'), local = runtimeFor('laptop');
  const desktop = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'desktop'), runtime: remote });
  let laptop;
  try {
    const peerPort = (await desktop.listen()).port;
    let reachable = true;
    const rows = [
      { id: 'lap-id', name: 'laptop', self: true, reachable: true },
      { id: 'desk-id', name: 'desktop', reachable: true, url: `http://127.0.0.1:${peerPort}` },
      { id: 'sleep-id', name: 'sleeping', reachable: false },
    ];
    const probes = [];
    const machines = { selfId: async () => 'lap-id', self: async () => 'laptop', origins: async () => [],
      list: async () => rows, peer: async id => { probes.push(id); return reachable && id === 'desk-id' ? rows[1] : null; } };
    laptop = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'laptop'), runtime: local, machines, sessionToken: 'test-token' });
    const port = (await laptop.listen()).port;
    assert.match(await runSessionTool({ computer: 'desktop', agent: 'claude', name: 'remote work', prompt: 'hello desktop' }), /on desktop/);
    assert.deepEqual(local.asked, []);
    assert.deepEqual(remote.asked.map(([c, tab]) => [c.type, tab ?? null]), [['tab-new', null], ['name', 'desktop-tab'], ['prompt', 'desktop-tab']]);
    assert.deepEqual(probes, ['desk-id']);
    assert.equal(remote.asked[2][0].expectedSessionId, 'desktop-session');
    const response = await fetch(`http://127.0.0.1:${port}/sessions/open`, { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify({ computer: 'desk-id', agent: 'pi', model: 'fixture/model', thinking: 'high' }) });
    assert.deepEqual(await response.json(), { id: 'desktop-tab' });
    assert.equal(remote.asked.filter(([c]) => c.type === 'tab-new').length, 2);
    assert.equal(local.asked.length, 0);
    assert.deepEqual(remote.asked.slice(-2).map(([c]) => c.type), ['model', 'thinking']);
    for (const computer of ['unknown', 'sleeping', '', '../desktop', { id: 'desk-id' }]) {
      await assert.rejects(runSessionTool({ computer }), /Unknown computer|offline|must be a machine/);
    }
    reachable = false;
    await assert.rejects(runSessionTool({ computer: 'desktop' }), /desktop is offline/);
    assert.equal(remote.asked.filter(([c]) => c.type === 'tab-new').length, 2);
    assert.equal(local.asked.length, 0);
    assert.match(await runSessionTool({ computer: 'laptop' }), /on laptop/);
    assert.equal(local.asked.filter(([c]) => c.type === 'tab-new').length, 1);
  } finally {
    await laptop?.close(); await desktop.close(); provideSessions(undefined);
    await rm(root, { recursive: true, force: true });
  }
});
