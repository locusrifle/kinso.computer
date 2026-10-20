import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createGueyServer } from '../../../../system/server.mjs';

const say = (role, text) => ({ role, content: text });

function receive(ws) {
  const inbox = [], changed = new EventEmitter();
  let failed;
  ws.on('message', raw => { inbox.push({ raw: String(raw).length, ...JSON.parse(String(raw)) }); changed.emit('ready'); });
  ws.on('error', error => { failed = error; changed.emit('ready'); });
  ws.on('close', () => { failed ||= new Error('WebSocket closed while waiting for a message'); changed.emit('ready'); });
  const next = type => new Promise((resolve, reject) => {
    const finish = (error, message) => { clearTimeout(timer); changed.off('ready', look); error ? reject(error) : resolve(message); };
    const look = () => {
      const i = inbox.findIndex(m => m.type === type);
      if (i >= 0) finish(null, inbox.splice(i, 1)[0]);
      else if (failed) finish(failed);
    };
    const timer = setTimeout(() => finish(new Error(`missing ${type}; received ${inbox.map(m => m.type).join(', ')}`)), 15000);
    changed.on('ready', look);
    look();
  });
  return { inbox, next };
}

test('after a session is sent whole, an update carries only the new messages; a rewritten history goes whole again', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-deltas-'));
  let messages = [say('user', 'one'), say('assistant', 'two')];
  let sessionId = 'a', partial = null;
  const fake = { events: new EventEmitter(), snapshot: () => ({ sessionId, cwd: '/tmp', messages, partial }), command: async c => c.type === 'snapshot' ? fake.snapshot() : ({}), close: async () => {} };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime: fake });
  let ws;
  try {
    const addr = await app.listen();
    ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`);
    const { next } = receive(ws);
    const whole = await next('snapshot');
    assert.deepEqual(whole.data.messages, messages);

    // A token streams: the messages are not resent.
    partial = say('assistant', 'thr');
    fake.events.emit('change');
    const streamed = await next('snapshot');
    assert.equal(streamed.data.messages, undefined);
    assert.deepEqual(streamed.data.partial, partial);
    assert.deepEqual([streamed.data.messagesBase, streamed.data.messagesTail], [2, []]);

    messages = [...messages, say('assistant', 'three')]; partial = null;
    fake.events.emit('change');
    const grown = await next('snapshot');
    assert.deepEqual([grown.data.messagesBase, grown.data.messagesTail], [2, [say('assistant', 'three')]]);

    // Compaction rewrote the history: shorter, so whole again.
    messages = [say('compactionSummary', 'one to three')];
    fake.events.emit('change');
    assert.deepEqual((await next('snapshot')).data.messages, messages);
    // The last sent message changed underneath (a fresh object, same words, is fine).
    messages = [say('compactionSummary', 'one to three'), say('user', 'four')];
    fake.events.emit('change');
    assert.deepEqual((await next('snapshot')).data.messagesTail, [say('user', 'four')]);
    messages = [say('compactionSummary', 'one to three'), say('user', 'four, edited'), say('user', 'five')];
    fake.events.emit('change');
    assert.deepEqual((await next('snapshot')).data.messages, messages);

    // Another session, and a window asking for the whole: both reset the base.
    sessionId = 'b'; messages = [say('user', 'b1')];
    fake.events.emit('change');
    assert.deepEqual((await next('snapshot')).data.messages, messages);
    ws.send(JSON.stringify({ type: 'snapshot', id: 'r1' }));
    const asked = await next('response');
    assert.deepEqual(asked.data.messages, messages);
    messages = [...messages, say('assistant', 'b2')];
    fake.events.emit('change');
    assert.deepEqual((await next('snapshot')).data.messagesTail, [say('assistant', 'b2')]);
    ws.close();
  } finally { ws?.terminate(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

for (const surface of ['desktop', 'phone', 'viewer', 'hidden', 'remote']) test(`background snapshots: ${surface}`, { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-warm-'));
  const rev = { a: 0, b: 0 }, messages = { a: [say('user', 'a')], b: [say('user', 'b')] };
  const fake = { events: new EventEmitter(), snapshot: (id = 'a') => ({ sessionId: id, cwd: '/tmp', messages: messages[id], tabs: ['a', 'b'].map(key => ({ id: key, sessionId: key, focused: key === id, revision: rev[key] })) }), command: async c => c.type === 'snapshot' ? fake.snapshot() : ({}), close: async () => {} };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime: fake, origins: ['http://desktop.example.ts.net'] });
  let ws;
  try {
    const addr = await app.listen();
    ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`, surface === 'remote' ? { origin: 'http://desktop.example.ts.net', headers: { Host: 'desktop.example.ts.net' } } : {});
    const { inbox, next } = receive(ws);
    await next('snapshot');
    ws.send(JSON.stringify({ type: 'hello', id: 'h', kind: ['hidden', 'remote'].includes(surface) ? 'desktop' : surface, visible: surface !== 'hidden' }));
    await next('response');
    if (surface === 'desktop') {
      const warm = await next('tab-snapshot'); assert.equal(warm.tabId, 'b'); assert.deepEqual(warm.data.messages, messages.b);
      messages.b = [...messages.b, say('assistant', 'answer')]; rev.b++; fake.events.emit('change');
      const grown = await next('tab-snapshot'); assert.equal(grown.data.messagesBase, 1); assert.deepEqual(grown.data.messagesTail, [messages.b[1]]);
      fake.events.emit('change'); await new Promise(r => setTimeout(r, 100));
      assert.equal(inbox.some(m => m.type === 'tab-snapshot'), false, 'unchanged background session is not resent');
    } else { fake.events.emit('change'); await new Promise(r => setTimeout(r, 100)); assert.equal(inbox.some(m => m.type === 'tab-snapshot'), false); }
    inbox.length = 0;
    ws.send(JSON.stringify({ type: 'tab-focus', id: 'f', tabId: 'b', snapshot: true }));
    const response = await next('response'); assert.equal(response.data.snapshot.sessionId, 'b'); assert.deepEqual(response.data.snapshot.messages, messages.b);
    await new Promise(r => setTimeout(r, 100)); assert.equal(inbox.some(m => m.type === 'snapshot'), false, 'focus sends one authoritative response');
  } finally { ws?.terminate(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

for (const total of [1000, 2000, 2001, 10000]) test(`a ${total}-message session opens from its newest tenth, capped at 200, and pages back without gaps`, { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-tail-'));
  const long = Array.from({ length: total }, (_, i) => say(i % 2 ? 'assistant' : 'user', `m${i}`));
  const initialCount = total === 1000 ? 100 : 200;
  const grownCount = total === 1000 ? 101 : 200;
  const initialFrom = total - initialCount;
  let messages = long, sessionId = 'long';
  const tabs = () => [{ id: 'a', sessionId, focused: true }];
  const fake = { events: new EventEmitter(), snapshot: () => ({ sessionId, cwd: '/tmp', messages, tabs: tabs() }), command: async c => c.type === 'snapshot' ? fake.snapshot() : ({}), close: async () => {} };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime: fake });
  let ws;
  try {
    const addr = await app.listen();
    ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`);
    const { next } = receive(ws);
    let n = 0;
    const ask = async (type, fields = {}) => { ws.send(JSON.stringify({ type, id: `q${++n}`, ...fields })); return next('response'); };
    const first = await next('snapshot');
    assert.equal(first.data.messagesFrom, initialFrom);
    assert.deepEqual(first.data.messages, long.slice(initialFrom));
    // An update appends at its place in the whole conversation.
    messages = [...long, say('user', `m${total}`)];
    fake.events.emit('change');
    const grown = await next('snapshot');
    assert.deepEqual([grown.data.messagesBase, grown.data.messagesTail], [total, [say('user', `m${total}`)]]);
    // A session switch uses the same cap, without changing the model's history.
    const focused = await ask('tab-focus', { tabId: 'a' });
    assert.deepEqual(focused.data.snapshot.messages, messages.slice(-grownCount));
    assert.equal(focused.data.snapshot.messagesFrom, messages.length - grownCount);
    assert.equal(messages.length, total + 1);
    // Older pages, in order, down to the first message.
    let before = initialFrom; const fetched = [];
    while (before > 0) {
      const page = await ask('messages-before', { tabId: 'a', sessionId: 'long', before });
      assert.equal(page.success, true);
      assert.equal(page.data.from + page.data.messages.length, before);
      assert.equal(page.data.messages.length, Math.min(before, grownCount));
      fetched.unshift(...page.data.messages); before = page.data.from;
    }
    assert.deepEqual(fetched, long.slice(0, initialFrom));
    assert.equal((await ask('messages-before', { tabId: 'a', sessionId: 'other', before: 500 })).success, false, 'a page of another session is refused');
    // A window asking for the whole gets the newest part too.
    const asked = await ask('snapshot');
    assert.equal(asked.data.messagesFrom, messages.length - grownCount);
    assert.ok(asked.raw < JSON.stringify(messages).length * 0.2, 'the newest part is a small fraction of the whole');
    // Small and empty sessions go whole.
    sessionId = 'small'; messages = long.slice(0, 30);
    fake.events.emit('change');
    const small = await next('snapshot');
    assert.deepEqual([small.data.messagesFrom, small.data.messages.length], [0, 30]);
    sessionId = 'empty'; messages = [];
    fake.events.emit('change');
    const empty = await next('snapshot');
    assert.deepEqual([empty.data.messagesFrom, empty.data.messages], [0, []]);
  } finally { ws?.terminate(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('the window is not sent what the model thought or passed to its tools, which it never draws', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-unseen-'));
  const answer = { role: 'assistant', content: [{ type: 'thinking', thinking: 'long reasoning', thinkingSignature: 'x'.repeat(5000) }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'cat big' } }, { type: 'text', text: 'Done.' }] };
  const result = { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'output\n'.repeat(5000) }], details: { fullOutputPath: '/tmp/x' } };
  const line = 'Shown in the conversation, in a square window: /tmp/film.mp4';
  const shownResult = { role: 'toolResult', toolCallId: 'c2', toolName: 'show', content: [{ type: 'text', text: `building…\n${line}\nmore` }, { type: 'image', mimeType: 'image/png', data: 'AAEC' }] };
  const messages = [say('user', 'go'), answer, result, shownResult];
  const fake = { events: new EventEmitter(), snapshot: () => ({ sessionId: 's', cwd: '/tmp', messages, partial: answer }), command: async () => ({}), close: async () => {} };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime: fake });
  let ws;
  try {
    const addr = await app.listen();
    ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`);
    const first = await receive(ws).next('snapshot');
    const shown = { ...answer, content: [{ type: 'thinking' }, { type: 'toolCall', id: 'c1', name: 'bash' }, { type: 'text', text: 'Done.' }] };
    // Of what a tool said back, only the line saying what it showed, and its pictures.
    const [, , sentResult, sentShown] = first.data.messages;
    assert.deepEqual(first.data.messages.slice(0, 2), [say('user', 'go'), shown]);
    assert.deepEqual(sentResult, { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [] });
    assert.deepEqual(sentShown.content[0], { type: 'text', text: line });
    assert.match(sentShown.content[1].url, /^\/media\/[0-9a-f]{64}$/);
    assert.equal(sentShown.content[1].data, undefined);
    assert.deepEqual(first.data.partial, shown);
    assert.deepEqual(answer.content[0].thinking, 'long reasoning', 'the session keeps all of it');
  } finally { ws?.terminate(); await app.close(); await rm(root, { recursive: true, force: true }); }
});
