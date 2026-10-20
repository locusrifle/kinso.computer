import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hook, ToolTask } from '@earendil-works/pi-durable';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { createRuntime, assertChatGPTSubscription } from '../runtime.mjs';
import { SessionInfo, legacySession } from '../durable-session.mjs';
import { fixture, context, answer, until } from './durable-fixture.mjs';

test('an explicit foreign SQLite file is never initialized as a new conversation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-foreign-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'foreign.sqlite'), db = new DatabaseSync(path); db.exec('CREATE TABLE unrelated (value TEXT)'); db.close();
  const original = await readFile(path);
  await assert.rejects(createRuntime({ sessionPath: path }), /no such table/);
  assert.deepEqual(await readFile(path), original);
});

test('ambiguous or unsupported legacy trees are rejected before projection or migration can rewrite them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-invalid-tree-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'old.jsonl');
  const header = { type: 'session', version: 3, id: 'legacy', cwd: dir, timestamp: new Date().toISOString() };
  const entry = { type: 'message', id: 'one', parentId: null, message: { role: 'user', content: 'hello', timestamp: 1 } };
  for (const entries of [[entry, entry], [{ ...entry, parentId: 'missing' }], [{ ...entry, parentId: 'one' }], [{ ...entry, type: 'future-runtime-state' }]]) {
    const original = [header, ...entries].map(JSON.stringify).join('\n') + '\n';
    await writeFile(path, original); await assert.rejects(legacySession(path), /Unsupported or ambiguous/); assert.equal(await readFile(path, 'utf8'), original);
  }
  const old = [{ ...header, version: 1 }, { type: 'message', message: entry.message }].map(JSON.stringify).join('\n') + '\n';
  await writeFile(path, old); assert.equal((await legacySession(path)).messages[0].content, 'hello'); assert.equal(await readFile(path, 'utf8'), old);
});

test('subscription identity cannot authorize an API endpoint or provider override', () => {
  const models = { isUsingSubscription: () => true };
  const model = { provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' };
  assert.doesNotThrow(() => assertChatGPTSubscription(models, model));
  for (const override of [{ baseUrl: 'https://api.openai.com/v1' }, { baseUrl: 'https://example.invalid' }, { api: 'openai-responses' }, { baseUrl: 'https://chatgpt.com/backend-api?route=paid' }]) assert.throws(() => assertChatGPTSubscription(models, { ...model, ...override }), /refusing a paid or overridden route/);
  assert.throws(() => assertChatGPTSubscription({ isUsingSubscription: () => false }, model), /refusing API-key fallback/);
});

test('manual compaction retains the whole visible history, and its request uses the same policy boundary', async t => {
  const settingsManager = SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1024 }, retry: { enabled: false } });
  const { runtime: r, idle, seen, models } = await fixture(t, { serviceOptions: { settingsManager } });
  for (let i = 0; i < 3; i++) { await r.command({ type: 'prompt', text: `turn ${i}: ${'context '.repeat(200)}` }); await idle(); }
  const before = r.snapshot().messages.length;
  const task = await r.session().conversation.compact(undefined, context); await r.session().harness.waitForTask(task, context);
  assert.equal(r.snapshot().messages.length, before + 1); assert.equal(r.snapshot().messages.at(-1).role, 'compactionSummary');
  await r.command({ type: 'prompt', text: 'more context '.repeat(200) }); await idle();
  const requests = seen.length;
  models.isUsingSubscription = () => false;
  const denied = await r.session().conversation.compact(undefined, context); await r.session().harness.waitForTask(denied, context);
  assert.equal(seen.length, requests, 'compaction cannot bypass the subscription guard');
});

test('an unsafe tool error ends the run without replay or a human recovery prompt', async t => {
  let effects = 0;
  const tool = { name: 'send', description: 'Synthetic effect', replay: 'unsafe', parameters: { type: 'object', properties: {} }, execute: async () => { effects++; return { isError: true, output: [{ type: 'text', text: 'response lost' }] }; } };
  const { runtime: r, idle, seen } = await fixture(t, { serviceOptions: { durableExtensions: [{ name: 'synthetic', tools: [tool] }] }, respond: (model, _request, n) => n === 1 ? answer(model, [{ type: 'toolCall', id: 'send-1', name: 'send', arguments: {} }], 'toolUse') : answer(model, [{ type: 'text', text: 'Outcome unknown; inspect the destination before any fresh action.' }]) });
  await r.command({ type: 'prompt', text: 'synthetic action' }); await idle();
  assert.equal(effects, 1); assert.equal(seen.length, 1);
  await r.command({ type: 'prompt', text: 'what happened?' }); await idle();
  assert.equal(seen.length, 2); assert.equal(effects, 1);
  assert.equal(r.snapshot().ui.dialogs.length, 0);
  assert.match(JSON.stringify(r.snapshot().messages), /response lost/);
});

test('legacy approval flag does not prompt for fresh routine checks; independent dangerous-tool blocks remain', async t => {
  let effects = 0;
  const tool = { name: 'send', description: 'Synthetic effect', replay: 'unsafe', parameters: { type: 'object', properties: {} }, execute: async () => { effects++; return {}; } };
  const { runtime: r, idle } = await fixture(t, { serviceOptions: { durableExtensions: [{ name: 'synthetic', tools: [tool], hooks: [hook(ToolTask, { beforeTool: call => call.name === 'send' ? { block: 'Explicit external consent required' } : undefined })] }] },
    respond: (model, _request, n) => n === 1 ? answer(model, [
      { type: 'toolCall', id: 'routine', name: 'bash', arguments: { command: 'printf routine-check' } },
      { type: 'toolCall', id: 'consent', name: 'send', arguments: {} },
    ], 'toolUse') : answer(model),
  });
  await r.session().conversation.commit(async tx => { const info = await tx.doc(SessionInfo, 1); info.requireEffectApproval = true; info.review.push({ name: 'send', reason: 'may have sent' }); }, context);
  await r.command({ type: 'prompt', text: 'check status only' }); await idle();
  assert.equal(effects, 0);
  assert.equal(r.snapshot().ui.dialogs.length, 0);
  assert.match(JSON.stringify(r.snapshot().messages.find(m => m.toolCallId === 'routine')), /routine-check/);
  assert.match(JSON.stringify(r.snapshot().messages.find(m => m.toolCallId === 'consent')), /Explicit external consent required/);
});

test('auxiliary Anthropic requests are blocked without mutating the caller-owned auth runtime', async t => {
  const { runtime: r, idle, seen } = await fixture(t, { serviceOptions: { settingsManager: SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1024 }, retry: { enabled: false } }) } });
  for (let i = 0; i < 3; i++) { await r.command({ type: 'prompt', text: 'context '.repeat(300) }); await idle(); }
  const count = seen.length;
  await r.session().conversation.configure({ model: { provider: 'anthropic', modelId: 'claude-opus-5-5' } }, context);
  const task = await r.session().conversation.compact(undefined, context);
  const ended = await r.session().harness.waitForTask(task, context);
  assert.equal(seen.length, count);
  assert.equal(ended.state.outcome.status, 'failed');
});
