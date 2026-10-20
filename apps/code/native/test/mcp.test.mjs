import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { mcpSession, runs, serveMcp, serveMcpOn } from '../mcp.mjs';
import { TOOLS } from '../tools.mjs';
import { createRuntime } from '../runtime.mjs';
import { invokeTool } from './durable-fixture.mjs';

// A 1x1 PNG.
const DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const until = async (check, what) => {
  const end = Date.now() + 30000;
  while (!check()) { assert.ok(Date.now() < end, what); await new Promise(resolve => setTimeout(resolve, 10)); }
};
// Per-test hooks run in registration order: removing the folder in the first
// hook raced the runtime's later watcher disposal. Remove roots only after all
// per-test runtimes, MCP sessions and servers have closed, not after a sleep.
const folders = [];
after(async () => { for (const dir of folders) await rm(dir, { recursive: true, force: true }); });

async function folder(t, cleanup = true) {
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-mcp-'));
  await writeFile(join(dir, 'dot.png'), Buffer.from(DOT, 'base64'));
  folders.push(dir);
  return dir;
}
// imperfect's server, as far as /mcp goes.
async function serve(t) {
  const server = createServer(async (req, res) => { if (!await serveMcp(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  serveMcpOn(server.address().port);
  return server.address().port;
}
async function piRuntime(t, cwd) {
  const models = await ModelRuntime.create({ authPath: join(cwd, 'auth.json'), modelsPath: null, modelsStorePath: join(cwd, 'models.json') });
  const runtime = await createRuntime({ cwd, agentDir: join(cwd, 'agent'), sessionDir: join(cwd, 'sessions'), serviceOptions: {
    modelRuntime: models,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true },
  } });
  t.after(async () => { await runtime.close(); await rm(cwd, { recursive: true, force: true }); });
  return runtime;
}
let id = 0;
const call = (config, method, params, init = {}) => fetch(config.url, {
  method: 'POST', ...init,
  headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: ++id }), method, params }),
});
const answer = async (...args) => (await (await call(...args)).json());

// First in this file: a Pi tab made before imperfect serves, as tabs restored
// at start are, is handed its tools once it does.
test('Pi connects to imperfect\'s tools and declares them as its own, with no codemode between', async t => {
  const cwd = await folder(t, false); // Close Pi's timers before removing its directory.
  // A tool that waits to be stopped, to see Esc reach it.
  let stopped = false, started = false;
  const wait = [{ name: 'wait', description: 'Waits until stopped.', parameters: { type: 'object', properties: {} } }, ({ signal }) => new Promise((_, reject) => {
    started = true;
    signal.addEventListener('abort', () => { stopped = true; reject(new Error('stopped')); });
  })];
  TOOLS.push(wait); runs.set('wait', wait[1]);
  t.after(() => { TOOLS.splice(TOOLS.indexOf(wait), 1); runs.delete('wait'); });
  const runtime = await piRuntime(t, cwd);
  const names = () => runtime.session().registry.snapshot().tools().map(row => row.tool.name);
  assert.equal(names().some(name => name.startsWith('mcp__imperfect__')), false);
  await serve(t);
  await until(() => names().includes('mcp__imperfect__show'), 'the tools arrive once imperfect serves');
  for (const [tool] of TOOLS) assert.ok(names().includes(`mcp__imperfect__${tool.name}`), tool.name);
  assert.equal(names().some(name => /codemode|tool_search/.test(name)), false);
  // A picture shown comes back to the model, and into the transcript, as a picture.
  const result = await invokeTool(runtime, 'mcp__imperfect__show', { path: 'dot.png' });
  assert.match(result.output[0].text, /dot\.png/, 'relative to the session\'s own folder');
  assert.deepEqual(result.output.find(block => block.type === 'image'), { type: 'image', data: DOT, mimeType: 'image/png' });
  // A stopped turn cancels the call it was waiting on.
  const stop = new AbortController();
  const waiting = invokeTool(runtime, 'mcp__imperfect__wait', {}, stop.signal);
  await until(() => started, 'the tool is executing before Esc stops it');
  stop.abort();
  assert.equal((await waiting).isError, true);
  await until(() => stopped, 'the tool was stopped');
  // The overview a new conversation opens on names them as they are.
  assert.ok(runtime.snapshot().startup.sections.find(s => s.name === 'Tools').compact.split(', ').includes('show'));
});

test('each session has its own token; none, another\'s or one from elsewhere is refused', async t => {
  const cwd = await folder(t), port = await serve(t);
  const mine = mcpSession({ cwd: () => cwd, session: () => 'session-a', harness: 'claude', ui: null });
  t.after(() => mine.close());
  const config = mine.config();
  assert.equal(config.url, `http://127.0.0.1:${port}/mcp`);
  assert.equal((await call({ url: config.url, headers: {} }, 'ping')).status, 403);
  assert.equal((await call({ url: config.url, headers: { Authorization: 'Bearer nope' } }, 'ping')).status, 403);
  const elsewhere = await new Promise(resolve => {
    const ask = request(config.url, { method: 'POST', headers: { ...config.headers, host: 'desk.tailnet.ts.net', 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    ask.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
  });
  assert.equal(elsewhere, 403);
  const hello = await answer(config, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(hello.result.serverInfo.name, 'imperfect');
  assert.deepEqual(hello.result.capabilities, { tools: { listChanged: true } });
  assert.equal((await call(config, 'notifications/initialized')).status, 202);
  const { result: { tools } } = await answer(config, 'tools/list');
  assert.deepEqual(tools.map(tool => tool.name), TOOLS.map(([tool]) => tool.name));
  assert.deepEqual(tools[0].inputSchema, TOOLS[0][0].parameters);
  mine.close();
  assert.equal((await call(config, 'ping')).status, 403, 'a closed session\'s token is refused');
});

test('a tool learns its session from the token, never from the model', async t => {
  const cwd = await folder(t);
  await serve(t);
  runs.set('whoami', async ({ cwd, session, harness, ui }) => JSON.stringify({ cwd, session, harness, ui: Boolean(ui) }));
  runs.set('fails', async () => { throw new Error('it broke'); });
  t.after(() => { runs.delete('whoami'); runs.delete('fails'); });
  const mine = mcpSession({ cwd: () => cwd, session: () => 'session-a', harness: 'pi', ui: { select() {} } });
  t.after(() => mine.close());
  const said = await answer(mine.config(), 'tools/call', { name: 'whoami', arguments: { session: 'forged', harness: 'forged' } });
  assert.deepEqual(JSON.parse(said.result.content[0].text), { cwd, session: 'session-a', harness: 'pi', ui: true });
  assert.deepEqual((await answer(mine.config(), 'tools/call', { name: 'fails' })).result, { content: [{ type: 'text', text: 'it broke' }], isError: true });
  assert.equal((await answer(mine.config(), 'tools/call', { name: 'nothing' })).error.code, -32602);
  assert.equal((await answer(mine.config(), 'resources/list')).error.code, -32601);
});

test('a stopped turn cancels its tool call', async t => {
  const cwd = await folder(t);
  await serve(t);
  let stopped = 0, started = 0;
  runs.set('wait', ({ signal }) => new Promise((_, reject) => {
    started++;
    signal.addEventListener('abort', () => { stopped++; reject(new Error('stopped')); });
  }));
  t.after(() => runs.delete('wait'));
  const mine = mcpSession({ cwd: () => cwd, session: () => 's', harness: 'claude', ui: null });
  t.after(() => mine.close());
  // As MCP says it: notifications/cancelled, naming the request.
  const pending = answer(mine.config(), 'tools/call', { name: 'wait' });
  const waiting = id;
  await until(() => started === 1, 'the first tool call is executing');
  assert.equal((await call(mine.config(), 'notifications/cancelled', { requestId: waiting })).status, 202);
  assert.deepEqual((await pending).result, { content: [{ type: 'text', text: 'stopped' }], isError: true });
  // Or by hanging up.
  const hangUp = new AbortController();
  const gone = call(mine.config(), 'tools/call', { name: 'wait' }, { signal: hangUp.signal }).catch(() => 'hung up');
  await until(() => started === 2, 'the second tool call is executing');
  hangUp.abort();
  assert.equal(await gone, 'hung up');
  await until(() => stopped === 2, 'the hung-up call was stopped');
});
