import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { agentStatus, tabLabel, createTabHost, turnActive, firstUserLine, workspaceLabel, sessionModel } from '../tabs.mjs';

test('session rail uses the last recorded model, never today’s default for past work', () => {
  assert.equal(sessionModel({ model: { name: 'New default' }, messages: [
    { role: 'assistant', model: 'old-model' },
    { role: 'assistant', model: 'last-model' },
    { role: 'user', content: 'continue' },
  ] }), 'last-model');
  assert.equal(sessionModel({ model: { id: 'default' }, messages: [{ role: 'assistant' }] }), 'default');
  assert.equal(sessionModel({ model: { name: 'Selected model' }, messages: [] }), 'Selected model');
  assert.equal(sessionModel({ messages: [{ role: 'assistant', model: '<synthetic>' }] }), null);
});

test('turnActive follows actual turn work, not composer busy from preflight', () => {
  assert.equal(turnActive({ busy: true, streaming: false }), false);
  assert.equal(turnActive({ busy: true, streaming: true }), true);
  assert.equal(turnActive({ busy: false, streaming: false }), false);
  assert.equal(turnActive({ busy: true }), true);
});

function fakeRuntime(initial = {}) {
  const events = new EventEmitter();
  let snap = { sessionId: 'x', sessionFile: '/tmp/x.jsonl', cwd: '/tmp', name: '', messages: [], busy: false, streaming: false, failed: null, ...initial };
  return {
    events,
    snapshot: () => snap,
    set(next) { snap = { ...snap, ...next }; events.emit('change'); },
    async command() {},
    async close() {},
  };
}

test('tab summaries retain the current provider independently of the display model', async () => {
  const first = fakeRuntime({ model: { provider: 'openai-codex', id: 'gpt' }, messages: [{ role: 'assistant', model: 'old-model' }] });
  const host = await createTabHost({ createRuntime: () => first });
  try {
    assert.equal(host.snapshot().tabs[0].model, 'old-model');
    assert.equal(host.snapshot().tabs[0].provider, 'openai-codex');
    first.set({ model: { provider: 'claude-agent', id: 'opus' } });
    assert.equal(host.snapshot().tabs[0].provider, 'claude-agent');
  } finally { await host.close(); }
});

test('settled fires when a model turn ends, not when a prompt is merely accepted', async () => {
  const first = fakeRuntime();
  const host = await createTabHost({ createRuntime: () => first });
  const settled = [];
  host.events.on('settled', info => settled.push(info));
  first.set({ busy: true, streaming: false });
  first.set({ busy: false, streaming: false });
  assert.deepEqual(settled, []);
  first.set({ busy: true, streaming: true });
  first.set({ busy: false, streaming: false });
  first.set({ busy: true, streaming: true, failed: null });
  first.set({ busy: false, streaming: false, failed: 'boom' });
  assert.deepEqual(settled, [{ id: 't1', asked: true }, { id: 't1', asked: true }]);
  await host.close();
});

test('imperfect status is derived from runtime facts and unseen settlement', async () => {
  const first = fakeRuntime({ cwd: '/work/imperfect.computer', ui: { dialogs: [], }, agent: 'pi' });
  const second = fakeRuntime({ cwd: '/work/imperfect.computer', ui: { dialogs: [], }, agent: 'pi' });
  let made = 0;
  const host = await createTabHost({ createRuntime: () => made++ ? second : first, claudeAvailable: () => false, codexAvailable: () => false });
  try {
    assert.equal(host.snapshot().tabs[0].status, 'idle');
    first.set({ busy: true, streaming: true });
    assert.equal(host.snapshot().tabs[0].status, 'working');
    first.set({ busy: false, streaming: false });
    await host.command({ type: 'tab-new' });
    first.set({ busy: true, streaming: true });
    first.set({ busy: false, streaming: false });
    assert.equal(host.snapshot().tabs.find(tab => tab.id === 't1').status, 'done');
    await host.command({ type: 'tab-focus', tabId: 't1' });
    assert.equal(host.snapshot().tabs.find(tab => tab.id === 't1').status, 'idle');
    second.set({ ui: { dialogs: [{ id: 'permission', method: 'confirm' }] } });
    assert.equal(host.snapshot().tabs.find(tab => tab.id === 't2').status, 'blocked');
  } finally {
    await host.close();
  }
});

test('agentStatus does not call a failed runtime or a working one idle', () => {
  const tab = { agent: 'pi', unseenSettled: false, runtime: { snapshot: () => ({}) } };
  assert.equal(agentStatus(tab, { failed: 'runtime ended', busy: false, streaming: false }), 'unknown');
  assert.equal(agentStatus(tab, { ui: { dialogs: [{ id: 'q' }] }, busy: false }), 'blocked');
  assert.equal(agentStatus(tab, { busy: false, streaming: false, operation: 'background' }), 'working');
});

test('tab labels prefer a real name, then the first prompt, never the session id', () => {
  assert.equal(tabLabel({ name: 'Refactor auth', sessionId: '01abc', messages: [] }), 'Refactor auth');
  assert.equal(tabLabel({
    name: '',
    sessionId: '01a08407-3233-719e-a1a9-50feac8cee82',
    messages: [{ role: 'user', content: 'can you work on the tab window' }],
  }), 'can you work on the tab window');
  assert.equal(tabLabel({
    name: '01a08407-3233-719e-a1a9-50feac8cee82',
    sessionId: '01a08407-3233-719e-a1a9-50feac8cee82',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'first line\nsecond' }] }],
  }), 'first line');
  assert.equal(tabLabel({
    sessionId: '01abc',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: '   \n  actual prompt  ' },
    ],
  }), 'actual prompt');
  assert.equal(tabLabel({ sessionId: '01abc', messages: [] }), 'new');
  assert.equal(tabLabel({
    name: 'new',
    sessionId: '01abc',
    messages: [{ role: 'user', content: 'clicked new for this session' }],
  }), 'clicked new for this session');
  assert.equal(firstUserLine({
    messages: [{ role: 'user', content: 'clicked new for this session' }],
  }), 'clicked new for this session');
});

test('tab-new is a different empty session; focusing restores the first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-tab-host-'));
  const cwd = join(root, 'work');
  const agent = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agent, { recursive: true });
  const host = await createTabHost({
    cwd, agentDir: agent, stateDir: join(root, 'store'), sessionDir: join(root, 'sessions'), claudeAvailable: () => false, codexAvailable: () => false,
  });
  try {
    const first = host.snapshot();
    await host.command({ type: 'tab-new' });
    const neu = host.snapshot();
    assert.notEqual(neu.sessionId, first.sessionId);
    assert.equal((neu.messages ?? []).length, 0);
    assert.equal(neu.tabs.length, 2);
    assert.equal(neu.tabs.filter(tab => tab.focused).length, 1);
    assert.equal(neu.tabs.find(tab => tab.focused).sessionId, neu.sessionId);
    const previous = neu.tabs.find(tab => !tab.focused);
    await host.command({ type: 'tab-focus', tabId: previous.id });
    assert.equal(host.snapshot().sessionId, first.sessionId);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the rail names home `~`, and everywhere else by its own directory', () => {
  assert.equal(workspaceLabel('/home/locus', '/home/locus'), '~');
  assert.equal(workspaceLabel('/home/locus/', '/home/locus'), '~', 'a trailing slash is the same place');
  // A directory literally called "workspace" told a person nothing, but the
  // answer is only `~` for home — a real project keeps its real name.
  assert.equal(workspaceLabel('/home/vaita/projects/imperfect.computer', '/home/vaita'), 'imperfect.computer');
  assert.equal(workspaceLabel('/home/locus/.imperfect/data/workspace', '/home/locus'), 'workspace');
  assert.equal(workspaceLabel('', '/home/locus'), '');
  assert.equal(workspaceLabel('/home/other', '/home/locus'), 'other', 'another home is not this one');
});

test('closing the last tab empties the console instead of refusing', async () => {
  const only = fakeRuntime();
  const host = await createTabHost({ createRuntime: () => only });
  const before = host.snapshot();
  assert.equal(before.tabs.length, 1);

  // The last tab used to be un-closable, which left Alt+Esc doing nothing on a
  // single session and made an empty console unreachable.
  const closed = await host.command({ type: 'tab-close', tabId: before.tabs[0].id });
  assert.equal(closed.ok, true);
  assert.equal(closed.focused, null);

  // No runtime is left to describe, and asking for a snapshot must still answer
  // rather than throw on a missing current tab: the window draws the harness
  // chooser from exactly this.
  const after = host.snapshot();
  assert.deepEqual(after.tabs, []);
  assert.equal(after.agent, null);
  assert.deepEqual(after.messages, []);
  await host.close();
});

test('closing the session in view goes on to the one the window names, else the next one', async () => {
  const host = await createTabHost({ createRuntime: () => fakeRuntime(), claudeAvailable: () => false, codexAvailable: () => false });
  try {
    await host.command({ type: 'tab-new' });
    await host.command({ type: 'tab-new' });
    await host.command({ type: 'tab-new' });
    const ids = host.snapshot().tabs.map(tab => tab.id);
    assert.equal(ids.length, 4);

    // Asked for nothing, it is the one after it, not the first.
    await host.command({ type: 'tab-focus', tabId: ids[1] });
    const plain = await host.command({ type: 'tab-close', tabId: ids[1] });
    assert.equal(plain.focused, ids[2]);

    // The window names the next in its rail, which may be anywhere.
    const named = await host.command({ type: 'tab-close', tabId: ids[2], then: ids[0] });
    assert.equal(named.focused, ids[0]);
    assert.equal(host.snapshot().tabs.find(tab => tab.focused)?.id, ids[0]);

    // The last one closed goes back to the one before it.
    await host.command({ type: 'tab-focus', tabId: ids[3] });
    const last = await host.command({ type: 'tab-close', tabId: ids[3] });
    assert.equal(last.focused, ids[0]);
  } finally {
    await host.close();
  }
});

test('a restart reopens each tab as it was without telling its harness anything again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-tab-restart-'));
  const sent = [], made = [];
  const createRuntime = extra => {
    made.push(extra);
    const runtime = fakeRuntime({ sessionFile: join(root, 'a.jsonl'), sessionId: 'a', name: 'Named', model: { provider: 'openai', id: 'm' }, messages: [{ role: 'user', content: 'hi' }] });
    runtime.command = async c => { sent.push(c.type); };
    return runtime;
  };
  try {
    for (let i = 0; i < 3; i++) await (await createTabHost({ stateDir: root, createRuntime, firstTab: 'pi', checkUpdates: false })).close();
    // Pi reads its model, thinking level and name from its own session; asked
    // again, it wrote a model_change and a name into it at every restart, and
    // made the last tab's model everyone's default.
    assert.deepEqual(sent, []);
    assert.deepEqual(made.slice(1).map(extra => [extra.sessionPath, extra.model?.id]), [[join(root, 'a.jsonl'), 'm'], [join(root, 'a.jsonl'), 'm']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
