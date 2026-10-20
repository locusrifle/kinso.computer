import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture, until, answer, context } from './durable-fixture.mjs';

async function crash(t, mode) {
  const dir = await mkdtemp(join(tmpdir(), 'interruption-prompts-'));
  const child = fork(new URL('./fixtures/interruption-crash.mjs', import.meta.url), [dir, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let accepted, ready, diagnostics = '';
  child.on('message', m => { if (m.type === 'accepted') accepted = m; if (m.type === 'ready') ready = true; });
  child.stderr.on('data', d => { diagnostics += d; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); });
  await until(() => { if (child.exitCode != null) throw new Error(diagnostics); return accepted && ready; });
  child.kill('SIGKILL'); await once(child, 'exit');
  return { dir, ...accepted };
}

for (const mode of ['readonly', 'bash-write', 'unsafe', 'persisted', 'legacy-pending', 'legacy-answered']) test(`${mode}: crash/reopen never requests recovery consent or duplicates an old effect`, async t => {
  const { dir, path, ack } = await crash(t, mode);
  let reruns = 0;
  const send = { name: 'send', description: 'Local synthetic effect', replay: 'unsafe', parameters: { type: 'object', properties: {} }, async execute() { reruns++; throw new Error('Must not run the old effect'); } };
  await writeFile(join(dir, 'evidence.txt'), 'inspect-first');
  const { runtime: r, idle, seen } = await fixture(t, { dir, sessionPath: path,
    serviceOptions: { resume: false, durableExtensions: [{ name: 'synthetic', tools: [send] }] },
    respond: (model, _request, n) => n === 1 ? answer(model, [{ type: 'toolCall', id: 'inspect-fresh', name: 'read', arguments: { path: 'evidence.txt' } }], 'toolUse') : answer(model, [{ type: 'text', text: 'Inspected state; no retry of the original action.' }]),
  });
  assert.equal(seen.length, 0, 'opening and rendering a paused recovery performs no work');
  assert.equal(r.snapshot().ui.dialogs.length, 0);
  r.session().harness.resume();
  await idle();
  assert.equal(reruns, 0);
  assert.equal(r.snapshot().ui.dialogs.length, 0);
  assert.equal(seen.length, 2);
  const old = r.snapshot().messages.filter(m => m.role === 'toolResult' && m.toolCallId === 'original-call');
  assert.equal(old.length, 1, 'one authoritative result for the original call');
  assert.equal(old[0].isError, mode !== 'persisted');
  if (mode === 'persisted') assert.match(JSON.stringify(old[0]), /original receipt/);
  else if (mode.startsWith('legacy')) assert.match(JSON.stringify(old[0]), /not run on recovery/);
  else assert.match(JSON.stringify(old[0]), /interrupted.*may have partially run/);
  const effects = await readFile(join(dir, 'effects.txt'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  assert.equal(effects, mode === 'bash-write' ? 'once' : ['unsafe', 'persisted'].includes(mode) ? 'sent\n' : '');
  if (['readonly', 'bash-write'].includes(mode)) assert.match(JSON.stringify(old[0]), /readonly-output/, 'committed shell output survives interruption');
  assert.match(JSON.stringify(r.snapshot().messages.find(m => m.toolCallId === 'inspect-fresh')), /inspect-first/);
  const before = r.snapshot().messages;
  for (let i = 0; i < 5; i++) assert.deepEqual(r.snapshot().messages, before, 'rerender does not alter calls/results');
  const duplicate = await r.command({ type: 'prompt', requestId: 'original-request', text: 'Perform the requested action once' });
  assert.equal(duplicate.submissionId, ack.submissionId);
  assert.equal(duplicate.duplicate, true);
  await r.close();
  const restored = await fixture(t, { dir, sessionPath: path }); await restored.idle();
  assert.deepEqual(restored.runtime.snapshot().messages, before, 'pause/reopen preserves every call and result');
  assert.equal(restored.seen.length, 0);
  assert.equal(restored.runtime.snapshot().ui.dialogs.length, 0);
});

test('cancel an executing bash write, resume for inspection, and keep its sole result without a prompt', async t => {
  const { runtime: r, dir, idle } = await fixture(t, { respond: (model, _request, n) => n === 1 ? answer(model, [{ type: 'toolCall', id: 'write-once', name: 'bash', arguments: { command: 'printf once >> effect.txt; sleep 2' } }], 'toolUse') : n === 2 ? answer(model, [{ type: 'toolCall', id: 'inspect-after-stop', name: 'read', arguments: { path: 'effect.txt' } }], 'toolUse') : answer(model) });
  await r.command({ type: 'prompt', text: 'run the local fixture once' });
  await until(async () => (await readFile(join(dir, 'effect.txt'), 'utf8').catch(() => '')) === 'once');
  // Sending a status question steers; it does not abort the call or open consent.
  await r.command({ type: 'prompt', text: 'are you working?' });
  assert.equal(r.snapshot().ui.dialogs.length, 0);
  const withdrawn = await r.command({ type: 'abort' }); await idle();
  assert.deepEqual(withdrawn.steering, ['are you working?']);
  const original = r.snapshot().messages.filter(m => m.role === 'toolResult' && m.toolCallId === 'write-once');
  assert.equal(original.length, 1); assert.equal(original[0].isError, true);
  await r.command({ type: 'prompt', text: 'inspect the existing result, do not repeat the write' }); await idle();
  assert.equal(r.snapshot().ui.dialogs.length, 0);
  assert.equal(await readFile(join(dir, 'effect.txt'), 'utf8'), 'once');
  assert.deepEqual(r.snapshot().messages.filter(m => m.role === 'toolResult' && m.toolCallId === 'write-once'), original);
  assert.match(JSON.stringify(r.snapshot().messages.find(m => m.toolCallId === 'inspect-after-stop')), /once/);
});
