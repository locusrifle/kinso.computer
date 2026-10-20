import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCache, joinSnapshot } from '../public/js/session-cache.js';
test('session cache preserves rendered message identity, merges deltas and invalidates stale bases', () => {
 const cache = createSessionCache(2), message = { role: 'user', content: 'first' };
 const a = cache.accept('a', { sessionId: 's', messages: [message] });
 assert.equal(cache.accept('a', { sessionId: 's', messages: [structuredClone(message)] }).messages, a.messages);
 assert.equal(cache.accept('a', { sessionId: 's', messagesBase: 1, messagesTail: [{ role: 'assistant', content: 'answer' }] }).messages[0], message);
 assert.equal(cache.accept('a', { sessionId: 's', messagesBase: 1, messagesTail: [] }), null);
 assert.equal(cache.get('a'), null);
 cache.accept('a', { sessionId: 's', messages: [message] });
 cache.accept('b', { sessionId: 'b', messages: [] }); cache.accept('c', { sessionId: 'c', messages: [] });
 assert.equal(cache.get('a'), null);
 cache.prune([{ id: 'b', sessionId: 'replaced' }, { id: 'c', sessionId: 'c' }]);
 assert.equal(cache.get('b'), null); assert.ok(cache.get('c'));
 cache.clear(); assert.equal(cache.get('c'), null);
});

test('a window of the newest messages joins what is held by its place in the whole conversation', () => {
 const all = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
 // Held: 2..9, after an older page was fetched. A whole snapshot from 6 keeps 2..5.
 const held = { sessionId: 's', messagesFrom: 2, messages: all.slice(2) };
 const again = joinSnapshot(held, { sessionId: 's', messagesFrom: 6, messages: structuredClone(all.slice(6)) });
 assert.equal(again.messagesFrom, 2);
 assert.equal(again.messages, held.messages, 'nothing changed: the same array, the same nodes');
 const more = joinSnapshot(held, { sessionId: 's', messagesFrom: 6, messages: [...structuredClone(all.slice(6)), { role: 'user', content: 'm10' }] });
 assert.deepEqual([more.messagesFrom, more.messages.length, more.messages[0]], [2, 9, all[2]]);
 // A delta counts from the start of the whole conversation.
 assert.equal(joinSnapshot(held, { sessionId: 's', messagesBase: 10, messagesTail: [{ role: 'user', content: 'm10' }] }).messages.length, 9);
 assert.equal(joinSnapshot(held, { sessionId: 's', messagesBase: 8, messagesTail: [] }), null);
 // A history rewritten underneath, a gap, or another session: the snapshot alone.
 const rewritten = joinSnapshot(held, { sessionId: 's', messagesFrom: 6, messages: [{ role: 'user', content: 'summary' }] });
 assert.deepEqual([rewritten.messagesFrom, rewritten.messages.length], [6, 1]);
 assert.equal(joinSnapshot({ ...held, messages: all.slice(2, 4) }, { sessionId: 's', messagesFrom: 6, messages: all.slice(6) }).messagesFrom, 6);
 assert.equal(joinSnapshot(held, { sessionId: 'other', messages: all }).messagesFrom, 0);
 // An older snapshot without messagesFrom (another computer's older imperfect) is whole.
 assert.equal(joinSnapshot(null, { sessionId: 's', messages: all }).messagesFrom, 0);
});

test('a view kept as it was is given back only for the same session, and the oldest go first', () => {
  const seen = createSessionCache(2);
  const a = { sessionId: 'one', messages: [{ role: 'user', content: 'hi' }] };
  seen.keep('["desk","tab-a"]', a);
  assert.equal(seen.get('["desk","tab-a"]', 'one'), a, 'the same object, nothing joined into it');
  assert.equal(seen.get('["desk","tab-a"]', 'two'), null, 'the tab holds another session now');
  seen.keep('["lap","tab-a"]', { sessionId: 'x' });
  seen.keep('["lap","tab-b"]', { sessionId: 'y' });
  assert.equal(seen.get('["desk","tab-a"]'), null);
  assert.ok(seen.get('["lap","tab-b"]'));
  seen.keep('', { sessionId: 'z' }); seen.keep('k', null);
  assert.equal(seen.get(''), null);
});
