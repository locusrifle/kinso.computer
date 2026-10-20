import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeRuntime as makeClaudeRuntime } from '../claude-runtime.mjs';
const createClaudeRuntime = options => makeClaudeRuntime({ authImpl: () => 'login', accountInfoImpl: async () => ({ apiProvider: 'firstParty', tokenSource: 'claude.ai', apiKeySource: 'none' }), ...options });
import { untilIdle } from '../tabs.mjs';
import { serveMcpOn } from '../mcp.mjs';

// A stand-in for the SDK's query(): it reads the prompt stream and answers
// each turn with the frames Claude Code sends, holding each turn open until
// the test lets it finish.
function fakeQuery() {
  const turns = [];
  let release = [];
  const impl = ({ prompt, options }) => {
    impl.options = options;
    const out = [];
    let wake = null, ended = false;
    const push = frame => { out.push(frame); wake?.(); };
    impl.emit = push; // frames Claude sends with no prompt: a turn of its own
    (async () => {
      for await (const input of prompt) {
        turns.push(input);
        push({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5', claude_code_version: '9.9.9', tools: ['Read'], slash_commands: ['review'] });
        push({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Look' } } });
        push({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }] } });
        push({ type: 'user', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents' }] } });
        await new Promise(resolve => release.push(resolve));
        push({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'Done.' }] } });
        push({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 3, output_tokens: 4 }, total_cost_usd: 0.01 });
      }
    })();
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (out.length) { yield out.shift(); continue; }
          await new Promise(resolve => { wake = resolve; });
          wake = null;
        }
      },
      interrupt: async () => {},
      close: () => { ended = true; wake?.(); },
      supportedModels: async () => [{ value: 'claude-opus-5', displayName: 'Opus 5', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }],
      setModel: async () => {},
      applyFlagSettings: async () => {},
      setPermissionMode: async () => {},
    };
  };
  impl.turns = turns;
  impl.finish = () => { const next = release; release = []; next.forEach(r => r()); };
  return impl;
}

const until = async check => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(check()); };

test('a subscription account without tokenSource resumes the same session with its saved model', async () => {
  const queryImpl = fakeQuery();
  const runtime = await createClaudeRuntime({
    sessionPath: 's1', model: { provider: 'claude-agent', id: 'sonnet' }, queryImpl,
    accountInfoImpl: async () => ({ apiProvider: 'firstParty', subscriptionType: 'Claude Pro' }),
    sessionInfoImpl: async () => ({ customTitle: 'Original conversation' }),
    sessionMessagesImpl: async () => [{ type: 'user', message: { content: 'original history' } }],
  });
  try {
    assert.equal(queryImpl.options.resume, 's1');
    assert.equal(queryImpl.options.model, 'sonnet');
    assert.equal(runtime.snapshot().messages[0].content[0].text, 'original history');
    assert.equal((await runtime.command({ type: 'prompt', text: 'continue' })).accepted, true);
    await until(() => queryImpl.turns.length === 1);
    assert.equal(queryImpl.turns[0].session_id, 's1');
    queryImpl.finish();
    await until(() => !runtime.snapshot().busy);
  } finally { queryImpl.finish(); await runtime.close(); }
});

test('a new Claude session with no model chosen starts on Opus 5.5; the computer\'s own Claude Code setting still wins', async () => {
  for (const [settings, model] of [[{}, 'claude-opus-5-5'], [{ effective: { model: 'sonnet' } }, 'sonnet']]) {
    const queryImpl = fakeQuery();
    const runtime = await createClaudeRuntime({ queryImpl, resolveSettingsImpl: () => settings });
    try { assert.equal(queryImpl.options.model, model); }
    finally { queryImpl.finish(); await runtime.close(); }
  }
});

test('Claude Code answers in the canonical vocabulary, with editable pending steering', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const cwd = mkdtempSync(join(tmpdir(), 'claude-runtime-'));
  const queryImpl = fakeQuery();
  const runtime = await createClaudeRuntime({ cwd, queryImpl, sessionMessagesImpl: async () => [] });
  try {
    assert.equal(queryImpl.options.permissionMode, 'bypassPermissions');
    assert.deepEqual(await runtime.command({ type: 'prompt', text: 'first', requestId: 'r1' }), { accepted: true, queued: false });
    await until(() => runtime.snapshot().messages.some(m => m.role === 'toolResult'));
    // Said during a turn, the next thing waits in the queue and can be taken back.
    await runtime.command({ type: 'prompt', text: 'second', requestId: 'r2' });
    assert.deepEqual(runtime.snapshot().queue.items, [{ id: 'r2', lane: 'steering', text: 'second', images: [] }]);
    assert.equal((await runtime.command({ type: 'queue-take', queueId: 'r2' })).item.text, 'second');
    await runtime.command({ type: 'prompt', text: 'third', requestId: 'r3' });
    const idle = untilIdle(runtime);
    queryImpl.finish();
    await until(() => queryImpl.turns.length === 2);
    queryImpl.finish();
    await idle;
    const snap = runtime.snapshot();
    assert.equal(snap.source, 'claude');
    assert.equal(snap.sessionId, 's1');
    assert.equal(snap.model.name, 'Opus 5');
    assert.equal(snap.busy, false);
    assert.deepEqual(snap.messages.filter(m => m.role === 'user').map(m => m.content[0].text), ['first', 'third']);
    const result = snap.messages.find(m => m.role === 'toolResult');
    assert.deepEqual(result.content, [{ type: 'text', text: 'contents' }]);
    assert.equal(snap.messages.at(-1).content[0].text, 'Done.');
    await runtime.command({ type: 'level', level: 'high' });
    assert.equal(runtime.snapshot().level, 'high');
  } finally { await runtime.close(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

test('Claude AskUserQuestion uses the shared questions dialog and returns its answers or cancellation', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const queryImpl = fakeQuery();
  const runtime = await createClaudeRuntime({ cwd: mkdtempSync(join(tmpdir(), 'claude-questions-')), queryImpl, sessionMessagesImpl: async () => [] });
  const questions = [{ header: 'Direction', question: 'Which way?', options: [{ label: 'Left', description: 'Go left.' }, { label: 'Right', description: 'Go right.' }], multiSelect: false }];
  try {
    const pending = queryImpl.options.canUseTool('AskUserQuestion', { questions });
    const dialog = runtime.snapshot().ui.dialogs[0];
    assert.equal(dialog.method, 'questions');
    assert.deepEqual(dialog.questions, questions);
    await runtime.command({ type: 'dialog', dialogId: dialog.id, value: { 'Which way?': 'Right' } });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { questions, answers: { 'Which way?': 'Right' } } });
    const cancelled = queryImpl.options.canUseTool('AskUserQuestion', { questions });
    await runtime.command({ type: 'dialog', dialogId: runtime.snapshot().ui.dialogs[0].id, cancelled: true });
    assert.equal((await cancelled).behavior, 'deny');
  } finally { await runtime.close(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

// A query that answers one turn by putting a command in the background,
// then says whatever the test hands it about that command afterwards.
function backgroundQuery() {
  const out = []; let wake = null, ended = false;
  const push = frame => { out.push(frame); wake?.(); };
  const impl = ({ prompt }) => {
    (async () => {
      for await (const _ of prompt) {
        push({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 60' } }] } });
        push({ type: 'user', session_id: 's1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: b1. Output is being written to: /tmp/b1.output' }] } });
        push({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'sleep 60' }], session_id: 's1' });
        push({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } });
      }
    })();
    return {
      async *[Symbol.asyncIterator]() { while (!ended) { if (out.length) { yield out.shift(); continue; } await new Promise(r => { wake = r; }); wake = null; } },
      interrupt: async () => {}, close: () => { ended = true; wake?.(); },
      supportedModels: async () => [], setModel: async () => {}, applyFlagSettings: async () => {}, setPermissionMode: async () => {},
    };
  };
  impl.say = push;
  return impl;
}

test('a tab waits on work Claude put in the background, and stops waiting when the SDK says it is done', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  for (const done of [
    // The finished notice as its own message (it may never come as words in a tool result).
    { type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', output_file: '/tmp/b1.output', summary: 'done', session_id: 's1' },
    // The whole live set, now empty.
    { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w1', task_type: 'watch', description: 'watcher', ambient: true }], session_id: 's1' },
  ]) {
    const queryImpl = backgroundQuery();
    const runtime = await createClaudeRuntime({ cwd: mkdtempSync(join(tmpdir(), 'claude-bg-')), queryImpl, sessionMessagesImpl: async () => [] });
    try {
      await runtime.command({ type: 'prompt', text: 'start it', requestId: 'r1' });
      await until(() => runtime.snapshot().operation === 'background');
      queryImpl.say(done);
      await until(() => runtime.snapshot().operation === null);
    } finally { await runtime.close(); }
  }
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

test('a resumed Claude session reads its transcript back from the SDK', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const cwd = mkdtempSync(join(tmpdir(), 'claude-resume-'));
  const rows = [
    { type: 'user', message: { content: 'what is in a.txt?' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } }, { type: 'text', text: '[Image: source: /home/me/.claude/projects/x/tool-results/mcp-imperfect-blob-1.png]' }] }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'It says hi.' }] } },
  ];
  const queryImpl = fakeQuery();
  const runtime = await createClaudeRuntime({ cwd, sessionPath: 'old', queryImpl, sessionMessagesImpl: async id => id === 'old' ? rows : [] });
  try {
    assert.equal(queryImpl.options.resume, 'old');
    await until(() => runtime.snapshot().messages.length === 4);
    const snap = runtime.snapshot();
    assert.equal(snap.name, 'what is in a.txt?');
    assert.deepEqual(snap.messages.map(m => m.role), ['user', 'assistant', 'toolResult', 'assistant']);
    assert.equal(snap.messages[2].toolName, 'Read');
    // A picture the tool handed back (a screenshot read) stays in the transcript, to be shown.
    assert.deepEqual(snap.messages[2].content.at(-1), { type: 'image', data: 'iVBORw0K', mimeType: 'image/png' });
  } finally { await runtime.close(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

test('a resumed Claude runtime is not exposed before its history is loaded', async () => {
  let release, started = false, ready = false;
  const history = new Promise(resolve => { release = resolve; });
  const opening = createClaudeRuntime({ sessionPath: 'kept', sessionMessagesImpl: () => history, queryImpl: () => {
    started = true;
    return { async *[Symbol.asyncIterator]() {}, close() {}, supportedModels: async () => [] };
  } });
  opening.then(() => { ready = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false);
  assert.equal(started, false);
  release([{ type: 'user', message: { content: 'past conversation' } }]);
  const runtime = await opening;
  try {
    assert.equal(runtime.snapshot().messages[0].content[0].text, 'past conversation');
    assert.equal(runtime.snapshot().sessionId, 'kept');
  } finally { await runtime.close(); }
});

test('a machine that is not signed in to Claude cannot start a Claude tab, but still shows one it had', async () => {
  const saved = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY; delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'claude-none-'));
  try {
    await assert.rejects(createClaudeRuntime({ authImpl: () => null, queryImpl: fakeQuery() }), /not signed in to Claude/);
    const rows = [{ type: 'user', message: { content: 'hello?' } }, { type: 'assistant', message: { content: [{ type: 'text', text: 'hi.' }] } }];
    const runtime = await createClaudeRuntime({ cwd: mkdtempSync(join(tmpdir(), 'claude-kept-')), sessionPath: 'kept', queryImpl: fakeQuery(), sessionMessagesImpl: async () => rows });
    try {
      await until(() => runtime.snapshot().messages.length === 2);
    } finally { await runtime.close(); }
  } finally { process.env = saved; }
});

// imperfect adds no words to Claude's system prompt: Claude Code reads the
// person's AGENTS.md (or CLAUDE.md) itself, and nothing is written into their
// tree. imperfect's tools are in the prompt from the first turn, since how to
// use show and dev_server is written in their descriptions.
test('Claude gets its own prompt, the person\'s instruction files, and imperfect\'s tools up front', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const dir = mkdtempSync(join(tmpdir(), 'claude-context-'));
  try {
    writeFileSync(join(dir, 'AGENTS.md'), 'rules');
    // Made before imperfect serves (a tab restored as it starts), Claude is
    // handed its tools once it does.
    const early = fakeQuery(), joined = [];
    const before = await createClaudeRuntime({ cwd: dir, queryImpl: args => ({ ...early(args), setMcpServers: async servers => { joined.push(servers); } }), sessionMessagesImpl: async () => [] });
    assert.deepEqual(early.options.mcpServers, {});
    serveMcpOn(5999);
    assert.equal(joined[0].imperfect.url, 'http://127.0.0.1:5999/mcp');
    await before.close();
    const queryImpl = fakeQuery();
    const runtime = await createClaudeRuntime({ cwd: dir, queryImpl, sessionMessagesImpl: async () => [] });
    const { options } = queryImpl;
    assert.equal(options.systemPrompt, undefined);
    assert.deepEqual(options.settingSources, [], 'filesystem settings cannot override subscription billing');
    // Claude Code's tools that only add noise here are taken away; its working ones stay.
    for (const tool of ['Workflow', 'Skill', 'ScheduleWakeup', 'PushNotification', 'ExitPlanMode']) assert.ok(options.disallowedTools.includes(tool), tool);
    for (const tool of ['Bash', 'Agent', 'AskUserQuestion', 'TaskStop', 'WebSearch']) assert.ok(!options.disallowedTools.includes(tool), tool);
    // One MCP server, imperfect's, with this session's own token, up front rather than behind tool search.
    const { imperfect } = options.mcpServers;
    assert.equal(imperfect.type, 'http');
    assert.equal(imperfect.url, 'http://127.0.0.1:5999/mcp');
    assert.match(imperfect.headers.Authorization, /^Bearer \S{20,}$/);
    assert.notEqual(imperfect.headers.Authorization, joined[0].imperfect.headers.Authorization);
    assert.equal(imperfect.alwaysLoad, true);
    // A slow tool (a picture) is waited for: Claude Code's own limit is 60 seconds.
    assert.equal(imperfect.timeout, 24 * 60 * 60 * 1000);
    assert.equal(joined[0].imperfect.timeout, imperfect.timeout, 'and for tools that join once imperfect serves');
    await runtime.close();
    assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), 'rules');
  } finally { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

// What Claude actually sent, recorded from the Agent SDK on a signed-in
// machine (test/fixtures/claude-sdk.jsonl): init, a streamed sentence, a Bash
// call and a Write call with their results, the answer, the result frame.
test('the recorded Claude stream folds into the canonical transcript through the same adapter', async () => {
  const { claudeEvents, createClaudeContext } = await import('../claude-runtime.mjs');
  const { createTranscript } = await import('../transcript.mjs');
  const frames = readFileSync(new URL('./fixtures/claude-sdk.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const t = createTranscript();
  const ctx = createClaudeContext();
  t.absorb({ type: 'user', content: 'Reply with exactly the words: hello from claude…' });
  t.absorb({ type: 'turn', state: 'start' });
  let session = null;
  for (const frame of frames) for (const event of claudeEvents(frame, ctx)) { if (event.type === 'session') session = event; else t.absorb(event); }
  const snap = t.view('claude');
  assert.equal(session.version, frames[0].claude_code_version);
  assert.ok(session.tools.includes('Bash'));
  assert.deepEqual(snap.messages.map(m => m.role), ['user', 'assistant', 'assistant', 'toolResult', 'assistant', 'toolResult', 'assistant']);
  assert.equal(snap.messages[1].content[0].text, 'hello from claude');
  assert.equal(snap.messages[2].content[0].name, 'Bash');
  assert.equal(snap.messages[3].content[0].text, 'probe-ok');
  assert.equal(snap.messages[4].content[0].name, 'Write');
  assert.match(snap.messages[6].content[0].text, /probe-ok/);
  assert.equal(snap.messages[6].model, 'claude-opus-5-5');
  assert.equal(snap.streaming, false);
  assert.equal(snap.failed, null);
  assert.equal(snap.stats.tokens.output, 204);
  assert.ok(snap.stats.contextUsage.contextWindow > 0);
});

test('a missing Claude resume never becomes a fresh conversation', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const cwd = mkdtempSync(join(tmpdir(), 'claude-runtime-'));
  const starts = [];
  // Before any prompt Claude Code reports its SessionStart hooks under an id
  // it never writes; resuming such an id fails as soon as Claude Code starts.
  const queryImpl = ({ prompt, options }) => {
    starts.push({ ...options });
    const missing = options.resume === 'ghost';
    const frames = [{ type: 'system', subtype: 'hook_started', session_id: 'ghost' }];
    return {
      async *[Symbol.asyncIterator]() {
        yield frames.shift();
        if (missing) throw new Error('Claude Code returned an error result: No conversation found with session ID: ghost');
        for await (const input of prompt) {
          yield { type: 'system', subtype: 'init', session_id: 'real', model: 'claude-opus-5' };
          yield { type: 'assistant', session_id: 'real', message: { content: [{ type: 'text', text: `heard ${input.message.content[0].text}` }] } };
          yield { type: 'result', subtype: 'success', session_id: 'real' };
        }
      },
      close() {}, interrupt: async () => {}, supportedModels: async () => [],
    };
  };
  const fresh = await createClaudeRuntime({ cwd, queryImpl, sessionMessagesImpl: async () => [] });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(fresh.session().sessionId, null);
  await fresh.close();

  const before = starts.length;
  await assert.rejects(createClaudeRuntime({ cwd, sessionPath: 'ghost', queryImpl, sessionMessagesImpl: async () => [] }), /not found.*refusing/);
  await assert.rejects(createClaudeRuntime({ cwd, sessionPath: 'ghost', queryImpl, sessionMessagesImpl: async () => { throw new Error('unreadable'); } }), /Cannot read Claude session ghost: unreadable/);
  assert.equal(starts.length, before, 'missing history does not start an SDK process');
  const runtime = await createClaudeRuntime({ cwd, sessionPath: 'ghost', queryImpl, sessionMessagesImpl: async () => [{ type: 'user', message: { content: 'past' } }] });
  try {
    await until(() => /No conversation found/.test(runtime.snapshot().failed ?? ''));
    const count = starts.length;
    await assert.rejects(runtime.command({ type: 'prompt', text: 'hello', requestId: 'r1' }), /No conversation found/);
    await runtime.command({ type: 'models' });
    assert.equal(starts.length, count);
    assert.equal(starts.at(-1).resume, 'ghost');
    assert.equal(runtime.session().sessionId, 'ghost');
    assert.equal(runtime.snapshot().queue.items.length, 0);
  } finally { await runtime.close(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

test('Claude rejects changed session IDs and missing-resume result frames', async () => {
  for (const frame of [
    { type: 'system', subtype: 'init', session_id: 'different' },
    { type: 'result', subtype: 'error_during_execution', session_id: 'kept', errors: ['No conversation found with session ID: kept'] },
  ]) {
    let starts = 0;
    const runtime = await createClaudeRuntime({ sessionPath: 'kept', sessionMessagesImpl: async () => [{ type: 'user', message: { content: 'past' } }], queryImpl: () => {
      starts++;
      return { async *[Symbol.asyncIterator]() { yield frame; }, close() {}, supportedModels: async () => [] };
    } });
    try {
      await until(() => Boolean(runtime.snapshot().failed));
      await assert.rejects(runtime.command({ type: 'prompt', text: 'retry' }), /refusing|No conversation found/);
      assert.equal(runtime.session().sessionId, 'kept');
      assert.equal(starts, 1);
    } finally { await runtime.close(); }
  }
});

test('a new Claude conversation resumes its learned ID when its SDK query ends', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const starts = [];
  const runtime = await createClaudeRuntime({ queryImpl: ({ prompt, options }) => {
    starts.push(options.resume);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const input of prompt) {
          yield { type: 'system', subtype: 'init', session_id: 'learned' };
          yield { type: 'result', subtype: 'success', session_id: 'learned' };
          throw new Error('SDK ended');
        }
      },
      close() {}, supportedModels: async () => [],
    };
  } });
  try {
    await runtime.command({ type: 'prompt', text: 'first' });
    await until(() => runtime.snapshot().failed === 'SDK ended');
    await runtime.command({ type: 'prompt', text: 'second' });
    await until(() => starts.length === 2 && runtime.snapshot().failed === 'SDK ended');
    assert.deepEqual(starts, [undefined, 'learned']);
    assert.equal(runtime.session().sessionId, 'learned');
  } finally { await runtime.close(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

test('closing a tab lets its turn finish but does not run what was queued behind it', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const queryImpl = fakeQuery();
  const runtime = await createClaudeRuntime({ cwd: mkdtempSync(join(tmpdir(), 'claude-close-')), queryImpl, sessionMessagesImpl: async () => [] });
  await runtime.command({ type: 'prompt', text: 'first', requestId: 'r1' });
  await until(() => queryImpl.turns.length === 1);
  await runtime.command({ type: 'prompt', text: 'second', requestId: 'r2' });
  const closing = runtime.close();
  queryImpl.finish();
  await closing;
  assert.equal(queryImpl.turns.length, 1);
});

test('a new conversation opens on what Claude Code was put together from', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const cwd = mkdtempSync(join(tmpdir(), 'claude-overview-'));
  writeFileSync(join(cwd, 'AGENTS.md'), 'Read me when asked.');
  const base = fakeQuery();
  const queryImpl = args => ({
    ...base(args),
    initializationResult: async () => ({}),
    mcpServerStatus: async () => [{ name: 'imperfect', status: 'connected', tools: [{ name: 'show' }, { name: 'dev_server' }] }, { name: 'notes', status: 'failed' }],
    getContextUsage: async () => ({ memoryFiles: [{ path: join(cwd, 'CLAUDE.md') }], skills: { skillFrontmatter: [{ name: 'run', source: 'built-in' }, { name: 'omarchy', source: 'userSettings' }] } }),
  });
  const runtime = await createClaudeRuntime({ cwd, queryImpl, sessionMessagesImpl: async () => [] });
  try {
    assert.equal(runtime.snapshot().startup.sections.some(s => s.name === 'Context'), false, 'a pointer is not loaded context');
    await until(() => runtime.snapshot().startup.sections.some(s => s.name === 'MCP'));
    const { version, cwd: folder, sections } = runtime.snapshot().startup;
    // Its version is said once Claude Code says it, with its first answer.
    assert.equal(version, 'Claude Code');
    assert.equal(folder, cwd);
    const line = Object.fromEntries(sections.map(s => [s.name, s.compact]));
    assert.deepEqual(line, { Context: 'CLAUDE.md', MCP: 'imperfect, notes (failed)', Tools: 'dev_server, show' });
    assert.equal(sections.find(s => s.name === 'MCP').expanded, 'imperfect: show, dev_server\nnotes: failed');
  } finally { await runtime.close(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

test('Claude startup retries a failed survey', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const cwd = mkdtempSync(join(tmpdir(), 'claude-survey-'));
  const base = fakeQuery();
  let starts = 0, surveys = 0;
  const queryImpl = args => {
    const generation = ++starts;
    return {
      ...base(args),
      initializationResult: async () => {
        if (++surveys === 1) throw new Error('not initialized yet');
      },
      mcpServerStatus: async () => [{ name: `server-${generation}`, status: 'connected', tools: [] }],
      getContextUsage: async () => ({ memoryFiles: [{ path: join(cwd, `context-${generation}.md`) }] }),
    };
  };
  const runtime = await createClaudeRuntime({ cwd, queryImpl, sessionMessagesImpl: async () => [] });
  const context = () => runtime.snapshot().startup.sections.find(s => s.name === 'Context')?.compact;
  try {
    await until(() => context() === 'context-1.md');
    assert.ok(surveys >= 2);
    assert.equal(runtime.snapshot().startup.sections.find(s => s.name === 'MCP').compact, 'server-1');
  } finally { await runtime.close(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

test('a turn the person began settles with a chime; one Claude began itself settles quietly', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const cwd = mkdtempSync(join(tmpdir(), 'claude-runtime-'));
  const queryImpl = fakeQuery();
  const runtime = await createClaudeRuntime({ cwd, queryImpl, sessionMessagesImpl: async () => [] });
  try {
    await runtime.command({ type: 'prompt', text: 'hello', requestId: 'r1' });
    await until(() => queryImpl.turns.length === 1);
    queryImpl.finish();
    await untilIdle(runtime);
    assert.equal(runtime.snapshot().turnAsked, true);
    // A background task reports back: Claude answers it without being sent anything.
    queryImpl.emit({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The task' } } });
    queryImpl.emit({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'The task finished.' }] } });
    queryImpl.emit({ type: 'result', subtype: 'success', session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
    await until(() => runtime.snapshot().turnAsked === false);
  } finally { await runtime.close(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

test('stopping a turn hands what was waiting back to the composer', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const queryImpl = fakeQuery();
  const runtime = await createClaudeRuntime({ cwd: mkdtempSync(join(tmpdir(), 'claude-abort-')), queryImpl, sessionMessagesImpl: async () => [] });
  try {
    await runtime.command({ type: 'prompt', text: 'first', requestId: 'r1' });
    await until(() => queryImpl.turns.length === 1);
    const image = { type: 'image', mimeType: 'image/png', data: Buffer.from('synthetic image').toString('base64') };
    await runtime.command({ type: 'prompt', text: 'second', images: [image], requestId: 'r2' });
    assert.deepEqual(await runtime.command({ type: 'abort' }), { steering: ['second'], items: [{ id: 'r2', lane: 'steering', text: 'second', images: [image] }] });
    assert.equal((await runtime.command({ type: 'queue-take', queueId: 'r2' })).item, null);
  } finally { queryImpl.finish(); await runtime.close(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

test('a Claude session is named in Claude Code itself, and opens again under that name', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const cwd = mkdtempSync(join(tmpdir(), 'claude-name-'));
  const queryImpl = fakeQuery();
  const renamed = [];
  const renameImpl = async (id, title) => { renamed.push([id, title]); };
  const runtime = await createClaudeRuntime({ cwd, queryImpl, renameImpl, sessionMessagesImpl: async () => [] });
  try {
    // Named before there is a session: written once its first turn has ended.
    await runtime.command({ type: 'name', name: 'Tidy the docs' });
    assert.equal(runtime.snapshot().name, 'Tidy the docs');
    await runtime.command({ type: 'prompt', requestId: 'r1', text: 'hello' });
    await until(() => queryImpl.turns.length === 1);
    assert.deepEqual(renamed, []);
    queryImpl.finish();
    await until(() => renamed.length === 1);
    assert.deepEqual(renamed, [['s1', 'Tidy the docs']]);
    await runtime.command({ type: 'name', name: 'Tidy every doc' });
    assert.deepEqual(renamed.at(-1), ['s1', 'Tidy every doc']);
  } finally { await runtime.close(); }
  const reopened = await createClaudeRuntime({ cwd, sessionPath: 's1', queryImpl: fakeQuery(), sessionInfoImpl: async id => ({ sessionId: id, customTitle: 'Tidy every doc' }),
    sessionMessagesImpl: async () => [{ type: 'user', session_id: 's1', message: { role: 'user', content: 'hello' } }] });
  try { assert.equal(reopened.snapshot().name, 'Tidy every doc'); }
  finally { await reopened.close(); }
});

// Claude Code reads what it is sent as it arrives, whether or not a turn is
// running, and takes a message marked 'next' at its next step.
test('every busy Claude prompt steers, even an obsolete transport behavior', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  const cwd = mkdtempSync(join(tmpdir(), 'claude-steer-'));
  const sent = [];
  let out = [], wake = null, release = null;
  const push = frame => { out.push(frame); wake?.(); };
  const queryImpl = ({ prompt }) => {
    (async () => {
      for await (const input of prompt) {
        sent.push(input);
        // A message taken mid-turn is not a turn of its own.
        if (input.priority === 'next') continue;
        push({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5' });
        push({ type: 'stream_event', session_id: 's1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Working' } } });
        void new Promise(resolve => { release = resolve; }).then(() => {
          push({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text: 'Done.' }] } });
          push({ type: 'result', subtype: 'success', session_id: 's1', usage: {} });
        });
      }
    })();
    return {
      async *[Symbol.asyncIterator]() { for (;;) { if (out.length) { yield out.shift(); continue; } await new Promise(resolve => { wake = resolve; }); wake = null; } },
      interrupt: async () => {}, close: () => {}, supportedModels: async () => [],
    };
  };
  const runtime = await createClaudeRuntime({ cwd, queryImpl, sessionMessagesImpl: async () => [] });
  try {
    await runtime.command({ type: 'prompt', text: 'first', requestId: 'r1' });
    await until(() => runtime.snapshot().streaming && sent.length === 1);
    assert.equal(sent[0].priority, undefined, 'with nothing running it starts a turn');
    const steered = await runtime.command({ type: 'prompt', text: 'go this way', requestId: 'r2' });
    assert.equal(steered.steered, true);
    await until(() => sent.length === 2);
    assert.equal(sent[1].priority, 'next', 'taken at the next step, mid-turn');
    assert.equal(sent[1].message.content[0].text, 'go this way');
    assert.equal(runtime.snapshot().queue.items.length, 0);
    await runtime.command({ type: 'prompt', text: 'and after', behavior: 'followUp', requestId: 'r3' });
    await until(() => sent.length === 3);
    assert.equal(sent[2].priority, 'next');
    assert.deepEqual(runtime.snapshot().queue.items, []);
    assert.equal((await runtime.command({ type: 'queue-take', queueId: 'r3' })).item, null, 'late editing cannot resend consumed steering');
    release();
    assert.equal(sent[2].message.content[0].text, 'and after');
    assert.deepEqual(runtime.snapshot().messages.filter(m => m.role === 'user').map(m => m.content[0].text), ['first', 'go this way', 'and after']);
  } finally { release?.(); await runtime.close(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
});

test("Claude's compaction is one divider: its status starts it, its boundary ends it with the counts, and the summary is never the person's", async () => {
  const { claudeEvents, createClaudeContext } = await import('../claude-runtime.mjs');
  const ctx = createClaudeContext();
  assert.deepEqual(claudeEvents({ type: 'system', subtype: 'status', status: 'compacting' }, ctx), [{ type: 'compaction', state: 'start' }]);
  assert.deepEqual(claudeEvents({ type: 'system', subtype: 'status', status: 'requesting' }, ctx), []);
  assert.deepEqual(claudeEvents({ type: 'system', subtype: 'status', status: null }, ctx), [{ type: 'compaction', state: 'stop' }]);
  assert.deepEqual(claudeEvents({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 392737, post_tokens: 6298 } }, ctx),
    [{ type: 'compaction', state: 'end', tokensBefore: 392737, tokensAfter: 6298 }]);
  const summary = { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.' } };
  assert.deepEqual(claudeEvents(summary, ctx), [{ type: 'compaction', state: 'end' }]);
  assert.deepEqual(claudeEvents({ type: 'user', isSynthetic: true, message: { role: 'user', content: 'written by Claude Code' } }, ctx), []);
  assert.deepEqual(claudeEvents({ type: 'user', message: { role: 'user', content: 'mine' } }, ctx), [{ type: 'user', content: [{ type: 'text', text: 'mine' }] }]);
});
