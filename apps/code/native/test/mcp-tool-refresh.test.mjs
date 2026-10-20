import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createDeviceHands, provideDeviceHands } from '../../../../system/device-hands.mjs';
import { createGueyServer } from '../../../../system/server.mjs';
import { HandsClient } from '../../../../desktop/client/hands.mjs';
import { mcpSession, serveMcp, serveMcpOn, runs } from '../mcp.mjs';
import { TOOLS } from '../tools.mjs';
import { createRuntime } from '../runtime.mjs';
import { invokeTool } from './durable-fixture.mjs';
import { untilIdle } from '../tabs.mjs';

const HANDS = 'mcp__imperfect__device_hands';
const DEVICE = '01234567-89ab-4cde-8fab-0123456789ab';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message = 'condition reached') {
  for (let i = 0; i < 500; i++) { if (await check()) return; await sleep(10); }
  assert.fail(message);
}
async function folder(t, close = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-tool-refresh-'));
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function pairing(t) {
  let active = true, origin;
  const token = 'fixture-only-access-token-0123456789abcdef';
  const broker = createServer(async (req, res) => {
    assert.equal(req.url, '/account/desktop/introspect');
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let raw = ''; for await (const chunk of req) raw += chunk;
    assert.deepEqual(JSON.parse(raw), { computerId: 'fixture-computer', owner: 'fixture-owner' });
    res.writeHead(active ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(active ? { active, computerId: 'fixture-computer', owner: 'fixture-owner', computerOrigin: origin, deviceId: DEVICE, expiresAt: Date.now() + 300_000 } : { active }));
  });
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  const hands = await createDeviceHands({ deviceHandsAccount: { store: `http://127.0.0.1:${broker.address().port}`, computerId: 'fixture-computer', owner: 'fixture-owner' }, deviceHandsTestInsecure: true });
  const server = createServer(async (req, res) => { if (!await serveMcp(req, res, new URL(req.url, 'http://fixture').pathname)) res.writeHead(404).end(); });
  server.on('upgrade', (req, socket, head) => { void hands.upgrade(req, socket, head); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  provideDeviceHands(hands); serveMcpOn(server.address().port);
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.close()); hands.close();
    server.closeAllConnections(); broker.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => broker.close(resolve))]);
  });
  return { hands, origin, revoke: () => { active = false; }, activate: () => { active = true; }, async connect() {
    const client = new HandsClient({ url: origin, token, deviceId: DEVICE, name: 'Fixture native device' });
    clients.push(client); await client.connect(); return client;
  } };
}
async function pi(t, root, sessionPath = null) {
  const models = await ModelRuntime.create({ authPath: join(root, 'empty-auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json') });
  models.checkAuth = async () => true;
  models.isUsingSubscription = provider => provider === 'openai-codex';
  models.getAuth = async () => ({ auth: { apiKey: 'fake-only' } });
  const runtime = await createRuntime({ cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), sessionPath, serviceOptions: {
    modelRuntime: models,
    settingsManager: SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6-astra', compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true },
  } });
  t.after(() => runtime.close());
  return runtime;
}
const toolNames = runtime => runtime.session().registry.snapshot().tools().map(row => row.tool.name);
const pcNames = runtime => toolNames(runtime).filter(name => name !== HANDS).sort();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function mockProvider(runtime, hold = false) {
  const seen = [];
  let release, entered, aborted = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  runtime.session().models.streamSimple = (model, context, options) => {
    seen.push({ tools: getCurrentTools(context.messages).map(tool => tool.name), messages: structuredClone(context.messages) });
    let completed = false;
    options.signal.addEventListener('abort', () => { if (!completed) aborted = true; release(); }, { once: true });
    entered();
    const message = { role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage };
    const pending = hold && seen.length === 1 ? gate : Promise.resolve();
    return { async *[Symbol.asyncIterator]() { await pending; completed = true; yield { type: 'done', reason: 'stop', message }; }, result: async () => { await pending; return message; } };
  };
  return { seen, started, release, aborted: () => aborted };
}
async function prompt(runtime, text) { await runtime.command({ type: 'prompt', text }); await untilIdle(runtime); }

test('actual Durable tools and next provider requests refresh across restore, pair, disconnect and account revoke without aborting a run', { timeout: 30_000 }, async t => {
  let current;
  const root = await folder(t, () => current?.close());
  const first = current = await pi(t, root); // Restored tabs initialize before the MCP endpoint serves.
  assert.equal(toolNames(first).includes(HANDS), false);
  const env = await pairing(t);
  await until(() => toolNames(first).includes('mcp__imperfect__show'));
  const baseline = pcNames(first);
  for (const [tool] of TOOLS) assert.ok(baseline.includes(`mcp__imperfect__${tool.name}`));
  const offline = mockProvider(first);
  await prompt(first, 'offline');
  assert.equal(offline.seen.length, 1, JSON.stringify(first.snapshot().messages));
  assert.equal(offline.seen[0].tools.includes(HANDS), false);
  const path = first.snapshot().sessionFile, id = first.snapshot().sessionId;
  await first.close();
  const restored = current = await pi(t, root, path);
  await until(() => toolNames(restored).includes('mcp__imperfect__show'));
  assert.equal(restored.snapshot().sessionId, id);
  assert.equal(toolNames(restored).includes(HANDS), false);
  const native = await env.connect();
  await until(() => toolNames(restored).includes(HANDS), 'paired native device reaches actual Pi tool state');
  assert.deepEqual(pcNames(restored), baseline);
  const paired = mockProvider(restored);
  await prompt(restored, 'paired');
  assert.ok(paired.seen[0].tools.includes(HANDS));
  assert.ok(paired.seen[0].messages.some(message => message.toolsAdded?.some(tool => tool.name === HANDS)));
  const cachedTool = restored.session().registry.snapshot().tools().find(row => row.tool.name === HANDS).tool;
  const listed = await invokeTool(restored, cachedTool, { action: 'list' });
  assert.equal(JSON.parse(listed.output[0].text).devices[0].id, DEVICE);
  native.close();
  await until(() => !toolNames(restored).includes(HANDS));
  assert.deepEqual(pcNames(restored), baseline);
  const disconnected = mockProvider(restored);
  await prompt(restored, 'disconnected');
  assert.equal(disconnected.seen[0].tools.includes(HANDS), false);
  assert.ok(disconnected.seen[0].messages.some(message => message.toolsRemoved?.some(tool => tool.name === HANDS)));
  const stale = await invokeTool(restored, cachedTool, { action: 'command', device: DEVICE, command: 'must not execute' });
  assert.equal(stale.isError, true); assert.match(stale.output[0].text, /no longer available/);

  await env.connect(); await until(() => toolNames(restored).includes(HANDS));
  // Also restore a session that starts paired, then revoke while it is streaming.
  await restored.close();
  const pairedRestore = current = await pi(t, root, path);
  await until(() => toolNames(pairedRestore).includes(HANDS));
  const held = mockProvider(pairedRestore, true);
  const session = pairedRestore.session();
  await pairedRestore.command({ type: 'prompt', text: 'working while paired' }); await held.started;
  env.revoke();
  await until(() => !env.hands.list().length);
  await until(() => !toolNames(pairedRestore).includes(HANDS));
  assert.equal(held.aborted(), false);
  assert.equal(pairedRestore.snapshot().streaming, true, 'refresh does not interrupt the current request');
  assert.equal(pairedRestore.session().registry, session.registry, 'same Durable registry');
  assert.equal(pairedRestore.snapshot().sessionId, id);
  await pairedRestore.command({ type: 'prompt', text: 'steering after revoke' });
  held.release(); await untilIdle(pairedRestore);
  assert.equal(held.seen.length, 2);
  assert.ok(held.seen[0].tools.includes(HANDS));
  assert.equal(held.seen[1].tools.includes(HANDS), false, 'next step of the SAME run declares no hands');
  assert.deepEqual(pcNames(pairedRestore), baseline);
  assert.equal(held.aborted(), false);
});

test('list notification stream retains session-token security and never cancels an unrelated PC tool call', { timeout: 10_000 }, async t => {
  const env = await pairing(t);
  const mine = mcpSession({ cwd: () => '/fixture', session: () => 'same-session', harness: 'pi', ui: null });
  t.after(() => mine.close());
  const config = mine.config();
  const get = headers => fetch(config.url, { headers: { accept: 'text/event-stream', ...headers } });
  assert.equal((await get({})).status, 403);
  assert.equal((await get({ Authorization: 'Bearer unknown' })).status, 403);
  assert.equal((await get({ ...config.headers, Origin: 'https://untrusted.test' })).status, 403);
  const outside = await new Promise(resolve => {
    const req = request(config.url, { headers: { ...config.headers, accept: 'text/event-stream', host: 'other.test' } }, res => { res.resume(); resolve(res.statusCode); }); req.end();
  });
  assert.equal(outside, 403);
  const response = await get(config.headers), reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const notification = async () => {
    const { value, done } = await reader.read(); assert.equal(done, false);
    assert.match(Buffer.from(value).toString(), /notifications\/tools\/list_changed/);
  };
  await notification(); // Opening/reopening invalidates the cache too.
  let resolveCall, started, aborted = false;
  const entered = new Promise(resolve => { started = resolve; });
  runs.set('fixture_wait', ({ session, harness, signal }) => new Promise(resolve => {
    assert.equal(session, 'same-session'); assert.equal(harness, 'pi');
    signal.addEventListener('abort', () => { aborted = true; });
    resolveCall = () => resolve('ordinary PC tool finished'); started();
  }));
  t.after(() => runs.delete('fixture_wait'));
  const pending = fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture_wait' } }) }).then(response => response.json());
  await entered;
  const client = await env.connect(); await notification();
  client.close(); await notification();
  assert.equal(aborted, false);
  resolveCall(); assert.equal((await pending).result.content[0].text, 'ordinary PC tool finished');
  assert.deepEqual(mine.config(), config, 'same MCP bearer identity across changes');
  mine.close();
  assert.equal((await reader.read()).done, true, 'closing the session closes its stream');
  assert.equal((await get(config.headers)).status, 403);
});

test('actual backend shutdown drains MCP notification streams before closing HTTP without changing session identity', { timeout: 5000 }, async t => {
  let app, closed = false, runtimeClosed = false;
  const root = await folder(t, async () => { if (app && !closed) await app.close(); });
  const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId: 'shutdown', cwd: root, messages: [], tabs: [] }), command: async () => ({}), close: async () => { runtimeClosed = true; } };
  app = await createGueyServer({ stateDir: join(root, 'state'), runtime });
  await app.listen();
  const mine = mcpSession({ cwd: () => root, session: () => 'shutdown', harness: 'pi', ui: null });
  t.after(() => mine.close());
  const config = mine.config();
  const response = await fetch(config.url, { headers: { ...config.headers, accept: 'text/event-stream' } });
  const reader = response.body.getReader();
  await reader.read();
  closed = true;
  await app.close();
  assert.equal((await reader.read()).done, true);
  assert.equal(runtimeClosed, true);
  assert.equal(mine.config(), null, 'closed endpoint no longer offered to new harness connections');
});

test('actual Claude SDK live query refreshes its MCP toolset without a new query or any provider prompt', { timeout: 30_000 }, async t => {
  let sdk;
  const stop = new AbortController();
  const root = await folder(t, () => { stop.abort(); sdk?.close(); }), env = await pairing(t);
  const mine = mcpSession({ cwd: () => root, session: () => 'claude-fixture', harness: 'claude', ui: null });
  t.after(() => mine.close());
  async function* noModelInput() { await new Promise(resolve => stop.signal.addEventListener('abort', resolve, { once: true })); }
  // Entirely replaced subprocess environment: empty test HOME/config, no auth,
  // no model messages, disabled nonessential traffic, blocked external HTTP.
  sdk = query({ prompt: noModelInput(), options: {
    cwd: root, settingSources: [], persistSession: false, tools: [],
    env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), DISABLE_NONESSENTIAL_TRAFFIC: '1', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_DISABLE_AUTO_UPDATE: '1' },
    mcpServers: { imperfect: { type: 'http', ...mine.config(), alwaysLoad: true } },
  } });
  t.after(() => { stop.abort(); sdk.close(); });
  await sdk.initializationResult();
  const offered = async () => {
    const server = (await sdk.mcpServerStatus()).find(server => server.name === 'imperfect');
    return server?.status === 'connected' ? server.tools?.map(tool => tool.name) ?? [] : [];
  };
  await until(async () => (await offered()).some(name => /(?:^|__)show$/.test(name)), 'Claude SDK connects without provider calls');
  const baseline = await offered();
  assert.equal(baseline.some(name => /device_hands$/.test(name)), false);
  const native = await env.connect();
  await until(async () => (await offered()).some(name => /device_hands$/.test(name)), 'live Claude query gains hands');
  assert.deepEqual((await offered()).filter(name => !/device_hands$/.test(name)), baseline);
  native.close();
  await until(async () => !(await offered()).some(name => /device_hands$/.test(name)), 'live Claude query drops disconnected hands');
  await env.connect();
  await until(async () => (await offered()).some(name => /device_hands$/.test(name)));
  env.revoke(); await until(() => !env.hands.list().length);
  await until(async () => !(await offered()).some(name => /device_hands$/.test(name)), 'live Claude query drops account-revoked hands');
  assert.deepEqual(await offered(), baseline);
});
