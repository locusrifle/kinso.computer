// Native-only hands. Never expose this object or permission setters to web content.
import WebSocket from 'ws';
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';

export const HANDS_LIMITS = Object.freeze({ file: 1024 * 1024, output: 1024 * 1024, screen: 8 * 1024 * 1024, wire: 12 * 1024 * 1024, concurrent: 8, timeout: 120_000 });
const PERMISSIONS = ['commands', 'screen', 'files'];
const ACTION_PERMISSION = { command: 'commands', screenshot: 'screen', read: 'files', write: 'files' };
const DETAILS = { command: 'Run a local shell command', screenshot: 'Capture the local screen', read: 'Read a local file', write: 'Write a local file' };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const handsPermissions = value => object(value) && Object.keys(value).length === 3 && PERMISSIONS.every(key => typeof value[key] === 'boolean');
export const handsId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const fail = code => { throw new Error(code); };
const text = (value, max) => typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max;
function validatePath(value) {
  if (!text(value, 4096) || !value) fail('invalid_path');
  if (!value.startsWith('~/') && !posix.isAbsolute(value) && !win32.isAbsolute(value)) fail('absolute_path_required');
}
export function handsPath(value) {
  validatePath(value);
  const path = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(path)) fail('absolute_path_required');
  return path;
}
export function handsBytes(data, encoding = 'utf8') {
  if (typeof data !== 'string' || !['utf8', 'base64'].includes(encoding)) fail('invalid_data');
  if (data.length > HANDS_LIMITS.file * 2) fail('file_limit');
  if (encoding === 'base64' && (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))) fail('invalid_base64');
  const bytes = Buffer.from(data, encoding);
  if (bytes.length > HANDS_LIMITS.file) fail('file_limit');
  return bytes;
}
export function validateHandsRequest(value) {
  if (!object(value) || typeof value.action !== 'string' || !Object.hasOwn(ACTION_PERMISSION, value.action)) fail('invalid_action');
  const keys = { command: ['action', 'command', 'cwd', 'timeoutMs'], screenshot: ['action'], read: ['action', 'path', 'encoding'], write: ['action', 'path', 'encoding', 'data'] }[value.action];
  if (Object.keys(value).some(key => !keys.includes(key))) fail('invalid_request');
  if (value.action === 'command') {
    if (!text(value.command, 32 * 1024) || !value.command.trim()) fail('invalid_command');
    if (value.cwd !== undefined) validatePath(value.cwd);
    if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > HANDS_LIMITS.timeout)) fail('invalid_timeout');
  }
  if (['read', 'write'].includes(value.action)) {
    validatePath(value.path);
    if (value.encoding !== undefined && !['utf8', 'base64'].includes(value.encoding)) fail('invalid_encoding');
    if (value.action === 'write') handsBytes(value.data, value.encoding);
  }
  return value;
}
export function validHandsImage(value) {
  if (!object(value) || value.mime !== 'image/png' || typeof value.data !== 'string' || value.data.length > Math.ceil(HANDS_LIMITS.screen / 3) * 4) return false;
  if (value.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) return false;
  const bytes = Buffer.from(value.data, 'base64');
  return bytes.length >= 8 && bytes.length <= HANDS_LIMITS.screen && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
}
// POSIX shells get a separate process group. Windows uses taskkill's tree switch.
// This is cancellation, NOT a sandbox: intentionally daemonized/escaped processes
// and effects already performed by a command cannot be revoked.
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
}

export class HandsClient {
  #url; #token; #deviceId; #name; #capture; #event; #status;
  #permissions = { commands: false, screen: false, files: false };
  #ws = null; #closed = false; #ready = false; #pending = new Map(); #seen = new Set(); #heartbeat; #lastPing;
  constructor({ url, token, deviceId, name, captureScreen, onEvent = () => {}, onStatus = () => {} }) {
    const address = new URL(url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(address.protocol) || address.username || address.password) fail('invalid_server_url');
    address.protocol = ['https:', 'wss:'].includes(address.protocol) ? 'wss:' : 'ws:';
    // Plaintext is only for local development; never carry a secret over remote HTTP.
    if (address.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) fail('secure_server_url_required');
    address.pathname = '/device-hands'; address.search = ''; address.hash = '';
    if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) fail('invalid_device_token');
    if (!handsId(deviceId) || !text(name, 80) || !name.trim() || /[\x00-\x1f\x7f]/.test(name)) fail('invalid_device_identity');
    this.#url = address; this.#token = token; this.#deviceId = deviceId; this.#name = name;
    this.#capture = captureScreen; this.#event = onEvent; this.#status = onStatus;
  }
  get permissions() { return Object.freeze({ ...this.#permissions }); }
  #send(value) {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > HANDS_LIMITS.wire || this.#ws.bufferedAmount > HANDS_LIMITS.wire) { this.#ws.terminate(); return false; }
    this.#ws.send(raw); return true;
  }
  #notify(id, action, status) {
    // Only fixed metadata. No paths, commands, outputs, screenshot or file bytes.
    this.#event({ id, action, detail: DETAILS[action] ?? 'Local hands action', status, time: Date.now() });
  }
  setPermission(name, enabled) {
    if (!PERMISSIONS.includes(name) || typeof enabled !== 'boolean') fail('invalid_permission');
    if (this.#closed || (enabled && !this.#ready)) fail('device_not_connected');
    this.#permissions[name] = enabled;
    if (!enabled) for (const work of this.#pending.values()) if (ACTION_PERMISSION[work.action] === name) work.stop.abort();
    this.#send({ type: 'permissions', permissions: this.permissions });
    return this.permissions;
  }
  #revoke() {
    this.#permissions = { commands: false, screen: false, files: false };
    for (const work of this.#pending.values()) work.stop.abort();
  }
  stop() {
    this.#revoke();
    this.#send({ type: 'permissions', permissions: this.permissions });
    this.#status('Stopped; all permissions off');
  }
  close() {
    this.#closed = true; this.#ready = false; this.#revoke();
    clearInterval(this.#heartbeat);
    this.#ws?.terminate();
    this.#status('Disconnected; all permissions off');
  }
  connect() {
    if (this.#closed || this.#ws) return Promise.reject(new Error('device_closed_or_connected'));
    const ws = this.#ws = new WebSocket(this.#url, { headers: { Authorization: `Bearer ${this.#token}` }, maxPayload: HANDS_LIMITS.wire, handshakeTimeout: 10_000, followRedirects: false });
    this.#status('Connecting');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(new Error(error)) : resolve(this); };
      const timer = setTimeout(() => { finish('registration_timeout'); this.close(); }, 10_000);
      ws.on('open', () => this.#send({ type: 'register', deviceId: this.#deviceId, name: this.#name, permissions: this.permissions }));
      ws.on('ping', () => { this.#lastPing = Date.now(); });
      ws.on('error', () => { finish('connection_failed'); this.close(); });
      ws.on('close', () => { finish('device_disconnected'); this.close(); });
      ws.on('message', (raw, binary) => {
        try {
          if (binary) fail('invalid_protocol');
          const message = JSON.parse(raw.toString());
          if (!this.#ready) {
            if (message?.type !== 'registered' || message.deviceId !== this.#deviceId) fail('registration_refused');
            if (this.#closed) fail('device_closed');
            this.#ready = true; this.#lastPing = Date.now();
            this.#heartbeat = setInterval(() => { if (Date.now() - this.#lastPing > 45_000) this.close(); }, 5000);
            this.#heartbeat.unref();
            this.#status('Connected; all permissions off'); finish(); return;
          }
          if (message?.type === 'cancel' && handsId(message.id)) { this.#pending.get(message.id)?.stop.abort(); return; }
          if (message?.type !== 'request' || !handsId(message.id) || !object(message.request)) fail('invalid_protocol');
          // Validation/effects are asynchronous, but never unhandled.
          void this.#request(message.id, message.request).catch(() => this.close());
        } catch { finish('invalid_protocol'); this.close(); }
      });
    });
  }
  async #request(id, request) {
    if (this.#closed || !this.#ready) return;
    if (this.#seen.has(id)) { this.close(); return; }
    this.#seen.add(id);
    if (this.#seen.size > 4096) { this.close(); return; }
    const action = typeof request.action === 'string' && Object.hasOwn(ACTION_PERMISSION, request.action) ? request.action : 'invalid';
    // A compromised peer may encode secrets in its correlation ID. Display a
    // native-generated event ID instead; protocol IDs stay private to transport.
    const eventId = randomUUID();
    this.#notify(eventId, action, 'requested'); // Synchronous visibility BEFORE permission checks/effects.
    let work;
    try {
      validateHandsRequest(request);
      if (!this.#permissions[ACTION_PERMISSION[action]]) fail('permission_denied');
      if (this.#pending.size >= HANDS_LIMITS.concurrent) fail('busy');
      work = { action, stop: new AbortController() };
      this.#pending.set(id, work);
      // Let the native event UI paint, and let Stop/revoke beat a queued action.
      await new Promise(resolve => setImmediate(resolve));
      const check = () => { if (this.#closed || !this.#ready || work.stop.signal.aborted || !this.#permissions[ACTION_PERMISSION[action]]) fail('cancelled'); };
      check(); this.#notify(eventId, action, 'running'); check();
      // Cancellation settles immediately even if native capture or a filesystem
      // syscall is still in flight. Late operations check the same aborted signal
      // before every later step and cannot publish a result or commit a staged file.
      let cancel;
      const aborted = new Promise((_, reject) => { cancel = () => reject(new Error('cancelled')); });
      work.stop.signal.addEventListener('abort', cancel, { once: true });
      const deadline = action === 'command' ? null : setTimeout(() => work.stop.abort(), 30_000);
      let result;
      try { result = await Promise.race([this.#execute(request, work.stop.signal, check), aborted]); }
      finally { clearTimeout(deadline); work.stop.signal.removeEventListener('abort', cancel); }
      check();
      this.#notify(eventId, action, 'done');
      this.#send({ type: 'response', id, success: true, data: result });
    } catch (error) {
      const cancelled = work?.stop.signal.aborted || this.#closed;
      this.#notify(eventId, action, cancelled ? 'cancelled' : 'failed');
      // Native OS errors can contain file contents/paths. Keep error codes bounded.
      const safe = ['permission_denied', 'busy', 'cancelled', 'command_timeout', 'output_limit', 'file_limit', 'capture_unavailable', 'invalid_capture', 'invalid_action', 'invalid_request', 'invalid_path', 'absolute_path_required', 'invalid_data', 'invalid_base64', 'invalid_command', 'invalid_timeout', 'invalid_encoding', 'regular_file_required'].includes(error.message) ? error.message : 'action_failed';
      if (!this.#closed) this.#send({ type: 'response', id, success: false, error: cancelled ? 'cancelled' : safe });
    } finally { this.#pending.delete(id); }
  }
  async #execute(request, signal, check) {
    if (request.action === 'command') return this.#command(request, signal);
    if (request.action === 'screenshot') {
      if (typeof this.#capture !== 'function') fail('capture_unavailable');
      const image = await this.#capture({ signal }); check();
      if (!validHandsImage(image)) fail('invalid_capture');
      return { mime: image.mime, data: image.data };
    }
    const path = handsPath(request.path);
    if (request.action === 'read') {
      const leaf = await lstat(path); check();
      if (!leaf.isFile()) fail('regular_file_required');
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        check(); const info = await file.stat(); check();
        if (!info.isFile()) fail('regular_file_required');
        if (info.size > HANDS_LIMITS.file) fail('file_limit');
        const chunks = []; let total = 0;
        for (;;) {
          check(); const buffer = Buffer.alloc(64 * 1024);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null); check();
          if (!bytesRead) break;
          total += bytesRead; if (total > HANDS_LIMITS.file) fail('file_limit');
          chunks.push(buffer.subarray(0, bytesRead));
        }
        return { encoding: request.encoding ?? 'utf8', data: Buffer.concat(chunks).toString(request.encoding ?? 'utf8'), bytes: total };
      } finally { await file.close(); }
    }
    // Atomic replacement; never follow the final symlink, create parent dirs,
    // or leave partial data on a cancelled write. Parent symlinks are allowed.
    const next = `${path}.hands-${randomUUID()}.tmp`;
    let file;
    try {
      const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; }); check();
      if (info && !info.isFile()) fail('regular_file_required');
      const bytes = handsBytes(request.data, request.encoding);
      file = await open(next, 'wx', 0o600); check();
      for (let offset = 0; offset < bytes.length;) {
        check(); const { bytesWritten } = await file.write(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset); offset += bytesWritten;
      }
      check(); await file.close(); file = null; check();
      await rename(next, path); check();
      return { bytes: bytes.length };
    } finally { await file?.close(); await unlink(next).catch(() => {}); }
  }
  #command(request, signal) {
    return new Promise((resolve, reject) => {
      const windows = process.platform === 'win32';
      const shell = windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
      const args = windows ? ['/d', '/s', '/c', request.command] : ['-c', request.command];
      // The pairing token is only in private JS memory, never env/argv/stdin.
      const child = spawn(shell, args, { cwd: request.cwd ? handsPath(request.cwd) : homedir(), detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout = [], stderr = []; let total = 0, failure = null, finished = false;
      const kill = code => { failure ??= code; finish(); };
      const finish = (code = null, sig = null) => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal.removeEventListener('abort', cancel);
        // Also clean up descendants left after the shell exits.
        killTree(child); child.stdout.destroy(); child.stderr.destroy();
        failure ? reject(new Error(failure)) : resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code, signal: sig });
      };
      const cancel = () => kill('cancelled');
      const timer = setTimeout(() => kill('command_timeout'), request.timeoutMs ?? 30_000);
      for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', chunk => {
        total += chunk.length;
        if (total > HANDS_LIMITS.output) { kill('output_limit'); return; }
        chunks.push(chunk);
      });
      signal.addEventListener('abort', cancel, { once: true });
      child.on('error', () => kill('action_failed'));
      child.on('close', finish);
      if (signal.aborted) cancel();
    });
  }
}
