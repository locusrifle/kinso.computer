import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerSocketURL, ownerSessionKey, createOwnerTransport } from '../public/js/owner-transport.js';

test('same-origin URLs and collision-free owner session keys', () => {
  assert.equal(ownerSocketURL('https://local.invalid/?token=secret', 'a', 'a'), 'wss://local.invalid/pi');
  assert.equal(ownerSocketURL('https://local.invalid', 'b', 'a'), 'wss://local.invalid/peer/b/pi');
  assert.notEqual(ownerSessionKey('a', 'same'), ownerSessionKey('b', 'same'));
});

class FakeSocket {
  readyState = 1; bufferedAmount = 0; sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.(); }
  message(data) { this.onmessage({ data: JSON.stringify(data) }); }
}
test('owner isolation, snapshot cache, ambiguous IDs, stale sockets and no replay', async () => {
  const events = [];
  const make = owner => createOwnerTransport({ owner, selfId: 'a', base: 'http://local', WebSocketImpl: FakeSocket, onMessage: (...args) => events.push(args), requestId: () => 'request' });
  const a = make('a'), b = make('b');
  const sa = a.connect(), sb = b.connect();
  assert.equal(a.connect(), sa);
  sa.message({ type: 'snapshot', data: { sessionId: 'same' } });
  sb.message({ type: 'snapshot', data: { sessionId: 'other' } });
  assert.equal(a.snapshot.sessionId, 'same');
  assert.deepEqual(events.map(x => x[0]), ['a', 'b']);
  const command = a.command('prompt', { requestId: 'durable' });
  sb.message({ type: 'response', id: 'request', success: true });
  a.close();
  await assert.rejects(command, e => e.owner === 'a' && e.requestId === 'request' && e.acceptanceUnknown);
  const replacement = a.connect();
  assert.deepEqual(replacement.sent, []);
  sa.message({ type: 'snapshot', data: { sessionId: 'stale' } });
  assert.equal(a.snapshot.sessionId, 'same');
  const accepted = b.command('harness');
  sb.message({ type: 'response', id: 'request', success: true, data: 'ok' });
  assert.equal(await accepted, 'ok');
  a.close(); b.close();
});

test('a command may carry its own deadline', async () => {
  const transport = createOwnerTransport({ owner: 'a', selfId: 'a', base: 'http://local', WebSocketImpl: FakeSocket, requestId: () => 'probe', timeoutMs: 60_000 });
  transport.connect();
  await assert.rejects(transport.command('hello', {}, { timeoutMs: 5 }), /timed out/);
  const patient = transport.command('hello');
  transport.socket.message({ type: 'response', id: 'probe', success: true, data: { kind: 'phone' } });
  assert.deepEqual(await patient, { kind: 'phone' });
  transport.close();
});

// A socket that opens when told to, or never.
class OpeningSocket {
  static made = [];
  readyState = 0; bufferedAmount = 0; sent = [];
  constructor() { OpeningSocket.made.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  answer(data) { const asked = this.sent.at(-1); this.onmessage({ data: JSON.stringify({ type: 'response', id: asked.id, success: true, data }) }); }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a socket still opening is given up after its deadline, so it can be replaced', async () => {
  OpeningSocket.made = [];
  const status = [];
  const transport = createOwnerTransport({ owner: 'a', selfId: 'a', base: 'http://local', WebSocketImpl: OpeningSocket, connectTimeoutMs: 20, onStatus: (_, s) => status.push(s) });
  const hung = transport.connect();
  assert.equal(transport.connect(), hung, 'one at a time');
  await wait(40);
  assert.equal(hung.readyState, 3);
  assert.deepEqual(status, ['closed']);
  const next = transport.connect();
  assert.notEqual(next, hung);
  next.open();
  await wait(40);
  assert.deepEqual(status, ['closed', 'open'], 'one that opened in time is kept');
  assert.ok(transport.openedAt > 0);
  transport.close();
});

test('a socket is asked whether it is alive, and one that does not answer is let go', async () => {
  OpeningSocket.made = [];
  let clock = 5000, ids = 0;
  const status = [];
  const transport = createOwnerTransport({ owner: 'a', selfId: 'a', base: 'http://local', WebSocketImpl: OpeningSocket, now: () => clock, requestId: () => `q${++ids}`, onStatus: (_, s) => status.push(s) });
  // None yet: it connects, and there is nothing to say until it opens.
  assert.equal(await transport.check(), null);
  const socket = OpeningSocket.made[0];
  socket.open();
  assert.equal(transport.openedAt, 5000);
  // Alive: the answer says when the question was sent.
  clock = 6000;
  const asked = transport.check({ fields: { kind: 'phone' } });
  assert.equal(transport.check(), asked, 'a question already out is not asked twice');
  assert.deepEqual(socket.sent.at(-1), { kind: 'phone', type: 'hello', id: 'q1' });
  clock = 6500;
  socket.answer({ kind: 'phone' });
  assert.deepEqual(await asked, { at: 6000 });
  // Dead but reading open: no answer in time, and it is closed for another.
  const silent = transport.check({ timeoutMs: 20 });
  assert.equal(await silent, null);
  assert.equal(socket.readyState, 3);
  assert.equal(transport.socket, null);
  assert.deepEqual(status, ['open', 'closed']);
  // Refused is still an answer: the socket is alive.
  transport.connect(); OpeningSocket.made.at(-1).open();
  const refused = transport.check();
  const live = OpeningSocket.made.at(-1);
  live.onmessage({ data: JSON.stringify({ type: 'response', id: live.sent.at(-1).id, success: false, error: 'no' }) });
  assert.ok(await refused);
  assert.equal(live.readyState, 1);
  transport.close();
});
