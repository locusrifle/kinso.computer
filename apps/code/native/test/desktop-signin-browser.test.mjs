import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, request } from 'node:http';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { openStore } from '../../../../locker/store.mjs';
import { createAccounts } from '../../../../locker/accounts.mjs';
import { createLockerServer } from '../../../../locker/server.mjs';
import { createGueyServer } from '../../../../system/server.mjs';
import { mcpSession } from '../mcp.mjs';
import { STORE, COMPUTER, listen, close, until, executable, computerProxy, realDoor, stageElectron, headlessDesktop } from './fixtures/desktop-signin-fixture.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const source = process.env.ACCOUNTS_DOOR_SOURCE || resolve(process.env.IMPERFECT_OS || join(homedir(), 'workbench/imperfect-os'), 'modules/door/door.py');
const runtime = () => ({ events: new EventEmitter(), snapshot: () => ({ sessionId: 'desktop-fixture', cwd: '/tmp', messages: [], tabs: [] }), command: async () => ({}), close: async () => {} });
const exists = path => stat(path).then(() => true, () => false);
const dead = async pid => { try { process.kill(pid, 0); return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z'; } catch { return true; } };

// Expensive but required dependencies fail explicitly, never silently skip. Named for npm test.
test('staged sandboxed desktop: password signup + saved recovery codes + signin → PKCE → real OS door → session MCP hands → browser-CSRF device revocation', { timeout: 120_000 }, async t => {
  const python = await executable(process.env.ACCOUNTS_DOOR_PYTHON, ['/run/current-system/sw/bin/python3', '/usr/bin/python3']);
  const electron = await executable(process.env.DESKTOP_FIXTURE_ELECTRON, [join(repo, 'node_modules/electron/dist/electron')]);
  await readFile(source); // OS checkout required; fail with exact path, no flaky dependency skip.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    assert.ok(['127.0.0.1', '[::1]'].includes(new URL(input).hostname), 'fixture Node outbound network is loopback-only');
    return originalFetch(input, { ...init, redirect: 'error' });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const root = await mkdtemp(join(tmpdir(), 'desktop-signin-e2e-'));
  const originalEnv = { HOME: process.env.HOME, IMPERFECT_PREFIX: process.env.IMPERFECT_PREFIX };
  process.env.HOME = join(root, 'server-home'); process.env.IMPERFECT_PREFIX = join(root, 'server-prefix');
  await mkdir(process.env.HOME);
  t.after(() => { for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let store, locker, adapter, server, browser, proxy, door, desktop, browserHandoff, page;
  const callers = [], browserPolicyErrors = [];
  t.after(async () => {
    // Never capture body text: a failing signup may still display recovery codes.
    const lastBrowser = page && await page.evaluate(() => ({ path: location.pathname, forms: [...document.forms].map(form => new URL(form.action).pathname) })).catch(() => null);
    t.diagnostic(JSON.stringify({ lastBrowser, browserPolicyErrors }));
    await desktop?.stop(); await browser?.close(); callers.forEach(c => c.close());
    await door?.stop(); await proxy?.stop(); await server?.close();
    if (browserHandoff) await close(browserHandoff); if (adapter) await close(adapter);
    await locker?.close(); store?.close();
    if (process.env.DESKTOP_SIGNIN_EVIDENCE) await writeFile(process.env.DESKTOP_SIGNIN_EVIDENCE, JSON.stringify({ root, proxy: proxy?.evidence, desktopLogs: desktop?.logs(), doorLogs: door?.logs() }, null, 2));
    await rm(root, { recursive: true, force: true });
  });
  store = openStore(join(root, 'accounts.sqlite'));
  const signer = generateKeyPairSync('ed25519');
  const operator = 'disposable-desktop-fixture-operator-0123456789';
  const accounts = createAccounts({ store, config: { base: STORE,
    signerPrivateKey: signer.privateKey, operatorToken: operator,
  } });
  locker = await createLockerServer({ store, accounts, mail: { configured: false }, config: { hosts: 'imperfect.computer', secure: true }, port: 0, log: { info() {}, warn() {}, error() {} } });
  const storePort = (await locker.listen()).port;
  // The real broker still checks canonical Host; local VM transport adapter changes only Host.
  adapter = createServer((req, res) => {
    const upstream = request({ host: '127.0.0.1', port: storePort, path: req.url, method: req.method, headers: { ...req.headers, host: 'imperfect.computer' } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => { res.writeHead(503); res.end(); }); req.pipe(upstream);
  });
  const adapterOrigin = `http://127.0.0.1:${await listen(adapter)}`;
  // Configuration is public registry metadata. No legacy shared-token pairing.
  // Owner is supplied after actual browser onboarding; create backend below.
  proxy = await computerProxy(root, python, storePort, 0);
  browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--no-proxy-server', '--disable-background-networking',
    `--host-resolver-rules=MAP *.imperfect.computer 127.0.0.1:${proxy.port}, MAP imperfect.computer 127.0.0.1:${proxy.port}, EXCLUDE 127.0.0.1, MAP * ~NOTFOUND`] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const allowed = new Set([STORE, COMPUTER]);
  let callbackOrigin;
  const denied = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (allowed.has(url.origin) || url.origin === callbackOrigin) return route.continue();
    denied.push(url.origin); return route.abort('blockedbyclient');
  });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('console', message => {
    if (/Content Security Policy|form-action|violates/i.test(message.text())) browserPolicyErrors.push(message.text().replace(/(https?:\/\/[^\s'"?]+)\?[^\s'"]+/g, '$1?[redacted]'));
  });
  // The actual main process sends the OS-browser authorization URL here.
  let opened;
  browserHandoff = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/open');
      let body = ''; for await (const b of req) body += b;
      const url = new URL(body); assert.equal(url.origin, STORE); assert.equal(url.pathname, '/account/desktop/authorize');
      const callback = new URL(url.searchParams.get('redirect_uri')); assert.equal(callback.hostname, '127.0.0.1'); assert.equal(callback.pathname, '/callback'); assert.equal(callback.protocol, 'http:');
      callbackOrigin = callback.origin; opened = url;
      await page.goto(url.href); res.end('fixture browser opened');
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  const browserOrigin = `http://127.0.0.1:${await listen(browserHandoff)}`;
  // Onboard from the native flow rather than from a pre-authenticated fake grant.
  // Backend is initialized only after real password signup and immutable owner exist.
  const staged = await stageElectron({ root, repo, proxy, browserOrigin });
  desktop = await headlessDesktop(root, electron, staged.stage, proxy);
  let controlPort;
  await until(async () => { desktop.assertAlive(); try { controlPort = JSON.parse(await readFile(join(root, 'control.json'), 'utf8')).port; return controlPort; } catch { return false; } }, 'Electron test controls ready');
  const control = `http://127.0.0.1:${controlPort}`;
  const state = async () => { desktop.assertAlive(); const response = await fetch(`${control}/state`); assert.equal(response.status, 200, await response.clone().text()); return response.json(); };
  const click = async action => { const response = await fetch(`${control}/${action}`, { method: 'POST' }); assert.equal(response.status, 200, await response.text()); };
  await until(async () => (await state()).ui?.bridge === 'object', 'sandboxed native controls');
  assert.equal((await state()).ui.node, 'undefined');
  assert.ok((await state()).ui.controls.every(c => !c.on && c.disabled));
  await click('sign-in');
  await until(() => opened, 'real main beginSignIn openExternal');
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
  const intent = `${opened.pathname}${opened.search}`;
  const submit = async action => {
    const response = page.waitForResponse(r => r.url() === `${STORE}${action}` && r.request().method() === 'POST');
    const form = page.locator(`form[action="${action}"]`);
    assert.ok(await form.locator('input[name="csrf"]').inputValue(), 'real account form CSRF present');
    await form.locator('button[type="submit"]').click();
    return response;
  };
  const login = page.locator('form[action="/account/login"]');
  await login.waitFor();
  assert.equal(await login.locator('input[name="next"]').inputValue(), intent, 'native intent reaches password form');
  await page.locator('a[href^="/account/signup?"]').click();
  const signup = page.locator('form[action="/account/signup"]');
  await signup.waitFor();
  assert.equal(await signup.locator('input[name="next"]').inputValue(), intent, 'signup retains native intent');
  assert.equal(await signup.locator('input[name="username"]').inputValue(), '');
  assert.equal(await signup.locator('input[name="name"]').inputValue(), '');
  await signup.locator('input[name="name"]').fill('Alder Fixture Person');
  await signup.locator('input[name="username"]').fill('alder');
  // Disposable local fixture only; never include passwords or displayed codes in diagnostics.
  const password = 'Quiet rivers carry silver lanterns';
  await signup.locator('input[name="password"]').fill(password);
  assert.equal((await submit('/account/signup')).status(), 200, 'signup directly displays recovery codes');
  const saved = page.locator('form[action="/account/recovery/saved"]');
  await saved.waitFor();
  assert.equal(await page.locator('.recovery-codes code').count(), 8, 'eight codes displayed before confirmation');
  assert.ok(await page.locator('.recovery-codes code').evaluateAll(codes => new Set(codes.map(code => code.textContent)).size === 8), 'eight distinct recovery codes');
  assert.equal(await saved.locator('input[name="next"]').inputValue(), intent, 'recovery confirmation retains native intent');
  const unavailableAfterSignup = page.waitForResponse(r => r.url() === opened.href && r.request().method() === 'GET');
  await saved.locator('input[name="saved"][value="yes"]').check();
  const confirmed = await submit('/account/recovery/saved');
  assert.equal(confirmed.status(), 303);
  assert.equal(confirmed.headers().location, intent, 'saved confirmation redirects to the exact safe native intent');
  assert.equal((await unavailableAfterSignup).status(), 403, 'new account cannot authorize an unprovisioned computer');
  const owner = store.accountByUsername('alder'); assert.equal(owner.name, 'Alder Fixture Person');
  assert.ok(owner.recovery_saved_at, 'recovery confirmation recorded');
  await page.goto(`${STORE}/account`);
  assert.equal((await submit('/account/logout')).status(), 303, 'real browser signout');
  await login.waitFor();
  await page.goto(opened.href);
  await login.waitFor();
  assert.equal(await login.locator('input[name="next"]').inputValue(), intent, 'password signin retains original native intent');
  await login.locator('input[name="username"]').fill('alder');
  await login.locator('input[name="password"]').fill(password);
  const unavailableAfterLogin = page.waitForResponse(r => r.url() === opened.href && r.request().method() === 'GET');
  const signedIn = await submit('/account/login');
  assert.equal(signedIn.status(), 303, 'actual password signin succeeds');
  assert.equal(signedIn.headers().location, intent);
  assert.equal((await unavailableAfterLogin).status(), 403, 'password signin cannot bypass provisioning');
  const register = async state => proxy.call(STORE, '/api/accounts/computers', { method: 'POST', headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alder', computerId: 'desktop-fixture-computer', state }) });
  assert.equal((await register('provisioning')).status, 200);
  const ready = await register('ready'); assert.equal(ready.status, 200);
  const registry = JSON.parse(ready.body); assert.equal(registry.owner, owner.id); assert.equal(registry.origin, COMPUTER);
  server = await createGueyServer({ stateDir: join(root, 'computer'), cwd: root, origins: [COMPUTER], hosted: true, runtime: runtime(), sessionToken: 'disposable-web-app-session-token',
    deviceHandsAccount: { store: adapterOrigin, computerId: registry.computerId, owner: owner.id }, deviceHandsTestInsecure: true });
  const backendPort = (await server.listen()).port;
  // Rebuild only the HTTP fixture transport now the actual web app has a port.
  // The staged native transport points at the existing relay, so update its destination.
  proxy.setBackendPort(backendPort);
  door = await realDoor({ root, source, python, registry, adapter: adapterOrigin }); proxy.setDoorPort(door.port);
  const pi = mcpSession({ cwd: () => root, session: () => 'desktop-fixture-pi-session', harness: 'pi', ui: null });
  const claude = mcpSession({ cwd: () => root, session: () => 'desktop-fixture-claude-session', harness: 'claude', ui: null }); callers.push(pi, claude);
  let requestId = 1;
  const ask = async (caller, method, params) => {
    const config = caller.config(); const response = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method, params }) });
    assert.equal(response.status, 200); return (await response.json()).result;
  };
  const listed = async caller => (await ask(caller, 'tools/list')).tools.some(tool => tool.name === 'device_hands');
  const call = (caller, args) => ask(caller, 'tools/call', { name: 'device_hands', arguments: args });
  assert.equal((await fetch(pi.config().url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) })).status, 403, 'MCP requires an actual session bearer, not desktop/browser credentials');
  await ask(pi, 'initialize', {}); await ask(claude, 'initialize', {});
  assert.equal(await listed(pi), false); assert.equal(await listed(claude), false);
  // Signup and password signin both reached the provisioning gate. Resume exact native flow.
  await page.goto(opened.href);
  const consent = page.locator('form[action="/account/desktop/authorize"]');
  await consent.waitFor();
  assert.ok(await consent.locator('input[name="csrf"]').inputValue(), 'real consent CSRF present');
  const authorized = page.waitForResponse(r => r.url() === `${STORE}/account/desktop/authorize` && r.request().method() === 'POST');
  await consent.locator('button').click();
  assert.equal((await authorized).status(), 303, 'explicit device consent issues one loopback code');
  await until(async () => (await state()).ui.controls.every(c => !c.disabled), 'native attached actual door + authenticated hands');
  const signed = await state();
  assert.equal(signed.ui.account, 'alder.imperfect.computer');
  assert.equal(signed.remote.url, COMPUTER + '/');
  assert.equal(signed.remote.page.title, 'imperfect', 'production web-app HTML served through real door');
  assert.equal(signed.remote.page.node, 'undefined'); assert.equal(signed.remote.page.bridge, 'undefined');
  assert.equal(signed.remote.security.sandbox, true); assert.equal(signed.remote.security.contextIsolation, true); assert.equal(signed.remote.security.nodeIntegration, false);
  assert.ok(proxy.evidence.pageChecks > 0, 'actual Python door admitted web app');
  assert.ok(proxy.evidence.handsChecks > 0, 'actual Python hands gate admitted native WebSocket');
  assert.deepEqual(proxy.evidence.paths.filter(p => p.startsWith('/door/desktop/')), ['/door/desktop/challenge', '/door/desktop/session']);
  const devices = server.deviceHands.list(); assert.equal(devices.length, 1);
  const device = devices[0].id; assert.match(device, /^[0-9a-f-]{36}$/);
  assert.ok(signed.ui.controls.every(c => !c.on), 'native hands default off');
  assert.equal(await listed(pi), true); assert.equal(await listed(claude), true);
  const marker = join(root, 'native-marker');
  const command = `printf desktop-fixture-marker > '${marker}'; printf desktop-fixture-marker`;
  assert.equal((await call(pi, { action: 'command', device, command })).isError, true);
  assert.equal(await exists(marker), false);
  await click('remote-opt-in'); // Untrusted remote has no IPC bridge or Node.
  assert.equal(await exists(marker), false);
  await click('commands-on'); // Real checkbox -> preload -> sender-validated main IPC -> HandsClient.
  await until(() => server.deviceHands.list()[0]?.permissions.commands, 'trusted native opt-in propagated');
  const output = await call(pi, { action: 'command', device, command }); assert.notEqual(output.isError, true);
  assert.equal(JSON.parse(output.content[0].text).stdout, 'desktop-fixture-marker');
  assert.equal(await readFile(marker, 'utf8'), 'desktop-fixture-marker');
  const pidFile = join(root, 'pending-pid'); const late = join(root, 'must-not-exist');
  const pending = call(claude, { action: 'command', device, command: `sleep 30 & echo $! > '${pidFile}'; wait; printf forbidden > '${late}'` }).then(result => ({ result }), error => ({ error }));
  let pid;
  await until(async () => {
    const value = await readFile(pidFile, 'utf8').catch(() => '');
    pid = /^[1-9][0-9]*\s*$/.test(value) ? Number(value) : 0;
    return pid > 1;
  }, 'actual pending local command started with complete PID');
  await page.goto(`${STORE}/account`);
  const revoke = page.locator('form').filter({ has: page.locator(`input[value="${device}"]`) });
  await revoke.waitFor(); assert.ok(await revoke.locator('input[name="csrf"]').inputValue());
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/account/desktop/'));
  await revoke.locator('button').click(); assert.equal((await response).status(), 303, 'real account Origin + cookie + CSRF revokes device');
  await until(() => server.deviceHands.list().length === 0, 'revocation disconnect bounded introspection');
  const canceled = await pending; assert.ok(!canceled.error, 'MCP returns guarded tool error'); assert.equal(canceled.result.isError, true); assert.match(canceled.result.content[0].text, /disconnected|revoked|cancelled|credential|authentication_lost/);
  await until(() => dead(pid), 'revoked native process tree canceled'); assert.equal(await exists(late), false);
  await until(async () => (await state()).ui.controls.every(c => !c.on && c.disabled), 'native revocation all hands off');
  assert.equal(await listed(pi), false); assert.equal(await listed(claude), false);
  assert.equal((await call(pi, { action: 'command', device, command })).isError, true, 'cached tool cannot execute');
  assert.deepEqual(denied, [], 'no unexpected browser-domain requests');
  t.diagnostic(JSON.stringify({ packagedLike: 'stageClient allowlist, standalone ws, real sandboxed Electron; not final installed artifact', sourceHashes: staged.hashes, transformedMainHash: staged.transformedMainHash, passwordSignupAndSignin: true, door: proxy.evidence, nativeMarker: 'desktop-fixture-marker', revokeCanceled: true }));
});
