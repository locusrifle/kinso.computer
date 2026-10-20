import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { launchChromium } from '../../tools/test-browser.mjs';
import { openStore } from '../store.mjs';
import { createAccounts } from '../accounts.mjs';
import { hashPassword, recoveryDigest } from '../passwords.mjs';
import { createLockerServer } from '../server.mjs';
import { STORE, COMPUTER, random, jwt, httpsProxy, startDoor, listen, close } from './accounts-browser-fixture.mjs';

// This intentionally runs the real OS door, not a JavaScript approximation.
// For another checkout set ACCOUNTS_DOOR_SOURCE and ACCOUNTS_DOOR_PYTHON to the
// OS modules/door/door.py and its Python with cryptography + python-pam.
const source = process.env.ACCOUNTS_DOOR_SOURCE || fileURLToPath(new URL('../../../os/modules/door/door.py', import.meta.url));
const python = process.env.ACCOUNTS_DOOR_PYTHON || 'python3';
const operator = 'throwaway-fixture-operator-token';
const form = values => new URLSearchParams(values).toString();
const cookie = response => response.headers['set-cookie']?.map(value => value.split(';')[0]).join('; ') || '';
function secureHostOnly(cookies, name, domain) {
  const found = cookies.find(c => [name, `__Host-${name}`].includes(c.name) && c.domain === domain);
  assert.ok(found, `${name} belongs only to ${domain}`);
  assert.ok(found.name.startsWith('__Host-'), 'production security cookies cannot be tossed from a sibling host');
  assert.equal(found.secure, true);
  assert.equal(found.httpOnly, true);
  assert.equal(found.path, '/');
  assert.ok(!found.domain.startsWith('.'));
  return found;
}

const PASSWORD = 'Quiet rivers carry silver lanterns';
const CHANGED_PASSWORD = 'Gentle winds scatter copper feathers';
const RECOVERED_PASSWORD = 'Distant mountains shelter violet gardens';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'accounts-browser-'));
  const store = openStore();
  const signer = generateKeyPairSync('ed25519');
  const logs = [];
  const accounts = createAccounts({ store, config: { base: STORE,
    signerPrivateKey: signer.privateKey, operatorToken: operator,
  }, codeSentence: key => `install imperfect: git clone https://buyer:${key}@imperfect.computer/imperfect.git ~/imperfect` });
  let app, proxy, browser, storeStopped = false;
  t.after(async () => {
    await browser?.close();
    if (proxy) await close(proxy.server);
    if (app && !storeStopped) await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  app = await createLockerServer({ store, accounts, mail: { configured: false },
    config: { hosts: 'imperfect.computer', secure: true }, port: 0,
    log: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...values) => logs.push(JSON.stringify(values))])),
  });
  proxy = await httpsProxy(root, python, (await app.listen()).port);
  browser = await launchChromium({ headless: true,
    args: ['--no-sandbox', '--no-proxy-server', '--disable-background-networking',
      `--host-resolver-rules=MAP *.imperfect.computer 127.0.0.1:${proxy.port}, MAP imperfect.computer 127.0.0.1:${proxy.port}`],
  });
  const observedCookies = new WeakMap();
  const newContext = async (width = 1200, extraOrigins = []) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const observations = new Map(); observedCookies.set(context, observations);
    // Every page request is allowlisted to these loopback fixtures. Never
    // contact a real account, mail service, computer or external asset host.
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (![STORE, COMPUTER, ...extraOrigins].includes(url.origin)) return route.abort('blockedbyclient');
      const headers = await route.request().allHeaders();
      const names = observations.get(url.origin) || new Set();
      for (const part of (headers.cookie || '').split(';')) if (part) names.add(part.trim().split('=')[0]);
      observations.set(url.origin, names);
      return route.continue();
    });
    return context;
  };
  return { root, store, signer, accounts, proxy, newContext, observedCookies, logs,
    async stopStore() { await app.close(); storeStopped = true; },
  };
}

async function submit(page, action) {
  const response = page.waitForResponse(r => r.url() === `${STORE}${action}` && r.request().method() === 'POST');
  await page.locator(`form[action="${action}"] button[type="submit"]`).click();
  return response;
}
async function fillSignup(page, username, name, password = PASSWORD, email = '') {
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="name"]').fill(name);
  await page.locator('input[name="password"]').fill(password);
  if (email) await page.locator('input[name="email"]').fill(email);
}
async function saveCodes(page, next = '/account') {
  await page.locator('input[name="saved"][value="yes"]').check();
  assert.equal((await submit(page, '/account/recovery/saved')).status(), 303);
  await page.waitForURL(`${STORE}${next}`);
}
async function signup(page, username, name, next = '/account') {
  await page.goto(`${STORE}/account/signup?next=${encodeURIComponent(next)}`);
  await fillSignup(page, username, name);
  assert.equal((await submit(page, '/account/signup')).status(), 200);
  const codes = await page.locator('code').allTextContents();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  await saveCodes(page, next);
  return codes;
}
async function login(page, username, password = PASSWORD, next = '/account') {
  await page.goto(`${STORE}/account?next=${encodeURIComponent(next)}`);
  await page.locator('form[action="/account/login"] input[name="username"]').fill(username);
  await page.locator('form[action="/account/login"] input[name="password"]').fill(password);
  assert.equal((await submit(page, '/account/login')).status(), 303);
  await page.waitForURL(`${STORE}${next}`);
}
async function logout(page) {
  assert.equal((await submit(page, '/account/logout')).status(), 303);
  await page.waitForURL(`${STORE}/account`);
  await page.locator('form[action="/account/login"]').waitFor();
}

for (const width of [390, 1200]) test(`Own password account lifecycle at ${width}px: signup, saved codes, signin, password change and recovery`, { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const owner = await f.newContext(width);
  const page = await owner.newPage(); page.setDefaultTimeout(10_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${STORE}/account/signup?next=${encodeURIComponent('https://evil.invalid/')}`);
  const anonymous = secureHostOnly(await owner.cookies(), '__Host-imperfect_form', 'imperfect.computer');
  assert.equal(anonymous.sameSite, 'Lax');
  assert.equal(await page.locator('input[name="username"]').inputValue(), '');
  assert.equal(await page.locator('input[name="name"]').inputValue(), '');
  await fillSignup(page, 'admin', 'Alder Person');
  assert.equal((await submit(page, '/account/signup')).status(), 400, 'reserved username rejected');
  const username = `alder${width}`;
  const name = 'Alder <script>window.accountInjected=true</script> Person';
  await fillSignup(page, username, name, PASSWORD, 'receipt@example.invalid');
  const signupResponse = await submit(page, '/account/signup');
  assert.equal(signupResponse.status(), 200, 'codes are a direct POST response, not a retrieval endpoint');
  const codes = await page.locator('code').allTextContents();
  assert.equal(codes.length, 8); assert.equal(new Set(codes).size, 8);
  assert.match(signupResponse.headers()['cache-control'], /no-store/);
  const account = f.store.accountByUsername(username);
  assert.ok(account); assert.equal(account.name, name);
  assert.equal(account.email, 'receipt@example.invalid', 'optional email is metadata, not the account identity');
  assert.match(account.id, /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(account).includes(PASSWORD), 'no plaintext password in account storage');
  const initialSession = secureHostOnly(await owner.cookies(), '__Host-imperfect_account', 'imperfect.computer');
  assert.equal(initialSession.sameSite, 'Lax');
  for (const code of codes) {
    assert.ok(f.store.recoveryAvailable(account.id, recoveryDigest(code)));
    assert.equal(f.store.recoveryAvailable(account.id, code), null, 'only recovery code digests are stored');
  }
  // An unchecked POST cannot claim the codes were saved. Keep the original
  // direct response in the browser: the server cannot redisplay lost codes.
  const unchecked = await f.proxy.call(STORE, '/account/recovery/saved', { method: 'POST', headers: {
    origin: STORE, cookie: `${initialSession.name}=${initialSession.value}`, 'content-type': 'application/x-www-form-urlencoded',
  }, body: form({ csrf: await page.locator('input[name="csrf"]').inputValue(), next: '/account' }) });
  assert.equal(unchecked.status, 400);
  assert.equal(f.store.account(account.id).recovery_saved_at, null);
  await saveCodes(page); // untrusted next must stay on the store
  assert.ok(f.store.account(account.id).recovery_saved_at);
  assert.match(await page.textContent('body'), new RegExp(`${username}\\.imperfect\\.computer`));
  // Signing up gives no legacy membership key; public GitHub clones need no key.
  assert.doesNotMatch(await page.textContent('body'), /your copy of the code|git clone/);
  assert.equal(await page.evaluate(() => window.accountInjected), undefined, 'display name is HTML-escaped');
  for (const code of codes) assert.ok(!(await page.textContent('body')).includes(code), 'codes shown once, absent from account page');
  const duplicate = await f.newContext(width); const duplicatePage = await duplicate.newPage();
  await duplicatePage.goto(`${STORE}/account/signup`);
  await fillSignup(duplicatePage, username, 'Another Person');
  assert.equal((await submit(duplicatePage, '/account/signup')).status(), 409, 'claimed username cannot be taken');
  assert.equal(f.store.accountByUsername(username).id, account.id);
  await duplicate.close();
  await logout(page);
  assert.equal((await owner.cookies()).some(c => c.name === '__Host-imperfect_account'), false);
  await login(page, username);
  const signedIn = secureHostOnly(await owner.cookies(), '__Host-imperfect_account', 'imperfect.computer');
  assert.notEqual(signedIn.value, initialSession.value, 'signin rotates the session');
  const other = await f.newContext(width); const otherPage = await other.newPage();
  await login(otherPage, username);
  await page.locator('form[action="/account/password"] input[name="current_password"]').fill(PASSWORD);
  await page.locator('form[action="/account/password"] input[name="password"]').fill(CHANGED_PASSWORD);
  assert.equal((await submit(page, '/account/password')).status(), 303);
  await page.waitForURL(`${STORE}/account`);
  await otherPage.goto(`${STORE}/account`);
  assert.equal(await otherPage.locator('form[action="/account/login"]').count(), 1, 'change password revokes other account sessions');
  await logout(page);
  await page.goto(`${STORE}/account/recover`);
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="code"]').fill(codes[0]);
  await page.locator('input[name="password"]').fill(RECOVERED_PASSWORD);
  assert.equal((await submit(page, '/account/recover')).status(), 303);
  await page.waitForURL(`${STORE}/account`);
  assert.equal(await page.locator('form[action="/account/login"]').count(), 1, 'recovery resets password without signing in');
  assert.equal((await owner.cookies()).some(c => c.name === '__Host-imperfect_account'), false);
  await login(page, username, RECOVERED_PASSWORD);
  await page.reload();
  for (const code of codes) assert.ok(!(await page.textContent('body')).includes(code));
  assert.deepEqual(errors, []);
  for (const secret of [PASSWORD, CHANGED_PASSWORD, RECOVERED_PASSWORD, ...codes]) assert.ok(!f.logs.join('\n').includes(secret), 'server never logs credentials');
});

test('Password account → own HTTPS computer: onboarding, provisioning, browser binding, offline sessions and rejected assertions', { timeout: 120_000 }, async t => {
  try { await access(source); }
  catch (error) {
    if (process.env.ACCOUNTS_DOOR_SOURCE) throw error;
    t.skip('requires the OS checkout: set ACCOUNTS_DOOR_SOURCE and ACCOUNTS_DOOR_PYTHON');
    return;
  }
  const f = await fixture(t);
  const { root, store, signer, accounts, proxy, newContext, observedCookies } = f;
  let door;
  t.after(async () => { await door?.stop(); });
  const owner = await newContext();
  const page = await owner.newPage(); page.setDefaultTimeout(10_000);
  await signup(page, 'alder', 'Alder Person');
  secureHostOnly(await owner.cookies(), '__Host-imperfect_account', 'imperfect.computer');
  const account = store.accountByUsername('alder');
  assert.equal(account.name, 'Alder Person');
  assert.match(account.id, /^[0-9a-f-]{36}$/);
  const other = await newContext(); const otherPage = await other.newPage(); otherPage.setDefaultTimeout(10_000);
  await signup(otherPage, 'birch', 'Another Person');
  assert.notEqual(store.accountByUsername('birch').id, account.id);

  const provision = async (state, auth = operator) => proxy.call(STORE, '/api/accounts/computers', {
    method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alder', computerId: 'fixture-computer', state }),
  });
  assert.equal((await provision('ready', 'wrong-fixture-token')).status, 401);
  const registered = await provision('provisioning'); assert.ok([200, 201].includes(registered.status));
  const ready = await provision('ready'); assert.ok([200, 201].includes(ready.status));
  const registry = JSON.parse(ready.body);
  assert.equal(registry.origin, COMPUTER); assert.equal(registry.owner, account.id);
  assert.equal(registry.store, STORE); assert.equal(registry.computerId, 'fixture-computer');
  assert.equal(registry.publicKey, accounts.publicKey);
  await page.goto(`${STORE}/account`);
  assert.match(await page.textContent('body'), /alder\.imperfect\.computer/);
  assert.match(await page.textContent('body'), /ready/);
  const fetched = await proxy.call(STORE, '/api/accounts/computers/alder', { headers: { authorization: `Bearer ${operator}` } });
  assert.equal(fetched.status, 200); assert.deepEqual(JSON.parse(fetched.body), registry);
  const restartDoor = async () => {
    if (door) await door.stop();
    door = await startDoor({ root, python, source, registry }); proxy.setDoorPort(door.port);
  };
  await restartDoor();
  await logout(page);
  await page.goto(`${COMPUTER}/work?fixture=yes`);
  const doorLogin = page.locator('form[action="/account/login"]');
  await doorLogin.waitFor();
  const doorNext = await doorLogin.locator('input[name="next"]').inputValue();
  assert.ok(doorNext.startsWith('/account/computer?'), 'door challenge is preserved through password signin');
  await doorLogin.locator('input[name="username"]').fill('alder');
  await doorLogin.locator('input[name="password"]').fill(PASSWORD);
  assert.equal((await submit(page, '/account/login')).status(), 303);
  await page.waitForURL(`${STORE}${doorNext}`);
  await page.locator('input[name="assertion"]').waitFor({ state: 'attached' });
  assert.equal(new URL(page.url()).origin, STORE);
  const issued = await page.locator('input[name="assertion"]').inputValue();
  const challengeCookie = secureHostOnly(await owner.cookies(), 'imperfect_door_challenge', 'alder.imperfect.computer');
  // Neither store's account cookie nor the door's challenge has sibling scope.
  // Inspect actual request headers: Playwright cookies(url) approximates
  // domain matching and does not distinguish host-only parent cookies.
  assert.equal(observedCookies.get(owner).get(COMPUTER).has('__Host-imperfect_account'), false);
  assert.equal(observedCookies.get(owner).get(STORE).has(challengeCookie.name), false);
  const noCookie = await proxy.call(COMPUTER, '/door/callback', { method: 'POST',
    headers: { origin: STORE, 'content-type': 'application/x-www-form-urlencoded' }, body: form({ assertion: issued }) });
  assert.equal(noCookie.status, 401, 'stolen assertion without initiating browser cookie refused');
  const browserErrors = []; page.on('pageerror', error => browserErrors.push(error.message));
  await Promise.all([page.waitForURL(`${COMPUTER}/work?fixture=yes`), page.locator('form[action$="/door/callback"] button').click()]);
  assert.match(await page.textContent('body'), /Your fixture computer/);
  const session = secureHostOnly(await owner.cookies(), 'imperfect_door', 'alder.imperfect.computer');
  assert.equal(observedCookies.get(owner).get(COMPUTER).has('__Host-imperfect_account'), false);
  assert.equal(observedCookies.get(owner).get(STORE).has(challengeCookie.name), false);
  assert.equal(session.sameSite, 'Lax'); assert.ok(session.expires > Date.now() / 1000 + 29 * 86400);
  assert.equal((await owner.cookies()).some(c => c.name === challengeCookie.name), false, 'browser challenge consumed');
  assert.deepEqual(browserErrors, []);
  for (const secret of [issued, challengeCookie.value, JSON.parse(Buffer.from(issued.split('.')[1], 'base64url')).nonce]) {
    assert.ok(!door.logs().includes(secret), 'successful sign-in does not log assertion or browser challenge');
  }

  const refused = await otherPage.goto(`${COMPUTER}/`);
  assert.equal(refused.status(), 403, 'store refuses a different account access to owner computer');
  assert.equal((await other.cookies()).some(c => ['imperfect_door', '__Host-imperfect_door'].includes(c.name)), false);
  // Restart with the same SQLite directory; replay protection and sessions must persist.
  await restartDoor();
  const replay = await proxy.call(COMPUTER, '/door/callback', { method: 'POST', headers: {
    origin: STORE, cookie: `${challengeCookie.name}=${challengeCookie.value}`,
    'content-type': 'application/x-www-form-urlencoded',
  }, body: form({ assertion: issued }) });
  assert.equal(replay.status, 401, 'real store assertion cannot be replayed after door restart');
  // A new, correctly browser-bound challenge cannot reuse a consumed jti,
  // even with a fresh valid signature. This isolates durable jti protection
  // from the already-consumed original nonce.
  const freshChallenge = await proxy.call(COMPUTER, '/door/?next=%2F');
  assert.equal(freshChallenge.status, 303);
  const reusedClaims = JSON.parse(Buffer.from(issued.split('.')[1], 'base64url'));
  reusedClaims.nonce = new URL(freshChallenge.headers.location).searchParams.get('nonce');
  const reusedId = await proxy.call(COMPUTER, '/door/callback', { method: 'POST', headers: {
    origin: STORE, cookie: cookie(freshChallenge), 'content-type': 'application/x-www-form-urlencoded',
  }, body: form({ assertion: jwt(signer.privateKey, reusedClaims) }) });
  assert.equal(reusedId.status, 401, 'consumed jti remains refused with a fresh challenge after restart');
  await page.reload(); assert.match(await page.textContent('body'), /Your fixture computer/);

  // Real HTTP rejection probes signed by the fixture's store key. Restart
  // between probes so production throttling does not mask crypto rejections.
  const challenge = async () => {
    const response = await proxy.call(COMPUTER, '/door/?next=%2F');
    assert.equal(response.status, 303);
    const location = new URL(response.headers.location);
    return { nonce: location.searchParams.get('nonce'), cookie: cookie(response) };
  };
  const postAssertion = (assertion, browserCookie, origin = STORE) => proxy.call(COMPUTER, '/door/callback', {
    method: 'POST', headers: { origin, cookie: browserCookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form({ assertion }),
  });
  const claims = nonce => { const now = Math.floor(Date.now() / 1000); return {
    iss: STORE, aud: registry.computerId, sub: registry.owner, iat: now, exp: now + 60, jti: random(), nonce,
  }; };
  const attacked = [];
  for (const kind of ['expired', 'forged', 'different-owner', 'different-browser', 'wrong-origin']) {
    await restartDoor();
    const first = await challenge(); let payload = claims(first.nonce); let key = signer.privateKey; let boundCookie = first.cookie;
    if (kind === 'expired') { payload.iat -= 120; payload.exp -= 120; }
    if (kind === 'forged') key = generateKeyPairSync('ed25519').privateKey;
    if (kind === 'different-owner') payload.sub = store.accountByUsername('birch').id;
    if (kind === 'different-browser') boundCookie = (await challenge()).cookie;
    const assertion = jwt(key, payload); attacked.push(assertion, first.nonce, first.cookie.split('=')[1]);
    const rejected = await postAssertion(assertion, boundCookie, kind === 'wrong-origin' ? 'https://evil.invalid' : STORE);
    assert.equal(rejected.status, kind === 'wrong-origin' ? 403 : 401, `${kind} assertion refused over real HTTP`);
    assert.equal(rejected.headers['set-cookie'], undefined, 'rejection never creates a session');
    if (kind === 'different-browser') {
      assert.equal((await postAssertion(assertion, first.cookie)).status, 303, 'the original initiating browser can still redeem');
      assert.equal((await postAssertion(assertion, first.cookie)).status, 401, 'the same nonce and assertion are one use');
    }
    for (const secret of attacked) assert.ok(!door.logs().includes(secret), 'door does not log assertions/nonces/challenge cookies');
  }

  await restartDoor();
  await f.stopStore();
  assert.equal((await proxy.call(STORE, '/account')).status, 503, 'the fixture store is actually stopped');
  await page.reload(); assert.match(await page.textContent('body'), /Your fixture computer/, 'store outage does not invalidate a door session');
  await restartDoor();
  await page.reload(); assert.match(await page.textContent('body'), /Your fixture computer/, 'existing session survives store outage plus door restart');
  assert.equal((await proxy.call(COMPUTER, '/door/check')).status, 401, 'offline availability does not admit an unsigned-in client');
  const ownerCookie = `${session.name}=${session.value}`;
  const confirmation = await page.goto(`${COMPUTER}/door/logout`);
  assert.equal(confirmation.status(), 200);
  assert.equal((await proxy.call(COMPUTER, '/door/check', { headers: { cookie: ownerCookie } })).status, 200, 'GET logout is confirmation only');
  assert.equal((await proxy.call(COMPUTER, '/door/logout', { method: 'POST', headers: {
    origin: STORE, cookie: ownerCookie,
  } })).status, 403, 'even a same-site sibling cannot force computer logout');
  const doorLogout = page.waitForResponse(r => r.url() === `${COMPUTER}/door/logout` && r.request().method() === 'POST');
  await page.locator('form[action="/door/logout"] button').click();
  assert.equal((await doorLogout).status(), 303, 'real computer-origin form ends the local session');
  assert.equal((await proxy.call(COMPUTER, '/door/check', { headers: { cookie: ownerCookie } })).status, 401);
});

for (const width of [390, 1200]) test(`Desktop consent at ${width}px preserves intent through password signin and only grants after explicit POST`, { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const account = f.store.createAccount({ username: 'alder', name: 'Alder Person', passwordHash: await hashPassword(PASSWORD) });
  f.store.registerComputer({ username: 'alder', computerId: 'fixture-desktop-computer', state: 'ready' });
  const callbacks = [];
  const loopback = createServer((req, res) => {
    callbacks.push({ method: req.method, url: req.url, cookie: req.headers.cookie });
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<!doctype html><h1>Desktop callback received</h1>');
  });
  const port = await listen(loopback); t.after(() => close(loopback));
  const loopbackOrigin = `http://127.0.0.1:${port}`;
  const verifier = random();
  const intent = { redirect_uri: `${loopbackOrigin}/callback`, state: random(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    device_name: 'Fixture <desktop> device',
  };
  const next = `/account/desktop/authorize?${new URLSearchParams(intent)}`;
  const context = await f.newContext(width, [loopbackOrigin]);
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  const initial = page.waitForResponse(r => r.url() === `${STORE}${next}` && r.request().method() === 'GET');
  await page.goto(`${STORE}${next}`);
  assert.equal((await initial).status(), 303, 'unauthenticated desktop request redirects to password form');
  const loginURL = new URL(page.url());
  assert.equal(loginURL.pathname, '/account'); assert.equal(loginURL.searchParams.get('next'), next);
  const loginForm = page.locator('form[action="/account/login"]');
  assert.equal(await loginForm.locator('input[name="next"]').inputValue(), next);
  assert.equal(callbacks.length, 0); assert.equal(f.store.desktopDevices(account.id).length, 0);
  await loginForm.locator('input[name="username"]').fill('alder');
  await loginForm.locator('input[name="password"]').fill(PASSWORD);
  assert.equal((await submit(page, '/account/login')).status(), 303);
  await page.waitForURL(`${STORE}${next}`);
  const consent = page.locator('form[action="/account/desktop/authorize"]');
  await consent.waitFor();
  assert.equal(callbacks.length, 0, 'signin does not authorize a device');
  assert.equal(f.store.desktopDevices(account.id).length, 0, 'consent GET does not grant');
  for (const [key, value] of Object.entries(intent)) assert.equal(await consent.locator(`input[name="${key}"]`).inputValue(), value);
  assert.match(await page.textContent('body'), /Fixture <desktop> device/);
  const consentPost = await submit(page, '/account/desktop/authorize');
  assert.equal(consentPost.status(), 303);
  assert.equal((await consentPost.request().allHeaders()).origin, STORE);
  await page.waitForURL(`${loopbackOrigin}/callback?**`);
  assert.match(await page.textContent('body'), /Desktop callback received/);
  assert.equal(callbacks.length, 1); assert.equal(callbacks[0].method, 'GET');
  assert.equal(callbacks[0].cookie, undefined, 'host-only account credential never travels to loopback');
  const callback = new URL(page.url());
  assert.equal(callback.searchParams.get('state'), intent.state);
  assert.deepEqual([...callback.searchParams.keys()].sort(), ['code', 'state']);
  const code = callback.searchParams.get('code'); assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const redeem = () => f.proxy.call(STORE, '/account/desktop/token', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: intent.redirect_uri, code_verifier: verifier }),
  });
  const grant = await redeem(); assert.equal(grant.status, 200);
  assert.equal(grant.headers['set-cookie'], undefined, 'native tokens are not browser sessions');
  const native = JSON.parse(grant.body);
  assert.equal(native.username, 'alder'); assert.equal(native.computerOrigin, COMPUTER);
  assert.ok(native.accessToken); assert.ok(native.refreshToken);
  assert.equal((await redeem()).status, 401, 'authorization code cannot replay');
  assert.equal(f.store.desktopDevices(account.id).length, 1);
  assert.equal(f.store.desktopDevices(account.id)[0].label, intent.device_name);
  for (const secret of [PASSWORD, code, verifier, native.accessToken, native.refreshToken]) assert.ok(!f.logs.join('\n').includes(secret));
});

test('Browser form binding, generic failures and one-use recovery do not leak credentials or create sessions', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const owner = await f.newContext(); const page = await owner.newPage(); page.setDefaultTimeout(10_000);
  const codes = await signup(page, 'cedar', 'Cedar Person');
  await logout(page);
  const flow = secureHostOnly(await owner.cookies(), '__Host-imperfect_form', 'imperfect.computer');
  const csrf = await page.locator('input[name="csrf"]').inputValue();
  const post = (path, values, headers = {}) => f.proxy.call(STORE, path, { method: 'POST',
    headers: { origin: STORE, cookie: `${flow.name}=${flow.value}`, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: form({ csrf, ...values }),
  });
  const values = { username: 'cedar', password: PASSWORD, next: '/account' };
  for (const [override, headers] of [[{ csrf: '' }, {}], [{ csrf: random() }, {}], [{}, { cookie: '' }], [{}, { origin: COMPUTER }]]) {
    const refused = await post('/account/login', { ...values, ...override }, headers);
    assert.equal(refused.status, 403); assert.equal(refused.headers['set-cookie'], undefined);
  }
  const other = await f.newContext(); const otherPage = await other.newPage();
  await otherPage.goto(`${STORE}/account`);
  const otherFlow = secureHostOnly(await other.cookies(), '__Host-imperfect_form', 'imperfect.computer');
  assert.equal((await post('/account/login', values, { cookie: `${otherFlow.name}=${otherFlow.value}` })).status, 403, 'stolen CSRF does not bind to another browser');
  const failures = [];
  for (const username of ['cedar', 'missing-person', 'receipt@example.invalid']) {
    const failed = await post('/account/login', { username, password: CHANGED_PASSWORD, next: '/account' });
    assert.equal(failed.status, 400); assert.equal(failed.headers['set-cookie'], undefined);
    failures.push(failed.body);
  }
  assert.equal(failures[0], failures[1]); assert.equal(failures[1], failures[2], 'email is not a login identity and failure is generic');
  const knownRecovery = await post('/account/recover', { username: 'cedar', code: random(), password: RECOVERED_PASSWORD });
  const unknownRecovery = await post('/account/recover', { username: 'missing-person', code: random(), password: RECOVERED_PASSWORD });
  assert.equal(knownRecovery.status, 400); assert.equal(unknownRecovery.status, 400);
  assert.equal(knownRecovery.body, unknownRecovery.body, 'recovery does not disclose whether a username exists');
  assert.equal(knownRecovery.headers['set-cookie'], undefined);
  await page.goto(`${STORE}/account/recover`);
  await page.locator('input[name="username"]').fill('cedar');
  await page.locator('input[name="code"]').fill(codes[0]);
  await page.locator('input[name="password"]').fill(RECOVERED_PASSWORD);
  assert.equal((await submit(page, '/account/recover')).status(), 303);
  await page.waitForURL(`${STORE}/account`);
  assert.equal(await page.locator('form[action="/account/login"]').count(), 1);
  await page.goto(`${STORE}/account/recover`);
  await page.locator('input[name="username"]').fill('cedar');
  await page.locator('input[name="code"]').fill(codes[0]);
  await page.locator('input[name="password"]').fill(CHANGED_PASSWORD);
  assert.equal((await submit(page, '/account/recover')).status(), 400, 'used recovery code cannot reset twice');
  assert.equal(f.store.recoveryAvailable(f.store.accountByUsername('cedar').id, recoveryDigest(codes[0])), null);
  await login(page, 'cedar', RECOVERED_PASSWORD);
  for (const secret of [PASSWORD, CHANGED_PASSWORD, RECOVERED_PASSWORD, ...codes]) assert.ok(!f.logs.join('\n').includes(secret));
});
