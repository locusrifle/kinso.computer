import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginSignIn, validateGrant, restoreAccount } from '../../../../desktop/client/auth.mjs';
import { canRemember, saveGrant, loadGrant, forgetGrant } from '../../../../desktop/client/session.mjs';

const token = 'test-only-not-a-real-credential-00000000';
const grant = origin => ({ username: 'tester', computerOrigin: origin, accessToken: token, refreshToken: token,
  deviceId: '12345678-1234-1234-1234-123456789abc',
  expiresAt: Date.now() + 60_000, doorCookie: { name: '__Host-imperfect_door', value: token, expiresAt: Date.now() + 60_000 } });
async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('desktop system-browser sign-in uses loopback state and PKCE; accepts only bound computer', async t => {
  let requested, exchanges = 0;
  const origin = 'http://127.0.0.1:45678';
  const broker = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/account/desktop/token');
    assert.equal(req.method, 'POST');
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); exchanges++;
    assert.equal(body.grant_type, 'authorization_code');
    assert.equal(body.redirect_uri, requested.searchParams.get('redirect_uri'));
    assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), requested.searchParams.get('code_challenge'));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(grant(origin)));
  });
  const login = beginSignIn({ broker, testOrigin: origin, openExternal: async url => {
    requested = new URL(url);
    assert.equal(requested.origin, broker);
    assert.equal(requested.pathname, '/account/desktop/authorize');
    const callback = new URL(requested.searchParams.get('redirect_uri'));
    assert.equal(callback.hostname, '127.0.0.1');
    callback.search = new URLSearchParams({ state: requested.searchParams.get('state'), code: 'one-use-fixture-code-123' });
    const wrong = new URL(callback); wrong.searchParams.set('state', 'invalid');
    assert.equal((await fetch(wrong)).status, 400);
    const unicode = new URL(callback); unicode.searchParams.set('state', 'é'.repeat(43));
    assert.equal((await fetch(unicode)).status, 400);
    const malformed = await new Promise((resolve, reject) => {
      const socket = createConnection({ host: callback.hostname, port: callback.port }); let reply = '';
      socket.on('connect', () => socket.end(`GET http://[ HTTP/1.1\r\nHost: ${callback.host}\r\nConnection: close\r\n\r\n`));
      socket.on('data', bytes => { reply += bytes; }); socket.on('end', () => resolve(reply)); socket.on('error', reject);
    });
    assert.match(malformed, /400/);
    assert.equal((await fetch(callback)).status, 200);
  } });
  t.after(login.cancel);
  assert.equal((await login.result).computerOrigin, origin);
  assert.equal(exchanges, 1);
});
test('desktop grant rejects origin substitution, expired sessions and unsafe cookies', () => {
  const good = grant('https://tester.imperfect.computer');
  assert.equal(validateGrant(good).username, 'tester');
  for (const bad of [
    { ...good, computerOrigin: 'https://attacker.example' },
    { ...good, computerOrigin: 'https://tester.imperfect.computer/path' },
    { ...good, expiresAt: Date.now() - 1 },
    { ...good, username: '../etc' },
    { ...good, username: ['tester'] },
    { ...good, username: 123, computerOrigin: 'https://123.imperfect.computer' },
    { ...good, accessToken: 'short' },
    { ...good, deviceId: undefined },
    { ...good, deviceId: 'attacker-device' },
    { ...good, doorCookie: { ...good.doorCookie, name: 'store-session' } },
    { ...good, doorCookie: { ...good.doorCookie, value: 'bad; cookie' } },
  ]) assert.throws(() => validateGrant(bad));
});
test('desktop sign-in is bounded, cancellable and does not allow an arbitrary broker', async () => {
  assert.throws(() => beginSignIn({ broker: 'https://attacker.example', openExternal: () => {} }));
  const timed = beginSignIn({ timeout: 30, openExternal: () => {} });
  await assert.rejects(timed.result, /timed out/);
  const cancelled = beginSignIn({ openExternal: () => {} });
  cancelled.cancel(); await assert.rejects(cancelled.result, /cancelled/);
});
test('desktop sign-in cancellation and deadline also stop an in-flight token exchange', async t => {
  for (const mode of ['cancel', 'deadline']) {
    const received = Promise.withResolvers();
    const broker = await fixture(t, async (req, _res) => {
      for await (const _chunk of req) {} received.resolve(); // Deliberately never return a token.
    });
    const login = beginSignIn({ broker, testOrigin: 'http://127.0.0.1:45678', timeout: mode === 'deadline' ? 500 : 5000,
      openExternal: async url => {
        const request = new URL(url), callback = new URL(request.searchParams.get('redirect_uri'));
        callback.search = new URLSearchParams({ state: request.searchParams.get('state'), code: 'fixture-pending-code-123' });
        await fetch(callback).catch(() => {});
      },
    });
    const rejected = assert.rejects(login.result, mode === 'cancel' ? /cancelled/ : /timed out/);
    await Promise.race([received.promise, login.result]); // Early load timeout must fail, never strand the fixture.
    if (mode === 'cancel') login.cancel();
    await rejected;
  }
});
test('sign-out or new sign-in supersedes pending startup load and refresh', async () => {
  const good = grant('https://tester.imperfect.computer');
  for (const phase of ['load', 'refresh-success', 'refresh-failure']) {
    let current = true, attached = 0, failed = 0;
    const gate = Promise.withResolvers(), started = Promise.withResolvers();
    const operation = restoreAccount({
      load: async () => {
        if (phase === 'load') { started.resolve(); return gate.promise; }
        return { ...good, expiresAt: Date.now() - 1 };
      },
      refresh: async () => { started.resolve(); return gate.promise; },
      attach: () => { attached++; }, current: () => current, failed: () => { failed++; },
    });
    await started.promise;
    current = false;
    if (phase === 'refresh-failure') gate.reject(new Error('old refresh refused')); else gate.resolve(good);
    await operation;
    assert.equal(attached, 0, phase); assert.equal(failed, 0, phase);
  }
});
test('desktop grant is encrypted or never saved; permissions are not persisted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-account-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'account.enc');
  const insecure = { isEncryptionAvailable: () => false };
  assert.equal(canRemember(insecure), false);
  assert.equal(await saveGrant(path, grant('https://tester.imperfect.computer'), insecure), false);
  await assert.rejects(readFile(path), /ENOENT/);
  const secure = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: text => Buffer.from(`cipher:${Buffer.from(text).toString('base64')}`),
    decryptString: bytes => Buffer.from(bytes.toString().slice(7), 'base64').toString() };
  const good = grant('https://tester.imperfect.computer');
  assert.equal(await saveGrant(path, good, secure), true);
  assert.equal((await readFile(path, 'utf8')).includes(token), false);
  assert.deepEqual(await loadGrant(path, secure), good);
  assert.equal(await saveGrant(path, { ...good, username: 'another' }, insecure), false);
  assert.equal(await loadGrant(path, secure), null, 'key-store fallback must discard the previous saved account');
  assert.equal(await saveGrant(path, good, secure), true);
  await forgetGrant(path); assert.equal(await loadGrant(path, secure), null);
  if (process.platform === 'linux') assert.equal(canRemember({ ...secure, getSelectedStorageBackend: () => 'basic_text' }), false);
});
