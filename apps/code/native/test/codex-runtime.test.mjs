import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { codexEvents, codexItemEvents, createCodexRuntime, listCodexSessions } from '../codex-runtime.mjs';
import { codexAuth, codexServer, createCodexSignIn } from '../codex-auth.mjs';
import { createTranscript } from '../transcript.mjs';
import { serveMcp, serveMcpOn } from '../mcp.mjs';
import { startFakeResponses, fakeCodexConfig } from './fixtures/fake-responses.mjs';

const until = async (check, what, ms = 20000) => {
  const end = Date.now() + ms;
  while (!(await check())) { assert.ok(Date.now() < end, what); await new Promise(resolve => setTimeout(resolve, 20)); }
};

// Recorded from codex-cli 0.163.0's own app server (test/fixtures/
// codex-app-server.jsonl), its model played by fixtures/fake-responses.mjs:
// the person's message, a reasoning summary streamed and settled, one shell
// command with its output, the answer streamed and settled, token counts and
// the turn's end.
test('the recorded Codex turn folds into the canonical transcript through the same adapter', () => {
  const frames = readFileSync(new URL('./fixtures/codex-app-server.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const t = createTranscript();
  const session = [];
  let partialSeen = false;
  for (const frame of frames) for (const event of codexEvents(frame)) {
    if (event.type === 'session') session.push(event); else t.absorb(event);
    if (t.view('codex').partial?.content?.some(b => b.type === 'text' && b.text.startsWith('The command printed'))) partialSeen = true;
  }
  const snap = t.view('codex');
  assert.equal(snap.source, 'codex');
  assert.ok(partialSeen, 'the answer streams before it settles');
  assert.deepEqual(snap.messages.map(m => m.role), ['user', 'assistant', 'assistant', 'toolResult', 'assistant']);
  assert.equal(snap.messages[0].content[0].text, 'Run echo hello-from-codex');
  assert.equal(snap.messages[1].content[0].type, 'thinking');
  assert.equal(snap.messages[1].content[0].thinking, '**Planning** I will run echo.');
  assert.equal(snap.messages[2].content[0].name, 'bash');
  assert.match(snap.messages[2].content[0].arguments.command, /echo hello-from-codex/);
  assert.equal(snap.messages[3].content[0].text, 'hello-from-codex\n');
  assert.equal(snap.messages[3].isError, false);
  assert.equal(snap.messages[4].content[0].text, 'The command printed hello-from-codex.');
  assert.equal(snap.streaming, false);
  assert.equal(snap.failed, null);
  assert.deepEqual(snap.stats.tokens, { input: 2100, output: 80, cacheRead: 400, cacheWrite: 0 });
  assert.equal(snap.stats.contextUsage.contextWindow, 258400);
  assert.deepEqual(session, []);
});

test('read back, a thread draws as it did live: pictures, tools, compaction, a failed turn', () => {
  const dot = 'iVBORw0KGgo=';
  const user = codexItemEvents({ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'look', text_elements: [] }, { type: 'image', url: `data:image/png;base64,${dot}` }] });
  assert.deepEqual(user, [{ type: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: dot, mimeType: 'image/png' }] }]);
  // imperfect's own tools come back through MCP, words and pictures alike.
  const [shown] = codexItemEvents({ type: 'mcpToolCall', id: 'm', server: 'imperfect', tool: 'show', status: 'completed', arguments: { path: '/x.png' }, result: { content: [{ type: 'text', text: 'shown' }, { type: 'image', data: dot, mimeType: 'image/png' }] }, error: null });
  assert.equal(shown.name, 'mcp__imperfect__show');
  assert.equal(shown.output, 'shown');
  assert.deepEqual(shown.images, [{ type: 'image', data: dot, mimeType: 'image/png' }]);
  assert.equal(codexItemEvents({ type: 'mcpToolCall', id: 'm', server: 's', tool: 't', status: 'failed', error: { message: 'no' } })[0].isError, true);
  assert.equal(codexItemEvents({ type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'a.txt', kind: 'add', diff: '+a' }] })[0].output, 'a.txt\n+a');
  assert.deepEqual(codexItemEvents({ type: 'imageGeneration', id: 'g', status: 'completed', result: dot, revisedPrompt: 'a dot' })[0].images, [{ type: 'image', data: dot, mimeType: 'image/png' }]);
  assert.deepEqual(codexItemEvents({ type: 'contextCompaction', id: 'c' }, false), [{ type: 'compaction', state: 'start' }]);
  assert.deepEqual(codexItemEvents({ type: 'plan', id: 'p', text: 'x' }), []);
  // Started, a tool runs; nothing is said of a message until it is complete.
  assert.equal(codexItemEvents({ type: 'commandExecution', id: 'x', command: 'ls', status: 'inProgress' }, false)[0].status, 'running');
  assert.deepEqual(codexItemEvents({ type: 'agentMessage', id: 'a', text: '' }, false), []);
  const failed = codexEvents({ method: 'turn/completed', params: { turn: { id: 't', status: 'failed', error: { message: 'usage limit reached' } } } });
  assert.deepEqual(failed, [{ type: 'error', message: 'usage limit reached' }, { type: 'turn', state: 'end', failed: 'usage limit reached' }]);
  assert.deepEqual(codexEvents({ method: 'turn/completed', params: { turn: { id: 't', status: 'interrupted' } } }), [{ type: 'turn', state: 'end' }]);
  assert.deepEqual(codexEvents({ method: 'error', params: { willRetry: true, error: { message: 'Reconnecting... 2/5' } } }), []);
});

// Codex's own files, as the CLI leaves them: a conversation from its terminal
// (the format before items), one from an app server, a `codex exec` run and
// a subagent's thread, which are not conversations to reopen, and a name.
test('Codex history is read from its own rollouts, named as Codex named them', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  const day = join(home, 'sessions', '2026', '10', '17');
  mkdirSync(day, { recursive: true });
  const rollout = (id, source, lines) => {
    const path = join(day, `rollout-2026-10-17T10-00-00-${id}.jsonl`);
    writeFileSync(path, [{ type: 'session_meta', payload: { id, cwd: '/w', source, base_instructions: { text: 'x'.repeat(50000) } } }, ...lines].map(line => JSON.stringify(line)).join('\n') + '\n');
    return path;
  };
  const a = rollout('0199aaaa-0000-7000-8000-000000000001', 'cli', [{ type: 'event_msg', payload: { type: 'user_message', message: 'from the terminal' } }]);
  const b = rollout('0199aaaa-0000-7000-8000-000000000002', 'vscode', [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context/>' }] } }, { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'from imperfect' }] } } }]);
  rollout('0199aaaa-0000-7000-8000-000000000003', 'exec', [{ type: 'event_msg', payload: { type: 'user_message', message: 'a script' } }]);
  rollout('0199aaaa-0000-7000-8000-000000000004', { subagent: 'review' }, [{ type: 'event_msg', payload: { type: 'user_message', message: 'a reviewer' } }]);
  rollout('0199aaaa-0000-7000-8000-000000000005', 'cli', []);
  writeFileSync(join(home, 'session_index.jsonl'), [
    { id: '0199aaaa-0000-7000-8000-000000000002', thread_name: 'first name' },
    { id: '0199aaaa-0000-7000-8000-000000000002', thread_name: 'Named' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const rows = (await listCodexSessions({ home })).sort((x, y) => x.path.localeCompare(y.path));
  assert.deepEqual(rows.map(r => [r.path, r.id, r.firstMessage, r.name, r.agent, r.cwd]), [
    [a, '0199aaaa-0000-7000-8000-000000000001', 'from the terminal', '', 'codex', '/w'],
    [b, '0199aaaa-0000-7000-8000-000000000002', 'from imperfect', 'Named', 'codex', '/w'],
  ]);
  assert.ok(rows.every(r => r.modified > 0));
  assert.deepEqual(await listCodexSessions({ home: join(home, 'missing') }), []);
});

test('signed in means a ChatGPT sign-in or a key in Codex\'s own auth.json', () => {
  assert.equal(codexAuth({ CODEX_HOME: mkdtempSync(join(tmpdir(), 'codex-auth-')) }), null);
  const home = mkdtempSync(join(tmpdir(), 'codex-auth-'));
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'a', refresh_token: 'r' } }));
  assert.equal(codexAuth({ CODEX_HOME: home }), 'chatgpt');
  const other = mkdtempSync(join(tmpdir(), 'codex-auth-'));
  writeFileSync(join(other, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }));
  assert.equal(codexAuth({ CODEX_HOME: other }), 'apikey');
});

// An app server that answers as Codex's does, and says what it was asked.
function fakeServer(script = {}) {
  const asked = [];
  const servers = [];
  const make = () => {
    const events = new EventEmitter();
    const server = {
      events, ready: Promise.resolve({ userAgent: 'imperfect/0.163.0 (Linux; x86_64)' }), closed: false, answered: [],
      async request(method, params = {}) {
        asked.push({ method, params });
        if (script[method]) return script[method](params, server);
        if (method === 'model/list') return { data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'workhorse', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }, { id: 'hidden', hidden: true, supportedReasoningEfforts: [] }], nextCursor: null };
        if (method === 'config/read') return { config: { model: null } };
        if (method === 'thread/start') return { thread: { id: 'thread-1', path: '/codex/sessions/rollout-x-thread-1.jsonl' }, model: params.model ?? 'gpt-6.1-sol', reasoningEffort: null, instructionSources: ['/w/AGENTS.md'] };
        if (method === 'thread/resume') return { thread: { id: params.threadId, path: '/codex/sessions/rollout-x-thread-1.jsonl' }, model: params.model, reasoningEffort: null, instructionSources: [] };
        if (method === 'turn/start') return { turn: { id: `turn-${asked.filter(a => a.method === 'turn/start').length}` } };
        return {};
      },
      respond: (id, result) => server.answered.push({ id, result }),
      refuse: (id, message) => server.answered.push({ id, error: message }),
      close() { server.closed = true; },
      say: (method, params) => events.emit('notification', { method, params }),
    };
    servers.push(server);
    return server;
  };
  return { make, asked, servers, last: () => servers.at(-1) };
}

test('a Codex tab runs its turns in Codex with approvals off and imperfect\'s tools, and stops them', async t => {
  const http = createServer(async (req, res) => { if (!await serveMcp(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(404).end(); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  serveMcpOn(http.address().port);
  const fake = fakeServer();
  const runtime = await createCodexRuntime({ cwd: '/w', serverImpl: fake.make, authImpl: () => 'chatgpt', usageImpl: async () => ({ signedIn: true, windows: [] }) });
  t.after(() => runtime.close());
  // No conversation, no session to remember; the overview says what Codex loaded.
  await until(() => runtime.snapshot().startup.sections.some(s => s.name === 'Context'), 'the thread starts for its overview');
  const before = runtime.snapshot();
  assert.equal(before.source, 'codex');
  assert.equal(before.sessionId, null);
  assert.equal(before.sessionFile, null);
  assert.equal(before.startup.version, 'Codex 0.163.0');
  assert.equal(before.model.provider, 'codex');
  const start = fake.asked.find(a => a.method === 'thread/start').params;
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.sandbox, 'danger-full-access');
  assert.equal(start.cwd, '/w');
  assert.match(start.config.mcp_servers.imperfect.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.match(start.config.mcp_servers.imperfect.http_headers.Authorization, /^Bearer /);
  // Codex's extras that only add noise here are off; its working tools are left alone.
  assert.equal(start.config.skills.bundled.enabled, false);
  for (const feature of ['goals', 'apps', 'plugins', 'image_generation', 'browser_use', 'computer_use']) assert.equal(start.config.features[feature], false, feature);
  for (const feature of ['multi_agent', 'shell_tool', 'unified_exec', 'view_image']) assert.equal(start.config.features[feature], undefined, feature);

  // Codex's models are its own, named under its own provider.
  assert.deepEqual((await runtime.command({ type: 'models' })).map(m => [m.provider, m.id, m.name, m.billing]), [['codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', 'ChatGPT subscription']]);
  await assert.rejects(runtime.command({ type: 'model', provider: 'codex', modelId: 'gpt-1' }), /does not offer/);
  assert.deepEqual(await runtime.command({ type: 'level' }), { current: 'low', available: ['low', 'high'] });
  await runtime.command({ type: 'level', level: 'high' });
  // A name given before the first turn waits for the thread to be written.
  await runtime.command({ type: 'name', name: 'Probe' });
  assert.equal(fake.asked.some(a => a.method === 'thread/name/set'), false);

  assert.deepEqual(await runtime.command({ type: 'prompt', text: 'hello', images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }), { accepted: true, queued: false });
  const turn = fake.asked.find(a => a.method === 'turn/start').params;
  assert.equal(turn.threadId, 'thread-1');
  assert.equal(turn.effort, 'high');
  assert.equal(turn.model, 'gpt-6.1-sol');
  assert.deepEqual(turn.input, [{ type: 'text', text: 'hello', text_elements: [] }, { type: 'image', url: 'data:image/png;base64,AAAA' }]);
  let snap = runtime.snapshot();
  assert.equal(snap.sessionId, 'thread-1');
  assert.equal(snap.sessionFile, '/codex/sessions/rollout-x-thread-1.jsonl');
  assert.equal(snap.streaming, true);
  assert.equal(snap.name, 'Probe');
  // Codex says the person's words back; they are drawn once.
  const server = fake.last();
  server.say('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
  server.say('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hello' }, { type: 'image', url: 'data:image/png;base64,AAAA' }] } });
  server.say('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: 'Hi' });
  // A subagent's thread reports through the same server, and is not drawn here.
  server.say('item/agentMessage/delta', { threadId: 'thread-2', turnId: 'turn-9', itemId: 'z', delta: 'not mine' });
  assert.equal(runtime.snapshot().partial.content[0].text, 'Hi');
  // Said during the turn, it goes into that turn.
  assert.deepEqual(await runtime.command({ type: 'prompt', text: 'and more' }), { accepted: true, queued: true, steered: true });
  assert.equal(runtime.snapshot().messages.filter(m => m.role === 'user').length, 1, 'wait for Codex to place the steered input');
  server.say('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'and more' }] } });
  server.say('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: 'Hi there' } });
  server.say('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
  snap = runtime.snapshot();
  assert.deepEqual(snap.messages.map(m => m.role), ['user', 'user', 'assistant']);
  assert.equal(snap.messages[0].content[1].type, 'image');
  assert.equal(snap.messages[2].content[0].text, 'Hi there');
  assert.equal(snap.streaming, false);
  await until(() => fake.asked.some(a => a.method === 'thread/name/set' && a.params.name === 'Probe'), 'named once written');

  // Its questions are the window's questions dialog.
  server.events.emit('request', { id: 7, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', header: 'Pick', question: 'Which?', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] } });
  const dialog = runtime.snapshot().ui.dialogs[0];
  assert.equal(dialog.method, 'questions');
  assert.equal(runtime.snapshot().busy, true);
  await runtime.command({ type: 'dialog', dialogId: dialog.id, value: { 'Which?': 'B' } });
  await until(() => server.answered.length, 'answered');
  assert.deepEqual(server.answered[0], { id: 7, result: { answers: { q1: { answers: ['B'] } } } });
  server.events.emit('request', { id: 8, method: 'item/permissions/requestApproval', params: {} });
  await until(() => server.answered.length === 2, 'refused');
  assert.match(server.answered[1].error, /does not answer/);

  // A stop ends the turn at once; what Codex says of it afterwards is not drawn.
  await runtime.command({ type: 'prompt', text: 'long one' });
  server.say('turn/started', { threadId: 'thread-1', turn: { id: 'turn-3' } });
  assert.deepEqual(await runtime.command({ type: 'abort' }), { steering: [], items: [] });
  assert.deepEqual(fake.asked.find(a => a.method === 'turn/interrupt').params, { threadId: 'thread-1', turnId: 'turn-3' });
  assert.equal(runtime.snapshot().streaming, false);
  const settled = runtime.snapshot().messages.length;
  server.say('item/completed', { threadId: 'thread-1', turnId: 'turn-3', item: { type: 'agentMessage', id: 'late', text: 'half an answer' } });
  server.say('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-3', status: 'interrupted' } });
  assert.equal(runtime.snapshot().messages.length, settled);
  assert.deepEqual(await runtime.command({ type: 'usage' }), { signedIn: true, windows: [] });

  // Codex ending under the tab fails its turn; the next prompt resumes the thread.
  await runtime.command({ type: 'prompt', text: 'again' });
  server.events.emit('exit', new Error('Codex stopped'));
  assert.equal(runtime.snapshot().failed, 'Codex stopped');
  await runtime.command({ type: 'prompt', text: 'after' });
  const resumed = fake.asked.filter(a => a.method === 'thread/resume');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].params.threadId, 'thread-1');
  assert.equal(resumed[0].params.approvalPolicy, 'never');
  assert.equal(fake.servers.length, 2);
});

test('a Codex session reopens from its rollout with its conversation, and a missing one is refused', async t => {
  const turns = [{ id: 't1', startedAt: 1000, completedAt: 1002, items: [
    { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'what is here?' }] },
    { type: 'commandExecution', id: 'c', command: 'ls', cwd: '/w', status: 'completed', aggregatedOutput: 'a.txt\n' },
    { type: 'agentMessage', id: 'a', text: 'One file.' },
  ] }];
  const fake = fakeServer({
    'thread/read': ({ threadId }) => { if (threadId !== '0199aaaa-0000-7000-8000-00000000000a') throw new Error('thread not loaded'); return { thread: { id: threadId, cwd: '/w', name: null, model: 'gpt-6.1-sol', path: '/home/x/.codex/sessions/rollout-2026-10-17T10-00-00-0199aaaa-0000-7000-8000-00000000000a.jsonl' } }; },
    'thread/turns/list': () => ({ data: turns, nextCursor: null }),
    'thread/resume': ({ threadId }) => ({ thread: { id: threadId, path: '/home/x/.codex/sessions/rollout-2026-10-17T10-00-00-0199aaaa-0000-7000-8000-00000000000a.jsonl' }, model: 'gpt-6.1-sol', instructionSources: [] }),
  });
  const path = '/home/x/.codex/sessions/rollout-2026-10-17T10-00-00-0199aaaa-0000-7000-8000-00000000000a.jsonl';
  // Reopened without a sign-in, it still shows what was said.
  const runtime = await createCodexRuntime({ sessionPath: path, serverImpl: fake.make, authImpl: () => null });
  t.after(() => runtime.close());
  const snap = runtime.snapshot();
  assert.equal(snap.sessionId, '0199aaaa-0000-7000-8000-00000000000a');
  assert.equal(snap.sessionFile, path);
  assert.equal(snap.cwd, '/w');
  assert.equal(snap.name, 'what is here?');
  assert.deepEqual(snap.messages.map(m => m.role), ['user', 'assistant', 'toolResult', 'assistant']);
  assert.equal(snap.messages[0].timestamp, 1000000);
  assert.equal(snap.messages.at(-1).timestamp, 1002000);
  assert.equal(snap.model.id, 'gpt-6.1-sol');
  assert.equal(fake.asked.some(a => a.method === 'thread/start'), false, 'reopening never starts a new thread');
  await runtime.command({ type: 'prompt', text: 'and now?' });
  assert.equal(fake.asked.find(a => a.method === 'thread/resume').params.excludeTurns, true);
  await assert.rejects(createCodexRuntime({ sessionPath: '0199aaaa-0000-7000-8000-00000000000b', serverImpl: fake.make, authImpl: () => 'chatgpt' }), /Cannot read Codex session/);
  const empty = fakeServer({ 'thread/read': () => ({ thread: { id: 'e' } }), 'thread/turns/list': () => ({ data: [], nextCursor: null }) });
  await assert.rejects(createCodexRuntime({ sessionPath: 'e', serverImpl: empty.make, authImpl: () => 'chatgpt' }), /refusing to start a new one/);
  assert.ok(empty.servers.every(s => s.closed), 'a refused session leaves no Codex running');
  await assert.rejects(createCodexRuntime({ serverImpl: fake.make, authImpl: () => null }), /Sign in to Codex in imperfect/);
});

test('Codex sign-in is its own device code, shown in the sign-in sheet; nothing else is shown', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-signin-'));
  const fake = fakeServer({
    'account/login/start': (params, server) => {
      assert.deepEqual(params, { type: 'chatgptDeviceCode' });
      setTimeout(() => {
        writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'secret-access', refresh_token: 'secret-refresh' } }));
        server.say('account/login/completed', { loginId: 'login-1', success: true, error: null });
      }, 20);
      return { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' };
    },
  });
  const signIn = createCodexSignIn({ serverImpl: fake.make, env: { CODEX_HOME: home } });
  assert.equal(signIn.configured(), null);
  const notes = [];
  await signIn.login({ signal: new AbortController().signal, notify: note => notes.push(note), prompt: () => { throw new Error('no prompt'); } });
  assert.deepEqual(notes, [{ type: 'device_code', userCode: 'ABCD-EFGH', verificationUri: 'https://auth.openai.com/codex/device' }]);
  assert.equal(signIn.configured(), 'chatgpt');
  assert.ok(fake.servers.every(s => s.closed));
  // Cancelled while the person has not entered the code, it ends.
  const waiting = fakeServer({ 'account/login/start': () => ({ type: 'chatgptDeviceCode', loginId: 'l', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'X' }) });
  const stop = new AbortController();
  const login = createCodexSignIn({ serverImpl: () => { const s = waiting.make(); s.close = () => { s.closed = true; s.events.emit('exit', new Error('Codex closed')); }; return s; }, env: { CODEX_HOME: mkdtempSync(join(tmpdir(), 'codex-signin-')) } })
    .login({ signal: stop.signal, notify: () => {}, prompt: () => {} });
  await until(() => waiting.servers.length && waiting.asked.length, 'started');
  stop.abort();
  await assert.rejects(login);
});

// The real Codex CLI, if this computer has it, with its model played by a
// stand-in Responses server: nothing leaves the computer and no account is
// needed. It proves the wiring the fakes above assume.
let installed = true;
try { execFileSync('codex', ['--version'], { stdio: 'ignore' }); } catch { installed = false; }
test('the installed Codex runs a turn, steers it, lists it and reopens it', { skip: !installed && 'the Codex CLI is not installed', timeout: 120000 }, async t => {
  const model = await startFakeResponses();
  t.after(() => model.close());
  const home = mkdtempSync(join(tmpdir(), 'codex-live-'));
  const work = mkdtempSync(join(tmpdir(), 'codex-work-'));
  writeFileSync(join(home, 'config.toml'), fakeCodexConfig(model.port));
  writeFileSync(join(work, 'AGENTS.md'), 'Be brief.\n');
  const http = createServer(async (req, res) => { if (!await serveMcp(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(404).end(); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise(resolve => http.close(resolve)); });
  serveMcpOn(http.address().port);
  const env = { ...process.env, CODEX_HOME: home };
  const serverImpl = () => codexServer({ env });
  const runtime = await createCodexRuntime({ cwd: work, serverImpl, authImpl: () => 'chatgpt' });
  t.after(() => runtime.close());
  runtime.snapshot();
  await until(() => runtime.snapshot().startup.sections.some(s => s.name === 'MCP' && s.compact === 'imperfect'), 'Codex connects to imperfect\'s tools');
  assert.deepEqual(runtime.snapshot().startup.sections.find(s => s.name === 'Context').compact, 'AGENTS.md');
  assert.ok((await runtime.command({ type: 'models' })).every(m => m.provider === 'codex'));

  await runtime.command({ type: 'prompt', text: 'run echo hello-from-codex' });
  await until(() => !runtime.snapshot().streaming, 'the turn ends');
  let snap = runtime.snapshot();
  assert.equal(snap.failed, null);
  assert.deepEqual(snap.messages.map(m => m.role), ['user', 'assistant', 'assistant', 'toolResult', 'assistant']);
  assert.equal(snap.messages[3].content[0].text.trim(), 'hello-from-codex');
  assert.equal(snap.messages[4].content[0].text, 'The command printed hello-from-codex.');
  assert.ok(model.requests[0].tools.some(tool => JSON.stringify(tool).includes('imperfect')), 'imperfect\'s tools are offered to the model');

  // Said while Codex works, it goes into the running turn.
  const hold = model.hold();
  await runtime.command({ type: 'prompt', text: 'first' });
  await hold.arrived;
  assert.deepEqual(await runtime.command({ type: 'prompt', text: 'second' }), { accepted: true, queued: true, steered: true });
  hold.release();
  await until(() => !runtime.snapshot().streaming, 'the steered turn ends');
  snap = runtime.snapshot();
  assert.equal(snap.failed, null);
  assert.ok(model.requests.some(request => JSON.stringify(request.input).includes('second')), 'Codex took the second message');
  assert.equal(snap.messages.filter(m => m.role === 'user').length, 3, 'each message drawn once');

  const rows = await listCodexSessions({ home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, snap.sessionId);
  assert.equal(rows[0].path, snap.sessionFile);
  assert.equal(rows[0].firstMessage, 'run echo hello-from-codex');
  assert.equal(rows[0].cwd, work);
  await runtime.command({ type: 'name', name: 'Echo' });
  assert.equal((await listCodexSessions({ home }))[0].name, 'Echo');
  await runtime.close();

  const reopened = await createCodexRuntime({ sessionPath: rows[0].path, serverImpl, authImpl: () => 'chatgpt' });
  t.after(() => reopened.close());
  const back = reopened.snapshot();
  assert.equal(back.sessionId, rows[0].id);
  assert.equal(back.cwd, work);
  assert.equal(back.name, 'Echo');
  assert.deepEqual(back.messages.filter(m => m.role !== 'toolResult').map(m => m.content.find(b => b.type === 'text')?.text).filter(Boolean),
    snap.messages.filter(m => m.role !== 'toolResult').map(m => m.content.find(b => b.type === 'text')?.text).filter(Boolean));
  await reopened.command({ type: 'prompt', text: 'one more' });
  await until(() => !reopened.snapshot().streaming, 'the reopened thread answers');
  assert.equal(reopened.snapshot().messages.at(-1).content[0].text, 'Heard: one more');
  assert.equal((await listCodexSessions({ home })).length, 1, 'the same thread, not a new one');
});
