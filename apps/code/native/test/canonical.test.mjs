import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS, ROLES, canonicalBlocks, canonicalMessage, canonicalSnapshot } from '../canonical.mjs';

// The vocabulary is a promise to the surfaces. Widening it is a decision, so it
// is written down here: a harness that needs a fifth block type has to change
// this line, and changing this line means finding the renderer that lacks a case.
test('the vocabulary is exactly what the transcript can render', () => {
  assert.deepEqual([...BLOCKS], ['text', 'thinking', 'toolCall', 'image']);
  assert.deepEqual([...ROLES], [
    'user', 'assistant', 'toolResult', 'custom',
    'compaction', 'compactionSummary', 'branchSummary',
  ]);
});

test('a block a harness invented is dropped', () => {
  const blocks = canonicalBlocks([
    { type: 'text', text: 'hello' },
    { type: 'redacted_thinking', data: 'xxx' },
    { type: 'server_tool_use', id: 'x' },
  ]);
  assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }]);
});

test('a harness may carry its own fields through, but not its own block names', () => {
  const [call] = canonicalBlocks([
    { type: 'toolCall', id: 'c1', name: 'Read', arguments: { path: '/x' }, thoughtSignature: 'sig' },
  ]);
  assert.equal(call.thoughtSignature, 'sig', 'Pi round-trips its own signature');
  assert.equal(call.name, 'Read');
  assert.deepEqual(call.arguments, { path: '/x' });
});

test('a string body becomes one text block, so a harness may send either', () => {
  assert.deepEqual(canonicalBlocks('bare'), [{ type: 'text', text: 'bare' }]);
  assert.equal(canonicalMessage({ role: 'user', content: 'hi' }).content[0].text, 'hi');
});

test('a session message keeps its body untouched', () => {
  // `compactionSummary` and friends are the harness talking about the session,
  // not the model talking to the person. Normalising their bodies into blocks
  // would break the renderer, which reads `summary` off them directly.
  const message = canonicalMessage({ role: 'compactionSummary', summary: 'a', tokensBefore: 9 });
  assert.equal(message.summary, 'a');
  assert.equal(message.tokensBefore, 9);
});

test('a role nobody renders does not reach a renderer', () => {
  assert.equal(canonicalMessage({ role: 'system', content: 'x' }), null);
});

// Pi snapshots must preserve the surface vocabulary without translation loss.
const PI_SHAPED = {
  sessionId: 's1', cwd: '/w', busy: false, streaming: false,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'read it' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'toolCall', id: 'c1', name: 'Read', arguments: {} }] },
    { role: 'toolResult', content: 'the file' },
  ],
};

test('Pi answers in the canonical vocabulary', () => {
  const snap = canonicalSnapshot(PI_SHAPED);
  assert.equal(snap.source, 'pi');
  assert.deepEqual(snap.messages, PI_SHAPED.messages);
});

for (const source of ['claude']) {
  test(`${source} answers in the same canonical vocabulary`, () => {
    const snap = canonicalSnapshot(PI_SHAPED, source);
    assert.equal(snap.source, source);
  });
}

for (const source of ['gemini']) {
  test(`${source} execution snapshots are rejected, never relabelled as Pi`, () => {
    assert.throws(() => canonicalSnapshot(PI_SHAPED, source), /Unsupported execution source/);
    assert.throws(() => canonicalSnapshot({ ...PI_SHAPED, source }), /Unsupported execution source/);
    assert.throws(() => canonicalSnapshot({ ...PI_SHAPED, source }, 'pi'), /Unsupported execution source/);
  });
}
