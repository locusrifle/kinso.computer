import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { createLockerServer, websiteHttpsRedirect } from '../server.mjs';
import { openStore } from '../store.mjs';

const proxyRequest = (overrides = {}) => ({
  method: 'GET', url: '/boot/sequence.mjs?v=a%2Fb&x=1&x=2',
  headers: { host: 'imperfect.computer', 'x-forwarded-proto': 'http' },
  socket: { remoteAddress: '127.0.0.1' }, ...overrides,
});

test('redirect trusts only the loopback proxy and its single HTTP scheme, never a supplied redirect origin', () => {
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(websiteHttpsRedirect(proxyRequest({ socket: { remoteAddress } })),
      'https://imperfect.computer/boot/sequence.mjs?v=a%2Fb&x=1&x=2');
  }
  for (const remoteAddress of ['192.0.2.1', '::ffff:192.0.2.1', undefined]) {
    assert.equal(websiteHttpsRedirect(proxyRequest({ socket: { remoteAddress } })), null);
  }
  for (const scheme of [undefined, '', 'https', 'http, https', 'https, http', ['http', 'http']]) {
    assert.equal(websiteHttpsRedirect(proxyRequest({ headers: { host: 'imperfect.computer', 'x-forwarded-proto': scheme } })), null);
  }
  assert.equal(websiteHttpsRedirect(proxyRequest({ headers: { host: 'imperfect.computer', 'cf-visitor': '{"scheme":"http"}' } })), null,
    'CF-Visitor is not a second, possibly conflicting source of truth');
  for (const host of ['evil.test', 'imperfect.computer.evil.test', 'imperfect.computer@evil.test', 'www.imperfect.computer.evil.test', 'noah.imperfect.computer', '127.0.0.1:4322', 'localhost:4321']) {
    assert.equal(websiteHttpsRedirect(proxyRequest({ headers: { host, 'x-forwarded-proto': 'http', 'x-forwarded-host': 'imperfect.computer' } })), null, host);
  }
  for (const url of ['//evil.test/a?q=1', '/%2f%2fevil.test/?next=https://evil.test', '/a/../b?x=%2f+%20&x=']) {
    const target = websiteHttpsRedirect(proxyRequest({ url }));
    assert.equal(target, `https://imperfect.computer${url}`);
    assert.equal(new URL(target).origin, 'https://imperfect.computer');
  }
  for (const url of ['https://evil.test/a', '*', '/a\r\nLocation: https://evil.test', '/a\n']) {
    assert.equal(websiteHttpsRedirect(proxyRequest({ url })), null);
  }
  assert.equal(websiteHttpsRedirect(proxyRequest({ socket: { remoteAddress: '127.0.0.1', encrypted: true } })), null);
});

async function fixture(t, secure = true) {
  const store = openStore();
  const app = await createLockerServer({
    store, mail: { configured: false }, port: 0,
    config: { secure, hosts: 'imperfect.computer,www.imperfect.computer' },
    log: { info() {}, warn() {}, error() {} },
  });
  const { port } = await app.listen();
  t.after(async () => { await app.close(); store.close(); });
  const call = (path = '/', { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method,
      headers: Object.fromEntries(Object.entries({ host: 'imperfect.computer', 'x-forwarded-proto': 'http', ...headers }).filter(([, value]) => value !== undefined)) }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
  return { app, port, call };
}

test('public HTTP GET and HEAD return 308 to canonical HTTPS before any page or API handling', async t => {
  const { call } = await fixture(t);
  for (const host of ['imperfect.computer', 'www.imperfect.computer', 'IMPERFECT.COMPUTER', 'www.imperfect.computer:80']) {
    for (const method of ['GET', 'HEAD']) {
      for (const path of ['/', '/boot/sequence.mjs?v=a%2Fb&x=1&x=2', '/health?check=1', '/missing?next=https://evil.test/a%3Fb', '//evil.test/a?q=1']) {
        const response = await call(path, { method, headers: { host, 'x-forwarded-host': 'evil.test', 'cf-visitor': '{"scheme":"https"}' } });
        assert.equal(response.status, 308, `${method} ${host}${path}`);
        assert.equal(response.headers.location, `https://imperfect.computer${path}`);
        assert.equal(response.body, '');
      }
    }
  }
});

test('HTTPS over HTTP tunnel origin does not loop; local HTTP and unrelated hostnames remain usable', async t => {
  const { call } = await fixture(t);
  for (const host of ['imperfect.computer', 'www.imperfect.computer']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await call('/', { method, headers: { host, 'x-forwarded-proto': 'https', 'cf-visitor': '{"scheme":"http"}' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.location, undefined);
      assert.equal(method === 'HEAD' ? response.body : '', '');
    }
  }
  for (const headers of [
    { 'x-forwarded-proto': undefined },
    { host: 'localhost:4321' },
    { host: 'elsewhere.test' },
    { host: 'noah.imperfect.computer' },
    { 'x-forwarded-proto': 'http, https' },
    { 'x-forwarded-proto': ['http', 'http'] },
  ]) {
    const response = await call('/', { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.location, undefined);
  }
  // Real APIs keep their normal responses on HTTPS; POSTs are never redirected.
  const health = await call('/health', { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(health.status, 200); assert.equal(JSON.parse(health.body).ok, true);
  const unlock = await call('/unlock', { method: 'POST' });
  assert.equal(unlock.status, 401); assert.deepEqual(JSON.parse(unlock.body), { ok: false });
  const webhook = await call('/webhooks/stripe', { method: 'POST' });
  assert.equal(webhook.status, 400); assert.equal(webhook.headers.location, undefined);
});

test('explicit insecure development stays HTTP even with public Host and forwarded headers', async t => {
  const { call } = await fixture(t, false);
  const response = await call('/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.location, undefined);
});

test('websocket upgrades bypass redirect without changing the server upgrade handling', async t => {
  const { app, port } = await fixture(t);
  assert.equal(websiteHttpsRedirect(proxyRequest({ headers: { host: 'imperfect.computer', 'x-forwarded-proto': 'http', upgrade: 'websocket' } })), null);
  // Locker has no websocket API; a sentinel listener proves the original request
  // still reaches Node's upgrade path, rather than being turned into a redirect.
  app.server.once('upgrade', (req, socket) => {
    assert.equal(req.url, '/socket?token=test');
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  const response = await new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write('GET /socket?token=test HTTP/1.1\r\nHost: imperfect.computer\r\nX-Forwarded-Proto: http\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
    let data = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('upgrade timed out')));
    socket.on('data', chunk => { data += chunk; });
    socket.on('end', () => { socket.end(); resolve(data); });
    socket.on('error', reject);
  });
  assert.match(response, /^HTTP\/1\.1 101 /);
  assert.doesNotMatch(response, /Location:/i);
});
