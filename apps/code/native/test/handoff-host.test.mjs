import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTabHost } from '../tabs.mjs';
import { createClaudeRuntime } from '../claude-runtime.mjs';
import { createHandoff, createGueyServer } from '../../../../system/server.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => { for (let i = 0; i < 400 && !check(); i++) await sleep(5); assert.ok(check()); };
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
async function directory(t) { const root = await mkdtemp(join(tmpdir(), 'handoff-host-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
// A runtime is busy until the test frees it.
function fake(id, busy = false) {
  let accepted = 0;
  return { events: new EventEmitter(), snapshot: () => ({ sessionId: id, sessionFile: `/tmp/${id}.jsonl`, cwd: '/tmp', messages: [], busy }),
    free() { busy = false; },
    async command(c) { if (c.type === 'prompt') { accepted++; return { accepted: true }; } },
    async close() {}, get accepted() { return accepted; } };
}
test('a pending restart leaves sessions and prompts usable while another tab works, and resume cancels it', async t => {
  const runtimes = [fake('a'), fake('b', true)]; let made = 0;
  const host = await createTabHost({ createRuntime: () => runtimes[made++], claudeAvailable: () => false, listPiSessions: async () => [] });
  t.after(() => { runtimes[1].free(); return host.close(); }); await host.command({ type: 'tab-new' });
  let restarts = 0; const control = createHandoff(host, () => { restarts++; }, { settle: 0 });
  assert.equal(control.request(true).accepted, true);
  assert.equal(host.snapshot().handoff.quiescing, false);
  runtimes.push(fake('c'), fake('history'));
  const created = await host.command({ type: 'tab-new' });
  await host.command({ type: 'prompt', text: 'new session works' }, created.id);
  assert.equal(runtimes[2].accepted, 1);
  await host.command({ type: 'tab-close', tabId: created.id });
  const opened = await host.command({ type: 'tab-open', path: '/tmp/history.jsonl' });
  await host.command({ type: 'tab-close', tabId: opened.id });
  assert.deepEqual(await host.command({ type: 'prompt', text: 'later' }, 't1'), { accepted: true });
  assert.equal(runtimes[0].accepted, 1, 'sent normally while waiting');
  await sleep(50); assert.equal(restarts, 0, 'a busy tab holds it'); assert.equal(control.snapshot().phase, 'waiting');
  control.resume(); await tick(); runtimes[1].free(); await sleep(50);
  assert.equal(restarts, 0, 'resumed, it does not restart'); assert.equal(host.snapshot().handoff.quiescing, false);
  assert.equal(runtimes[0].accepted, 1, 'the fence lifted, what it held is sent in place');
  assert.deepEqual(await host.command({ type: 'prompt', text: 'now' }, 't1'), { accepted: true });
  control.request(true); await until(() => restarts === 1);
});
test('a tab being made as the fence goes up is waited for, and is fenced too', async t => {
  const block = gate(), first = fake('first'), second = fake('second'); let n = 0;
  const host = await createTabHost({ createRuntime: async () => n++ ? (await block.promise, second) : first, claudeAvailable: () => false, listPiSessions: async () => [] }); t.after(() => host.close());
  const creation = host.command({ type: 'tab-new' }); host.requestQuiesce(); let idle = false;
  const waiting = host.waitForIdle().then(() => { idle = true; }); await tick(); assert.equal(idle, false);
  block.release(); const made = await creation; await waiting;
  assert.equal((await host.command({ type: 'prompt', text: 'x' }, made.id)).queued, true);
  assert.equal(second.accepted, 0);
});
test('a session opening during the idle settle window lifts the final fence and its nonselected turn is waited for', async t => {
  const block = gate(), first = fake('first'), second = fake('second', true); let n = 0;
  const host = await createTabHost({ createRuntime: async () => n++ ? (await block.promise, second) : first, claudeAvailable: () => false, listPiSessions: async () => [] });
  t.after(() => { block.release(); second.free(); return host.close(); });
  let restarts = 0;
  const control = createHandoff(host, () => { restarts++; }, { settle: 20 });
  control.request(); await tick();
  const creation = host.command({ type: 'tab-new' });
  await sleep(50);
  assert.equal(host.snapshot().handoff.quiescing, false);
  assert.equal(restarts, 0);
  block.release(); await creation;
  await host.command({ type: 'tab-focus', tabId: 't1' });
  await sleep(50); assert.equal(restarts, 0, 'the nonselected new session still holds it');
  second.free(); await until(() => restarts === 1);
});

test('corrupt tab mapping is preserved and persistence failure blocks prompt ACK without throwing UI events', async t => {
  const root = await directory(t), path = join(root, 'open-tabs.json'); await writeFile(path, '{bad');
  await assert.rejects(createTabHost({ stateDir: root, createRuntime: () => fake('a'), listPiSessions: async () => [] }), /preserved for review/);
  assert.equal(await readFile(path, 'utf8'), '{bad'); await rm(path);
  const r = fake('a'), host = await createTabHost({ stateDir: root, createRuntime: () => r, claudeAvailable: () => false, listPiSessions: async () => [] }); t.after(() => host.close());
  await mkdir(`${path}.tmp`);
  // Force a mapping change; the event is advisory, but acceptance must fail closed.
  const original = r.snapshot; r.snapshot = () => ({ ...original(), name: 'changed' });
  assert.doesNotThrow(() => r.events.emit('change'));
  await tick(); assert.ok(host.snapshot().handoff.persistenceError);
  await assert.rejects(host.command({ type: 'prompt', text: 'must not accept' }), /not durable/);
  await assert.rejects(host.command({ type: 'tab-new' }), /not durable/); assert.equal(r.accepted, 0);
});
test('unused Pi tabs without a transcript do not enter recovery or hold handoff', async t => {
  const root = await directory(t), missing = join(root, 'never-flushed.jsonl'), zero = join(root, 'zero.jsonl');
  await writeFile(zero, '');
  const rows = [
    { agent: 'pi', session: missing, empty: true, restoreError: 'previous failed restore' },
    { agent: 'pi', session: zero, empty: true },
    { agent: 'claude', session: 'existing-claude', empty: false, focused: true },
  ];
  await writeFile(join(root, 'open-tabs.json'), JSON.stringify(rows));
  let piCalls = 0;
  const host = await createTabHost({ stateDir: root, firstTab: null, checkUpdates: false,
    createRuntime: () => { piCalls++; throw new Error('must not restore a placeholder'); },
    createClaudeRuntime: () => fake('existing-claude'), claudeAvailable: () => true,
    listPiSessions: async () => [], listClaudeSessions: async () => [] });
  t.after(() => host.close());
  assert.equal(piCalls, 0);
  assert.equal(host.snapshot().agent, 'claude');
  assert.equal(host.snapshot().tabs.length, 1);
  assert.deepEqual(host.snapshot().handoff.recovery, []);
  host.requestQuiesce(); await host.waitForIdle();
  const saved = JSON.parse(await readFile(join(root, 'open-tabs.json'), 'utf8'));
  assert.equal(saved.length, 1); assert.equal(saved[0].agent, 'claude');
});
test('only-unused Pi tabs may leave the chooser without manufacturing a replacement session', async t => {
  const root = await directory(t);
  await writeFile(join(root, 'open-tabs.json'), JSON.stringify([{ agent: 'pi', session: join(root, 'missing.jsonl'), empty: true }]));
  const host = await createTabHost({ stateDir: root, firstTab: null, checkUpdates: false,
    createRuntime: () => { throw new Error('must not create a session'); }, listPiSessions: async () => [] });
  t.after(() => host.close());
  assert.deepEqual(host.snapshot().tabs, []);
  assert.deepEqual(host.snapshot().handoff.recovery, []);
  host.requestQuiesce(); await host.waitForIdle();
  assert.deepEqual(JSON.parse(await readFile(join(root, 'open-tabs.json'), 'utf8')), []);
});
test('missing nonempty or unknown Pi sessions and missing Claude sessions remain held for review', async t => {
  const root = await directory(t);
  const rows = [
    { agent: 'pi', session: join(root, 'nonempty.jsonl'), empty: false },
    { agent: 'pi', session: join(root, 'unknown.jsonl') },
    { agent: 'pi', session: join(root, 'not-boolean.jsonl'), empty: 'true' },
    { session: join(root, 'unknown-agent.jsonl'), empty: true },
    { agent: 'claude', session: 'missing-claude', empty: true },
  ];
  await writeFile(join(root, 'open-tabs.json'), JSON.stringify(rows));
  const attempted = [];
  const fail = opts => { attempted.push(opts.sessionPath); throw new Error('missing transcript'); };
  const host = await createTabHost({ stateDir: root, firstTab: null, checkUpdates: false,
    createRuntime: fail, createClaudeRuntime: fail, claudeAvailable: () => true,
    listPiSessions: async () => [], listClaudeSessions: async () => [] });
  t.after(() => host.close());
  assert.deepEqual(attempted, rows.map(row => row.session));
  assert.equal(host.snapshot().handoff.recovery.length, rows.length);
  host.requestQuiesce(); await assert.rejects(host.waitForIdle(), /restore failed; handoff held/);
  const saved = JSON.parse(await readFile(join(root, 'open-tabs.json'), 'utf8'));
  assert.deepEqual(saved.map(({ restoreError, ...row }) => row), rows);
});
test('an empty marker never bypasses restore of an existing Pi transcript or hides its failure', async t => {
  const root = await directory(t), path = join(root, 'persisted.jsonl');
  await writeFile(path, 'persisted transcript');
  const row = { agent: 'pi', session: path, empty: true, threadId: 'stable', identityPath: path };
  await writeFile(join(root, 'open-tabs.json'), JSON.stringify([row]));
  let supplied;
  const host = await createTabHost({ stateDir: root, firstTab: null, checkUpdates: false,
    createRuntime: opts => { supplied = opts.sessionPath; throw new Error('corrupt transcript'); }, listPiSessions: async () => [] });
  t.after(() => host.close());
  assert.equal(supplied, path);
  assert.deepEqual(host.snapshot().handoff.recovery, [{ session: path, error: 'corrupt transcript' }]);
  host.requestQuiesce(); await assert.rejects(host.waitForIdle(), /held for review/);
  assert.equal(await readFile(path, 'utf8'), 'persisted transcript');
});
test('server startup replay runs once only after listen and does not await an entire replay turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-server-')), block = gate(), r = fake('startup'); let calls = 0, app;
  r.resumeDelivery = async () => { calls++; assert.equal(app.server.listening, true); await block.promise; };
  app = await createGueyServer({ runtime: r, stateDir: root, port: 0 }); t.after(async () => { block.release(); await app.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(calls, 0); const address = await app.listen(); assert.ok(address.port); await tick(); assert.equal(calls, 1);
  void app.handoff.startDelivery(); await tick(); assert.equal(calls, 1);
  const health = await (await fetch(`http://127.0.0.1:${address.port}/health`)).json(); assert.equal(health.handoff.phase, 'running');
});
test('a session reopened from history is opened by the path it was listed under', async t => {
  const root = await directory(t), path = join(root, 'never-flushed.jsonl'); let made = 0;
  let supplied;
  const h = await createTabHost({ stateDir: root, listPiSessions: async () => [], createRuntime: opts => {
    const r = fake(`sdk-${++made}`), snap = r.snapshot; supplied = opts.sessionPath;
    r.snapshot = () => ({ ...snap(), ui: { dialogs: [] }, sessionFile: opts.sessionPath || path }); return r;
  } });
  t.after(() => h.close());
  await h.command({ type: 'tab-close', tabId: h.snapshot().tabs[0].id });
  await h.command({ type: 'tab-open', path });
  assert.equal(supplied, path); assert.equal(h.snapshot().sessionFile, path);
});


test('WebSocket restart accepts blocked work immediately without fencing, health exposes wait, resume cancels it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'handoff-wire-')), block = gate();
  // A tab host whose one turn ends when the test says.
  let fenced = false;
  const r = { events: new EventEmitter(), snapshot: () => ({ sessionId: 'wire', cwd: '/tmp', messages: [], tabs: [] }),
    requestQuiesce() { fenced = true; }, waitForIdle: () => block.promise, async resumeDelivery() { fenced = false; },
    async command() {}, async close() {}, get fenced() { return fenced; } };
  let restarts = 0;
  const app = await createGueyServer({ runtime: r, stateDir: root, port: 0, restart: () => { restarts++; }, handoff: { settle: 0 } });
  let ws;
  try {
    const { port } = await app.listen(), base = `http://127.0.0.1:${port}`;
    ws = new WebSocket(`ws://127.0.0.1:${port}/pi`, { origin: base });
    await once(ws, 'open');
    let seq = 0;
    const command = type => new Promise(resolve => {
      const id = String(++seq);
      const receive = raw => { const result = JSON.parse(raw); if (result.type === 'response' && result.id === id) { ws.off('message', receive); resolve(result); } };
      ws.on('message', receive); ws.send(JSON.stringify({ id, type }));
    });
    const accepted = await command('machine-restart'); assert.equal(accepted.success, true); assert.equal(accepted.data.accepted, true);
    assert.equal(restarts, 0); assert.equal(r.fenced, false);
    assert.equal((await (await fetch(`${base}/health`)).json()).handoff.phase, 'waiting');
    app.handoff.resume();
    block.release(); await sleep(20); assert.equal(restarts, 0, 'resumed, it does not restart');
    await command('machine-restart'); await until(() => restarts === 1);
  } finally { ws?.terminate(); block.release(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

// Claude Code as the SDK hands it over, each frame said by the test; `turn`
// answers the person's message.
function claudeQuery() {
  const out = []; let wake = null, ended = false;
  const impl = ({ prompt }) => {
    (async () => { for await (const _ of prompt) impl.turn(); })();
    return {
      async *[Symbol.asyncIterator]() { while (!ended) { if (out.length) { yield out.shift(); continue; } await new Promise(r => { wake = r; }); wake = null; } },
      interrupt: async () => {}, close: () => { ended = true; wake?.(); },
      supportedModels: async () => [], setModel: async () => {}, applyFlagSettings: async () => {},
    };
  };
  impl.say = (...frames) => { out.push(...frames.map(frame => ({ session_id: 's1', ...frame }))); wake?.(); };
  return impl;
}
test('a Claude session whose turn ended with a subagent still working holds a restart until the subagent is done and answered', async t => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test';
  t.after(() => { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; });
  const queryImpl = claudeQuery();
  // As Claude Code does it: the turn ends, and Claude Code stays running while its subagent works.
  queryImpl.turn = () => queryImpl.say(
    { type: 'system', subtype: 'session_state_changed', state: 'running' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { run_in_background: true } }] } },
    { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', task_type: 'local_agent', description: 'Make the covers' }] },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Async agent launched successfully.' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'A worker is making them.' }] } },
    { type: 'result', subtype: 'success', usage: {} });
  const host = await createTabHost({ firstTab: 'claude', claudeAvailable: () => true, listPiSessions: async () => [], listClaudeSessions: async () => [],
    createClaudeRuntime: options => createClaudeRuntime({ ...options, authImpl: () => 'login', accountInfoImpl: async () => ({ apiProvider: 'firstParty', tokenSource: 'claude.ai' }), queryImpl, sessionMessagesImpl: async () => [] }) });
  t.after(() => host.close());
  let restarts = 0; const control = createHandoff(host, () => { restarts++; }, { settle: 0, poll: 5 });
  await host.command({ type: 'prompt', text: 'make the covers', requestId: 'r1' });
  await until(() => host.snapshot().messages.length === 4 && !host.snapshot().busy);
  assert.equal(host.snapshot().tabs[0].status, 'working', 'its tab says it is still working');
  control.request();
  await until(() => control.snapshot().background?.length);
  assert.deepEqual(control.snapshot().background, ['make the covers: Make the covers']);
  assert.equal(host.snapshot().handoff.quiescing, false, 'every session takes prompts while it waits');
  // The worker finishes, and Claude answers it on its own: that holds the restart too.
  queryImpl.say({ type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    { type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', output_file: '/tmp/a1.output', summary: 'Made the covers' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'The covers are done.' }] } });
  await until(() => host.snapshot().messages.length === 5);
  await sleep(30); assert.equal(restarts, 0);
  queryImpl.say({ type: 'result', subtype: 'success', usage: {} }, { type: 'system', subtype: 'session_state_changed', state: 'idle' });
  await until(() => restarts === 1);
  assert.equal(host.snapshot().tabs[0].status, 'idle');
});
test('background work that never ends holds a restart only until the limit, and the log says what it cut off', async () => {
  const said = []; let restarts = 0, fences = 0;
  const runtime = { events: new EventEmitter(), requestQuiesce() { fences++; }, waitForIdle: async () => {}, resumeDelivery: async () => {}, background: () => ['dev: npm run dev'] };
  const control = createHandoff(runtime, () => { restarts++; }, { settle: 0, poll: 5, backgroundLimit: 300, log: message => said.push(message) });
  control.request();
  await until(() => control.snapshot().phase === 'waiting');
  // Asking again does not start the clock over.
  await sleep(150); const again = Date.now(); control.request();
  await until(() => restarts === 1);
  assert.ok(Date.now() - again < 250, 'it restarts on the first request\'s clock');
  assert.equal(fences, 1, 'only the final check fences');
  assert.match(said.join('\n'), /cuts off: dev: npm run dev/);
});

// Delivery is never paused. What is said while a restart waits is taken at
// once, waits as pending steering that can be taken back, is written down with its
// tab, and is sent once, in order, first thing after the restart.
const recordingReceipts = new WeakMap();
function recording(id, sent, { refuse = () => false } = {}) {
  const receipts = recordingReceipts.get(sent) || new Set(); recordingReceipts.set(sent, receipts);
  const r = fake(id);
  r.command = async c => {
    if (c.type === 'prompt') {
      if (c.requestId && receipts.has(c.requestId)) return { accepted: true, duplicate: true };
      if (refuse(c)) throw new Error('not now');
      if (c.requestId) receipts.add(c.requestId);
      sent.push(c.behavior ? `${c.text} (${c.behavior})` : c.text); return { accepted: true };
    }
    if (c.type === 'abort') return { steering: [], items: [] };
  };
  return r;
}
test('what is said during a handoff survives the restart and is sent once, in order, first thing after it', async t => {
  const root = await directory(t), sent = [];
  const image = { type: 'image', mimeType: 'image/png', data: Buffer.from('held image').toString('base64') };
  const options = { stateDir: root, listPiSessions: async () => [], checkUpdates: false, createRuntime: () => recording('kept', sent) };
  let host = await createTabHost(options);
  const control = createHandoff(host, () => {}, { settle: 0 });
  control.request();
  await until(() => control.snapshot().phase === 'restarting');
  for (const type of ['tab-new', 'tab-open', 'tab-close']) await assert.rejects(host.command({ type }), /fenced/);
  // Every submission is held durably until the restart completes.
  for (const [id, text, behavior] of [['a', 'one', 'steer'], ['b', 'two', 'followUp'], ['c', 'three'], ['d', 'gone']]) assert.equal((await host.command({ type: 'prompt', requestId: id, text, behavior, ...(id === 'b' ? { images: [image] } : {}) })).queued, true);
  assert.deepEqual((await host.command({ type: 'prompt', requestId: 'b', text: 'two' })).duplicate, true);
  // Taken back like any pending steering.
  assert.deepEqual((await host.command({ type: 'queue-take', queueId: 'd' })).item, { id: 'd', lane: 'steering', text: 'gone' });
  assert.deepEqual(host.snapshot().queue.items.map(item => item.text), ['one', 'two', 'three']);
  // The restart goes ahead without sending them.
  await host.waitForIdle(); control.cancelWaiter(); await host.close();
  assert.deepEqual(sent, []);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'open-tabs.json'), 'utf8'))[0].held.map(item => item.text), ['one', 'two', 'three']);
  host = await createTabHost(options);
  assert.deepEqual(host.snapshot().queue.items.find(item => item.id === 'b').images, [image]);
  assert.ok(host.snapshot().queue.items.every(item => item.lane === 'steering'));
  // Said after the restart, before what was held went: it goes behind it.
  assert.equal((await host.command({ type: 'prompt', requestId: 'e', text: 'four' })).queued, true);
  await host.resumeDelivery();
  await until(() => sent.length === 4);
  assert.deepEqual(sent, ['one', 'two', 'three', 'four']);
  assert.equal(JSON.parse(await readFile(join(root, 'open-tabs.json'), 'utf8'))[0].held, undefined);
  assert.equal((await host.command({ type: 'prompt', requestId: 'a', text: 'one' })).duplicate, true, 'a send retried across the restart is still taken once');
  await host.close();
  // Restarted again, nothing is sent a second time.
  host = await createTabHost(options); await host.resumeDelivery(); await sleep(20);
  assert.deepEqual(sent, ['one', 'two', 'three', 'four']);
  await host.close();
});
test('what is held stays first in line when its harness refuses it, and a stop hands it back', async t => {
  const root = await directory(t), sent = [];
  let refusing = true;
  const host = await createTabHost({ stateDir: root, listPiSessions: async () => [], checkUpdates: false, createRuntime: () => recording('r', sent, { refuse: () => refusing }) });
  t.after(() => host.close());
  host.requestQuiesce();
  await host.command({ type: 'prompt', text: 'first' });
  await host.resumeDelivery();
  assert.deepEqual(host.snapshot().queue.items.map(item => item.text), ['first']);
  refusing = false;
  await host.command({ type: 'prompt', text: 'second' });
  await until(() => sent.length === 2);
  assert.deepEqual(sent, ['first', 'second']);
  host.requestQuiesce();
  await host.command({ type: 'prompt', text: 'third' });
  assert.deepEqual((await host.command({ type: 'abort' })).steering, ['third']);
  assert.equal(host.snapshot().queue?.items?.length ?? 0, 0);
});

// Pi writes a session with its first answer and Claude Code has none before
// its first turn, so a tab with no conversation yet has nothing to reopen.
test('a tab with no conversation yet comes back new after a restart, with what was said to it meanwhile', async t => {
  const root = await directory(t), sent = [];
  const never = join(root, 'never-written.jsonl');
  const made = [];
  const options = { stateDir: root, listPiSessions: async () => [], listClaudeSessions: async () => [], checkUpdates: false, claudeAvailable: () => true,
    createRuntime: extra => { made.push(['pi', extra]); const r = recording('fresh-pi', sent); const snap = r.snapshot; r.snapshot = () => ({ ...snap(), sessionFile: extra.sessionPath ?? never }); return r; },
    createClaudeRuntime: extra => { made.push(['claude', extra]); const r = recording('', sent); const snap = r.snapshot; r.snapshot = () => ({ ...snap(), sessionId: null, sessionFile: null }); return r; } };
  let host = await createTabHost(options);
  const claude = await host.command({ type: 'tab-new', agent: 'claude' });
  host.requestQuiesce();
  await host.command({ type: 'prompt', text: 'to pi' }, host.snapshot().tabs[0].id);
  await host.command({ type: 'prompt', text: 'to claude' }, claude.id);
  await host.close();
  made.length = 0;
  host = await createTabHost(options);
  try {
    assert.deepEqual(host.snapshot().handoff.recovery, [], 'nothing is left for review');
    assert.deepEqual(made.map(([agent, extra]) => [agent, extra.sessionPath ?? null]), [['pi', null], ['claude', null]]);
    await host.resumeDelivery();
    await until(() => sent.length === 2);
    assert.deepEqual(sent.sort(), ['to claude', 'to pi']);
  } finally { await host.close(); }
});

test('a Claude tab whose first turn failed before it had a session still comes back after a restart, with what was said to it meanwhile', async t => {
  const root = await directory(t), sent = [];
  const options = { stateDir: root, listPiSessions: async () => [], listClaudeSessions: async () => [], checkUpdates: false, claudeAvailable: () => true,
    createRuntime: () => recording('fresh-pi', sent),
    // What was said shows, but Claude Code never named a session.
    createClaudeRuntime: () => { const r = recording('', sent); const snap = r.snapshot; r.snapshot = () => ({ ...snap(), sessionId: null, sessionFile: null, messages: [{ role: 'user', content: 'hello' }] }); return r; } };
  let host = await createTabHost(options);
  const claude = await host.command({ type: 'tab-new', agent: 'claude' });
  host.requestQuiesce();
  await host.command({ type: 'prompt', text: 'are you there' }, claude.id);
  await host.close();
  host = await createTabHost(options);
  try {
    assert.deepEqual(host.snapshot().handoff.recovery, [], 'nothing is left for review');
    await host.resumeDelivery();
    await until(() => sent.includes('are you there'));
  } finally { await host.close(); }
});
