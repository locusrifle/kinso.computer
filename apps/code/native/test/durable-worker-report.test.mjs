import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Subagents } from '../subagent.mjs';
import { runWorker } from '../subagent-runner.mjs';
import { createRuntime } from '../runtime.mjs';
import { redactor } from '../../../../system/memory.mjs';
import { fixture, answer } from './durable-fixture.mjs';

// These exercise Subagents.start and must run from the parent, never by
// removing IMPERFECT_SUBAGENT or bypassing its recursion guard in a worker.
for (const [name, content] of [
  ['empty', []],
  ['thinking-only', [{ type: 'thinking', thinking: 'nothing to report' }]],
  ['whitespace', [{ type: 'text', text: ' \n\t ' }]],
]) test(`a ${name} worker stop is not a successful final report`, async t => {
  const { dir, models } = await fixture(t, { respond: model => answer(model, content) });
  const manager = new Subagents({ root: join(dir, 'tasks'), owner: 'parent', agentDir: join(dir, 'agent'), launch: async () => {} });
  const task = manager.start({ task: 'Report assigned work', cwd: dir });
  const result = await runWorker(task.path, { redact: String, signals: new EventEmitter(), makeModels: async () => models });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /without.*(?:final|report)|empty/i);
  assert.equal(result.output, '');
  assert.equal(manager.read(task.id).status, 'failed');
  assert.notEqual(manager.read(task.id).summary, 'Final report ready');
  assert.equal(JSON.parse(await readFile(task.resultPath)).status, 'failed');
});

for (const long of [false, true]) test(`worker failure retains authoritative receipt cause, redacted and bounded (long=${long})`, async t => {
  const secret = 'worker-receipt-sensitive-sentinel';
  const detail = `Provider refused ${secret}${long ? ' x'.repeat(40000) : ''}`;
  const { dir, models } = await fixture(t, { respond: model => ({ ...answer(model, [], 'error'), errorMessage: detail }) });
  const manager = new Subagents({ root: join(dir, 'tasks'), owner: 'parent', agentDir: join(dir, 'agent'), launch: async () => {} });
  const task = manager.start({ task: 'Report assigned work', cwd: dir });
  const result = await runWorker(task.path, { redact: redactor([secret]), signals: new EventEmitter(), makeModels: async () => models });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /^Worker submission model_error: Provider refused /);
  assert.ok(!result.error.includes(secret));
  assert.ok(result.error.includes('[redacted]'));
  assert.ok(result.error.length <= 65536);
  if (long) assert.equal(result.error.length, 65536);
  assert.equal(result.output, '');
  assert.equal(result.usage, null);
  assert.equal(result.usageReliable, false);
  assert.deepEqual(result.models, {});
  const saved = await readFile(task.resultPath, 'utf8');
  const state = manager.read(task.id);
  assert.ok(!saved.includes(secret));
  assert.equal(JSON.parse(saved).error, result.error);
  assert.equal(state.status, 'failed');
  assert.match(state.summary, /^Worker submission model_error:/);
  assert.ok(state.summary.length <= 200);
});

test('a done worker receipt without a stop answer still fails after explicit tool termination', async t => {
  const { dir, models } = await fixture(t, { respond: model => answer(model, [{ type: 'toolCall', id: 'stop', name: 'stop', arguments: {} }], 'toolUse') });
  const manager = new Subagents({ root: join(dir, 'tasks'), owner: 'parent', agentDir: join(dir, 'agent'), launch: async () => {} });
  const task = manager.start({ task: 'Report assigned work', cwd: dir });
  const result = await runWorker(task.path, { redact: String, signals: new EventEmitter(), makeModels: async () => models,
    makeRuntime: options => createRuntime({ ...options, serviceOptions: { ...options.serviceOptions, durableExtensions: [{ name: 'stop', tools: [{
      name: 'stop', description: 'Explicitly end this run', replay: 'unsafe', parameters: { type: 'object', properties: {} },
      execute: async () => ({ output: [], control: { terminate: true } }),
    }] }] } }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'Worker ended without a final answer');
  assert.equal(result.output, '');
  assert.equal(result.usageReliable, false);
});
