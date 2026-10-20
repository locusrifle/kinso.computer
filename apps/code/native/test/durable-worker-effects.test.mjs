import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionInfo } from '../durable-session.mjs';
import { fixture, answer, context } from './durable-fixture.mjs';

const call = (name, args = {}, id = name) => ({ type: 'toolCall', id, name, arguments: args });
const toolAnswer = (model, calls) => answer(model, calls, 'toolUse');
const info = r => r.session().harness.snapshot(SessionInfo, r.session().conversation.id, context);
async function submit(r) {
  const ack = await r.command({ type: 'prompt', text: 'Inspect and honestly report incomplete work; never retry an uncertain effect.' });
  return (await r.session().harness.submission(ack.submissionId, context)).wait(context);
}
const synthetic = execute => ({ name: 'send', description: 'Synthetic unsafe effect', replay: 'unsafe', parameters: { type: 'object', properties: {} }, execute });

// This shell really times out; its earlier local effect remains. No timeout
// exemption or shell-command safety guess may let the model rerun it.
test('worker bash timeout permits safe read/report, retaining review and denying later bash/edit/write/send', async t => {
  let effects = 0;
  const { runtime: r, dir, seen } = await fixture(t, {
    serviceOptions: { worker: true, durableExtensions: [{ name: 'synthetic', tools: [synthetic(async () => { effects++; return {}; })] }] },
    respond: (model, _request, n) => {
      if (n === 1) return toolAnswer(model, [call('bash', { command: 'printf uncertain >> effect.txt; sleep 1', timeout: 0.05 }, 'timeout')]);
      if (n === 2) return toolAnswer(model, [call('read', { path: 'effect.txt' }, 'inspect')]);
      if (n === 3) return toolAnswer(model, [
        call('bash', { command: 'printf forbidden > forbidden.txt' }, 'later-bash'),
        call('edit', { path: 'effect.txt', oldText: 'uncertain', newText: 'forbidden' }, 'later-edit'),
        call('write', { path: 'forbidden.txt', content: 'forbidden' }, 'later-write'),
        call('send'),
      ]);
      return answer(model, [{ type: 'text', text: 'Incomplete: command timed out after an effect. Read confirmed it; further effects require parent review. No retry.' }]);
    },
  });
  const settled = await submit(r);
  assert.equal(settled.status, 'done', 'a report is possible, not proof of implementation success');
  assert.equal(seen.length, 4);
  const results = r.snapshot().messages.filter(m => m.role === 'toolResult');
  assert.match(JSON.stringify(results.find(m => m.toolCallId === 'timeout')), /timed out/);
  assert.match(JSON.stringify(results.find(m => m.toolCallId === 'inspect')), /uncertain/);
  for (const id of ['later-bash', 'later-edit', 'later-write', 'send']) {
    const result = results.find(m => m.toolCallId === id);
    assert.equal(result.isError, true, id);
    assert.match(JSON.stringify(result), /parent review/, id);
  }
  assert.equal(await readFile(join(dir, 'effect.txt'), 'utf8'), 'uncertain', 'the timed-out effect executes exactly once, never retries');
  await assert.rejects(stat(join(dir, 'forbidden.txt')), { code: 'ENOENT' });
  assert.equal(effects, 0);
  assert.ok((await info(r)).review.some(item => item.name === 'bash'));
  assert.equal((await info(r)).requireEffectApproval, undefined);
  assert.equal(r.snapshot().ui.dialogs.length, 0);
  assert.notEqual((await r.session().conversation.agent(context)).tools.find(t => t.name === 'bash').replay, 'safe');
  assert.match(r.snapshot().messages.at(-1).content[0].text, /Incomplete/);
});

for (const thrown of [false, true]) for (const multi of [false, true]) {
  test(`worker ${thrown ? 'thrown' : 'returned'} unsafe error (${multi ? 'multi' : 'single'} call) retains review but allows reporting`, async t => {
    let effects = 0;
    const send = synthetic(async () => {
      effects++;
      if (thrown) throw new Error('response lost');
      return { isError: true, output: [{ type: 'text', text: 'response lost' }] };
    });
    const { runtime: r, dir, seen } = await fixture(t, {
      serviceOptions: { worker: true, durableExtensions: [{ name: 'synthetic', tools: [send] }] },
      respond: (model, _request, n) => n === 1 ? toolAnswer(model, [call('send'), ...(multi ? [call('read', { path: 'evidence.txt' })] : [])])
        : n === 2 ? toolAnswer(model, [call('send', {}, 'repeat'), call('read', { path: 'evidence.txt' }, 'inspect')])
          : answer(model, [{ type: 'text', text: 'Incomplete; response lost, parent review needed.' }]),
    });
    await writeFile(join(dir, 'evidence.txt'), 'safe evidence');
    assert.equal((await submit(r)).status, 'done');
    assert.equal(seen.length, 3);
    assert.equal(effects, 1);
    assert.ok((await info(r)).review.some(item => item.name === 'send'));
    const results = r.snapshot().messages.filter(m => m.role === 'toolResult');
    assert.match(JSON.stringify(results.find(m => m.toolCallId === 'repeat')), /parent review/);
    assert.match(JSON.stringify(results.find(m => m.toolCallId === 'inspect')), /safe evidence/);
    assert.equal(r.snapshot().ui.dialogs.length, 0);
  });
}

for (const isError of [false, true]) test(`worker preserves explicit tool terminate (isError=${isError})`, async t => {
  const { runtime: r, seen } = await fixture(t, {
    serviceOptions: { worker: true, durableExtensions: [{ name: 'synthetic', tools: [synthetic(async () => ({ isError, output: [{ type: 'text', text: 'stop explicitly' }], control: { terminate: true } }))] }] },
    respond: model => toolAnswer(model, [call('send')]),
  });
  const settled = await submit(r);
  assert.equal(settled.status, 'done', 'Durable termination settles the receipt, not an implementation verdict');
  assert.equal(seen.length, 1, 'no automatic report after explicit terminate');
  assert.equal(r.snapshot().messages.some(m => m.role === 'assistant' && m.stopReason === 'stop'), false);
  assert.equal((await info(r)).review.length, isError ? 1 : 0);
});

for (const guard of ['review', 'requireEffectApproval']) test(`worker persisted ${guard} permits inspection, never new effects even after reopen`, async t => {
  const first = await fixture(t, { serviceOptions: { worker: true } });
  const { runtime: initial, dir } = first;
  await writeFile(join(dir, 'evidence.txt'), 'persisted evidence');
  await initial.session().conversation.commit(async tx => {
    const doc = await tx.doc(SessionInfo, initial.session().conversation.id);
    if (guard === 'review') doc.review.push({ name: 'send', reason: 'Uncertain transport' });
    else doc.requireEffectApproval = true;
  }, context);
  const path = initial.snapshot().sessionFile;
  await initial.close();
  const { runtime: r, seen } = await fixture(t, { dir, sessionPath: path, serviceOptions: { worker: true },
    respond: (model, _request, n) => n === 1 ? toolAnswer(model, [
      call('bash', { command: 'printf forbidden > forbidden.txt' }),
      call('edit', { path: 'evidence.txt', oldText: 'persisted', newText: 'forbidden' }),
      call('write', { path: 'forbidden.txt', content: 'forbidden' }),
      call('read', { path: 'evidence.txt' }),
    ]) : answer(model),
  });
  assert.equal((await submit(r)).status, 'done');
  assert.equal(seen.length, 2);
  assert.equal(await readFile(join(dir, 'evidence.txt'), 'utf8'), 'persisted evidence');
  await assert.rejects(stat(join(dir, 'forbidden.txt')), { code: 'ENOENT' });
  for (const name of ['bash', 'edit', 'write']) assert.match(JSON.stringify(r.snapshot().messages.find(m => m.toolName === name)), /parent review/);
  const after = await info(r);
  if (guard === 'review') assert.equal(after.review.length, 1);
  else { assert.equal(after.requireEffectApproval, true); assert.deepEqual(after.review, []); }
  assert.equal(r.snapshot().ui.dialogs.length, 0);
});
