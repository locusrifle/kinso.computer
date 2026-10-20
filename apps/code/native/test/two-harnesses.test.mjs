import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createTabHost, AGENTS } from '../tabs.mjs';

function setup(stateDir, rows = []) {
  const runtimes = [];
  const options = { stateDir, claudeAvailable: () => false, codexAvailable: () => false, listPiSessions: async () => rows, createRuntime: async ({ sessionPath }) => {
    const snap = { sessionId: sessionPath ? 'old' : 'new', sessionFile: sessionPath || join(stateDir, 'new.jsonl'), messages: [], model: { provider: 'anthropic', id: 'claude' } };
    const events = new EventEmitter();
    const runtime = { events, snapshot: () => snap, close: async () => {}, command: async c => {
      if (c.type === 'models') return [{ provider: 'anthropic', id: 'claude' }];
      if (c.type === 'prompt') { snap.messages.push({ role: 'user', content: c.text, timestamp: Date.now() }); events.emit('change'); return { accepted: true }; }
    }, set: fields => { Object.assign(snap, fields); events.emit('change'); } };
    runtimes.push(runtime); return runtime;
  } };
  return { options, runtimes };
}

function claudeRuntime(runtimes, { sessionPath = null } = {}) {
  const snap = { sessionId: sessionPath, sessionFile: sessionPath, messages: [], model: { provider: 'claude-agent', id: 'opus' } };
  const events = new EventEmitter();
  const runtime = { agent: 'claude', events, snapshot: () => snap, close: async () => {}, command: async c => {
    if (c.type === 'models') return [{ provider: 'claude-agent', id: 'opus' }];
    if (c.type === 'prompt') { snap.sessionId = snap.sessionFile = 'claude-session'; snap.messages.push({ role: 'user', content: c.text }); events.emit('change'); return { accepted: true }; }
  } };
  runtimes.push(runtime); return runtime;
}

test('two harnesses: Claude Code runs beside Pi only where this machine is signed in to Claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'two-harnesses-'));
  const { options, runtimes } = setup(dir);
  let signedIn = false;
  const claudeRows = [{ id: 'claude-old', path: 'claude-old', agent: 'claude', firstMessage: 'earlier', cwd: dir, modified: 2 }];
  Object.assign(options, {
    claudeAvailable: () => signedIn,
    listClaudeSessions: async () => claudeRows,
    createClaudeRuntime: async extra => claudeRuntime(runtimes, extra),
  });
  let host = await createTabHost(options);
  try {
    assert.deepEqual([...AGENTS], ['pi', 'claude', 'codex']);
    await assert.rejects(host.command({ type: 'tab-new', agent: 'claude' }), /Sign in to Claude Code in imperfect/);
    assert.equal((await host.command({ type: 'sessions' })).some(r => r.agent === 'claude'), false);
    signedIn = true;
    assert.ok((await host.command({ type: 'sessions' })).some(r => r.agent === 'claude' && r.id === 'claude-old'));
    // Pi Anthropic is neither listed nor selectable, even with a saved model.
    assert.ok((await host.command({ type: 'models' })).every(m => m.engine === 'claude'));
    await assert.rejects(host.command({ type: 'model', provider: 'anthropic', modelId: 'claude' }), /not used/);
    assert.deepEqual(host.snapshot().tabs.map(t => t.agent), ['pi']);
    const tab = await host.command({ type: 'tab-new', agent: 'claude' });
    assert.equal(host.snapshot(tab.id).agent, 'claude');
    assert.equal((await host.command({ type: 'models' }, tab.id))[0].engine, 'claude');
    // A fresh Claude tab has no session yet, so it is not remembered until its first turn.
    assert.equal(JSON.parse(readFileSync(join(dir, 'open-tabs.json'))).some(r => r.agent === 'claude'), false);
    await host.command({ type: 'prompt', text: 'hello' }, tab.id);
    assert.equal(host.snapshot(tab.id).sessionId, 'claude-session');
    const opened = await host.command({ type: 'tab-open', path: 'claude-old', agent: 'claude', cwd: dir });
    assert.equal(host.snapshot(opened.id).agent, 'claude');
    assert.equal(runtimes.at(-1).snapshot().sessionFile, 'claude-old');
    await host.close();
    host = await createTabHost(options);
    const restored = host.snapshot().tabs.map(t => host.snapshot(t.id)).filter(s => s.agent === 'claude').map(s => s.sessionFile).sort();
    assert.deepEqual(restored, ['claude-old', 'claude-session']);
  } finally { await host.close(); }
});

test('a session keeps its id through a restart and a reopen from history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-empty-'));
  let generation = 0;
  // Pi's id is written at the head of its session file, so a reopened file
  // answers with the id it was made with.
  const options = { stateDir: dir, claudeAvailable: () => false, codexAvailable: () => false, listPiSessions: async () => [{ id: 'sdk-1', path: join(dir, 'sdk-1.jsonl'), agent: 'pi', modified: 1 }], createRuntime: async ({ sessionPath } = {}) => {
    const id = sessionPath ? basename(sessionPath, '.jsonl') : `sdk-${++generation}`;
    return { events: new EventEmitter(), snapshot: () => ({ sessionId: id, sessionFile: join(dir, `${id}.jsonl`), messages: [{ role: 'user', content: 'hi' }] }), command: async () => {}, close: async () => {} };
  } };
  let host = await createTabHost(options);
  const id = host.snapshot().sessionId;
  // A flushed header is a restorable session even before its first message.
  // An unflushed, unused placeholder is instead discarded at startup.
  writeFileSync(host.snapshot().sessionFile, JSON.stringify({ type: 'session', id }) + '\n');
  await host.close();
  host = await createTabHost(options);
  try {
    assert.equal(host.snapshot().sessionId, id);
    const tab = host.snapshot().tabs[0];
    await host.command({ type: 'tab-close', tabId: tab.id });
    const row = (await host.command({ type: 'sessions' }))[0];
    await host.command({ type: 'tab-open', path: row.path });
    assert.equal(host.snapshot().sessionId, id);
  } finally { await host.close(); }
});

test('concurrent archive attachment shares one runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-attach-'));
  const path = join(dir, 'old.jsonl'); writeFileSync(path, 'retained');
  const { options, runtimes } = setup(dir, [{ id: 'old', path, firstMessage: 'work', modified: 1, agent: 'pi' }]);
  const host = await createTabHost(options);
  try {
    const [a,b] = await Promise.all([host.command({ type: 'tab-open', path }), host.command({ type: 'tab-open', path })]);
    assert.equal(a.id, b.id); assert.equal(runtimes.length, 2);
  } finally { await host.close(); }
});

test('opening a host session ID selects its running runtime, scoped to its agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-identity-'));
  const path = join(dir, 'stored.jsonl');
  writeFileSync(path, 'retained');
  writeFileSync(join(dir, 'open-tabs.json'), JSON.stringify([{ agent: 'pi', session: path }]));
  const { options, runtimes } = setup(dir);
  Object.assign(options, { claudeAvailable: () => true, listClaudeSessions: async () => [], createClaudeRuntime: async extra => claudeRuntime(runtimes, extra) });
  const host = await createTabHost(options);
  try {
    const original = host.snapshot().tabs[0];
    const [a, b] = await Promise.all([
      host.command({ type: 'tab-open', path: 'old', agent: 'pi' }),
      host.command({ type: 'tab-open', path, agent: 'pi' }),
    ]);
    assert.equal(a.id, original.id);
    assert.equal(b.id, original.id);
    assert.equal(runtimes.length, 1);
    const other = await host.command({ type: 'tab-open', path: 'old', agent: 'claude' });
    assert.notEqual(other.id, original.id);
    const again = await host.command({ type: 'tab-open', path: 'old', agent: 'claude' });
    assert.equal(again.id, other.id);
    assert.equal(runtimes.length, 2);
  } finally { await host.close(); }
});

// Alt+Esc is the one explicit force-close. Everything else still refuses to
// close a tab that has work in it.
test('a tab with work in it closes only when the close is confirmed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-close-'));
  const { options, runtimes } = setup(dir);
  const host = await createTabHost(options);
  try {
    const [tab] = host.snapshot().tabs;
    runtimes[0].set({ queue: { items: [{ id: 'r', lane: 'steering', text: 'next' }] } });
    await assert.rejects(host.command({ type: 'tab-close', tabId: tab.id }), /unfinished work/);
    await host.command({ type: 'tab-close', tabId: tab.id, closeConfirmed: true });
    assert.deepEqual(host.snapshot().tabs, []);
  } finally { await host.close(); }
});
