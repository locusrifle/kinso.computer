import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { generateKeyPairSync, randomBytes, verify, createPublicKey, createHash, scrypt as nodeScrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { setImmediate as tick } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, RESERVED_USERNAMES } from '../store.mjs';
import { createAccounts } from '../accounts.mjs';
import { digest, equal } from '../account-security.mjs';
import { hashPassword, verifyPassword, validatePassword, generateRecoveryCodes, recoveryDigest } from '../passwords.mjs';
import { run as operator } from '../tools/accounts.mjs';
import { createLockerServer } from '../server.mjs';

const BASE = 'https://imperfect.computer';
const PASSWORD = 'Silver clouds drift over quiet water';
const NEW_PASSWORD = 'Quiet rivers flow beneath violet skies';
const operatorToken = 'fixture-operator-credential-32-characters';
const nonce = () => randomBytes(32).toString('base64url');
const signer = generateKeyPairSync('ed25519');
const config = { base: BASE, signerPrivateKey: signer.privateKey, operatorToken };
const post = (data, cookie = '', origin = BASE) => ({ method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
const jsonPost = (data, token = operatorToken) => ({ method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(data) });
const csrf = page => /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
const cookieOf = (response, name = '__Host-imperfect_account') => response.headers['set-cookie']?.find(value => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`))?.split(';')[0];
const codesOf = response => [...response.body.matchAll(/<code>([^<]+)<\/code>/g)].map(match => match[1]).filter(code => /^[a-f0-9-]{35}$/i.test(code));

async function boot(t, { file = ':memory:', accountConfig = config } = {}) {
  let at = 1_800_000_000_000;
  const now = () => at, store = openStore(file, { now });
  const accounts = createAccounts({ store, config: accountConfig, now });
  const logs = [];
  const app = await createLockerServer({ store, accounts, config: { hosts: 'imperfect.computer,www.imperfect.computer', secure: true }, mail: { configured: false }, port: 0, log: { error: value => logs.push(value), warn: value => logs.push(value) } });
  const address = await app.listen();
  t.after(async () => { await app.close(); store.close(); });
  const call = (path, init = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path, method: init.method ?? 'GET', headers: { host: 'imperfect.computer', ...init.headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const body = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) }); });
    });
    req.on('error', reject); req.end(init.body);
  });
  async function anonymous(path = '/account') {
    const page = await call(path);
    assert.equal(page.status, 200, page.body);
    const cookie = cookieOf(page, '__Host-imperfect_form');
    assert.ok(cookie); assert.ok(csrf(page));
    return { page, cookie, csrf: csrf(page) };
  }
  async function signup(username = 'alder', { name = 'A Person', email = '', password = PASSWORD, next = '/account', saved = true } = {}) {
    const form = await anonymous(`/account/signup?next=${encodeURIComponent(next)}`);
    const response = await call('/account/signup', post({ username, name, password, email, next, csrf: form.csrf }, form.cookie));
    assert.equal(response.status, 200, response.body);
    const cookie = cookieOf(response), codes = codesOf(response);
    assert.ok(cookie); assert.equal(codes.length, 8);
    if (saved) {
      const result = await call('/account/recovery/saved', post({ csrf: csrf(response), saved: 'yes', next }, cookie));
      assert.equal(result.status, 303, result.body);
    }
    return { cookie, codes, response, account: store.accountByUsername(username), password };
  }
  async function login(username = 'alder', password = PASSWORD, next = '/account', oldCookie = '') {
    const form = await anonymous(`/account?next=${encodeURIComponent(next)}`);
    const response = await call('/account/login', post({ username, password, next, csrf: form.csrf }, [form.cookie, oldCookie].filter(Boolean).join('; ')));
    return { response, cookie: cookieOf(response), form };
  }
  const page = cookie => call('/account', { headers: { cookie } });
  return { store, app, accounts, call, signup, login, anonymous, page, logs, now, advance: (ms = 60_000) => { at += ms; } };
}

function direct(accounts, path, init = {}, remoteAddress = '203.0.113.22') {
  const req = { method: init.method ?? 'GET', url: path, socket: { remoteAddress }, headers: { host: 'imperfect.computer', ...init.headers }, async *[Symbol.asyncIterator]() { if (init.body) yield Buffer.from(init.body); } };
  const res = { status: null, headers: {}, body: '', setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body ?? ''; } };
  return accounts.handle(req, res).then(() => res);
}

function resetLink(f, command = 'reset-password') {
  let output = '';
  operator(f.store, [command, 'alder'], { write(value) { output += value; } }, { base: BASE, now: f.now });
  const url = new URL(output.trim());
  assert.equal(url.origin, BASE); assert.equal(url.pathname, '/account/reset');
  const token = url.searchParams.get('token'); assert.equal(Buffer.from(token, 'base64url').length, 32);
  return { token, path: `${url.pathname}${url.search}` };
}

async function desktopCredentials(f, owner) {
  f.store.registerComputer({ username: owner.account.username, computerId: 'fixture-computer', state: 'ready' });
  const signed = await f.page(owner.cookie), verifier = nonce();
  const intent = { redirect_uri: 'http://127.0.0.1:54321/callback', state: nonce(), code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', device_name: 'Security fixture' };
  const code = async () => {
    const response = await f.call('/account/desktop/authorize', post({ ...intent, csrf: csrf(signed) }, owner.cookie));
    assert.equal(response.status, 303, response.body); return new URL(response.headers.location).searchParams.get('code');
  };
  const redeem = code => f.call('/account/desktop/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: intent.redirect_uri, code_verifier: verifier }) });
  const grant = await redeem(await code()); assert.equal(grant.status, 200, grant.body);
  return { ...grant.json(), pending: await code(), redeem };
}
async function assertDesktopRevoked(f, grant) {
  assert.equal(f.store.desktopAccess(digest(grant.accessToken)), null);
  const refresh = await f.call('/account/desktop/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }) });
  assert.equal(refresh.status, 401); assert.equal((await grant.redeem(grant.pending)).status, 401);
}

// Cryptographic tests include an actual historical record, not a mocked verifier.
test('scrypt hashes are salted/versioned, compare safely, reject corrupt records and upgrade historical work', async () => {
  const a = await hashPassword(PASSWORD), b = await hashPassword(PASSWORD);
  assert.notEqual(a, b); assert.doesNotMatch(a, /Silver/);
  assert.match(a, /^scrypt\$v2\$N=131072,r=8,p=1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.deepEqual(await verifyPassword(PASSWORD, a), { ok: true, needsUpgrade: false });
  assert.deepEqual(await verifyPassword('wrong but long password', a), { ok: false, needsUpgrade: false });
  const salt = randomBytes(16);
  const key = await promisify(nodeScrypt)(PASSWORD, salt, 32, { N: 16384, r: 8, p: 1 });
  const legacy = `scrypt$v1$N=16384,r=8,p=1$${salt.toString('hex')}$${key.toString('hex')}`;
  assert.deepEqual(await verifyPassword(PASSWORD, legacy), { ok: true, needsUpgrade: true });
  for (const record of [null, '', 'plaintext', a.replace('N=131072', 'N=999999'), a.replace('v2', 'v99')]) assert.deepEqual(await verifyPassword(PASSWORD, record), { ok: false, needsUpgrade: false });
  assert.equal(equal('same', 'same'), true); assert.equal(equal('same', 'different'), false);
  assert.equal(digest('fixture').length, 64);
});

test('login transparently upgrades a historical hash; a concurrent reset cannot reissue a stale session', async t => {
  const f = await boot(t), salt = randomBytes(16);
  const key = await promisify(nodeScrypt)(PASSWORD, salt, 32, { N: 16384, r: 8, p: 1 });
  const legacy = `scrypt$v1$N=16384,r=8,p=1$${salt.toString('hex')}$${key.toString('hex')}`;
  const account = f.store.createAccount({ username: 'alder', name: 'A Person', passwordHash: legacy }); f.store.markRecoverySaved(account.id);
  const login = await f.login(); assert.equal(login.response.status, 303);
  const upgraded = f.store.account(account.id).password_hash;
  assert.notEqual(upgraded, legacy); assert.deepEqual(await verifyPassword(PASSWORD, upgraded), { ok: true, needsUpgrade: false });
  const newHash = await hashPassword(NEW_PASSWORD), form = await f.anonymous();
  const blocker = hashPassword('Another unrelated long fixture passphrase');
  const pending = direct(f.accounts, '/account/login', post({ username: 'alder', password: PASSWORD, csrf: form.csrf }, form.cookie), '127.0.0.1');
  await tick();
  f.store.replacePassword(account.id, { expectedHash: upgraded, passwordHash: newHash });
  const result = await pending; await blocker;
  assert.equal(result.status, 400); assert.match(result.body, /Sign-in failed\. Try again\./); assert.equal(cookieOf(result), undefined);
  assert.equal(f.store.accountSession(digest(login.cookie.split('=')[1])), null);
});

test('password rules allow passphrases, enforce bounds, reject common passwords and folded username', () => {
  for (const password of [null, '', 'short', 'x'.repeat(257), 'password123', '1234567890', 'An ALDER password']) {
    assert.throws(() => validatePassword(password, 'alder'), error => error.status === 400 && (!password || !error.message.includes(String(password))));
  }
  for (const password of [PASSWORD, 'x'.repeat(256), 'é'.repeat(10)]) assert.doesNotThrow(() => validatePassword(password, 'alder'));
  const codes = generateRecoveryCodes(); assert.equal(codes.length, 8); assert.equal(new Set(codes).size, 8);
  for (const code of codes) { assert.match(code, /^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/); assert.equal(recoveryDigest(code).length, 64); assert.equal(recoveryDigest(code.toUpperCase().replaceAll('-', ' ')), recoveryDigest(code)); }
});

test('signup atomically claims a valid immutable username, escapes name and stores only hashes/unverified email', async t => {
  const root = await mkdtemp(join(tmpdir(), 'accounts-signup-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'locker.db'), f = await boot(t, { file });
  const owner = await f.signup('alder', { name: '<script>bad()</script>', email: 'same@example.invalid', saved: false });
  assert.match(owner.account.id, /^[0-9a-f-]{36}$/); assert.equal(owner.account.username, 'alder');
  assert.equal(owner.account.email, 'same@example.invalid'); assert.equal(owner.account.email_verified_at, null);
  assert.equal(owner.account.recovery_saved_at, null);
  const page = await f.page(owner.cookie); assert.doesNotMatch(page.body, /<script>bad/);
  for (const code of owner.codes) assert.ok(!page.body.includes(code), 'recovery codes never redisplayed');
  const db = new DatabaseSync(file);
  const stored = JSON.stringify(['accounts', 'account_sessions'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  const recoveryTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%recovery%'").all();
  const recoveries = JSON.stringify(recoveryTables.map(({ name }) => db.prepare(`SELECT * FROM ${name}`).all()));
  for (const secret of [PASSWORD, ...owner.codes, owner.cookie.split('=')[1]]) assert.ok(!`${stored}${recoveries}`.includes(secret));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('oauth_states', 'account_identities')").get().n, 0);
  db.close();
  assert.equal((await f.call('/account/recovery/saved', post({ csrf: csrf(owner.response), next: '/account' }, owner.cookie))).status, 400);
  assert.equal((await f.call('/account/recovery/saved', post({ csrf: csrf(owner.response), saved: 'yes', next: '/account' }, owner.cookie))).status, 303);
  assert.ok(f.store.account(owner.account.id).recovery_saved_at);
  const accountPage = await f.page(owner.cookie); assert.match(accountPage.body, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  const other = await f.signup('birch', { email: 'same@example.invalid' });
  assert.notEqual(other.account.id, owner.account.id, 'email never links accounts');
  const emailLogin = await f.login('same@example.invalid'); assert.equal(emailLogin.response.status, 400); assert.match(emailLogin.response.body, /Sign-in failed\. Try again\./);
  assert.deepEqual(f.logs, []);
});

test('signup rejects reserved/invalid/colliding usernames, missing name, bad password/email and concurrent collision', async t => {
  const f = await boot(t), form = await f.anonymous('/account/signup');
  const data = { username: 'alder', name: 'A Person', password: PASSWORD, csrf: form.csrf };
  for (const username of ['AlDer', 'ab', '-alder', 'alder-', 'a'.repeat(21), 'a_b', 'www', 'store', 'demo', 'mail', 'admin', 'api', 'noah', 'locus', 'vaita']) {
    f.advance(); const current = await f.anonymous('/account/signup');
    assert.equal((await f.call('/account/signup', post({ ...data, username, csrf: current.csrf }, current.cookie))).status, 400, username);
  }
  for (const extra of [{ name: '' }, { password: 'short' }, { password: 'password123' }, { password: 'This has ALDER in it' }, { email: 'not-an-email' }]) {
    f.advance(); const current = await f.anonymous('/account/signup');
    assert.equal((await f.call('/account/signup', post({ ...data, ...extra, csrf: current.csrf }, current.cookie))).status, 400, JSON.stringify(extra));
  }
  f.advance(); const a = await f.anonymous('/account/signup'), b = await f.anonymous('/account/signup');
  const results = await Promise.all([a, b].map(current => f.call('/account/signup', post({ ...data, csrf: current.csrf }, current.cookie))));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.match(results.find(r => r.status === 409).body, /username.*taken/i);
  assert.ok(RESERVED_USERNAMES.has('noah')); assert.equal(f.store.accountByUsername('alder').name, 'A Person');
});

test('every browser POST requires exact canonical Origin and CSRF; anonymous forms bind browser and expire', async t => {
  const f = await boot(t), owner = await f.signup(), signed = await f.page(owner.cookie);
  const anonymous = await f.anonymous('/account/signup');
  const routes = [
    ['/account/signup', { username: 'birch', name: 'Birch', password: PASSWORD }, anonymous],
    ['/account/login', { username: 'alder', password: PASSWORD }, anonymous],
    ['/account/recover', { username: 'alder', code: owner.codes[0], password: NEW_PASSWORD }, anonymous],
    ['/account/reset', { token: resetLink(f).token, password: NEW_PASSWORD }, anonymous],
    ['/account/recovery/saved', { saved: 'yes' }, { cookie: owner.cookie, csrf: csrf(signed) }],
    ['/account/password', { current_password: PASSWORD, password: NEW_PASSWORD }, { cookie: owner.cookie, csrf: csrf(signed) }],
    ['/account/recovery/regenerate', { current_password: PASSWORD }, { cookie: owner.cookie, csrf: csrf(signed) }],
    ['/account/logout', {}, { cookie: owner.cookie, csrf: csrf(signed) }],
    ['/account/logout-everywhere', {}, { cookie: owner.cookie, csrf: csrf(signed) }],
  ];
  for (const [path, data, session] of routes) {
    for (const origin of ['', 'null', 'https://evil.invalid', 'https://www.imperfect.computer', 'http://imperfect.computer', 'https://imperfect.computer:444']) {
      assert.equal((await f.call(path, post({ ...data, csrf: session.csrf }, session.cookie, origin))).status, 403, `${path} ${origin}`);
    }
    for (const bad of [undefined, 'wrong']) assert.equal((await f.call(path, post({ ...data, ...(bad ? { csrf: bad } : {}) }, session.cookie))).status, 403, path);
    f.advance();
  }
  const formA = await f.anonymous(), formB = await f.anonymous();
  assert.equal((await f.call('/account/login', post({ username: 'alder', password: PASSWORD, csrf: formA.csrf }, formB.cookie))).status, 403);
  assert.equal((await f.call('/account/login', post({ username: 'alder', password: PASSWORD, csrf: formA.csrf }, `${formA.cookie}; ${formA.cookie}`))).status, 403);
  f.advance(15 * 60_000);
  assert.equal((await f.call('/account/login', post({ username: 'alder', password: PASSWORD, csrf: formA.csrf }, formA.cookie))).status, 403);
});

test('login failures are generic; successful login rotates sessions/cookies and unsafe continuation fails closed', async t => {
  const f = await boot(t), owner = await f.signup();
  const wrong = await f.login('alder', 'wrong password value'), unknown = await f.login('unknown-person', 'wrong password value');
  for (const result of [wrong, unknown]) { assert.equal(result.response.status, 400); assert.match(result.response.body, /Sign-in failed\. Try again\./); assert.doesNotMatch(result.response.body, /wrong password value|unknown-person|password_hash/); assert.equal(result.cookie, undefined); }
  const signed = await f.login('alder', PASSWORD, '/account', owner.cookie);
  assert.equal(signed.response.status, 303); assert.equal(signed.response.headers.location, '/account'); assert.notEqual(signed.cookie, owner.cookie);
  const sessionHeader = signed.response.headers['set-cookie'].find(c => c.startsWith('__Host-imperfect_account='));
  assert.match(sessionHeader, /; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/); assert.doesNotMatch(sessionHeader, /Domain=/i);
  const formHeader = signed.form.page.headers['set-cookie'].find(c => c.startsWith('__Host-imperfect_form='));
  assert.match(formHeader, /HttpOnly; Secure; SameSite=Lax$/); assert.doesNotMatch(formHeader, /Domain=/i);
  assert.equal(signed.response.headers['cache-control'], 'no-store');
  assert.equal(f.store.accountSession(digest(owner.cookie.split('=')[1])), null, 'pre-login session removed');
  for (const next of ['//evil.invalid', '/\\evil.invalid', 'https://evil.invalid', '/unexpected']) {
    f.advance(); const result = await f.login('alder', PASSWORD, next); assert.equal(result.response.headers.location, '/account');
  }
  const intent = `/account/computer?computer=fixture&nonce=${nonce()}`;
  f.advance(); assert.equal((await f.login('alder', PASSWORD, intent)).response.headers.location, intent);
  assert.equal((await f.call('/account', { headers: { host: 'www.imperfect.computer' } })).status, 400);
  assert.deepEqual(f.logs, []);
});

test('username throttle is normalized, independent of spoofed address; address/global budgets expire with Retry-After', async t => {
  const f = await boot(t), form = await f.anonymous();
  for (let i = 0; i < 5; i++) {
    const result = await f.call('/account/login', { ...post({ username: i % 2 ? 'ALDER' : 'alder', password: PASSWORD, csrf: form.csrf }, form.cookie), headers: { ...post({}, form.cookie).headers, 'cf-connecting-ip': `198.51.100.${i + 1}` } });
    assert.equal(result.status, 400);
  }
  const sixth = await f.call('/account/login', post({ username: ' alder ', password: PASSWORD, csrf: form.csrf }, form.cookie));
  assert.equal(sixth.status, 429); assert.ok(Number(sixth.headers['retry-after']) > 0);
  f.advance(); const current = await f.anonymous();
  assert.equal((await f.call('/account/login', post({ username: 'alder', password: PASSWORD, csrf: current.csrf }, current.cookie))).status, 400);
  // An untrusted remote peer cannot obtain new address budgets by forging tunnel headers.
  f.advance();
  const budgetForm = await f.anonymous('/account/signup');
  const invalid = post({ username: 'birch', name: 'Birch', password: 'short', csrf: budgetForm.csrf }, budgetForm.cookie);
  for (let i = 0; i < 30; i++) assert.equal((await direct(f.accounts, '/account/signup', { ...invalid, headers: { ...invalid.headers, 'cf-connecting-ip': `192.0.2.${i + 1}` } })).status, 400);
  const address = await direct(f.accounts, '/account/signup', { ...invalid, headers: { ...invalid.headers, 'cf-connecting-ip': '192.0.2.222' } });
  assert.equal(address.status, 429); assert.ok(Number(address.headers['retry-after']) > 0);
  f.advance();
  for (let i = 0; i < 300; i++) assert.equal((await direct(f.accounts, '/account/signup', invalid, `198.51.${Math.floor(i / 250)}.${i % 250 + 1}`)).status, 400);
  assert.equal((await direct(f.accounts, '/account/signup', invalid, '203.0.113.99')).status, 429);
  f.advance(); assert.equal((await direct(f.accounts, '/account/signup', invalid, '203.0.113.99')).status, 400);
});

test('recovery codes reset without autologin, consume once even concurrently, revoke sessions and reject replay generically', async t => {
  const f = await boot(t), owner = await f.signup(), second = await f.login(), desktop = await desktopCredentials(f, owner);
  const forms = await Promise.all([f.anonymous('/account/recover'), f.anonymous('/account/recover')]);
  const results = await Promise.all(forms.map(form => f.call('/account/recover', post({ username: 'alder', code: owner.codes[0], password: NEW_PASSWORD, csrf: form.csrf }, form.cookie))));
  assert.deepEqual(results.map(r => r.status).sort(), [303, 400]);
  const success = results.find(r => r.status === 303); assert.equal(success.headers.location, '/account'); assert.equal(cookieOf(success), undefined);
  for (const cookie of [owner.cookie, second.cookie]) assert.equal(f.store.accountSession(digest(cookie.split('=')[1])), null);
  await assertDesktopRevoked(f, desktop);
  const replayForm = await f.anonymous('/account/recover');
  const replay = await f.call('/account/recover', post({ username: 'alder', code: owner.codes[0], password: PASSWORD, csrf: replayForm.csrf }, replayForm.cookie));
  assert.equal(replay.status, 400); assert.match(replay.body, /Recovery failed\. Try again\./); assert.ok(!replay.body.includes(owner.codes[0]));
  f.advance(); assert.equal((await f.login('alder', PASSWORD)).response.status, 400); assert.equal((await f.login('alder', NEW_PASSWORD)).response.status, 303);
  assert.deepEqual(f.logs, []);
});

test('unknown username, wrong recovery code and invalid new password give the same safe recovery failure', async t => {
  const f = await boot(t), owner = await f.signup();
  const messages = [];
  for (const values of [{ username: 'alder', code: 'wrong-code', password: NEW_PASSWORD }, { username: 'unknown-person', code: owner.codes[0], password: NEW_PASSWORD }, { username: 'alder', code: owner.codes[0], password: 'short' }]) {
    const form = await f.anonymous('/account/recover');
    const result = await f.call('/account/recover', post({ ...values, csrf: form.csrf }, form.cookie));
    assert.equal(result.status, 400); messages.push(/role="alert">([^<]+)</.exec(result.body)?.[1]);
    for (const secret of [values.code, values.password]) assert.ok(!result.body.includes(secret));
  }
  assert.deepEqual(messages, Array(3).fill('Recovery failed. Try again.')); assert.deepEqual(f.logs, []);
});

test('operator password reset links are hashed, expire after 24h and atomic under replay/concurrency', async t => {
  const f = await boot(t), owner = await f.signup(), desktop = await desktopCredentials(f, owner);
  const expired = resetLink(f); assert.equal(f.store.resetToken(digest(expired.token)).purpose, 'password');
  f.advance(86400_000); assert.equal(f.store.resetToken(digest(expired.token)), null);
  const expiredPage = await f.call(expired.path); assert.equal(expiredPage.status, 400); assert.ok(!expiredPage.body.includes(expired.token));
  const active = resetLink(f), forms = await Promise.all([f.anonymous(active.path), f.anonymous(active.path)]);
  const result = await Promise.all(forms.map(form => f.call('/account/reset', post({ token: active.token, password: NEW_PASSWORD, csrf: form.csrf }, form.cookie))));
  assert.deepEqual(result.map(r => r.status).sort(), [303, 400]); assert.equal(f.store.resetToken(digest(active.token)), null);
  assert.equal(f.store.accountSession(digest(owner.cookie.split('=')[1])), null);
  await assertDesktopRevoked(f, desktop);
  assert.equal((await f.call(active.path)).status, 400);
  assert.equal((await f.login('alder', NEW_PASSWORD)).response.status, 303);
  assert.deepEqual(f.logs, []);
});

test('password changes keep current session, revoke other sessions; recovery regeneration replaces eight codes once', async t => {
  const f = await boot(t), owner = await f.signup(), other = await f.login(), page = await f.page(owner.cookie), desktop = await desktopCredentials(f, owner);
  const bad = await f.call('/account/password', post({ current_password: 'wrong password value', password: NEW_PASSWORD, csrf: csrf(page) }, owner.cookie));
  assert.equal(bad.status, 400); assert.equal(f.store.accountSession(digest(other.cookie.split('=')[1])).account_id, owner.account.id);
  const changed = await f.call('/account/password', post({ current_password: PASSWORD, password: NEW_PASSWORD, csrf: csrf(page) }, owner.cookie));
  assert.equal(changed.status, 303); assert.equal(changed.headers.location, '/account');
  const currentCookie = cookieOf(changed) ?? owner.cookie;
  assert.ok(f.store.accountSession(digest(currentCookie.split('=')[1]))); assert.equal(f.store.accountSession(digest(other.cookie.split('=')[1])), null);
  await assertDesktopRevoked(f, desktop);
  const fresh = await f.page(currentCookie);
  assert.equal((await f.call('/account/recovery/regenerate', post({ current_password: PASSWORD, csrf: csrf(fresh) }, currentCookie))).status, 400);
  const regen = await f.call('/account/recovery/regenerate', post({ current_password: NEW_PASSWORD, csrf: csrf(fresh) }, currentCookie));
  assert.equal(regen.status, 200); const codes = codesOf(regen); assert.equal(codes.length, 8);
  for (const code of codes) assert.ok(!owner.codes.includes(code));
  const later = await f.page(currentCookie); for (const code of codes) assert.ok(!later.body.includes(code));
  f.advance(); const recover = await f.anonymous('/account/recover');
  assert.equal((await f.call('/account/recover', post({ username: 'alder', code: owner.codes[1], password: PASSWORD, csrf: recover.csrf }, recover.cookie))).status, 400);
  const link = resetLink(f, 'regenerate-codes'), resetForms = await Promise.all([f.anonymous(link.path), f.anonymous(link.path)]);
  const resets = await Promise.all(resetForms.map(reset => f.call('/account/reset', post({ token: link.token, csrf: reset.csrf }, reset.cookie))));
  assert.deepEqual(resets.map(r => r.status).sort(), [200, 400]);
  const resetCodes = resets.find(r => r.status === 200);
  assert.equal(codesOf(resetCodes).length, 8); assert.equal(f.store.resetToken(digest(link.token)), null);
  assert.equal(f.store.accountSession(digest(currentCookie.split('=')[1])), null, 'operator codes reset revokes old sessions');
  assert.equal(f.store.account(owner.account.id).recovery_saved_at, null);
  assert.equal((await f.call('/account/recovery/saved', post({ csrf: csrf(resetCodes), saved: 'yes' }, cookieOf(resetCodes)))).status, 303);
  assert.equal((await f.call(link.path)).status, 400);
});

test('logout-everywhere revokes all store sessions; signed crypto mutations cannot complete after concurrent logout', async t => {
  const f = await boot(t), owner = await f.signup(), other = await f.login(), page = await f.page(owner.cookie);
  assert.equal((await f.call('/account/logout-everywhere', post({ csrf: csrf(page) }, owner.cookie))).status, 303);
  for (const cookie of [owner.cookie, other.cookie]) assert.equal(f.store.accountSession(digest(cookie.split('=')[1])), null);
  for (const path of ['/account/password', '/account/recovery/regenerate']) {
    f.advance(); const current = await f.login(), signed = await f.page(current.cookie);
    const before = f.store.account(owner.account.id).password_hash;
    // Scrypt's queued await must not retain authorization after another request logs out.
    const blocker = hashPassword('Another unrelated long fixture passphrase');
    const pending = direct(f.accounts, path, post({ current_password: PASSWORD, password: NEW_PASSWORD, csrf: csrf(signed) }, current.cookie), '127.0.0.1');
    await tick();
    assert.equal((await f.call('/account/logout', post({ csrf: csrf(signed) }, current.cookie))).status, 303);
    const result = await pending; await blocker;
    assert.equal(result.status, 403, path); assert.equal(f.store.account(owner.account.id).password_hash, before);
  }
});

test('password change rechecks authorization after both verification and new-password hashing', async t => {
  const f = await boot(t), owner = await f.signup(), signed = await f.page(owner.cookie);
  let notify, reads = 0;
  const verified = new Promise(resolve => { notify = resolve; });
  const original = f.store.accountSession;
  f.store.accountSession = (...args) => {
    const row = original(...args);
    // Session lookup, initial CSRF validation, then post-verification validation.
    if (++reads === 3) notify();
    return row;
  };
  const pending = direct(f.accounts, '/account/password', post({ current_password: PASSWORD, password: NEW_PASSWORD, csrf: csrf(signed) }, owner.cookie), '127.0.0.1');
  await verified; f.store.accountSession = original;
  assert.equal((await f.call('/account/logout', post({ csrf: csrf(signed) }, owner.cookie))).status, 303);
  const result = await pending; assert.equal(result.status, 403);
  assert.deepEqual(await verifyPassword(PASSWORD, f.store.account(owner.account.id).password_hash), { ok: true, needsUpgrade: false });
});

test('operator registry is idempotent and immutable; only ready owner gets exact Ed25519 assertion and CSP', async t => {
  const f = await boot(t), g = await f.signup();
  const registration = { username: 'alder', computerId: 'fixture-computer', state: 'provisioning', origin: 'https://evil.invalid', owner: 'attacker' };
  assert.equal((await f.call('/api/accounts/computers', jsonPost(registration, 'wrong'))).status, 401);
  const first = await f.call('/api/accounts/computers', jsonPost(registration)); assert.equal(first.status, 200);
  assert.deepEqual(first.json(), { computerId: 'fixture-computer', username: 'alder', state: 'provisioning', origin: 'https://alder.imperfect.computer', owner: g.account.id, store: BASE, publicKey: f.accounts.publicKey });
  assert.deepEqual((await f.call('/api/accounts/computers', jsonPost(registration))).json(), first.json());
  assert.deepEqual((await f.call('/api/accounts/computers/alder', { headers: { authorization: `Bearer ${operatorToken}` } })).json(), first.json());
  assert.equal((await f.call('/api/accounts/computers', jsonPost({ ...registration, computerId: 'replacement' }))).status, 409);
  const challenge = nonce(), path = `/account/computer?computer=fixture-computer&nonce=${challenge}&callback=https://evil.invalid`;
  const signed = () => f.call(path, { headers: { cookie: g.cookie } }); assert.equal((await signed()).status, 403);
  for (const state of ['stopped', 'failed']) { assert.equal((await f.call('/api/accounts/computers', jsonPost({ ...registration, state }))).status, 200); assert.equal((await signed()).status, 403); }
  assert.equal((await f.call('/api/accounts/computers', jsonPost({ ...registration, state: 'ready' }))).status, 200);
  const result = await signed(); assert.equal(result.status, 200);
  assert.match(result.headers['content-security-policy'], /form-action https:\/\/alder\.imperfect\.computer;/);
  assert.match(result.body, /action="https:\/\/alder\.imperfect\.computer\/door\/callback"/); assert.doesNotMatch(result.body, /evil.invalid/);
  const assertion = /name="assertion" value="([^"]+)"/.exec(result.body)[1], [head, payload, signature] = assertion.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'EdDSA', typ: 'JWT' });
  assert.ok(verify(null, Buffer.from(`${head}.${payload}`), createPublicKey(f.accounts.publicKey), Buffer.from(signature, 'base64url')));
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'nonce', 'sub']);
  assert.equal(claims.iss, BASE); assert.equal(claims.aud, registration.computerId); assert.equal(claims.sub, g.account.id);
  assert.equal(claims.exp - claims.iat, 60); assert.equal(claims.nonce, challenge); assert.equal(Buffer.from(claims.jti, 'base64url').length, 32);
  const other = await f.signup('birch'); assert.equal((await f.call(path, { headers: { cookie: other.cookie } })).status, 403);
  assert.equal((await f.call('/api/accounts/computers', jsonPost({ ...registration, username: 'birch' }))).status, 409);
  assert.equal((await f.call('/api/accounts/computers', jsonPost({ ...registration, state: 'unknown' }))).status, 400);
});

test('sessions are hashed, persist across reopening, expire; no signer/operator does not disable password accounts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'accounts-persist-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'locker.db'), f = await boot(t, { file, accountConfig: { base: BASE } }), owner = await f.signup();
  const token = owner.cookie.split('=')[1], db = new DatabaseSync(file), rows = db.prepare('SELECT * FROM account_sessions').all();
  assert.equal(rows.length, 1); assert.equal(rows[0].token_hash, digest(token)); assert.notEqual(rows[0].token_hash, token); db.close();
  const reopened = openStore(file, { now: f.now }); assert.equal(reopened.accountSession(digest(token)).account_id, owner.account.id); reopened.close();
  assert.equal((await f.call('/api/accounts/computers', jsonPost({}))).status, 401);
  assert.throws(() => createAccounts({ store: f.store, config: { base: 'http://imperfect.computer' } }), /HTTPS/);
  assert.throws(() => createAccounts({ store: f.store, config: { base: `${BASE}/` } }), /canonical/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }); assert.throws(() => createAccounts({ store: f.store, config: { base: BASE, signerPrivateKey: rsa.privateKey } }), /Ed25519/);
  f.advance(30 * 86400_000); assert.equal(f.store.accountSession(digest(token)), null);
});
