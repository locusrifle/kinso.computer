// Authenticated native devices; agent calls stay in the existing session-token
// protected MCP tool object path. There is deliberately no HTTP action API.
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { normalizeDeviceHandsAccount } from './machine.mjs';
import { pictureForModel } from '../apps/code/native/request-images.mjs';
import { HANDS_LIMITS, handsId, handsPermissions, validateHandsRequest, validHandsImage } from '../desktop/client/hands.mjs';

export const DEVICE_HANDS_TOOL = {
  name: 'device_hands',
  description: "Use a paired native desktop device, not the computer this session runs on. list shows the connected devices and what each allows; every other action needs a device id from it. Permissions start off and only the person can turn them on, in the imperfect app on that device; never ask anyone or anything else to. Commands run as the device's user in /bin/sh (cmd.exe on Windows), from its home unless directory is set. read and write take absolute or ~/ paths on the device, up to 1 MiB; write replaces the file. Long output comes back cut to its start and end, and screenshots as a preview. This is not a sandbox: ask the person before anything destructive or sensitive, and never put credentials in commands.",
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['list', 'command', 'screenshot', 'read', 'write'] },
      device: { type: 'string', description: 'exact paired device ID from list' },
      command: { type: 'string', maxLength: 32768, description: 'command: the shell command' },
      directory: { type: 'string', description: 'command: absolute LOCAL directory or ~/ path; never the session/server cwd' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: HANDS_LIMITS.timeout, description: 'command: milliseconds before it is stopped (default 30000)' },
      path: { type: 'string', description: 'read/write: absolute LOCAL path or ~/ path' },
      encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'read/write: utf8 (default), or base64 for binary files' },
      data: { type: 'string', description: 'write: bounded file contents (never in local event metadata)' },
    }, required: ['action'],
  },
};

let provider = null, available = false;
const availability = new EventEmitter();
export const hasDeviceHands = () => !!provider?.list().length;
function availabilityChanged() {
  const next = hasDeviceHands();
  if (next === available) return;
  available = next;
  availability.emit('change');
}
export function onDeviceHandsChange(fn) { availability.on('change', fn); return () => availability.off('change', fn); }
export function provideDeviceHands(value) { provider = value; availabilityChanged(); }
export async function runDeviceHands({ action, device, command, directory, timeoutMs, path, encoding, data, signal } = {}) {
  if (!provider) throw new Error('device_hands is not serving');
  if (action === 'list') return JSON.stringify({ devices: provider.list() });
  const request = Object.fromEntries(Object.entries({ action, command, cwd: action === 'command' ? directory : undefined, timeoutMs, path, encoding, data }).filter(([, value]) => value !== undefined));
  let result;
  try { result = await provider.request(device, request, { signal }); }
  catch (error) { throw new Error(HINTS[error.message] ? `${error.message}: ${HINTS[error.message]}` : error.message); }
  if (action === 'screenshot') {
    const seen = await pictureForModel(Buffer.from(result.data, 'base64'), result.mime);
    return seen ? [seen.block] : 'The screenshot was too big to send.';
  }
  if (action === 'command') return JSON.stringify({ ...result, stdout: clip(result.stdout), stderr: clip(result.stderr) });
  if (action === 'read' && result.data.length > MOST_CHARS) {
    return JSON.stringify(result.encoding === 'utf8' ? { ...result, data: clip(result.data) } : { bytes: result.bytes, encoding: result.encoding, data: null, note: 'too big to return as base64; work on it with a command instead' });
  }
  return JSON.stringify(result);
}

// What the model is handed of a device's output: a 1 MiB answer is a quarter
// of a million tokens, so long text keeps its start and its end.
const MOST_CHARS = 20_000;
function clip(text) {
  if (typeof text !== 'string' || text.length <= MOST_CHARS) return text;
  const half = MOST_CHARS / 2;
  return `${text.slice(0, half)}\n… (${text.length - MOST_CHARS} characters cut; send long output to a file and read the part you need) …\n${text.slice(-half)}`;
}
// The device answers in fixed codes; what each means for the next step.
const HINTS = {
  permission_denied: 'the person has not turned that permission on for this device; ask them to, in the imperfect app on it',
  permission_revoked: 'the person turned that permission off while it ran',
  busy: 'the device is busy with other actions; try again shortly',
  device_busy: 'the device is busy with other actions; try again shortly',
  command_timeout: 'the command ran past its timeout; give a longer timeoutMs (at most 120000) or run it in the background',
  output_limit: 'the command printed more than 1 MiB; narrow it, or send its output to a file and read part of it',
  file_limit: 'the file is over 1 MiB; work on it with a command instead',
  capture_unavailable: 'the device cannot capture its screen right now',
  regular_file_required: 'the path is not a regular file (a folder or a link)',
  explicit_device_required: 'give device, an id from list',
  not_connected: 'that device is not connected; list shows the ones that are',
};

// Missing config disables pairing; bad config fails startup without naming the
// secret path or file contents. No account/password/session token fallback.
export async function createDeviceHands({ deviceHandsTokenFile, deviceHandsAccount, deviceHandsTestInsecure = false } = {}) {
  const account = deviceHandsAccount === undefined ? null : normalizeDeviceHandsAccount(deviceHandsAccount, { testInsecure: deviceHandsTestInsecure });
  let expected = null;
  if (!account && deviceHandsTokenFile !== undefined) {
    try {
      const raw = await readFile(deviceHandsTokenFile, 'utf8');
      const token = raw.trim();
      if (raw.length > 4096 || token.length < 32 || /\s/.test(token)) throw new Error();
      expected = Buffer.from(token);
    } catch { throw new Error('Invalid device hands token configuration'); }
  }
  const sockets = new WebSocketServer({ noServer: true, maxPayload: HANDS_LIMITS.wire });
  const devices = new Map(), connections = new Set();
  let closed = false;
  const send = (ws, message) => {
    if (ws.readyState !== 1 || ws.bufferedAmount > HANDS_LIMITS.wire) { ws.terminate(); return false; }
    ws.send(JSON.stringify(message)); return true;
  };
  const heartbeat = setInterval(() => {
    for (const ws of connections) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, 15_000);
  heartbeat.unref();
  const dropPending = (entry, code) => {
    for (const pending of [...entry.pending.values()]) pending.finish(new Error(code));
  };
  function attach(ws, auth = null) {
    ws.on('error', () => {});
    connections.add(ws); ws.alive = true;
    let entry = null;
    let checking = null, revoked = false, expiryTimer;
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      if (entry) {
        for (const pending of entry.pending.values()) send(ws, { type: 'cancel', id: pending.id });
        dropPending(entry, 'device_authentication_lost');
        if (devices.get(entry.id) === entry) { devices.delete(entry.id); availabilityChanged(); }
      }
      ws.terminate();
    };
    const armExpiry = () => {
      clearTimeout(expiryTimer);
      if (auth) expiryTimer = setTimeout(revoke, Math.max(0, auth.data.expiresAt - Date.now()));
    };
    const authenticate = async () => {
      if (!auth) return;
      if (revoked || auth.data.expiresAt <= Date.now()) { revoke(); throw new Error('device_authentication_lost'); }
      checking ??= introspectAccount(account, auth.token, deviceHandsTestInsecure).then(data => {
        if (revoked || data.deviceId !== auth.data.deviceId || data.computerOrigin !== auth.data.computerOrigin) throw new Error();
        auth.data = data; armExpiry();
      }).catch(() => { revoke(); throw new Error('device_authentication_lost'); }).finally(() => { checking = null; });
      await checking;
    };
    const authTimer = auth ? setInterval(() => { authenticate().catch(() => {}); }, 1000) : null;
    armExpiry();
    const timer = setTimeout(() => ws.close(1008, 'registration required'), 5000);
    ws.on('pong', () => { ws.alive = true; });
    ws.on('close', () => {
      clearTimeout(timer); clearTimeout(expiryTimer); clearInterval(authTimer); connections.delete(ws);
      if (entry) {
        dropPending(entry, 'device_disconnected');
        if (devices.get(entry.id) === entry) { devices.delete(entry.id); availabilityChanged(); }
      }
    });
    ws.on('message', (raw, binary) => {
      try {
        if (revoked || (auth && auth.data.expiresAt <= Date.now())) { revoke(); throw new Error(); }
        if (binary) throw new Error();
        const message = JSON.parse(raw.toString());
        if (!entry) {
          if (message?.type !== 'register' || !handsId(message.deviceId) || typeof message.name !== 'string' || !message.name.trim() || Buffer.byteLength(message.name) > 80 || /[\x00-\x1f\x7f]/.test(message.name) || !handsPermissions(message.permissions) || Object.values(message.permissions).some(Boolean)) throw new Error();
          if (auth && message.deviceId !== auth.data.deviceId) throw new Error();
          if (devices.has(message.deviceId)) { ws.close(1008, 'device ID already registered'); return; }
          entry = { id: message.deviceId, name: message.name, ws, authenticate, permissions: { ...message.permissions }, pending: new Map() };
          devices.set(entry.id, entry); availabilityChanged(); clearTimeout(timer);
          send(ws, { type: 'registered', deviceId: entry.id }); return;
        }
        if (message?.type === 'permissions' && handsPermissions(message.permissions)) {
          entry.permissions = { ...message.permissions };
          for (const pending of [...entry.pending.values()]) {
            if (!entry.permissions[permission(pending.action)]) {
              send(ws, { type: 'cancel', id: pending.id }); pending.finish(new Error('permission_revoked'));
            }
          }
          return;
        }
        if (message?.type !== 'response' || !handsId(message.id) || typeof message.success !== 'boolean') throw new Error();
        const pending = entry.pending.get(message.id);
        if (!pending) return; // Late result after cancellation; never revive work.
        if (!message.success) {
          // Remote errors can contain arbitrary secrets; only relay fixed codes.
          const codes = ['permission_denied', 'busy', 'cancelled', 'command_timeout', 'output_limit', 'file_limit', 'capture_unavailable', 'invalid_capture', 'action_failed', 'regular_file_required'];
          pending.finish(new Error(codes.includes(message.error) ? message.error : 'device_action_failed')); return;
        }
        if (!validResult(pending.action, message.data)) throw new Error();
        pending.finish(null, message.data);
      } catch { ws.close(1008, 'invalid hands protocol'); dropPending(entry ?? { pending: new Map() }, 'invalid_device_response'); }
    });
  }
  return {
    sockets,
    list: () => [...devices.values()].map(({ id, name, permissions }) => ({ id, name, permissions: { ...permissions } })),
    // Called ONLY by server's upgrade branch, ahead of its UI-origin gate.
    async upgrade(req, socket, head) {
      socket.on('error', () => socket.destroy());
      const refuse = status => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      const token = /^Bearer ([A-Za-z0-9_-]{32,4096})$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const supplied = Buffer.from(token);
      if (closed || Object.hasOwn(req.headers, 'origin') || req.url !== '/device-hands' || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || !token) { refuse('401 Unauthorized'); return; }
      let auth = null;
      if (account) {
        try { auth = { token, data: await introspectAccount(account, token, deviceHandsTestInsecure) }; }
        catch { refuse('401 Unauthorized'); return; }
      } else if (!expected || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { refuse('401 Unauthorized'); return; }
      if (closed || socket.destroyed) { socket.destroy(); return; }
      if (connections.size >= 64) { refuse('503 Service Unavailable'); return; }
      sockets.handleUpgrade(req, socket, head, ws => attach(ws, auth));
    },
    async request(device, request, { signal } = {}) {
      try {
        validateHandsRequest(request);
        if (!handsId(device)) throw new Error('explicit_device_required');
        if (closed) throw new Error('device_hands_closed');
        if (signal?.aborted) throw new Error('cancelled');
        const entry = devices.get(device);
        if (!entry || entry.ws.readyState !== 1) throw new Error('device_not_connected');
        await entry.authenticate();
        if (signal?.aborted) throw new Error('cancelled');
        if (closed || devices.get(device) !== entry || entry.ws.readyState !== 1) throw new Error('device_not_connected');
        // Denials still reach the native app for visibility. The client is the
        // permission enforcement boundary; stale server state cannot grant it.
        if (entry.pending.size >= HANDS_LIMITS.concurrent) throw new Error('device_busy');
        return new Promise((resolve, reject) => {
          const id = randomUUID();
          const finish = (error, result) => {
            if (!entry.pending.delete(id)) return;
            clearTimeout(timer); signal?.removeEventListener('abort', cancel);
            error ? reject(error) : resolve(result);
          };
          const cancel = () => { send(entry.ws, { type: 'cancel', id }); finish(new Error('cancelled')); };
          const timer = setTimeout(() => { send(entry.ws, { type: 'cancel', id }); finish(new Error('device_timeout')); }, request.action === 'command' ? (request.timeoutMs ?? 30_000) + 2000 : 30_000);
          entry.pending.set(id, { id, action: request.action, finish });
          signal?.addEventListener('abort', cancel, { once: true });
          if (!send(entry.ws, { type: 'request', id, request })) finish(new Error('device_disconnected'));
          if (signal?.aborted) cancel();
        });
      } catch (error) { return Promise.reject(error); }
    },
    close() {
      closed = true; clearInterval(heartbeat);
      for (const entry of devices.values()) dropPending(entry, 'device_disconnected');
      for (const ws of connections) ws.terminate();
      devices.clear(); sockets.close();
      if (provider === this) { provider = null; availabilityChanged(); }
    },
  };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
async function introspectAccount(account, token, testInsecure = false) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 1000);
  try {
    const response = await fetch(`${account.store}/account/desktop/introspect`, {
      method: 'POST', redirect: 'error', signal: stop.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ computerId: account.computerId, owner: account.owner }),
    });
    if (response.status !== 200 || !response.headers.get('content-type')?.startsWith('application/json')) throw new Error();
    let raw = '', size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8192) { stop.abort(); throw new Error(); }
      raw += Buffer.from(chunk).toString('utf8');
    }
    const data = JSON.parse(raw);
    if (data.active !== true || data.computerId !== account.computerId || data.owner !== account.owner || !UUID.test(data.deviceId) || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= Date.now() || data.expiresAt > Date.now() + 24 * 3600_000) throw new Error();
    const origin = new URL(data.computerOrigin);
    if (origin.origin !== data.computerOrigin || origin.username || origin.password || !['https:', 'http:'].includes(origin.protocol) || (origin.protocol === 'http:' && (!testInsecure || !['127.0.0.1', '[::1]'].includes(origin.hostname)))) throw new Error();
    return data;
  } finally { clearTimeout(timer); }
}
const permission = action => ({ command: 'commands', screenshot: 'screen', read: 'files', write: 'files' })[action];
function validResult(action, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (action === 'screenshot') return validHandsImage(value) && Object.keys(value).every(key => ['mime', 'data'].includes(key));
  if (action === 'command') return Object.keys(value).every(key => ['stdout', 'stderr', 'exitCode', 'signal'].includes(key)) && typeof value.stdout === 'string' && typeof value.stderr === 'string' && Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) <= HANDS_LIMITS.output * 3 && (value.exitCode === null || Number.isInteger(value.exitCode)) && (value.signal === null || (typeof value.signal === 'string' && value.signal.length <= 32));
  if (!Number.isInteger(value.bytes) || value.bytes < 0 || value.bytes > HANDS_LIMITS.file) return false;
  if (action === 'write') return Object.keys(value).length === 1;
  return Object.keys(value).every(key => ['encoding', 'data', 'bytes'].includes(key)) && ['utf8', 'base64'].includes(value.encoding) && typeof value.data === 'string' && Buffer.byteLength(value.data) <= HANDS_LIMITS.file * 3;
}
