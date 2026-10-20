import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { createRuntime } from '../runtime.mjs';
import { createTabHost } from '../tabs.mjs';
import { fixture, until } from './durable-fixture.mjs';

for (const confirmed of [false, true]) test(`closing the first authenticated Pi tab releases its writer (${confirmed ? 'confirmed' : 'idle'})`, { timeout: 15000 }, async t => {
  let host;
  t.after(async () => { await host?.close(); });
  const f = await fixture(t);
  await f.runtime.close();
  host = await createTabHost({
    cwd: f.dir, agentDir: join(f.dir, 'agent'), sessionDir: join(f.dir, 'sessions'), stateDir: join(f.dir, 'state'),
    authentication: true, claudeAvailable: () => false, codexAvailable: () => false,
    serviceOptions: {
      modelRuntime: f.models,
      settingsManager: SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noContextFiles: true, noThemes: true, noPromptTemplates: true },
    },
  });
  await host.command({ type: 'prompt', text: 'Keep this saved conversation' });
  await until(() => !host.snapshot().busy);
  const before = host.snapshot(), first = before.tabs[0];
  assert.equal(before.messages.at(-1).content[0].text, 'ok');
  assert.ok(await readFile(`${first.sessionFile}.owner`, 'utf8'));

  await host.command({ type: 'tab-close', tabId: first.id, closeConfirmed: confirmed });
  assert.deepEqual(host.snapshot().tabs, []);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'state/open-tabs.json'), 'utf8')), []);
  await assert.rejects(readFile(`${first.sessionFile}.owner`), { code: 'ENOENT' });
  assert.ok((await host.command({ type: 'auth_providers' })).length, 'machine sign-in stays usable with no tabs');
  assert.equal(host.isIdle(), true);

  const reopened = await host.command({ type: 'tab-open', agent: 'pi', path: first.sessionFile });
  assert.equal(reopened.sessionId, before.sessionId);
  assert.deepEqual(host.snapshot().messages, before.messages, 'reopening continues the saved transcript');
  assert.equal(f.seen.length, 1, 'closing/reopening must not make a model request');
  const state = host.snapshot();
  await assert.rejects(createRuntime({ cwd: f.dir, agentDir: join(f.dir, 'agent'), sessionPath: first.sessionFile }), /already has a writer/);
  assert.equal(host.snapshot().sessionId, state.sessionId, 'an actually open tab still owns its writer');
});
