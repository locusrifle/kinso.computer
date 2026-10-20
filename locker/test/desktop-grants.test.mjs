import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../store.mjs';
import { createAccounts } from '../accounts.mjs';
import { digest } from '../account-security.mjs';

const BASE = 'https://imperfect.computer';
const random = () => randomBytes(32).toString('base64url');
const signer = generateKeyPairSync('ed25519');
const hash = value => createHash('sha256').update(value).digest('base64url');
const csrf = page => /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
const parse = response => JSON.parse(response.body);
const form = (data, cookie, origin = BASE) => ({ method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
const native = (data, token, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(data) });

async function fixture(t, { file = ':memory:', at = 1_800_000_000_000 } = {}) {
  let time = at;
  const now = () => time;
  const store = openStore(file, { now });
  const calls = [];
  const accounts = createAccounts({ store, now, config: { base: BASE, signerPrivateKey: signer.privateKey } });
  const server = createServer(async (req, res) => {
    try { if (!await accounts.handle(req, res)) { res.writeHead(404); res.end(); } }
    catch { res.writeHead(500); res.end('fixture error'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const call = (path, init = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method: init.method ?? 'GET', headers: { host: 'imperfect.computer', ...init.headers } }, res => {
      const chunks = []; res.on('data', b => chunks.push(b));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(init.body);
  });
  const account = store.createAccount({ username: 'alder', name: 'Alder Person', passwordHash: 'synthetic-desktop-hash-not-for-login' });
  store.markRecoverySaved(account.id);
  store.registerComputer({ username: 'alder', computerId: 'fixture-computer', state: 'ready' });
  const token = random(), antiCSRF = random();
  store.saveAccountSession({ tokenHash: digest(token), accountId: account.id, csrf: antiCSRF, expiresAt: now() + 30 * 86400_000 });
  const cookie = `__Host-imperfect_account=${token}`;
  const state = random(), verifier = random();
  const intent = { redirect_uri: 'http://127.0.0.1:54321/callback', state, code_challenge: hash(verifier), code_challenge_method: 'S256', device_name: 'Fixture desktop' };
  const path = `/account/desktop/authorize?${new URLSearchParams(intent)}`;
  async function code(extra = {}) {
    const consent = await call('/account/desktop/authorize', form({ ...intent, csrf: antiCSRF, ...extra }, cookie));
    assert.equal(consent.status, 303, consent.body);
    const url = new URL(consent.headers.location);
    assert.equal(url.origin, 'http://127.0.0.1:54321'); assert.equal(url.pathname, '/callback');
    assert.equal(url.searchParams.get('state'), state);
    assert.deepEqual([...url.searchParams.keys()].sort(), ['code', 'state']);
    return url.searchParams.get('code');
  }
  const redeem = (code, extra = {}) => call('/account/desktop/token', native({ grant_type: 'authorization_code', code, redirect_uri: intent.redirect_uri, code_verifier: verifier, ...extra }));
  async function grant() { const result = await redeem(await code()); assert.equal(result.status, 200, result.body); return parse(result); }
  const refresh = token => call('/account/desktop/token', native({ grant_type: 'refresh_token', refresh_token: token }));
  const introspect = (token, extra = {}, headers) => call('/account/desktop/introspect', native({ computerId: 'fixture-computer', owner: account.id, ...extra }, token, headers));
  return { store, accounts, account, cookie, csrf: antiCSRF, now, advance: ms => { time += ms; }, call, path, intent, verifier, code, redeem, grant, refresh, introspect, calls };
}

test('authorize explicitly consents; grant/introspection/desktop assertion exact, hashes only, no cookie or CORS', async t => {
  const f = await fixture(t);
  const first = await f.call(f.path, { headers: { cookie: f.cookie } });
  assert.equal(first.status, 200); assert.match(first.body, /Authorize device/); assert.ok(csrf(first));
  assert.equal(f.store.desktopDevices(f.account.id).length, 0);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(first.headers['content-security-policy'], `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self' ${new URL(f.intent.redirect_uri).origin}; frame-ancestors 'none'; base-uri 'none'`, 'consent CSP allows only self and the validated loopback redirect origin');
  assert.ok(!first.headers['content-security-policy'].includes('stripe.com'), 'desktop consent does not allow Stripe');
  const accountPage = await f.call('/account', { headers: { cookie: f.cookie } });
  assert.equal(accountPage.headers['content-security-policy'], "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com; frame-ancestors 'none'; base-uri 'none'");
  assert.ok(!accountPage.headers['content-security-policy'].includes('127.0.0.1'), 'loopback allowance is scoped to desktop consent');
  const g = await f.grant();
  assert.deepEqual(Object.keys(g).sort(), ['accessToken', 'computerOrigin', 'deviceId', 'expiresAt', 'refreshToken', 'username']);
  assert.equal(g.username, 'alder'); assert.equal(g.computerOrigin, 'https://alder.imperfect.computer');
  assert.match(g.deviceId, /^[0-9a-f-]{36}$/); assert.equal(g.expiresAt, f.now() + 300_000);
  const info = await f.introspect(g.accessToken);
  assert.equal(info.status, 200); assert.equal(info.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(parse(info), { active: true, computerId: 'fixture-computer', owner: f.account.id, computerOrigin: g.computerOrigin, deviceId: g.deviceId, expiresAt: g.expiresAt });
  const nonce = random();
  const door = await f.call('/account/desktop/door', native({ nonce }, g.accessToken));
  assert.equal(door.status, 200);
  const assertion = parse(door).assertion, [head, payload, sig] = assertion.split('.');
  assert.ok(verify(null, Buffer.from(`${head}.${payload}`), signer.publicKey, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'device', 'exp', 'iat', 'iss', 'jti', 'nonce', 'purpose', 'sub']);
  assert.equal(claims.iss, BASE); assert.equal(claims.aud, 'fixture-computer'); assert.equal(claims.sub, f.account.id);
  assert.equal(claims.nonce, nonce); assert.equal(claims.purpose, 'desktop'); assert.equal(claims.device, g.deviceId); assert.equal(claims.exp - claims.iat, 60);
  assert.equal((await f.call('/account/desktop/door', native({ nonce: 'wrong' }, g.accessToken))).status, 403);
  const page = await f.call('/account', { headers: { cookie: f.cookie } });
  assert.match(page.body, /Fixture desktop/); assert.ok(page.body.includes(g.deviceId)); assert.match(page.body, /last used/);
  assert.match(page.body, /does not sign out existing computer web sessions/);
  assert.equal(f.calls.length, 0);
});

test('strict IPv4 callback, state, S256, device label and consent Origin/CSRF refusals', async t => {
  const f = await fixture(t);
  const invalid = [
    { redirect_uri: 'http://localhost:1234/callback' }, { redirect_uri: 'http://[::1]:1234/callback' },
    { redirect_uri: 'http://127.1:1234/callback' }, { redirect_uri: 'http://2130706433:1234/callback' },
    { redirect_uri: 'http://127.0.0.1:0/callback' }, { redirect_uri: 'http://127.0.0.1:65536/callback' },
    { redirect_uri: 'http://127.0.0.1:01234/callback' }, { redirect_uri: 'https://127.0.0.1:1234/callback' },
    { redirect_uri: 'http://user@127.0.0.1:1234/callback' }, { redirect_uri: 'http://127.0.0.1:1234/callback?evil=x' },
    { redirect_uri: 'http://127.0.0.1:1234/callback#x' }, { redirect_uri: 'http://127.0.0.1:1234/other' },
    { code_challenge_method: 'plain' }, { code_challenge: 'bad' }, { state: 'bad' },
    { device_name: 'x'.repeat(81) }, { device_name: '\nname' }, { device_name: '' },
  ];
  for (const extra of invalid) {
    const path = `/account/desktop/authorize?${new URLSearchParams({ ...f.intent, ...extra })}`;
    assert.equal((await f.call(path, { headers: { cookie: f.cookie } })).status, 400, JSON.stringify(extra));
  }
  assert.equal((await f.call(`${f.path}&state=${random()}`, { headers: { cookie: f.cookie } })).status, 400);
  for (const origin of ['', 'null', 'https://evil.invalid', 'https://www.imperfect.computer']) {
    assert.equal((await f.call('/account/desktop/authorize', form({ ...f.intent, csrf: f.csrf }, f.cookie, origin))).status, 403);
  }
  assert.equal((await f.call('/account/desktop/authorize', form({ ...f.intent, csrf: 'wrong' }, f.cookie))).status, 403);
  assert.equal((await f.call('/account/desktop/authorize', form({ ...f.intent, csrf: f.csrf }, ''))).status, 403);
  assert.equal(f.store.desktopDevices(f.account.id).length, 0);
  const { device_name, ...unlabelled } = f.intent;
  const explicitPort = await f.call('/account/desktop/authorize', form({ ...unlabelled, redirect_uri: 'http://127.0.0.1:80/callback', csrf: f.csrf }, f.cookie));
  assert.equal(explicitPort.status, 303);
  assert.ok(explicitPort.headers.location.startsWith('http://127.0.0.1:80/callback?'), 'literal callback binding, no default-port normalization');
  assert.equal((await f.redeem(new URL(explicitPort.headers.location).searchParams.get('code'), { redirect_uri: 'http://127.0.0.1:80/callback' })).status, 200);
  assert.equal(f.store.desktopDevices(f.account.id)[0].label, 'imperfect desktop');
});

test('desktop continuation survives password sign-up, saved codes and sign-in without granting on GET or open redirect', async t => {
  const f = await fixture(t);
  const anon = await f.call(f.path);
  assert.equal(anon.status, 303); assert.equal(new URL(anon.headers.location, BASE).searchParams.get('next'), f.path);
  const page = await f.call(`/account/signup?next=${encodeURIComponent(f.path)}`);
  const formCookie = page.headers['set-cookie'].find(c => c.startsWith('__Host-imperfect_form=')).split(';')[0];
  const password = 'Silver clouds drift over quiet water';
  const signup = await f.call('/account/signup', form({ csrf: csrf(page), username: 'birch', name: 'Birch Person', password, next: f.path }, formCookie));
  assert.equal(signup.status, 200, signup.body);
  assert.equal([...signup.body.matchAll(/<code>[^<]+<\/code>/g)].length, 8);
  const cookie = signup.headers['set-cookie'].find(c => c.startsWith('__Host-imperfect_account=')).split(';')[0];
  const saved = await f.call('/account/recovery/saved', form({ csrf: csrf(signup), saved: 'yes', next: f.path }, cookie));
  assert.equal(saved.status, 303); assert.equal(saved.headers.location, f.path);
  assert.equal((await f.call(f.path, { headers: { cookie } })).status, 403, 'unprovisioned account');
  f.store.registerComputer({ username: 'birch', computerId: 'birch-computer', state: 'ready' });
  const consent = await f.call(f.path, { headers: { cookie } });
  assert.equal(consent.status, 200); assert.match(consent.body, /birch.imperfect.computer/);
  const birch = f.store.accountByUsername('birch'); assert.equal(f.store.desktopDevices(birch.id).length, 0);
  assert.equal((await f.call('/account/logout', form({ csrf: csrf(consent) }, cookie))).status, 303);
  const loginPage = await f.call(`/account?next=${encodeURIComponent(f.path)}`);
  const loginCookie = loginPage.headers['set-cookie'].find(c => c.startsWith('__Host-imperfect_form=')).split(';')[0];
  const login = await f.call('/account/login', form({ csrf: csrf(loginPage), username: 'birch', password, next: f.path }, loginCookie));
  assert.equal(login.status, 303); assert.equal(login.headers.location, f.path);
  const signedCookie = login.headers['set-cookie'].find(c => c.startsWith('__Host-imperfect_account=')).split(';')[0];
  assert.equal((await f.call(f.path, { headers: { cookie: signedCookie } })).status, 200);
  for (const next of ['//evil.invalid', '/\\evil.invalid', 'https://evil.invalid', '/account/desktop/authorize?redirect_uri=https://evil.invalid', `${f.path}#evil`]) {
    f.advance(60_000);
    const p = await f.call(`/account?next=${encodeURIComponent(next)}`);
    const c = p.headers['set-cookie'].find(c => c.startsWith('__Host-imperfect_form=')).split(';')[0];
    const done = await f.call('/account/login', form({ csrf: csrf(p), username: 'birch', password, next }, c));
    assert.equal(done.status, 303, done.body); assert.equal(done.headers.location, '/account');
  }
});

test('PKCE and redirect binding burn code; replay/concurrent redemption/expired codes cannot issue', async t => {
  const f = await fixture(t);
  for (const extra of [{ code_verifier: random() }, { redirect_uri: 'http://127.0.0.1:54322/callback' }]) {
    const code = await f.code(); assert.equal((await f.redeem(code, extra)).status, 401);
    assert.equal((await f.redeem(code)).status, 401);
  }
  let code = await f.code();
  assert.equal((await f.redeem(code, { code_verifier: 'short' })).status, 401);
  assert.equal((await f.redeem(code)).status, 401);
  code = await f.code();
  const results = await Promise.all([f.redeem(code), f.redeem(code)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
  assert.equal((await f.redeem(code)).status, 401);
  code = await f.code(); f.advance(60_000);
  assert.equal((await f.redeem(code)).status, 401);
});

test('native routes reject all Origin values, JSON/body bounds, wrong access binding and method', async t => {
  const f = await fixture(t), g = await f.grant();
  for (const route of ['token', 'introspect', 'door', 'revoke']) {
    for (const origin of ['', 'null', BASE, 'https://evil.invalid']) {
      const res = await f.call(`/account/desktop/${route}`, native({ refresh_token: g.refreshToken }, g.accessToken, { origin }));
      assert.equal(res.status, 403); assert.match(res.headers['content-type'], /application\/json/);
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    }
    assert.equal((await f.call(`/account/desktop/${route}`)).status, 400);
    assert.equal((await f.call(`/account/desktop/${route}`, form({}, f.cookie))).status, 403);
    assert.equal((await f.call(`/account/desktop/${route}`, native({ padding: 'x'.repeat(9000) }))).status, 413);
  }
  for (const extra of [{ owner: 'wrong' }, { computerId: 'wrong' }]) {
    const res = await f.introspect(g.accessToken, extra); assert.equal(res.status, 401); assert.deepEqual(parse(res), { active: false });
  }
  assert.equal((await f.introspect(random())).status, 401);
  assert.equal((await f.call('/account/desktop/introspect', native({ computerId: 'fixture-computer', owner: f.account.id }, null, { cookie: f.cookie }))).status, 401);
  assert.equal((await f.call('/account/desktop/token', native({ grant_type: 'refresh_token', refresh_token: g.refreshToken }, null, { host: 'www.imperfect.computer' }))).status, 400);
  assert.equal((await f.call('/account/desktop/token', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 400);
  assert.equal((await f.call('/account/desktop/token', { ...native({}), body: '{' })).status, 400);
  assert.equal((await f.call('/account/desktop/token', native(null))).status, 400);
});

test('refresh rotates atomically with absolute expiry; reuse invalidates EVERY issued access and refresh', async t => {
  const f = await fixture(t), first = await f.grant();
  const next = parse(await f.refresh(first.refreshToken));
  assert.equal(next.deviceId, first.deviceId); assert.notEqual(next.refreshToken, first.refreshToken); assert.notEqual(next.accessToken, first.accessToken);
  assert.equal((await f.introspect(first.accessToken)).status, 200);
  assert.equal((await f.introspect(next.accessToken)).status, 200);
  assert.equal((await f.refresh(first.refreshToken)).status, 401);
  for (const g of [first, next]) {
    assert.equal((await f.introspect(g.accessToken)).status, 401);
    assert.equal((await f.refresh(g.refreshToken)).status, 401);
  }
  const other = await f.grant(); assert.equal((await f.introspect(other.accessToken)).status, 200);
  const races = await Promise.all([f.refresh(other.refreshToken), f.refresh(other.refreshToken)]);
  assert.deepEqual(races.map(r => r.status).sort(), [200, 401]);
  assert.equal((await f.introspect(parse(races.find(r => r.status === 200)).accessToken)).status, 401);
  const expiring = await f.grant();
  f.advance(300_000); assert.equal((await f.introspect(expiring.accessToken)).status, 401);
  f.advance(30 * 86400_000 - 360_000);
  const near = await f.refresh(expiring.refreshToken); assert.equal(near.status, 200);
  assert.equal(parse(near).expiresAt, f.now() + 60_000, 'access bounded by absolute family expiry');
  f.advance(60_000); assert.equal((await f.refresh(parse(near).refreshToken)).status, 401);
});

test('ready and immutable owner checked at consent, code redemption, refresh, access and door issuance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-owner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'store.db'), f = await fixture(t, { file }), g = await f.grant(), code = await f.code();
  for (const state of ['provisioning', 'stopped', 'failed']) {
    f.store.registerComputer({ username: 'alder', computerId: 'fixture-computer', state });
    assert.equal((await f.call(f.path, { headers: { cookie: f.cookie } })).status, 403);
    assert.equal((await f.refresh(g.refreshToken)).status, 401);
    assert.equal((await f.introspect(g.accessToken)).status, 401);
    assert.equal((await f.call('/account/desktop/door', native({ nonce: random() }, g.accessToken))).status, 401);
  }
  assert.equal((await f.redeem(code)).status, 401);
  f.store.registerComputer({ username: 'alder', computerId: 'fixture-computer', state: 'ready' });
  const pending = await f.code(), other = f.store.createAccount({ username: 'other-owner', name: 'Other', passwordHash: 'synthetic-other-hash' });
  const db = new DatabaseSync(file); t.after(() => db.close());
  db.prepare('UPDATE account_computers SET owner = ? WHERE computer_id = ?').run(other.id, 'fixture-computer');
  assert.equal((await f.call(f.path, { headers: { cookie: f.cookie } })).status, 403);
  assert.equal((await f.redeem(pending)).status, 401);
  assert.equal((await f.refresh(g.refreshToken)).status, 401);
  assert.equal((await f.introspect(g.accessToken)).status, 401);
  assert.equal((await f.call('/account/desktop/door', native({ nonce: random() }, g.accessToken))).status, 401);
});

test('native, account UI and logout revocation; CSRF/exact Origin and account scoping', async t => {
  const f = await fixture(t), first = await f.grant(), other = await f.grant();
  const second = parse(await f.refresh(first.refreshToken));
  for (const origin of ['', 'null', 'https://evil.invalid']) assert.equal((await f.call('/account/desktop/devices/revoke', form({ csrf: f.csrf, device_id: first.deviceId }, f.cookie, origin))).status, 403);
  assert.equal((await f.call('/account/desktop/devices/revoke', form({ csrf: 'wrong', device_id: first.deviceId }, f.cookie))).status, 403);
  assert.equal((await f.introspect(second.accessToken)).status, 200);
  const attacker = f.store.createAccount({ username: 'birch', name: 'Birch', passwordHash: 'synthetic-attacker-hash' });
  f.store.markRecoverySaved(attacker.id);
  const attackerToken = random(), attackerCSRF = random();
  f.store.saveAccountSession({ tokenHash: digest(attackerToken), accountId: attacker.id, csrf: attackerCSRF, expiresAt: f.now() + 86400_000 });
  assert.equal((await f.call('/account/desktop/devices/revoke', form({ csrf: attackerCSRF, device_id: first.deviceId }, `__Host-imperfect_account=${attackerToken}`))).status, 303);
  assert.equal((await f.introspect(second.accessToken)).status, 200);
  assert.equal((await f.call('/account/desktop/devices/revoke', form({ csrf: f.csrf, device_id: first.deviceId }, f.cookie))).status, 303);
  assert.equal((await f.introspect(first.accessToken)).status, 401); assert.equal((await f.introspect(second.accessToken)).status, 401);
  assert.equal((await f.introspect(other.accessToken)).status, 200);
  for (let i = 0; i < 2; i++) assert.deepEqual(parse(await f.call('/account/desktop/revoke', native({ refresh_token: other.refreshToken }))), { revoked: true });
  assert.equal((await f.introspect(other.accessToken)).status, 401);
  assert.deepEqual(parse(await f.call('/account/desktop/revoke', native({ refresh_token: random() }))), { revoked: true });
  const beforeRotation = await f.grant(), afterRotation = parse(await f.refresh(beforeRotation.refreshToken));
  assert.equal((await f.call('/account/desktop/revoke', native({ refresh_token: beforeRotation.refreshToken }))).status, 200);
  assert.equal((await f.introspect(afterRotation.accessToken)).status, 401, 'old token revokes a refresh racing sign-out');
  assert.equal((await f.refresh(afterRotation.refreshToken)).status, 401);
  const last = await f.grant(), pending = await f.code();
  assert.equal((await f.call('/account/logout', form({ csrf: 'wrong' }, f.cookie))).status, 403);
  assert.equal((await f.introspect(last.accessToken)).status, 200);
  assert.equal((await f.call('/account/logout', form({ csrf: f.csrf }, f.cookie))).status, 303);
  assert.equal((await f.introspect(last.accessToken)).status, 401); assert.equal((await f.refresh(last.refreshToken)).status, 401);
  assert.equal((await f.redeem(pending)).status, 401);
});

test('logout racing a delayed consent body cannot authorize a stale browser session', async t => {
  const f = await fixture(t);
  let release, reading;
  const hold = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reading = resolve; });
  const req = { method: 'POST', url: '/account/desktop/authorize', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'imperfect.computer', origin: BASE, cookie: f.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    async *[Symbol.asyncIterator]() { reading(); await hold; yield Buffer.from(new URLSearchParams({ ...f.intent, csrf: f.csrf }).toString()); },
  };
  const res = { status: null, body: '', setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = body ?? ''; } };
  const pending = f.accounts.handle(req, res);
  await started;
  assert.equal((await f.call('/account/logout', form({ csrf: f.csrf }, f.cookie))).status, 303);
  release(); await pending;
  assert.equal(res.status, 403); assert.equal(f.store.desktopDevices(f.account.id).length, 0);
});

test('codes/grants survive store reopen; opaque tokens hashed; reuse revocation persists across independent handles', async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-persist-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'store.db'), f = await fixture(t, { file });
  const code = await f.code(), g = await f.grant();
  let reopened = openStore(file, { now: f.now });
  assert.equal(reopened.desktopAccess(digest(g.accessToken)).device_id, g.deviceId);
  const next = { accessHash: digest(random()), refreshHash: digest(random()), accessExpiresAt: f.now() + 300_000 };
  assert.ok(reopened.rotateDesktopRefresh({ ...next, tokenHash: digest(g.refreshToken) }));
  reopened.close(); reopened = openStore(file, { now: f.now });
  assert.equal(reopened.desktopAccess(next.accessHash).device_id, g.deviceId);
  assert.equal(reopened.rotateDesktopRefresh({ ...next, tokenHash: digest(g.refreshToken) }), null);
  reopened.close(); reopened = openStore(file, { now: f.now });
  assert.equal(reopened.desktopAccess(next.accessHash), null); assert.equal(reopened.desktopAccess(digest(g.accessToken)), null);
  reopened.close();
  assert.equal((await f.redeem(code)).status, 200, 'pending code persists');
  const db = new DatabaseSync(file);
  const rows = db.prepare('SELECT * FROM desktop_refresh').all();
  assert.ok(rows.some(r => r.token_hash === digest(g.refreshToken)));
  const stored = JSON.stringify(['desktop_codes', 'desktop_devices', 'desktop_access', 'desktop_refresh'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  for (const secret of [g.accessToken, g.refreshToken, code, f.verifier]) assert.ok(!stored.includes(secret));
  db.close();
});

test('introspection has a polling-safe separate bounded budget, not browser 30/min', async t => {
  const f = await fixture(t), g = await f.grant();
  for (let i = 0; i < 40; i++) assert.equal((await f.introspect(g.accessToken)).status, 200);
  for (let i = 0; i < 570; i++) await f.introspect(random());
  assert.equal((await f.introspect(g.accessToken)).status, 429);
  f.advance(60_000); assert.equal((await f.introspect(g.accessToken)).status, 200);
});
