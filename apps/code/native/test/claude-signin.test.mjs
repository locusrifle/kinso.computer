import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createProvider } from '@earendil-works/pi-ai';
import { createClaudeSignIn, claudeAuth, claudeExecutable, claudeSubscriptionEnv } from '../claude-auth.mjs';
import { createTabHost } from '../tabs.mjs';
import { createClaudeRuntime, assertClaudeSubscription } from '../claude-runtime.mjs';
import { withoutPiAnthropic } from '../runtime.mjs';
import { harnessFixture } from './fixtures/harness-page.mjs';

const wait = async predicate => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('Timed out');
};
const code = 'fixture-code.opaque~part#fixture-state';
const url = 'https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=fixture-challenge&state=fixture-state&trailing=complete';
const fixtureOAuth = { accessToken: 'fixture-Claude-Code-secret', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600000, scopes: ['user:inference', 'user:profile'] };

async function hostedFixture({ oldPiAuth = false, statusFailure = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claude-hosted-'));
  const config = join(root, '.imperfect/credentials/claude'), agentDir = join(root, 'agent'), credentials = join(config, '.credentials.json');
  const env = { HOME: root, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(root, 'untrusted-config'), CLAUDE_CODE_OAUTH_TOKEN: 'fixture-ambient-not-active', ANTHROPIC_API_KEY: 'fixture-key-never-used', ANTHROPIC_BASE_URL: 'https://example.invalid', DISPLAY: ':99', BROWSER: 'unsafe', CLAUDE_CODE_USE_BEDROCK: '1' };
  const calls = [], children = [];
  let exchanges = 0, piLogin = 0, piStreams = 0;
  const signIn = createClaudeSignIn({ env, spawnImpl(executable, args, options) {
    assert.equal(executable, claudeExecutable());
    assert.deepEqual(args.slice(0, 3), ['--setting-sources', '', 'auth']);
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(options.env.CLAUDE_CONFIG_DIR, env.CLAUDE_CONFIG_DIR, 'history remains in Claude Code’s normal config directory');
    assert.equal(options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, config);
    assert.equal(options.env.DISPLAY, undefined);
    assert.equal(options.env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(options.env.BROWSER, '/bin/true');
    assert.equal(options.shell, false);
    calls.push(args.slice(3));
    const child = new EventEmitter(); children.push(child);
    child.stdout = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    child.stdin = new Writable({ write(chunk, encoding, done) {
      (async () => {
        assert.equal(String(chunk), code + '\n'); exchanges++;
        await mkdir(config, { recursive: true, mode: 0o700 });
        await writeFile(credentials, JSON.stringify({ claudeAiOauth: fixtureOAuth }), { mode: 0o600 });
        child.stdout.write('Login successful.\n'); child.emit('close', 0);
      })().then(() => done(), done);
    } });
    queueMicrotask(() => {
      if (args.includes('login')) {
        // No terminal, no local browser; prompt and URL span output chunks.
        const split = url.indexOf('fixture-state') + 7;
        child.stdout.write('Opening browser…\nIf browser did not open, visit: ' + url.slice(0, split));
        child.stdout.write(url.slice(split) + '\nPaste code here if prompted > ');
      } else if (args.includes('status')) {
        child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: statusFailure ? 'bedrock' : 'firstParty' })); child.emit('close', 0);
      } else {
        rm(credentials, { force: true }).then(() => child.emit('close', 0));
      }
    });
    return child;
  } });
  await mkdir(agentDir, { recursive: true });
  const authPath = join(agentDir, 'auth.json');
  if (oldPiAuth) await writeFile(authPath, JSON.stringify({ anthropic: { type: 'oauth', access: 'fixture-unused-Pi-secret', refresh: 'fixture-refresh', expires: Date.now() + 3600000 } }));
  const models = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: join(root, 'models.json') });
  const model = { id: 'fixture-claude', name: 'Fixture Claude', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://example.invalid', reasoning: true, input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  models.registerNativeProvider(createProvider({ id: 'anthropic', name: 'Anthropic', models: [model],
    auth: { oauth: { name: 'Forbidden Pi OAuth', isSubscription: true, login() { piLogin++; throw new Error('Forbidden'); }, refresh(c) { return c; }, toAuth(c) { return { apiKey: c.access }; } } },
    api: { stream() { piStreams++; throw new Error('Forbidden model call'); }, streamSimple() { piStreams++; throw new Error('Forbidden model call'); } },
  }));
  const host = await createTabHost({ cwd: root, agentDir, stateDir: join(root, 'state'), sessionDir: join(root, 'sessions'), authentication: true, checkUpdates: false,
    claudeSignIn: signIn, claudeAvailable: () => Boolean(signIn.configured()), codexAvailable: () => false,
    serviceOptions: { modelRuntime: models, settingsManager: SettingsManager.inMemory({ defaultProvider: 'anthropic', defaultModel: model.id }), resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true } },
    createClaudeRuntime: async () => {
      let selectedModel = null;
      return { events: new EventEmitter(), snapshot: () => ({ sessionId: 'fixture-claude-session', messages: [], busy: false, model: selectedModel, billing: 'Claude subscription' }),
        async command(c) { if (c.type === 'models') return [{ provider: 'claude-agent', id: 'opus', name: 'Opus', billing: 'Claude subscription' }]; if (c.type === 'model') selectedModel = { provider: c.provider, id: c.modelId }; }, async close() {} };
    },
  });
  return { root, env, credentials, host, models, signIn, calls, children, snap: () => host.snapshot().auth, counters: () => ({ exchanges, piLogin, piStreams }), async close() { await host.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const oldPiAuth of [false, true]) test(`hosted Claude sign-in uses Claude Code, not Pi (old Pi OAuth: ${oldPiAuth})`, async () => {
  const f = await hostedFixture({ oldPiAuth });
  try {
    assert.equal(f.signIn.configured(), null);
    const providers = await f.host.command({ type: 'auth_providers' });
    assert.equal(f.calls.length, 0, 'listing never starts OAuth');
    assert.ok(providers.some(p => p.id === 'claude-agent'));
    assert.ok(!providers.some(p => p.id === 'anthropic'));
    assert.ok(!f.snap().configured, 'old Pi OAuth is not an available account');
    assert.ok(!(await f.host.command({ type: 'models' })).some(m => m.provider === 'anthropic'));
    await assert.rejects(f.host.command({ type: 'auth_login', provider: 'anthropic', method: 'oauth' }), /Unknown/);
    await assert.rejects(f.host.command({ type: 'model', provider: 'anthropic', modelId: 'fixture-claude' }), /not used/);
    if (oldPiAuth) {
      assert.match((await f.host.command({ type: 'auth_accounts' })).find(p => p.id === 'anthropic').name, /NOT USED/);
      await assert.rejects(f.host.command({ type: 'prompt', text: 'never spend' }), /only in Claude Code/);
      assert.throws(() => withoutPiAnthropic(f.models.streamSimple.bind(f.models))({ provider: 'anthropic' }, {}), /only in Claude Code/, 'Durable applies the same guard to auxiliary requests without mutating the caller-owned ModelRuntime');
    }
    await f.host.command({ type: 'auth_login', provider: 'claude-agent', method: 'oauth' });
    await wait(() => f.snap().prompt);
    assert.equal(f.snap().events[0].url, url, 'a partial state is never offered');
    await assert.rejects(f.host.command({ type: 'prompt', text: 'not during login' }), /sign-in/);
    await f.host.command({ type: 'auth_answer', promptId: f.snap().prompt.id, value: code });
    await wait(() => !f.snap().busy);
    assert.equal(f.snap().status, 'success');
    assert.equal(claudeAuth(f.env), 'login');
    assert.equal((await stat(f.credentials)).mode & 0o077, 0);
    assert.deepEqual(f.calls, [['login', '--claudeai'], ['status', '--json']]);
    assert.deepEqual(f.counters(), { exchanges: 1, piLogin: 0, piStreams: 0 });
    assert.deepEqual(f.host.snapshot().messages, []);
    const snapshot = JSON.stringify(f.host.snapshot());
    for (const secret of [code, fixtureOAuth.accessToken, 'fixture-unused-Pi-secret', 'fixture-key-never-used']) assert.ok(!snapshot.includes(secret));
    const offered = await f.host.command({ type: 'models' });
    assert.ok(offered.some(m => m.engine === 'claude' && m.provider === 'claude-agent'));
    assert.ok(!offered.some(m => m.provider === 'anthropic'));
    await f.host.command({ type: 'model', provider: 'claude-agent', modelId: 'opus' });
    assert.equal(f.host.snapshot().agent, 'claude');
    assert.equal(f.host.snapshot().auth.status, 'success', 'sign-in console survives replacing the empty Pi tab');
    await f.host.command({ type: 'auth_logout', provider: 'claude-agent' });
    await wait(() => !f.snap().busy);
    assert.equal(f.signIn.configured(), null);
    if (oldPiAuth) {
      assert.ok((await readFile(join(f.root, 'agent/auth.json'), 'utf8')).includes('fixture-unused-Pi-secret'), 'no silent deletion');
      await f.host.command({ type: 'auth_logout', provider: 'anthropic' });
      await wait(() => !f.snap().busy);
      assert.ok(!(await f.models.listCredentials()).some(c => c.providerId === 'anthropic'));
    }
  } finally { await f.close(); }
});

test('Claude cancellation and invalid state never exchange a code; status mismatch is not success', async () => {
  const f = await hostedFixture({ statusFailure: true });
  try {
    for (const action of ['cancel', 'wrong-state', 'newline', 'status-mismatch']) {
      await f.host.command({ type: 'auth_login', provider: 'claude-agent', method: 'oauth' });
      await wait(() => f.snap().prompt);
      const id = f.snap().prompt.id;
      if (action === 'cancel') await f.host.command({ type: 'auth_cancel' });
      else await f.host.command({ type: 'auth_answer', promptId: id, value: action === 'wrong-state' ? 'fixture-code#wrong-state' : action === 'newline' ? 'fixture-code\ninjected#fixture-state' : code });
      await wait(() => !f.snap().busy);
      assert.equal(f.snap().status, action === 'cancel' ? 'cancelled' : 'error');
      await assert.rejects(f.host.command({ type: 'auth_answer', promptId: id, value: code }), /expired/);
    }
    assert.equal(f.counters().exchanges, 1);
  } finally { await f.close(); }
});

test('subscription environment and account preflight block keys, alternate backends and helpers', async () => {
  const env = claudeSubscriptionEnv({ HOME: '/fixture', PATH: '/bin', ANTHROPIC_API_KEY: 'never', ANTHROPIC_AUTH_TOKEN: 'never', ANTHROPIC_BASE_URL: 'never', CLAUDE_CODE_USE_VERTEX: '1', AWS_ACCESS_KEY_ID: 'never', NODE_OPTIONS: 'never', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-subscription' });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'ambient tokens cannot override the saved browser account');
  assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined); assert.equal(env.ANTHROPIC_BASE_URL, undefined); assert.equal(env.CLAUDE_CODE_USE_VERTEX, undefined); assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  const kept = claudeSubscriptionEnv({ HOME: '/fixture', PATH: '/bin', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', IMPERFECT_PORT: '5067', WAYLAND_DISPLAY: 'wayland-1', NIX_LD: '/ld.so' });
  for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'IMPERFECT_PORT', 'WAYLAND_DISPLAY', 'NIX_LD']) assert.ok(kept[key], `${key} reaches the agent's tools`);
  assert.equal(claudeSubscriptionEnv(env, { login: true }).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assertClaudeSubscription({ apiProvider: 'firstParty', tokenSource: 'claude.ai', apiKeySource: 'none' });
  // The installed SDK's real subscription accountInfo shape omits both sources.
  for (const plan of ['Claude Pro', 'Claude Max', 'Claude Team', 'Claude Enterprise']) {
    assertClaudeSubscription({ apiProvider: 'firstParty', subscriptionType: plan });
  }
  for (const account of [{ apiProvider: 'bedrock' }, { apiProvider: 'firstParty', tokenSource: 'claude.ai', apiKeySource: 'apiKeyHelper' }, { apiProvider: 'firstParty', tokenSource: 'none' },
    { apiProvider: 'firstParty' }, { apiProvider: 'firstParty', subscriptionType: 'API' },
    { apiProvider: 'bedrock', subscriptionType: 'Claude Pro' },
    { apiProvider: 'firstParty', subscriptionType: 'Claude Pro', tokenSource: 'console' },
    { apiProvider: 'firstParty', subscriptionType: 'Claude Pro', apiKeySource: 'apiKeyHelper' },
  ]) assert.throws(() => assertClaudeSubscription(account), /blocked/);
  let calls = 0;
  assert.throws(() => withoutPiAnthropic(() => calls++)({ provider: 'anthropic' }), /only in Claude Code/);
  assert.equal(calls, 0);
  const saved = process.env.CLAUDE_CODE_OAUTH_TOKEN; process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-subscription';
  const runtime = await createClaudeRuntime({ authImpl: () => 'login', resolveSettingsImpl: () => ({}), accountInfoImpl: async () => ({ apiProvider: 'firstParty', tokenSource: 'claude.ai', apiKeySource: 'apiKeyHelper' }), queryImpl: ({ prompt, options }) => {
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    return { async *[Symbol.asyncIterator]() {}, supportedModels: async () => [], close() {}, setModel() {}, async accountInfo() { return {}; } };
  } });
  try {
    await assert.rejects(runtime.command({ type: 'prompt', text: 'no API spending' }), /blocked/);
    assert.equal(runtime.snapshot().messages.length, 0);
  } finally { await runtime.close(); if (saved === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved; }
});

test('cancel after answering and callback before answering never forward a late code', async () => {
  const f = await hostedFixture();
  try {
    for (const callback of [false, true]) {
      const controller = new AbortController();
      let answer;
      const pending = f.signIn.login({ signal: controller.signal, notify() {}, prompt(request) {
        return new Promise((resolve, reject) => { answer = resolve; request.signal.addEventListener('abort', () => reject(new Error('ended')), { once: true }); });
      } });
      await wait(() => answer);
      if (callback) {
        await mkdir(join(f.root, '.imperfect/credentials/claude'), { recursive: true });
        await writeFile(f.credentials, JSON.stringify({ claudeAiOauth: fixtureOAuth }));
        f.children.at(-1).emit('close', 0);
        answer(code);
        await pending;
      } else {
        answer(code); controller.abort();
        await assert.rejects(pending, /did not complete/);
      }
      assert.equal(f.counters().exchanges, 0);
    }
  } finally { await f.close(); }
});

test('billing verification cannot authorize a restarted Claude child', async () => {
  let queries = 0, consumed = 0, end, approve;
  const runtime = await createClaudeRuntime({ authImpl: () => 'login', resolveSettingsImpl: () => ({}),
    accountInfoImpl: () => new Promise(resolve => { approve = resolve; }),
    queryImpl: ({ prompt }) => {
      queries++;
      (async () => { for await (const input of prompt) consumed++; })();
      return { async *[Symbol.asyncIterator]() { await new Promise(resolve => { end = resolve; }); },
        supportedModels: async () => [], close() { end?.(); } };
    },
  });
  try {
    const sending = runtime.command({ type: 'prompt', text: 'must not reach an unchecked child' });
    await wait(() => end && approve);
    end(); await new Promise(resolve => setImmediate(resolve));
    approve({ apiProvider: 'firstParty', tokenSource: 'claude.ai' });
    await assert.rejects(sending, /restarted or sign-in changed during billing verification/);
    assert.equal(queries, 1); assert.equal(consumed, 0);
  } finally { await runtime.close(); }
});

test('a separate sign-in console still fences Pi work, and outlives closing its tab', async () => {
  const events = new EventEmitter();
  let busy = false, drops = 0, closes = 0;
  const runtime = { events, snapshot: () => ({ busy, messages: [] }),
    command: async c => { if (c.type === 'abort') busy = false; }, drop: async () => { drops++; }, close: async () => { closes++; } };
  const auth = { events: new EventEmitter(), snapshot: () => ({ busy: false, auth: { busy: false } }),
    command: async () => {}, close: async () => { closes++; } };
  const runtimes = [runtime, auth];
  const host = await createTabHost({ authentication: true, checkUpdates: false, createRuntime: () => runtimes.shift() });
  try {
    busy = true;
    assert.equal(host.isIdle(), false);
    // Pi at work holds up a Pi provider's sign-in, not Claude Code's or Codex's.
    await assert.rejects(host.command({ type: 'auth_login', provider: 'openai-codex', method: 'oauth' }), /busy/);
    await host.command({ type: 'auth_login', provider: 'codex', method: 'oauth' });
    await host.command({ type: 'tab-close', tabId: host.snapshot().tabs[0].id, closeConfirmed: true });
    assert.equal(drops, 1); assert.equal(closes, 1); assert.equal(host.isIdle(), true);
    await host.command({ type: 'auth_providers' });
  } finally { await host.close(); }
  assert.equal(closes, 2);
});

test('an idle Claude child is renewed after browser sign-in, not kept on the previous account', async () => {
  const f = await hostedFixture();
  let queries = 0, consumed = 0;
  const runtime = await createClaudeRuntime({ authImpl: () => 'login', resolveSettingsImpl: () => ({}), queryImpl: ({ prompt }) => {
    queries++; let end;
    (async () => { for await (const input of prompt) consumed++; })();
    return { async *[Symbol.asyncIterator]() { await new Promise(resolve => { end = resolve; }); },
      supportedModels: async () => [], close() { end?.(); } };
  } });
  try {
    await runtime.command({ type: 'models' }); assert.equal(queries, 1);
    await f.signIn.login({ signal: new AbortController().signal, notify() {}, prompt: async () => code });
    await runtime.command({ type: 'models' });
    assert.equal(queries, 2, 'the next operation uses a new SDK child after sign-in');
    assert.equal(consumed, 0);
  } finally { await runtime.close(); await f.close(); }
});

test('installed Claude Code recognizes its secure-storage override without moving session config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-native-status-'));
  try {
    const storage = join(root, '.imperfect/credentials/claude');
    await mkdir(storage, { recursive: true });
    await writeFile(join(storage, '.credentials.json'), JSON.stringify({ claudeAiOauth: fixtureOAuth }), { mode: 0o600 });
    const env = claudeSubscriptionEnv({ HOME: root, PATH: process.env.PATH });
    const { stdout } = await promisify(execFile)(claudeExecutable(), ['--setting-sources', '', 'auth', 'status', '--json'], { env, timeout: 15000 });
    const status = JSON.parse(stdout); // local status only: dummy tokens, no exchange/model request
    assert.equal(status.loggedIn, true);
    assert.equal(status.authMethod, 'claude.ai');
    assert.equal(status.apiProvider, 'firstParty');
    assert.equal(env.CLAUDE_CONFIG_DIR, join(root, '.claude'));
    assert.equal(env.CLAUDE_SECURESTORAGE_CONFIG_DIR, storage);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a shared subscription token serves every account without a sign-in of its own; a sign-in comes first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-shared-token-'));
  const token = 'sk-ant-oat01-' + 'f'.repeat(40);
  const env = { HOME: root, PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-ambient-never' };
  try {
    assert.equal(claudeAuth(env), null);
    assert.equal(claudeSubscriptionEnv(env).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'an inherited variable is never the shared token');
    await mkdir(join(root, '.imperfect/credentials'), { recursive: true });
    for (const bad of ['', 'sk-ant-api03-' + 'k'.repeat(40), 'sk-ant-oat01-short', `${token}\nsecond line`]) {
      await writeFile(join(root, '.imperfect/credentials/claude-token'), bad);
      assert.equal(claudeAuth(env), null, 'only a Claude subscription token counts, never an API key');
      assert.equal(claudeSubscriptionEnv(env).CLAUDE_CODE_OAUTH_TOKEN, undefined);
    }
    await writeFile(join(root, '.imperfect/credentials/claude-token'), `${token}\n`, { mode: 0o600 });
    assert.equal(claudeAuth(env), 'token');
    assert.equal(createClaudeSignIn({ env }).configured(), 'token', 'the window shows Claude signed in');
    assert.equal(claudeSubscriptionEnv(env).CLAUDE_CODE_OAUTH_TOKEN, token);
    assert.equal(claudeSubscriptionEnv(env, { login: true }).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'signing in saves the person\'s own account');
    assertClaudeSubscription({ apiProvider: 'firstParty', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' }, { token: true });
    assert.throws(() => assertClaudeSubscription({ apiProvider: 'firstParty', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' }), /blocked/, 'only when imperfect gave it');
    assert.throws(() => assertClaudeSubscription({ apiProvider: 'firstParty', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiKeySource: 'ANTHROPIC_API_KEY' }, { token: true }), /blocked/);
    assert.throws(() => assertClaudeSubscription({ apiProvider: 'bedrock', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' }, { token: true }), /blocked/);
    // The installed Claude Code takes it as an OAuth token (local status only; no request).
    const { stdout } = await promisify(execFile)(claudeExecutable(), ['--setting-sources', '', 'auth', 'status', '--json'], { env: claudeSubscriptionEnv(env), timeout: 15000 });
    const status = JSON.parse(stdout);
    assert.equal(status.loggedIn, true); assert.equal(status.authMethod, 'oauth_token'); assert.equal(status.apiProvider, 'firstParty');
    // The account's own sign-in wins over the shared token.
    await mkdir(join(root, '.imperfect/credentials/claude'), { recursive: true });
    await writeFile(join(root, '.imperfect/credentials/claude/.credentials.json'), JSON.stringify({ claudeAiOauth: fixtureOAuth }), { mode: 0o600 });
    assert.equal(claudeAuth(env), 'login');
    assert.equal(claudeSubscriptionEnv(env).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('existing terminal credentials work until private storage is adopted; logout never falls back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-storage-'));
  const env = { HOME: root, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-ignored' };
  try {
    assert.equal(claudeAuth(env), null);
    await mkdir(join(root, '.claude'));
    await writeFile(join(root, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: fixtureOAuth }));
    assert.equal(claudeAuth(env), 'login');
    assert.equal(claudeSubscriptionEnv(env).CLAUDE_SECURESTORAGE_CONFIG_DIR, join(root, '.claude'));
    await mkdir(join(root, '.imperfect/credentials/claude'), { recursive: true });
    assert.equal(claudeAuth(env), null, 'an empty signed-out private profile must not use the old account');
    assert.equal(claudeSubscriptionEnv(env).CLAUDE_CONFIG_DIR, join(root, '.claude'), 'history stays in its normal location');
    assert.equal(claudeSubscriptionEnv(env).CLAUDE_SECURESTORAGE_CONFIG_DIR, join(root, '.imperfect/credentials/claude'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('hosted web app shows Claude Code billing, accepts its code privately, and selects the Claude harness', async () => {
  const f = await hostedFixture({ oldPiAuth: true });
  const web = await harnessFixture({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Fixture ready' }] }] });
  const push = () => web.push(f.host.snapshot());
  f.host.events.on('change', push);
  web.answer = async c => {
    if (c.type === 'level') return { current: 'high', available: ['high'] };
    const result = await f.host.command(c); push(); return result;
  };
  try {
    push();
    const page = web.page;
    await page.getByRole('dialog').waitFor();
    assert.match(await page.locator('.auth-subtitle').textContent(), /Claude Code \/ Claude subscription/);
    assert.match(await page.locator('.auth-subtitle').textContent(), /Old Pi Anthropic sign-ins are never used/);
    await page.getByRole('button', { name: 'Use a subscription / sign in', exact: true }).click();
    assert.equal(await page.locator('.auth-provider').filter({ hasText: 'Anthropic' }).count(), 0);
    await page.locator('.auth-provider').filter({ hasText: 'Claude Code' }).click();
    await page.locator('#auth-answer').waitFor();
    assert.equal(await page.locator('#auth-answer').getAttribute('type'), 'password');
    assert.match(await page.locator('.auth-event a').getAttribute('href'), /^https:\/\/claude.com\/cai\/oauth\/authorize/);
    await page.locator('#auth-answer').fill(code);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.waitForFunction(() => harness.guiSnapshot().tabs.find(t => t.focused)?.agent === 'claude');
    // The mark beside the model is the brand's, so the harness is named in words; billing is not.
    assert.match(await page.locator('#entry-pi-label .entry-harness-name').textContent(), /^Claude Code$/);
    assert.doesNotMatch(await page.locator('#entry-pi-label').textContent(), /subscription|API/i);
    assert.match(await page.locator('#entry-pi-label').getAttribute('title'), /^Claude Code · /);
    assert.equal(await page.locator('#entry-pi-label .brand-mark').getAttribute('data-brand'), 'imperfect');
    assert.equal(await page.locator('#entry-input').inputValue(), '');
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(code));
    assert.ok(!(await page.locator('#entry-output').textContent()).includes(code));
    assert.deepEqual(f.counters(), { exchanges: 1, piLogin: 0, piStreams: 0 });
    assert.deepEqual(web.errors, []);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('#entry-pi-label').click();
    await page.locator('#entry-dialog').waitFor({ state: 'visible' });
    const opus = page.locator('#entry-dialog .entry-dialog-option').filter({ hasText: 'Opus' });
    assert.match(await opus.getAttribute('title'), /Claude Code \/ Claude subscription/);
    assert.match(await opus.textContent(), /Subscription/);
    assert.ok(!(await page.locator('#entry-dialog').textContent()).includes('Forbidden Pi'));
  } finally { f.host.events.off('change', push); await web.close(); await f.close(); }
});

test('Claude sign-in never falls back to a Pi model when Claude model discovery fails', async () => {
  const f = await hostedFixture({ oldPiAuth: true });
  const web = await harnessFixture({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Fixture ready' }] }] });
  const push = () => web.push(f.host.snapshot());
  f.host.events.on('change', push);
  web.answer = async c => {
    if (c.type === 'models') return [{ provider: 'openai-codex', id: 'fixture-gpt', name: 'Fixture GPT', engine: 'pi', billing: 'ChatGPT subscription' }];
    const result = await f.host.command(c); push(); return result;
  };
  try {
    push(); const page = web.page;
    await page.getByRole('button', { name: 'Use a subscription / sign in', exact: true }).click();
    await page.locator('.auth-provider').filter({ hasText: 'Claude Code' }).click();
    await page.locator('#auth-answer').fill(code);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('.auth-feedback').filter({ hasText: 'no other harness was selected' }).waitFor();
    assert.equal(f.snap().status, 'success');
    assert.equal(f.host.snapshot().agent, 'pi');
    assert.equal(web.commands.filter(c => c.type === 'model').length, 0);
    assert.equal(f.counters().piStreams, 0);
    assert.deepEqual(web.errors, []);
  } finally { f.host.events.off('change', push); await web.close(); await f.close(); }
});
