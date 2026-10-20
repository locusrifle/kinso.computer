import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '@earendil-works/pi-ai';
import { createRuntime } from '../runtime.mjs';
import { createTabHost } from '../tabs.mjs';
import { answer, until } from './durable-fixture.mjs';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAuth } from '../auth.mjs';
import { SOURCES, canonicalSnapshot } from '../canonical.mjs';

const settle = async auth => {
  for (let i = 0; i < 200; i++) {
    if (!auth.busy) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Auth did not settle');
};

test('old Pi Anthropic credentials can be removed, but no new Anthropic login is offered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-auth-'));
  const env = { ...process.env };
  let auth;
  try {
    await writeFile(join(root, 'auth.json'), JSON.stringify({ anthropic: { type: 'api_key', key: 'fixture-old-unused-key' } }));
    const models = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json') });
    // Keep native provider login/storage, but forbid network catalog requests.
    models.refresh = async () => ({ aborted: false, errors: new Map() });
    auth = createAuth({ models: () => models, changed() {}, assertIdle() {} });
    assert.ok(!auth.providers().some(p => p.id === 'anthropic'));
    assert.ok(auth.providers().some(p => p.id === 'claude-agent'));
    assert.ok(auth.providers().some(p => p.id === 'codex' && p.methods.some(m => m.subscription)));
    for (const method of ['oauth', 'api_key']) assert.throws(() => auth.login('anthropic', method), /Unknown/);
    assert.match((await auth.accounts()).find(p => p.id === 'anthropic').name, /NOT USED/);
    assert.ok(!JSON.stringify(auth.snapshot()).includes('fixture-old-unused-key'));
    await auth.logout('anthropic');
    await settle(auth);
    assert.equal(auth.snapshot().status, 'success');
    assert.deepEqual(await models.listCredentials(), []);
    await assert.rejects(auth.logout('anthropic'), /No stored/);
    assert.deepEqual({ ...process.env }, env);
  } finally {
    await auth?.cancel();
    await rm(root, { recursive: true, force: true });
  }
});

test('separate Pi auth and conversation runtimes refresh subscription eligibility after login and logout', { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-auth-separated-'));
  const runtimes = [];
  let host, streams = 0;
  const model = { id: 'fixture-chatgpt', name: 'Fixture ChatGPT', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  try {
    host = await createTabHost({ cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), stateDir: join(root, 'state'), authentication: true,
      claudeAvailable: () => false, codexAvailable: () => false,
      createRuntime: async options => {
        const models = await ModelRuntime.create({ authPath: join(root, 'synthetic-auth.json'), modelsPath: null, modelsStorePath: join(root, `models-${runtimes.length}.json`), allowModelNetwork: false });
        models.registerNativeProvider(createProvider({ id: 'openai-codex', name: 'Fixture ChatGPT', models: [model],
          auth: { oauth: { name: 'Fixture subscription', isSubscription: true,
            async login(i) { await i.prompt({ type: 'text', message: 'Fixture code' }); return { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600000 }; },
            async refresh(c) { return c; }, async toAuth(c) { return { apiKey: c.access }; } } },
          api: { stream() { throw new Error('Unexpected provider stream'); }, streamSimple() { throw new Error('Unexpected provider stream'); } },
          async fetchModels() { return [model]; },
        }));
        models.streamSimple = selected => {
          streams++;
          const message = answer(selected);
          return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message }; }, async result() { return message; } };
        };
        runtimes.push(models);
        return createRuntime({ ...options, serviceOptions: { modelRuntime: models,
          settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id, compaction: { enabled: false }, retry: { enabled: false } }),
          resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true } } });
      },
    });
    assert.equal(runtimes.length, 2);
    assert.notEqual(runtimes[0], runtimes[1]);
    assert.equal(host.snapshot().model.id, model.id);
    await assert.rejects(host.command({ type: 'prompt', text: 'unsigned' }), /subscription sign-in/);
    await host.command({ type: 'auth_login', provider: model.provider, method: 'oauth' });
    await until(() => host.snapshot().auth.prompt);
    await host.command({ type: 'auth_answer', promptId: host.snapshot().auth.prompt.id, value: 'synthetic-code' });
    await until(() => !host.snapshot().auth.busy);
    assert.equal(host.snapshot().auth.status, 'success');
    assert.equal(runtimes[0].isUsingSubscription(model.provider), true);
    assert.equal(host.snapshot().billing, 'Subscription');
    // No model picker/catalog operation between sign-in and the next prompt.
    await host.command({ type: 'prompt', text: 'signed in' });
    await until(() => !host.snapshot().busy);
    assert.equal(streams, 1);
    await host.command({ type: 'auth_logout', provider: model.provider });
    await until(() => !host.snapshot().auth.busy);
    assert.equal(runtimes[0].isUsingSubscription(model.provider), false);
    assert.notEqual(host.snapshot().billing, 'Subscription');
    await assert.rejects(host.command({ type: 'prompt', text: 'signed out' }), /subscription sign-in/);
    assert.equal(streams, 1);
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});

test('canonical execution accepts Pi, Claude and Codex and never relabels other sources', () => {
  assert.deepEqual(SOURCES, ['pi', 'claude', 'codex']);
  assert.equal(canonicalSnapshot().source, 'pi');
  assert.equal(canonicalSnapshot({}, 'claude').source, 'claude');
  assert.equal(canonicalSnapshot({}, 'codex').source, 'codex');
  assert.throws(() => canonicalSnapshot({}, 'gemini'), /Unsupported execution source/);
  assert.throws(() => canonicalSnapshot({ source: 'gemini' }), /Unsupported execution source/);
  assert.throws(() => canonicalSnapshot({ source: 'gemini' }, 'pi'), /Unsupported execution source/);
});
