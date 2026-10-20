import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createProvider } from '@earendil-works/pi-ai';
import { createRuntime } from '../runtime.mjs';
import { createAuth } from '../auth.mjs';

const wait = async predicate => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for auth state');
};
const fakeModel = { id: 'fixture-model', name: 'Fixture model', provider: 'guey-test', api: 'openai-completions', baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function fixture(root) {
  const authPath = join(root, 'agent/auth.json');
  const models = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(root, 'models-store.json') });
  const control = { mode: 'success', calls: 0, streams: 0, refreshFail: false, syncFail: false };
  const provider = createProvider({ id: 'guey-test', name: 'Guey test subscription', models: [fakeModel],
    filterModels(models, credential) { if (control.syncFail && credential) throw new Error('fixture synchronization failure'); return models; },
    api: { stream() { control.streams++; throw new Error('No model call allowed'); }, streamSimple() { control.streams++; throw new Error('No model call allowed'); } },
    auth: {
      apiKey: { name: 'Test API key', async login(i) { return { type: 'api_key', key: await i.prompt({ type: 'secret', message: 'Test API key' }) }; }, async resolve({ credential }) { return credential?.key ? { auth: { apiKey: credential.key } } : undefined; } },
      oauth: { name: 'Test subscription', isSubscription: true,
        async login(i) {
          control.calls++;
          i.notify({ type: 'auth_url', url: 'https://example.invalid/authorize', instructions: 'Safe fixture; do not visit this URL.' });
          i.notify({ type: 'device_code', userCode: 'TEST-1234', verificationUri: 'https://example.invalid/device' });
          i.notify({ type: 'info', message: 'Fixture instructions', links: [{ url: 'javascript:alert(1)', label: 'unsafe' }] });
          await i.prompt({ type: 'text', message: 'Test account name' });
          const choice = await i.prompt({ type: 'select', message: 'Choose test account', options: [{ id: 'one', label: 'Account one' }, { id: 'two', label: 'Account two' }] });
          assert.ok(['one', 'two'].includes(choice));
          const secret = await i.prompt({ type: 'secret', message: 'Test secret' });
          if (control.mode === 'fail') throw new Error('provider exception contains ' + secret);
          if (control.mode === 'callback') {
            const controller = new AbortController();
            const pending = i.prompt({ type: 'manual_code', message: 'Callback will win', signal: controller.signal });
            controller.abort(); await pending.catch(() => {});
          } else await i.prompt({ type: 'manual_code', message: 'Paste test authorization code' });
          i.notify({ type: 'progress', message: 'Exchanging fixture code' });
          return { type: 'oauth', access: 'fixture-access-SECRET', refresh: 'fixture-refresh-SECRET', expires: Date.now() + 3600000 };
        },
        async refresh(c) { return c; }, async toAuth(c) { return { apiKey: c.access }; },
      },
    },
    async fetchModels({ allowNetwork }) { if (allowNetwork && control.refreshFail) throw new Error('fixture catalog failure'); return [fakeModel]; },
  });
  models.registerNativeProvider(provider);
  await mkdir(join(root, 'state'), { recursive: true });
  const runtime = await createRuntime({ cwd: root, stateDir: join(root, 'state'), agentDir: join(root, 'agent'), sessionDir: join(root, 'agent/sessions'), authentication: true,
    serviceOptions: { modelRuntime: models, settingsManager: SettingsManager.inMemory(), resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true } } });
  return { runtime, models, authPath, control };
}

test('stock SDK auth persists isolated credentials; cancellation, stale answers, failure, callback and logout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-auth-')); const f = await fixture(root);
  const command = (type, fields = {}) => f.runtime.command({ type, ...fields });
  const snap = () => f.runtime.snapshot().auth;
  const answer = async value => { await wait(() => snap().prompt); return command('auth_answer', { promptId: snap().prompt.id, value }); };
  try {
    const providers = await command('auth_providers');
    assert.ok(providers.find(p => p.id === 'guey-test').methods.some(m => m.type === 'oauth'));
    assert.equal(f.control.calls, 0, 'listing providers must not begin authorization');
    await assert.rejects(command('auth_login', { provider: 'missing', method: 'oauth' }), /Unknown/);
    await assert.rejects(command('auth_login', { provider: 'guey-test', method: 'wrong' }), /Unsupported/);
    await command('auth_login', { provider: 'guey-test', method: 'oauth' });
    await wait(() => snap().prompt); const stale = snap().prompt.id;
    await assert.rejects(command('model', { provider: 'guey-test', modelId: fakeModel.id }), /busy/);
    await assert.rejects(command('prompt', { text: 'do not run' }), /sign-in/);
    await assert.rejects(command('auth_login', { provider: 'guey-test', method: 'oauth' }), /busy/);
    await assert.rejects(command('auth_answer', { promptId: stale, value: '' }), /nonempty/);
    await command('auth_cancel'); assert.equal(snap().status, 'cancelled');
    await assert.rejects(command('auth_answer', { promptId: stale, value: 'late' }), /expired/);
    assert.equal((await f.models.listCredentials()).length, 0);
    // A provider exception containing a submitted secret must never reach snapshot.
    f.control.mode = 'fail'; await command('auth_login', { provider: 'guey-test', method: 'oauth' });
    await answer('test account'); await wait(() => snap().prompt?.type === 'select');
    await assert.rejects(command('auth_answer', { promptId: snap().prompt.id, value: 'invalid' }), /Invalid/);
    await answer('one'); await wait(() => snap().prompt?.type === 'secret'); await answer('do-not-expose-me');
    await wait(() => !snap().busy); assert.equal(snap().status, 'error');
    assert.ok(!JSON.stringify(f.runtime.snapshot()).includes('do-not-expose-me'));
    assert.equal((await f.models.listCredentials()).length, 0);
    // Per-prompt cancellation is not whole-flow cancellation (callback won).
    f.control.mode = 'callback'; f.control.refreshFail = true;
    await command('auth_login', { provider: 'guey-test', method: 'oauth' });
    await answer('test'); await wait(() => snap().prompt?.type === 'select'); await answer('two');
    await wait(() => snap().prompt?.type === 'secret'); await answer('not-stored-input');
    await wait(() => !snap().busy); assert.equal(snap().status, 'success');
    assert.match(snap().message, /could not be refreshed/);
    assert.equal(JSON.parse(await readFile(f.authPath, 'utf8'))['guey-test'].access, 'fixture-access-SECRET');
    assert.equal((await stat(f.authPath)).mode & 0o077, 0);
    assert.ok(!JSON.stringify(f.runtime.snapshot()).includes('fixture-access-SECRET'));
    assert.deepEqual(f.runtime.snapshot().messages, [], 'auth never enters conversation history');
    await command('model', { provider: 'guey-test', modelId: fakeModel.id });
    assert.equal(f.runtime.snapshot().model.id, fakeModel.id);
    await command('auth_logout', { provider: 'guey-test' }); await wait(() => !snap().busy);
    assert.deepEqual(await f.models.listCredentials(), []);
    await assert.rejects(command('auth_logout', { provider: 'guey-test' }), /No stored/);
    f.control.refreshFail = false;
    await command('auth_login', { provider: 'guey-test', method: 'api_key' });
    await answer('fixture-api-KEY'); await wait(() => !snap().busy);
    assert.equal(JSON.parse(await readFile(f.authPath, 'utf8'))['guey-test'].key, 'fixture-api-KEY');
    assert.ok(!JSON.stringify(f.runtime.snapshot()).includes('fixture-api-KEY'));
    await command('auth_logout', { provider: 'guey-test' }); await wait(() => !snap().busy);
    f.control.syncFail = true;
    await command('auth_login', { provider: 'guey-test', method: 'api_key' });
    await answer('saved-before-sync-failed'); await wait(() => !snap().busy);
    assert.equal(snap().status, 'warning'); assert.match(snap().message, /Credentials saved/);
    assert.equal(JSON.parse(await readFile(f.authPath, 'utf8'))['guey-test'].key, 'saved-before-sync-failed');
    assert.equal(f.control.streams, 0);
  } finally { await f.runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('auth timeout is cancellable even while waiting for a provider prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-auth-timeout-')); const f = await fixture(root);
  let adapter;
  try {
    adapter = createAuth({ models: () => f.models, changed() {}, assertIdle() {}, timeoutMs: 20 });
    adapter.login('guey-test', 'oauth'); await wait(() => !adapter.busy);
    assert.equal(adapter.snapshot().status, 'cancelled'); assert.deepEqual(await f.models.listCredentials(), []);
  } finally { await adapter?.cancel(); await f.runtime.close(); await rm(root, { recursive: true, force: true }); }
});


test("Pi at work holds up Pi's sign-ins only: Codex's and Claude Code's are their own, one at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-auth-own-')); const f = await fixture(root);
  let release, adapter;
  const codex = { configured: () => null, logout: async () => {}, login: i => new Promise(resolve => { i.notify({ type: 'device_code', userCode: 'ABCD-1234', verificationUri: 'https://auth.openai.com/codex/device' }); release = resolve; }) };
  try {
    adapter = createAuth({ models: () => f.models, changed() {}, assertIdle() { throw new Error('Agent is busy; abort or wait before changing model'); }, codex });
    assert.throws(() => adapter.login('guey-test', 'oauth'), /busy/);
    adapter.login('codex', 'oauth');
    await wait(() => release);
    assert.equal(adapter.snapshot().providerId, 'codex');
    assert.throws(() => adapter.login('claude-agent', 'oauth'), /already under way/);
    release(); await wait(() => !adapter.busy);
    assert.equal(adapter.snapshot().status, 'success');
  } finally { await adapter?.cancel(); await f.runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test('one ChatGPT subscription is offered by the sign-ins that work by a code, named for their harness', () => {
  const provider = (id, name, oauth, apiKey) => ({ id, name, auth: { ...(oauth ? { oauth: { name: `${name} subscription`, isSubscription: true } } : {}), ...(apiKey ? { apiKey: { name: `${name} API key`, login: true } } : {}) } });
  const runtime = {
    getProviders: () => [provider('anthropic', 'Anthropic', true, true), provider('openai', 'OpenAI', true, true), provider('openai-codex', 'OpenAI Codex (legacy)', true, false), provider('xai', 'xAI', true, true)],
    getProviderAuthStatus: () => ({ configured: false }),
  };
  const auth = createAuth({ models: () => runtime, changed() {}, assertIdle() {}, claude: { configured: () => false }, codex: { configured: () => false } });
  const rows = auth.providers();
  const methods = id => rows.find(p => p.id === id)?.methods.map(m => m.type);
  assert.deepEqual(rows.map(p => p.name), ['Claude', 'ChatGPT · Codex', 'OpenAI', 'ChatGPT · Pi', 'xAI']);
  assert.deepEqual(methods('openai'), ['api_key'], 'the browser-callback ChatGPT sign-in is not offered; the API key still is');
  assert.deepEqual(methods('openai-codex'), ['oauth']);
  assert.deepEqual(methods('xai'), ['oauth', 'api_key'], 'other providers are unchanged');
  const subscriptions = rows.filter(p => p.methods.some(m => m.type === 'oauth')).map(p => p.name);
  assert.deepEqual(subscriptions.filter(name => /ChatGPT|OpenAI/.test(name)), ['ChatGPT · Codex', 'ChatGPT · Pi']);
  assert.throws(() => auth.login('openai', 'oauth'), /Unsupported login method/);
});
