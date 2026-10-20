import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { fixture, answer, context } from './durable-fixture.mjs';

const settings = () => SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } });
const failures = r => r.snapshot().messages.filter(message => message.role === 'assistant' && message.errorMessage);

for (const recovers of [true, false]) test(`retry display ${recovers ? 'clears recovered failures' : 'keeps one terminal error'}, including reopen`, async t => {
  const { runtime: r, idle, seen, dir } = await fixture(t, {
    serviceOptions: { settingsManager: settings() },
    respond: (model, _messages, count) => recovers && count === 3 ? answer(model) : { ...answer(model, [], 'error'), errorMessage: '503 synthetic overloaded' },
  });
  await r.command({ type: 'prompt', text: 'retry fixture' });
  await idle();
  assert.equal(seen.length, 3);
  assert.equal(failures(r).length, recovers ? 0 : 1);
  assert.equal(r.snapshot().stats.tokens.input, 3, 'all attempts still count');
  const stored = await r.session().conversation.entries({ order: 'ascending' }, 100, undefined, context);
  assert.equal(stored.items.filter(entry => entry.kind === 'pi.assistant' && entry.model[0].errorMessage).length, recovers ? 2 : 3, 'raw failures remain immutable');
  assert.equal(r.snapshot().messages.filter(message => message.usage).length, 3, 'display projection must not drop accounting metadata');
  const before = r.snapshot().messages, path = r.snapshot().sessionFile;
  await r.close();
  const reopened = await fixture(t, { dir, sessionPath: path });
  assert.deepEqual(reopened.runtime.snapshot().messages, before);
  assert.equal(failures(reopened.runtime).length, recovers ? 0 : 1);
  assert.equal(reopened.seen.length, 0);
});
