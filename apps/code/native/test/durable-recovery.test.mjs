import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, until, answer } from './durable-fixture.mjs';
import { SessionInfo, context } from '../durable-session.mjs';
async function crash(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), 'durable-crash-'));
  const child = fork(new URL('./fixtures/durable-crash.mjs', import.meta.url), [dir, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = []; let diagnostics = '';
  child.on('message', message => messages.push(message)); child.stderr.on('data', data => { diagnostics += data; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); });
  await until(() => { if (child.exitCode != null) throw new Error(diagnostics); return messages.some(m => m.type === 'accepted') && messages.some(m => m.type === (mode === 'queue' ? 'generation' : 'effect')); });
  const accepted = messages.find(m => m.type === 'accepted');
  child.kill('SIGKILL'); await once(child, 'exit');
  return { dir, accepted };
}

test('SIGKILL/reopen retains accepted queue and request-id dedup, without a second Pi queue', async t => {
  const { dir, accepted } = await crash(t, 'queue');
  const { runtime: r, idle } = await fixture(t, { dir, sessionPath: accepted.path });
  const duplicate = await r.command({ type: 'prompt', requestId: 'second', text: 'second' });
  assert.equal(duplicate.submissionId, accepted.second.submissionId); assert.equal(duplicate.duplicate, true);
  await idle();
  const words = r.snapshot().messages.filter(m => m.role === 'user').map(m => m.content[0].text);
  assert.deepEqual(words, ['first', 'second']);
  const receipt = await r.session().harness.submission(accepted.second.submissionId, context);
  assert.equal((await receipt.status(context)).status, 'done');
});

test('worker SIGKILL/reopen never replays unsafe intent, but can read/report behind the retained fence', async t => {
  const { dir, accepted } = await crash(t, 'unsafe');
  let reruns = 0;
  const tool = { name: 'unsafe', description: 'Synthetic effect', parameters: { type: 'object', properties: {} }, replay: 'unsafe', async execute() { reruns++; return {}; } };
  const { runtime: r, idle, seen } = await fixture(t, { dir, sessionPath: accepted.path,
    serviceOptions: { worker: true, durableExtensions: [{ name: 'fixture', tools: [tool] }] },
    respond: (model, _request, n) => n === 1 ? answer(model, [
      { type: 'toolCall', id: 'repeat', name: 'unsafe', arguments: {} },
      { type: 'toolCall', id: 'inspect', name: 'read', arguments: { path: 'absent.txt' } },
    ], 'toolUse') : answer(model, [{ type: 'text', text: 'Incomplete: original effect uncertain; repeat denied. Parent review required.' }]),
  });
  await idle();
  assert.equal(reruns, 0, 'original execution notified the crash helper once; reopen never executes it again');
  assert.ok(seen.length >= 2, 'model can inspect/report rather than waiting for a person');
  assert.equal(r.snapshot().ui.dialogs.length, 0);
  const review = (await r.session().harness.snapshot(SessionInfo, 1, context)).review;
  assert.ok(review.some(item => /execution intent/.test(item.reason)));
  const results = r.snapshot().messages.filter(m => m.role === 'toolResult');
  assert.match(JSON.stringify(results.find(m => m.toolCallId === 'effect-1')), /may have partially run/);
  assert.match(JSON.stringify(results.find(m => m.toolCallId === 'repeat')), /parent review/);
  assert.equal(results.find(m => m.toolCallId === 'inspect').isError, true, 'safe read executes and reports the missing file normally');
  assert.match(JSON.stringify(results.find(m => m.toolCallId === 'inspect')), /ENOENT|not found|does not exist/i);
  assert.ok(r.snapshot().messages.some(m => m.role === 'assistant' && m.stopReason === 'stop'));
});

for (const mode of ['safe', 'unsafe']) test(`SIGKILL/reopen ${mode} tool: replay policy and uncertain-effect gate`, async t => {
  const { dir, accepted } = await crash(t, mode); let reruns = 0;
  const tool = { name: mode, description: 'Synthetic fixture', parameters: { type: 'object', properties: {} }, replay: mode, async execute() { reruns++; return { output: [{ type: 'text', text: 'read complete' }] }; } };
  const { runtime: r, idle, seen } = await fixture(t, { dir, sessionPath: accepted.path, serviceOptions: { durableExtensions: [{ name: 'fixture', tools: [tool] }] } });
  await idle();
  assert.equal(reruns, mode === 'safe' ? 1 : 0);
  assert.equal(r.snapshot().ui.dialogs.length, 0);
  if (mode === 'unsafe') { assert.ok(seen.length); assert.ok((await r.session().harness.snapshot(SessionInfo, 1, context)).review.length); }
  const results = r.snapshot().messages.filter(m => m.role === 'toolResult');
  assert.equal(results.length, 1);
  assert.equal(Boolean(results[0].isError), mode === 'unsafe');
  if (mode === 'unsafe') assert.match(results[0].content.map(b => b.text).join(''), /may have partially run/);
});
