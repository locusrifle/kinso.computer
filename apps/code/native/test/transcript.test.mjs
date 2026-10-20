import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, createTranscript } from '../transcript.mjs';

// What was said, without when (every message is timed; see the last test).
const said = messages => messages.map(({ timestamp: _t, ...message }) => message);

// The events every stream harness speaks. Widening this list is a decision:
// a new event needs a case in createTranscript, or it is unknown by design.
test('the event vocabulary is exactly what the transcript folds', () => {
  assert.deepEqual([...EVENTS], ['user', 'text', 'thinking', 'tool', 'turn', 'usage', 'error', 'compaction']);
});

test('text streams by id, settles into a message, and the partial shows what is still arriving', () => {
  const t = createTranscript();
  t.absorb({ type: 'user', content: 'hi' });
  t.absorb({ type: 'turn', state: 'start' });
  t.absorb({ type: 'text', id: 'a', delta: 'hel' });
  t.absorb({ type: 'text', id: 'a', delta: 'lo' });
  let snap = t.view('claude');
  assert.equal(snap.streaming, true);
  assert.deepEqual(snap.partial, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] });
  assert.equal(snap.messages.length, 1);
  t.absorb({ type: 'text', id: 'a', text: 'hello.', done: true, model: 'm1' });
  snap = t.view('claude');
  assert.equal(snap.partial, null);
  assert.deepEqual(said(snap.messages).at(-1), { role: 'assistant', content: [{ type: 'text', text: 'hello.' }], model: 'm1' });
});

// Claude streams by content index and settles by message; the ids differ.
test('a settled block that names nothing live takes the oldest live block of its kind', () => {
  const t = createTranscript();
  t.absorb({ type: 'thinking', id: 's1', delta: 'hm' });
  t.absorb({ type: 'text', id: 's2', delta: 'draft' });
  t.absorb({ type: 'text', id: 'other', text: 'final', done: true });
  const snap = t.view('claude');
  assert.deepEqual(said(snap.messages), [{ role: 'assistant', content: [{ type: 'text', text: 'final' }] }]);
  assert.deepEqual(snap.partial, { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] });
});

test('a tool runs, then becomes a call and its result, in the vocabulary the transcript draws', () => {
  const t = createTranscript();
  t.absorb({ type: 'turn', state: 'start' });
  t.absorb({ type: 'tool', id: 'c1', name: 'shell', arguments: { command: 'ls' }, status: 'running' });
  t.absorb({ type: 'tool', id: 'c1', status: 'running', output: 'a\n' });
  assert.deepEqual(t.view('claude').messages, [], 'a running tool is not yet in the conversation');
  t.absorb({ type: 'tool', id: 'c1', status: 'done', output: 'a\nb\n' });
  const snap = t.view('claude');
  assert.deepEqual(said(snap.messages), [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'shell', arguments: { command: 'ls' } }] },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'shell', content: [{ type: 'text', text: 'a\nb\n' }], isError: false },
  ]);
});

test('a turn that ends settles what was streaming and fails what was still running', () => {
  const t = createTranscript();
  t.absorb({ type: 'turn', state: 'start' });
  t.absorb({ type: 'text', id: 'a', delta: 'half a thou' });
  t.absorb({ type: 'tool', id: 'c1', name: 'Read', arguments: {}, status: 'running' });
  t.absorb({ type: 'turn', state: 'end', failed: 'interrupted' });
  const snap = t.view('claude');
  assert.equal(snap.streaming, false);
  assert.equal(snap.failed, 'interrupted');
  assert.equal(snap.partial, null);
  assert.deepEqual(snap.messages.map(m => m.role), ['assistant', 'assistant', 'toolResult']);
  assert.equal(snap.messages[0].content[0].text, 'half a thou');
  assert.equal(snap.messages[2].isError, true);
});

test('the same words twice in a row are one message: a harness echoes, retries repeat', () => {
  const t = createTranscript();
  t.absorb({ type: 'user', content: 'do it' });
  t.absorb({ type: 'user', content: [{ type: 'text', text: 'do it' }] });
  assert.equal(t.messages.length, 1);
  t.absorb({ type: 'text', id: 'x', text: 'done', done: true });
  t.absorb({ type: 'user', content: 'do it' });
  assert.equal(t.messages.length, 3, 'after an answer it is a new message');
});

// Antifragile: an event nobody taught the transcript is still read if it has
// words in it. The view never throws on it.
test('an unknown event degrades to a readable line, never a broken view', () => {
  const t = createTranscript();
  assert.equal(t.absorb({ type: 'hologram', kind: 'item/hologram', text: 'A plan:\n- one' }), false);
  assert.equal(t.absorb({ type: 'turn/moderation' }), false);
  assert.equal(t.absorb(null), false);
  const snap = t.view('claude');
  assert.deepEqual(said(snap.messages), [{ role: 'custom', customType: 'item/hologram', content: 'A plan:\n- one' }]);
});

test('usage is the latest counters; an error is an inline row', () => {
  const t = createTranscript();
  t.absorb({ type: 'usage', tokens: { input: 1, output: 2 } });
  t.absorb({ type: 'usage', cost: 0.5 });
  t.absorb({ type: 'error', message: 'rate limited' });
  const snap = t.view('claude');
  assert.deepEqual(snap.stats, { tokens: { input: 1, output: 2 }, cost: 0.5 });
  assert.deepEqual(said(snap.messages), [{ role: 'assistant', content: [], errorMessage: 'rate limited' }]);
});

test('every message keeps when it was said, so a turn can be timed', () => {
  const t = createTranscript();
  t.absorb({ type: 'user', content: 'go', timestamp: 1000 });
  t.absorb({ type: 'turn', state: 'start', timestamp: 1000 });
  t.absorb({ type: 'text', id: 'a', text: 'done.', done: true, timestamp: 4500 });
  t.absorb({ type: 'turn', state: 'end', timestamp: 4600 });
  assert.deepEqual(t.messages.map(m => m.timestamp), [1000, 4500]);
  const before = Date.now();
  t.absorb({ type: 'user', content: 'again' });
  assert.ok(t.messages.at(-1).timestamp >= before, 'one with no time of its own happened now');
});

test('a compaction is one divider in the conversation, its counts from either half', () => {
  const t = createTranscript();
  t.absorb({ type: 'compaction', state: 'start' });
  assert.equal(t.compacting, true);
  t.absorb({ type: 'compaction', state: 'end', tokensBefore: 392737, tokensAfter: 6298 });
  t.absorb({ type: 'compaction', state: 'end' });
  assert.equal(t.compacting, false);
  assert.deepEqual(said(t.messages), [{ role: 'compactionSummary', tokensBefore: 392737, tokensAfter: 6298 }]);
  t.absorb({ type: 'compaction', state: 'start' });
  t.absorb({ type: 'compaction', state: 'stop' });
  assert.equal(t.compacting, false, 'a status that clears ends it too');
  assert.equal(t.messages.length, 1);
});
