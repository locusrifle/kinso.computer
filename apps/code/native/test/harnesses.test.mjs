import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTabHost, AGENTS } from '../tabs.mjs';
import { SOURCES } from '../canonical.mjs';

// One host, three harnesses, one gate each. Claude and Codex are startable
// only where this machine is signed in to them; their history joins the one
// list; a model whose provider is Claude's lands in a Claude tab, one whose
// provider is Codex's in a Codex tab.
function stub(runtimes, agent, provider, { sessionPath = null } = {}) {
  const snap = { sessionId: sessionPath, sessionFile: sessionPath, cwd: '/w', messages: [], model: { provider, id: 'm' } };
  const events = new EventEmitter();
  const runtime = { agent, events, snapshot: () => snap, close: async () => {}, command: async c => {
    if (c.type === 'models') return [{ provider, id: 'm' }];
    if (c.type === 'prompt') { snap.sessionId = snap.sessionFile = `${agent}-session`; snap.messages.push({ role: 'user', content: c.text }); events.emit('change'); return { accepted: true }; }
    if (c.type === 'model') return { id: c.modelId };
  } };
  runtimes.push(runtime);
  return runtime;
}

test('with no model picked yet, a new tab is Claude Code where this machine is signed in to it, else Pi; Pi can still be chosen', async () => {
  for (const signedIn of [true, false]) {
    const runtimes = [];
    const host = await createTabHost({
      stateDir: mkdtempSync(join(tmpdir(), 'harnesses-')),
      firstTab: null,
      listPiSessions: async () => [], listClaudeSessions: async () => [],
      createRuntime: async () => stub(runtimes, 'pi', 'openai'),
      claudeAvailable: () => signedIn, codexAvailable: () => false,
      createClaudeRuntime: async extra => stub(runtimes, 'claude', 'claude-agent', extra),
    });
    try {
      const first = await host.command({ type: 'tab-new' });
      assert.equal(host.snapshot(first.id).agent, signedIn ? 'claude' : 'pi');
      const pi = await host.command({ type: 'tab-new', agent: 'pi' });
      assert.equal(host.snapshot(pi.id).agent, 'pi');
    } finally { await host.close(); }
  }
});

test('Claude runs beside Pi only where this machine is signed in to it, and shares the one history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harnesses-'));
  const runtimes = [];
  let claudeSignedIn = false;
  const host = await createTabHost({
    stateDir: dir,
    listPiSessions: async () => [],
    createRuntime: async () => stub(runtimes, 'pi', 'openai'),
    claudeAvailable: () => claudeSignedIn, codexAvailable: () => false,
    createClaudeRuntime: async extra => stub(runtimes, 'claude', 'claude-agent', extra),
    listClaudeSessions: async () => [{ id: 'cx-old', path: 'cx-old', agent: 'claude', firstMessage: 'earlier', cwd: dir, modified: 3 }],
  });
  try {
    assert.deepEqual([...AGENTS], ['pi', 'claude', 'codex']);
    assert.equal(AGENTS, SOURCES, 'the harnesses the host runs are the sources the vocabulary names');
    await assert.rejects(host.command({ type: 'tab-new', agent: 'claude' }), /Sign in to Claude Code in imperfect/);
    assert.equal((await host.command({ type: 'sessions' })).some(r => r.agent === 'claude'), false);
    claudeSignedIn = true;
    assert.ok((await host.command({ type: 'sessions' })).some(r => r.agent === 'claude' && r.id === 'cx-old'));
    // An OpenAI model picked in a Pi tab stays in Pi; a Claude model moves to Claude.
    await host.command({ type: 'model', provider: 'openai', modelId: 'm' });
    assert.equal(runtimes.length, 1);
    const moved = await host.command({ type: 'model', provider: 'claude-agent', modelId: 'm' });
    assert.equal(host.snapshot(moved.__selectedTabId).agent, 'claude');
    assert.deepEqual(host.snapshot().tabs.map(t => t.agent), ['claude'], 'the empty Pi tab became the Claude one');
    // The next new tab starts on the model picked last.
    const next = await host.command({ type: 'tab-new' });
    assert.equal(host.snapshot(next.id).agent, 'claude');
    const tab = await host.command({ type: 'tab-new', agent: 'claude' });
    assert.equal(host.snapshot(tab.id).agent, 'claude');
    // One list across both harnesses: a person picks a model, not a harness.
    assert.deepEqual((await host.command({ type: 'models' }, tab.id)).map(m => m.engine).sort(), ['claude', 'pi']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'open-tabs.json'))).some(r => r.agent === 'claude'), false, 'no session until the first turn');
    await host.command({ type: 'prompt', text: 'hello' }, tab.id);
    assert.equal(host.snapshot(tab.id).sessionId, 'claude-session');
    assert.equal(JSON.parse(readFileSync(join(dir, 'open-tabs.json'))).some(r => r.agent === 'claude' && r.session === 'claude-session'), true);
    const rows = await host.command({ type: 'sessions' });
    assert.equal(rows.some(r => r.agent === 'codex'), false, 'a harness not signed in here lists no history');
    // Opened from history as listed: Claude resumes by its id, not a path made of it.
    const row = rows.find(r => r.id === 'cx-old');
    assert.equal(row.path, 'cx-old');
    const opened = await host.command({ type: 'tab-open', path: row.path, agent: row.agent, cwd: row.cwd });
    assert.equal(host.snapshot(opened.id).agent, 'claude');
    assert.equal(runtimes.at(-1).snapshot().sessionFile, 'cx-old');
  } finally { await host.close(); }
});

test('Codex runs beside Pi and Claude only where this machine is signed in to it, and its models stay its own', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harnesses-'));
  const runtimes = [];
  let codexSignedIn = false;
  const rollout = '/home/x/.codex/sessions/2026/10/17/rollout-2026-10-17T10-00-00-0199aaaa-0000-7000-8000-000000000001.jsonl';
  const options = {
    stateDir: dir, firstTab: null,
    listPiSessions: async () => [], listClaudeSessions: async () => [],
    createRuntime: async () => stub(runtimes, 'pi', 'openai-codex'),
    claudeAvailable: () => true,
    createClaudeRuntime: async extra => stub(runtimes, 'claude', 'claude-agent', extra),
    codexAvailable: () => codexSignedIn,
    createCodexRuntime: async extra => stub(runtimes, 'codex', 'codex', extra),
    listCodexSessions: async () => [{ id: '0199aaaa-0000-7000-8000-000000000001', path: rollout, agent: 'codex', firstMessage: 'earlier', cwd: dir, modified: 5 }],
  };
  let host = await createTabHost(options);
  try {
    // What the new-session question reads: every harness, and whether it can start here.
    assert.deepEqual(host.snapshot().harnesses.map(h => [h.agent, h.ready]), [['pi', true], ['claude', true], ['codex', false]]);
    assert.match(host.snapshot().harnesses.find(h => h.agent === 'codex').blocked, /Sign in to Codex in imperfect/);
    await assert.rejects(host.command({ type: 'tab-new', agent: 'codex' }), /Sign in to Codex in imperfect to use your ChatGPT subscription/);
    assert.equal((await host.command({ type: 'sessions' })).some(r => r.agent === 'codex'), false);
    assert.equal((await host.command({ type: 'models' })).some(m => m.engine === 'codex'), false);
    codexSignedIn = true;
    assert.equal(host.snapshot().harnesses.find(h => h.agent === 'codex').ready, true);
    const tab = await host.command({ type: 'tab-new', agent: 'codex' });
    assert.equal(host.snapshot(tab.id).agent, 'codex');
    assert.equal(host.snapshot(tab.id).tabs.find(t => t.id === tab.id).agent, 'codex');
    // One list across the three. Pi's ChatGPT model and Codex's are two rows,
    // each run by its own harness.
    assert.deepEqual((await host.command({ type: 'models' }, tab.id)).map(m => `${m.engine}/${m.provider}`).sort(), ['claude/claude-agent', 'codex/codex', 'pi/openai-codex']);
    const pi = await host.command({ type: 'tab-new', agent: 'pi' });
    const stayed = await host.command({ type: 'model', provider: 'openai-codex', modelId: 'm' }, pi.id);
    assert.equal(host.snapshot(stayed.__selectedTabId).agent, 'pi', 'a Pi GPT model stays in Pi');
    const moved = await host.command({ type: 'model', provider: 'codex', modelId: 'm' }, pi.id);
    assert.equal(host.snapshot(moved.__selectedTabId).agent, 'codex', 'a Codex model moves to Codex');
    // The next new tab, and the question's first answer, is the last model's harness.
    const next = await host.command({ type: 'tab-new' });
    assert.equal(host.snapshot(next.id).agent, 'codex');
    assert.equal(host.snapshot().harnesses.find(h => h.usual).agent, 'codex');
    // A Codex tab has no session until its first turn, then is remembered.
    assert.equal(JSON.parse(readFileSync(join(dir, 'open-tabs.json'))).some(r => r.agent === 'codex'), false);
    await host.command({ type: 'prompt', text: 'hello' }, tab.id);
    assert.equal(host.snapshot(tab.id).sessionId, 'codex-session');
    assert.equal(JSON.parse(readFileSync(join(dir, 'open-tabs.json'))).filter(r => r.agent === 'codex').length, 1);
    // History: listed with its harness, reopened in it by its rollout.
    const row = (await host.command({ type: 'sessions' })).find(r => r.agent === 'codex');
    assert.equal(row.path, rollout);
    const opened = await host.command({ type: 'tab-open', path: row.path, agent: row.agent, cwd: row.cwd });
    assert.equal(host.snapshot(opened.id).agent, 'codex');
    assert.equal(runtimes.at(-1).snapshot().sessionFile, rollout);
    assert.equal((await host.command({ type: 'tab-open', path: row.path, agent: 'codex' })).id, opened.id, 'opened once');
    // A restart brings back what had a turn, in Codex, and drops the empty ones.
    await host.close();
    host = await createTabHost(options);
    assert.deepEqual(host.snapshot().tabs.map(t => host.snapshot(t.id)).filter(s => s.agent === 'codex').map(s => s.sessionFile).sort(), ['codex-session', rollout].sort());
  } finally { await host.close(); }
});

test('the fresh picker exposes and remembers an explicitly chosen last model without starting another runtime', async () => {
  const runtimes = [];
  const host = await createTabHost({
    stateDir: mkdtempSync(join(tmpdir(), 'harness-model-')), firstTab: null,
    listPiSessions: async () => [], listClaudeSessions: async () => [],
    createRuntime: async () => stub(runtimes, 'pi', 'openai'),
    claudeAvailable: () => true, codexAvailable: () => false,
    createClaudeRuntime: async () => stub(runtimes, 'claude', 'claude-agent'),
  });
  try {
    await host.command({ type: 'tab-new', model: { provider: 'claude-agent', id: 'chosen-model' } });
    const usual = host.snapshot().harnesses.find(row => row.usual);
    assert.equal(usual.agent, 'claude');
    assert.deepEqual(usual.model, { provider: 'claude-agent', id: 'chosen-model' });
    assert.equal(runtimes.length, 1);
    await host.command({ type: 'tab-new' });
    assert.equal(host.snapshot().agent, 'claude');
    assert.deepEqual(host.snapshot().harnesses.find(row => row.usual).model, usual.model);
  } finally { await host.close(); }
});

test('an explicit fresh model failure is not silently replaced with the harness default', async () => {
  const runtimes = [], calls = [];
  const host = await createTabHost({
    stateDir: mkdtempSync(join(tmpdir(), 'harness-model-fail-')), firstTab: null,
    listPiSessions: async () => [], listClaudeSessions: async () => [],
    createRuntime: async () => stub(runtimes, 'pi', 'openai'),
    claudeAvailable: () => true, codexAvailable: () => false,
    createClaudeRuntime: async () => {
      const runtime = stub(runtimes, 'claude', 'claude-agent');
      const command = runtime.command;
      runtime.command = async c => { calls.push(c.type); if (c.type === 'model') throw new Error('fixture model unavailable'); return command(c); };
      return runtime;
    },
  });
  try {
    await assert.rejects(host.command({ type: 'tab-new', model: { provider: 'claude-agent', id: 'unavailable' } }), /fixture model unavailable/);
    assert.deepEqual(calls, ['model']);
    assert.equal(host.snapshot().harnesses.find(row => row.usual)?.model, undefined);
  } finally { await host.close(); }
});
