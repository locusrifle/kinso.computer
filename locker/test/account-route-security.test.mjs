import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openStore } from '../store.mjs';
import { createAccounts } from '../accounts.mjs';
import { digest } from '../account-security.mjs';

const BASE = 'https://imperfect.computer';
const random = () => randomBytes(32).toString('base64url');
function fixture(t) {
  let at = 1_800_000_000_000;
  const now = () => at, store = openStore(':memory:', { now });
  t.after(() => store.close());
  const accounts = createAccounts({ store, now, config: { base: BASE } });
  async function call(path, { method = 'GET', cookie = '', data = {}, address = '203.0.113.20', headers = {} } = {}) {
    const req = { url: path, method, socket: { remoteAddress: address }, headers: { host: 'imperfect.computer', cookie, ...(method === 'POST' ? { origin: BASE, 'content-type': 'application/x-www-form-urlencoded' } : {}), ...headers }, async *[Symbol.asyncIterator]() { yield Buffer.from(new URLSearchParams(data).toString()); } };
    const res = { status: null, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }, end(body = '') { this.body = body; } };
    await accounts.handle(req, res); return res;
  }
  return { store, call, advance: ms => { at += ms; }, now };
}
const formCookie = response => response.headers['set-cookie'].split(';')[0];
const csrf = response => /name="csrf" value="([^"]+)"/.exec(response.body)[1];

test('new anonymous bindings are socket/global-budgeted; recognized bindings remain available and expire', async t => {
  const f = fixture(t);
  const first = await f.call('/account');
  assert.equal(first.status, 200);
  for (let i = 1; i < 30; i++) assert.equal((await f.call('/account/signup', { headers: { 'cf-connecting-ip': `198.51.100.${i}` } })).status, 200);
  const exhausted = await f.call('/account/recover', { headers: { 'cf-connecting-ip': '198.51.100.222' } });
  assert.equal(exhausted.status, 429); assert.equal(exhausted.headers['retry-after'], '60');
  const recognized = await f.call('/account', { cookie: formCookie(first) });
  assert.equal(recognized.status, 200); assert.equal(csrf(recognized), csrf(first));
  assert.equal(recognized.headers['set-cookie'], undefined, 'reuses the browser binding without minting another');
  for (let i = 0; i < 269; i++) assert.equal((await f.call('/account', { address: `198.51.100.${i}` })).status, 200);
  assert.equal((await f.call('/account', { address: '192.0.2.1' })).status, 429, 'global new-binding limit');
  assert.equal((await f.call('/account', { cookie: formCookie(first) })).status, 200, 'recognized binding still works at global exhaustion');
  f.advance(60_000);
  assert.equal((await f.call('/account')).status, 200);
  f.advance(900_000);
  assert.equal((await f.call('/account/login', { method: 'POST', cookie: formCookie(first), data: { csrf: csrf(first), username: 'alder', password: 'A private disposable fixture phrase' } })).status, 403);
});

test('credential-work exhaustion cannot deny either sign-out action', async t => {
  const f = fixture(t);
  const account = f.store.createAccount({ username: 'alder', name: 'Alder', passwordHash: 'disposable-store-fixture-hash' });
  const sessions = [];
  for (let i = 0; i < 3; i++) {
    const token = random(), anti = random();
    f.store.saveAccountSession({ tokenHash: digest(token), accountId: account.id, csrf: anti, expiresAt: f.now() + 86400_000, credentialVersion: account.credential_version });
    sessions.push({ token, anti });
  }
  for (let i = 0; i < 30; i++) assert.equal((await f.call('/account/signup', { method: 'POST' })).status, 403);
  assert.equal((await f.call('/account/signup', { method: 'POST' })).status, 429);
  const logout = await f.call('/account/logout', { method: 'POST', cookie: `__Host-imperfect_account=${sessions[0].token}`, data: { csrf: sessions[0].anti } });
  assert.equal(logout.status, 303); assert.equal(f.store.accountSession(digest(sessions[0].token)), null);
  assert.ok(f.store.accountSession(digest(sessions[1].token)));
  const everywhere = await f.call('/account/logout-everywhere', { method: 'POST', cookie: `__Host-imperfect_account=${sessions[1].token}`, data: { csrf: sessions[1].anti } });
  assert.equal(everywhere.status, 303);
  for (const session of sessions) assert.equal(f.store.accountSession(digest(session.token)), null);
  assert.equal(f.store.saveAccountSession({ tokenHash: digest(random()), accountId: account.id, csrf: random(), expiresAt: f.now() + 86400_000, credentialVersion: account.credential_version }), false, 'stale in-flight login fenced by credential epoch');
});
