import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createGueyServer } from '../../../../system/server.mjs';
import { HandsClient, HANDS_LIMITS } from '../../../../desktop/client/hands.mjs';
import { mcpSession } from '../mcp.mjs';
import { availableTools } from '../tools.mjs';
import { provideDeviceHands, runDeviceHands } from '../../../../system/device-hands.mjs';

const DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => { for (let i = 0; i < 300 && !await check(); i++) await sleep(10); assert.ok(await check(), 'condition reached'); };
const runtime = () => ({ events: new EventEmitter(), snapshot: () => ({ sessionId: 's', cwd: '/tmp', messages: [], tabs: [] }), command: async () => ({}), close: async () => {} });
async function setup(t, enabled = true, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-hands-'));
  // Test-only secret, generated in disposable test state; never live credentials.
  const token = 'test-only-hands-token-0123456789abcdef';
  const tokenFile = join(root, 'pairing-token');
  if (enabled) await writeFile(tokenFile, token, { mode: 0o600 });
  const app = await createGueyServer({ stateDir: join(root, 'state'), runtime: runtime(), sessionToken: 'test-only-session-token', ...(enabled ? { deviceHandsTokenFile: tokenFile } : {}), ...options });
  const { port } = await app.listen();
  const url = `http://127.0.0.1:${port}`;
  const events = [], statuses = [], clients = [];
  let captures = 0;
  const client = (options = {}) => {
    const hands = new HandsClient({ url, token, deviceId: 'test-device', name: 'Test device', captureScreen: async () => { captures++; return { mime: 'image/png', data: DOT }; }, onEvent: event => events.push(event), onStatus: status => statuses.push(status), ...options });
    clients.push(hands); return hands;
  };
  t.after(async () => { for (const hands of clients) hands.close(); await app.close(); await rm(root, { force: true, recursive: true }); });
  const permit = async (hands, name, enabled = true) => { hands.setPermission(name, enabled); await until(() => app.deviceHands.list()[0]?.permissions[name] === enabled); };
  return { app, url, root, token, client, events, statuses, permit, captures: () => captures };
}
function ask(config, method, params, id = 1) {
  return fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
}
const toolCall = async (config, args) => (await (await ask(config, 'tools/call', { name: 'device_hands', arguments: args })).json()).result;
const toolText = result => JSON.parse(result.content[0].text);
const request = (env, action, args = {}, options = {}) => env.app.deviceHands.request(env.deviceId ?? 'test-device', { action, ...args }, options);

// Real imperfect server, real ws client, real local child processes and filesystem.
test('both existing harness tool sets drive permission-gated real native hands end to end', async t => {
  const env = await setup(t), hands = env.client();
  assert.deepEqual(hands.permissions, { commands: false, screen: false, files: false });
  assert.throws(() => { hands.permissions.commands = true; }, TypeError);
  assert.throws(() => hands.setPermission('commands', true), /not_connected/);
  await hands.connect();
  assert.ok(availableTools().some(([tool]) => tool.name === 'device_hands'));
  const pi = mcpSession({ cwd: () => '/server/directory/that/must/not/be/used', session: () => 'pi-s', harness: 'pi', ui: null });
  const claude = mcpSession({ cwd: () => '/server/directory/that/must/not/be/used', session: () => 'claude-s', harness: 'claude', ui: null });
  t.after(() => { pi.close(); claude.close(); });
  for (const caller of [pi, claude]) {
    const list = (await (await ask(caller.config(), 'tools/list')).json()).result.tools;
    assert.ok(list.some(tool => tool.name === 'device_hands'));
    assert.equal(toolText(await toolCall(caller.config(), { action: 'list' })).devices[0].id, 'test-device');
    assert.equal((await toolCall(caller.config(), { action: 'command', device: 'test-device', command: 'echo not_allowed' })).isError, true);
  }
  const path = join(env.root, 'contents.txt');
  for (const [action, args] of [['command', { command: 'echo not_allowed' }], ['read', { path }], ['write', { path, data: 'not_allowed' }], ['screenshot', {}]]) {
    await assert.rejects(request(env, action, args), /permission_denied/);
  }
  assert.equal(env.captures(), 0); await assert.rejects(stat(path), /ENOENT/);
  await env.permit(hands, 'commands');
  const output = toolText(await toolCall(pi.config(), { action: 'command', device: 'test-device', command: 'printf safe_output; printf safe_error >&2' }));
  assert.deepEqual(output, { stdout: 'safe_output', stderr: 'safe_error', exitCode: 0, signal: null });
  const pwd = toolText(await toolCall(claude.config(), { action: 'command', device: 'test-device', command: process.platform === 'win32' ? 'cd' : 'pwd' }));
  assert.equal(pwd.stdout.trim(), homedir(), 'MCP injected SERVER cwd is not forwarded');
  const local = toolText(await toolCall(pi.config(), { action: 'command', device: 'test-device', command: 'pwd', directory: env.root }));
  assert.equal(local.stdout.trim(), env.root);
  await env.permit(hands, 'commands', false);
  await assert.rejects(request(env, 'command', { command: 'echo no' }), /permission_denied/);
  await env.permit(hands, 'files');
  const contents = 'private file contents\n𝒱';
  assert.deepEqual(toolText(await toolCall(claude.config(), { action: 'write', device: 'test-device', path, data: contents })), { bytes: Buffer.byteLength(contents) });
  assert.equal(await readFile(path, 'utf8'), contents);
  const read = toolText(await toolCall(pi.config(), { action: 'read', device: 'test-device', path }));
  assert.equal(read.data, contents);
  const binary = Buffer.from([0, 255, 128, 10]);
  await request(env, 'write', { path, encoding: 'base64', data: binary.toString('base64') });
  assert.equal((await request(env, 'read', { path, encoding: 'base64' })).data, binary.toString('base64'));
  await env.permit(hands, 'screen');
  assert.deepEqual((await toolCall(pi.config(), { action: 'screenshot', device: 'test-device' })).content, [{ type: 'image', mimeType: 'image/png', data: DOT }]);
  assert.equal(env.captures(), 1);
  hands.stop(); await until(() => !env.app.deviceHands.list()[0].permissions.files);
  assert.deepEqual(hands.permissions, { commands: false, screen: false, files: false });
  await assert.rejects(request(env, 'screenshot'), /permission_denied/);
  assert.equal(env.captures(), 1);
  for (const event of env.events) {
    assert.deepEqual(Object.keys(event).sort(), ['action', 'detail', 'id', 'status', 'time']);
    assert.doesNotMatch(JSON.stringify(event), /private file|safe_output|safe_error|not_allowed|contents\.txt|0123456789abcdef/);
  }
  assert.ok(env.events.some(event => event.action === 'screenshot' && event.status === 'requested'));
  assert.doesNotMatch(JSON.stringify(env.statuses), /0123456789abcdef/);
});

test('pairing disabled by default, authenticates bearer only, rejects duplicate IDs and has no public HTTP actions', async t => {
  const disabled = await setup(t, false);
  await assert.rejects(disabled.client().connect(), /connection_failed/);
  const env = await setup(t);
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: `Bearer ${env.token}`, Origin: env.url }, { Authorization: `Bearer ${env.token}`, Origin: '' }]) {
    const status = await new Promise(resolve => {
      const ws = new WebSocket(`${env.url.replace('http:', 'ws:')}/device-hands`, { headers });
      ws.on('error', () => {});
      ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); ws.terminate(); });
    });
    assert.equal(status, 401);
  }
  const hands = env.client(); await hands.connect();
  await assert.rejects(env.client().connect(), /disconnected/);
  assert.equal(env.app.deviceHands.list().length, 1);
  await env.permit(hands, 'commands');
  assert.equal((await request(env, 'command', { command: 'printf original' })).stdout, 'original');
  assert.equal((await fetch(`${env.url}/device-hands`, { method: 'POST', body: JSON.stringify({ action: 'command', command: 'touch /tmp/never' }) })).status, 404);
  assert.equal((await fetch(`${env.url}/device-hands/command`)).status, 404);
  for (const headers of [{}, { Authorization: `Bearer ${env.token}` }]) {
    assert.equal((await ask({ url: `${env.url}/mcp`, headers }, 'tools/call', { name: 'device_hands', arguments: { action: 'command', device: 'test-device', command: 'echo no' } })).status, 403);
  }
  const root = await mkdtemp(join(tmpdir(), 'imperfect-hands-bad-token-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bad = join(root, 'bad'); await writeFile(bad, 'too-short-secret');
  await assert.rejects(createGueyServer({ stateDir: root, runtime: runtime(), deviceHandsTokenFile: bad }), error => error.message === 'Invalid device hands token configuration');
});

test('input validation, file/output/time limits, real capture requirement and no permission grant by remote content', async t => {
  const env = await setup(t), hands = env.client({ captureScreen: undefined }); await hands.connect();
  for (const name of ['commands', 'files', 'screen']) await env.permit(hands, name);
  for (const value of [null, [], {}, { action: 'invalid' }, { action: 'command', command: '' }, { action: 'command', command: 'echo ok', timeoutMs: 120001 }, { action: 'read', path: 'relative' }, { action: 'write', path: '/tmp/x', data: '???', encoding: 'base64' }, { action: 'screenshot', permissions: { screen: true } }]) {
    await assert.rejects(env.app.deviceHands.request('test-device', value));
  }
  await assert.rejects(env.app.deviceHands.request(undefined, { action: 'screenshot' }), /explicit_device/);
  await assert.rejects(env.app.deviceHands.request('missing', { action: 'screenshot' }), /not_connected/);
  await assert.rejects(request(env, 'write', { path: join(env.root, 'big'), data: 'x'.repeat(HANDS_LIMITS.file + 1) }), /file_limit/);
  const boundary = join(env.root, 'boundary');
  const boundaryBytes = Buffer.alloc(HANDS_LIMITS.file, 255).toString('base64');
  assert.equal((await request(env, 'write', { path: boundary, data: boundaryBytes, encoding: 'base64' })).bytes, HANDS_LIMITS.file);
  assert.equal((await request(env, 'read', { path: boundary, encoding: 'base64' })).data, boundaryBytes);
  const big = join(env.root, 'big'); await writeFile(big, 'x'.repeat(HANDS_LIMITS.file + 1));
  await assert.rejects(request(env, 'read', { path: big }), /file_limit/);
  await assert.rejects(request(env, 'read', { path: env.root }), /regular_file_required/);
  const link = join(env.root, 'link'); await symlink(big, link);
  await assert.rejects(request(env, 'write', { path: link, data: 'no' }), /regular_file_required/);
  await assert.rejects(request(env, 'read', { path: link }));
  await assert.rejects(request(env, 'screenshot'), /capture_unavailable/);
  await assert.rejects(request(env, 'command', { command: 'sleep 2', timeoutMs: 50 }), /command_timeout/);
  await assert.rejects(request(env, 'command', { command: 'yes x' }), /output_limit/);
  assert.equal((await request(env, 'command', { command: 'exit 7' })).exitCode, 7);
  assert.equal((await request(env, 'command', { command: 'pwd', cwd: env.root })).stdout.trim(), env.root);
});

async function childJob(env) {
  const pidFile = join(env.root, `pid-${Math.random()}`);
  const command = `sleep 30 & echo $! > '${pidFile}'; wait`;
  const pending = request(env, 'command', { command });
  // Attach immediately to avoid unhandled rejections when tests revoke.
  const result = pending.then(value => ({ value }), error => ({ error }));
  await until(async () => (await stat(pidFile).catch(() => null))?.size > 0);
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'recorded a real native child PID');
  return { pid, result };
}
async function dead(pid) {
  try {
    process.kill(pid, 0);
    // Linux unreaped zombies are dead too (their parent was group-killed).
    return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z';
  } catch { return true; }
}

test('Stop, permission off, tool abort and disconnect cancel real shell child trees; closed client never executes', async t => {
  const env = await setup(t), hands = env.client(); await hands.connect();
  for (const mode of ['permission', 'stop', 'abort', 'disconnect']) {
    await env.permit(hands, 'commands');
    if (mode === 'abort') {
      const stop = new AbortController();
      const pending = request(env, 'command', { command: 'sleep 30' }, { signal: stop.signal }).catch(error => error);
      await until(() => env.events.some(event => event.status === 'running'));
      stop.abort(); assert.match((await pending).message, /cancelled/); continue;
    }
    const { pid, result } = await childJob(env);
    if (mode === 'permission') hands.setPermission('commands', false);
    if (mode === 'stop') hands.stop();
    if (mode === 'disconnect') env.app.deviceHands.sockets.clients.forEach(ws => ws.terminate());
    assert.match((await result).error.message, /revoked|cancelled|disconnected/);
    await until(() => dead(pid));
    if (mode === 'disconnect') {
      await until(() => !hands.permissions.commands);
      assert.throws(() => hands.setPermission('commands', true), /not_connected/);
      await assert.rejects(hands.connect(), /closed/);
    }
  }
});

test('all actions visible before effect, and Stop cancels queued file/command/screen work', async t => {
  const env = await setup(t);
  let hands, stopNext = false, stopPhase = 'requested', captured = 0;
  hands = env.client({ onEvent: event => { env.events.push(event); if (stopNext && event.status === stopPhase) hands.stop(); }, captureScreen: async () => { captured++; return { mime: 'image/png', data: DOT }; } });
  await hands.connect();
  for (const phase of ['requested', 'running']) {
    stopPhase = phase;
    for (const [action, args, permission] of [['command', { command: `touch '${join(env.root, 'command-effect')}'` }, 'commands'], ['write', { path: join(env.root, 'file-effect'), data: 'private' }, 'files'], ['read', { path: join(env.root, 'file-effect') }, 'files'], ['screenshot', {}, 'screen']]) {
      stopNext = false; await env.permit(hands, permission); stopNext = true;
      await assert.rejects(request(env, action, args), /permission_denied|revoked|cancelled/);
    }
  }
  assert.equal(captured, 0);
  await assert.rejects(stat(join(env.root, 'command-effect')), /ENOENT/);
  await assert.rejects(stat(join(env.root, 'file-effect')), /ENOENT/);
});

test('malformed, binary and oversized device frames are rejected and cannot replace a paired device', async t => {
  const env = await setup(t);
  const connect = async () => {
    const ws = new WebSocket(`${env.url.replace('http:', 'ws:')}/device-hands`, { headers: { Authorization: `Bearer ${env.token}` } });
    ws.on('error', () => {}); await once(ws, 'open'); return ws;
  };
  for (const [body, options] of [['{', {}], [JSON.stringify({ type: 'register', deviceId: 'x', name: 'X', permissions: { commands: true, screen: false, files: false } }), {}], [Buffer.from('{}'), { binary: true }], ['x'.repeat(HANDS_LIMITS.wire + 1), {}]]) {
    const ws = await connect(); const closed = once(ws, 'close'); ws.send(body, options);
    const [code] = await closed; assert.ok([1008, 1009].includes(code), `close code ${code}`);
  }
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'register', deviceId: 'x', name: 'X', permissions: { commands: false, screen: false, files: false } }));
  await once(ws, 'message');
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'response', id: 'not-an-integer-success', success: 'true' }));
  assert.equal((await closed)[0], 1008);
});

test('in-flight capture cancellation is immediate, does not leak late results, and releases concurrent slots', async t => {
  const env = await setup(t);
  let resolveCaptures = [], fast = false;
  const hands = env.client({ captureScreen: () => fast ? Promise.resolve({ mime: 'image/png', data: DOT }) : new Promise(resolve => resolveCaptures.push(resolve)) });
  await hands.connect(); await env.permit(hands, 'screen');
  const results = Array.from({ length: HANDS_LIMITS.concurrent }, () => request(env, 'screenshot').catch(error => error));
  await until(() => resolveCaptures.length === HANDS_LIMITS.concurrent);
  await assert.rejects(request(env, 'screenshot'), /device_busy/);
  hands.stop();
  for (const result of await Promise.all(results)) assert.match(result.message, /revoked|cancelled/);
  await until(() => env.events.filter(event => event.status === 'cancelled').length === HANDS_LIMITS.concurrent);
  fast = true; await env.permit(hands, 'screen');
  assert.equal((await request(env, 'screenshot')).data, DOT);
  for (const resolve of resolveCaptures) resolve({ mime: 'image/png', data: DOT });
  await sleep(50);
  assert.equal(env.events.filter(event => event.action === 'screenshot' && event.status === 'done').length, 1, 'no late capture published');
  hands.close(); assert.deepEqual(hands.permissions, { commands: false, screen: false, files: false });
});

test('invalid native PNG capture is never silently replaced with a fake screenshot', async t => {
  const env = await setup(t);
  let image = { mime: 'image/jpeg', data: DOT };
  const hands = env.client({ captureScreen: async () => image }); await hands.connect(); await env.permit(hands, 'screen');
  await assert.rejects(request(env, 'screenshot'), /invalid_capture/);
  image = { mime: 'image/png', data: Buffer.alloc(HANDS_LIMITS.screen + 1).toString('base64') };
  await assert.rejects(request(env, 'screenshot'), /invalid_capture/);
  image = { mime: 'image/png', data: Buffer.from('not a PNG').toString('base64') };
  await assert.rejects(request(env, 'screenshot'), /invalid_capture/);
  assert.equal(env.events.filter(event => event.action === 'screenshot' && event.status === 'done').length, 0);
});

test('existing MCP cancellation reaches device command trees, not only an internal test signal', async t => {
  const env = await setup(t), hands = env.client(); await hands.connect(); await env.permit(hands, 'commands');
  const caller = mcpSession({ cwd: () => '/server-only', session: () => 'cancel-session', harness: 'claude', ui: null });
  t.after(() => caller.close());
  const pidFile = join(env.root, 'mcp-pid');
  const pending = ask(caller.config(), 'tools/call', { name: 'device_hands', arguments: { action: 'command', device: 'test-device', command: `sleep 30 & echo $! > '${pidFile}'; wait` } }, 600);
  await until(async () => (await stat(pidFile).catch(() => null))?.size > 0);
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  const cancelled = await fetch(caller.config().url, { method: 'POST', headers: caller.config().headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 600 } }) });
  assert.equal(cancelled.status, 202);
  const result = (await (await pending).json()).result;
  assert.equal(result.isError, true); assert.equal(result.content[0].text, 'cancelled');
  await until(() => dead(pid));
});

test('compromised authenticated server cannot remotely turn on local permissions and malformed/oversized requests never execute', async t => {
  const env = await setup(t), hands = env.client(); await hands.connect();
  const ws = [...env.app.deviceHands.sockets.clients][0];
  // Bypass server request validator to exercise the native boundary itself.
  const nextResponse = () => once(ws, 'message').then(([raw]) => JSON.parse(raw.toString()));
  let response = nextResponse();
  ws.send(JSON.stringify({ type: 'request', id: env.token, request: { action: 'command', command: 'echo no', permission: true } }));
  assert.equal((await response).success, false);
  assert.doesNotMatch(JSON.stringify(env.events), /test-only-hands-token/);
  response = nextResponse();
  ws.send(JSON.stringify({ type: 'request', id: 'bad-2', request: { action: 'write', path: join(env.root, 'no'), data: 'x'.repeat(HANDS_LIMITS.file + 1) } }));
  assert.equal((await response).error, 'file_limit');
  assert.deepEqual(hands.permissions, { commands: false, screen: false, files: false });
  // Property-key coercion must not turn malformed ['write'] into a file action.
  await env.permit(hands, 'files');
  const malformedPath = join(env.root, 'array-action');
  await assert.rejects(env.app.deviceHands.request('test-device', { action: ['write'], path: malformedPath, data: 'bad' }), /invalid_action/);
  response = nextResponse();
  ws.send(JSON.stringify({ type: 'request', id: 'array-action', request: { action: ['write'], path: malformedPath, data: 'bad' } }));
  assert.equal((await response).error, 'invalid_action');
  await assert.rejects(stat(malformedPath), /ENOENT/);
  assert.ok(env.events.every(event => typeof event.action === 'string'));
  ws.send(JSON.stringify({ type: 'permissions', permissions: { commands: true, screen: true, files: true } }));
  await until(() => env.app.deviceHands.list().length === 0);
  assert.deepEqual(hands.permissions, { commands: false, screen: false, files: false });
  const other = env.client({ deviceId: 'oversized' }); await other.connect();
  const target = [...env.app.deviceHands.sockets.clients][0];
  target.send('x'.repeat(HANDS_LIMITS.wire + 1));
  await until(() => env.app.deviceHands.list().length === 0);
  assert.deepEqual(other.permissions, { commands: false, screen: false, files: false });
  await assert.rejects(stat(join(env.root, 'no')), /ENOENT/);
});

// A device can answer with a mebibyte; the model is handed its start and end,
// and a failure says what to do next.
test('the model is handed long device output cut to its start and end, and failures with a next step', async () => {
  const long = `${'a'.repeat(30_000)}${'z'.repeat(30_000)}`;
  provideDeviceHands({ list: () => [{ id: 'd' }], request: async (device, { action }) => {
    if (action === 'command') return { stdout: long, stderr: '', exitCode: 0, signal: null };
    if (action === 'read') return { bytes: 60_000, encoding: 'base64', data: long };
    throw new Error('permission_denied');
  } });
  try {
    const output = JSON.parse(await runDeviceHands({ action: 'command', device: 'd', command: 'yes' }));
    assert.ok(output.stdout.length < 21_000);
    assert.match(output.stdout, /^a+\n… \(40000 characters cut; send long output to a file/);
    assert.match(output.stdout, /z$/);
    assert.equal(JSON.parse(await runDeviceHands({ action: 'read', device: 'd', path: '~/x', encoding: 'base64' })).data, null);
    await assert.rejects(runDeviceHands({ action: 'write', device: 'd', path: '~/x', data: 'x' }), /^Error: permission_denied: the person has not turned that permission on/);
  } finally { provideDeviceHands(null); }
});
