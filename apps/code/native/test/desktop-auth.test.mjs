import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { beginSignIn, completeGrant, refreshGrant, revokeGrant, createAccountScope, restoreAccount } from '../../../../desktop/client/auth.mjs';

const credential = 'fixture-only-credential-0000000000000000';
const deviceId = '12345678-1234-1234-1234-123456789abc';
const nonce = 'a'.repeat(43), assertion = 'fixture.payload.signature';
const cookie = () => ({ name: '__Host-imperfect_door', value: credential, expiresAt: Date.now() + 60_000 });
const raw = origin => ({ username: 'tester', computerOrigin: origin, deviceId,
  accessToken: credential, refreshToken: credential, expiresAt: Date.now() + 60_000 });
async function fixture(t, handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => { res.destroy(); throw error; });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function body(req) {
  assert.equal(req.headers.origin, undefined);
  assert.equal(req.headers.cookie, undefined);
  assert.equal(req.method, 'POST');
  let text = ''; for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}
function json(res, value) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); }
function callback(url) {
  const authorize = new URL(url), target = new URL(authorize.searchParams.get('redirect_uri'));
  target.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'fixture-authorization-code-123' });
  return target;
}
test('raw broker sign-in and refresh perform native nonce/assertion/session exchange with stable device identity', async t => {
  const calls = []; let computer, broker;
  computer = await fixture(t, async (req, res) => {
    const data = await body(req); calls.push(req.url);
    assert.equal(req.headers.authorization, undefined);
    if (req.url === '/door/desktop/challenge') { assert.deepEqual(data, {}); json(res, { nonce }); }
    else { assert.equal(req.url, '/door/desktop/session'); assert.deepEqual(data, { assertion }); json(res, { doorCookie: cookie() }); }
  });
  broker = await fixture(t, async (req, res) => {
    const data = await body(req); calls.push(req.url);
    if (req.url === '/account/desktop/token') {
      assert.equal(req.headers.authorization, undefined);
      assert.ok(['authorization_code', 'refresh_token'].includes(data.grant_type));
      json(res, raw(computer));
    } else {
      assert.equal(req.url, '/account/desktop/door'); assert.deepEqual(data, { nonce });
      assert.equal(req.headers.authorization, `Bearer ${credential}`); json(res, { assertion });
    }
  });
  const login = beginSignIn({ broker, testOrigin: computer, openExternal: async url => {
    assert.equal(new URL(url).searchParams.get('device_name'), 'imperfect desktop');
    assert.equal((await fetch(callback(url))).status, 200);
  } });
  t.after(login.cancel);
  const grant = await login.result;
  assert.equal(grant.deviceId, deviceId); assert.equal(grant.doorCookie.name, '__Host-imperfect_door');
  assert.deepEqual(calls, ['/account/desktop/token', '/door/desktop/challenge', '/account/desktop/door', '/door/desktop/session']);
  calls.length = 0;
  const refreshed = await refreshGrant(grant, { broker, testOrigin: computer });
  assert.equal(refreshed.deviceId, deviceId);
  assert.deepEqual(calls, ['/account/desktop/token', '/door/desktop/challenge', '/account/desktop/door', '/door/desktop/session']);
});
test('origin substitution cannot send an assertion or bearer to another host; fixture overrides are explicit and loopback-only', async t => {
  let leaked = 0;
  const attacker = await fixture(t, (_req, res) => { leaked++; json(res, { nonce }); });
  const expected = 'http://127.0.0.1:45678';
  await assert.rejects(completeGrant(raw(attacker), { broker: attacker, testOrigin: expected }), /origin/);
  await assert.rejects(completeGrant(raw(attacker)), /origin/);
  await assert.rejects(refreshGrant(raw(attacker)), /origin/);
  for (const override of ['https://evil.invalid', 'http://localhost:45678', `${attacker}/path`, `${attacker}/`, 'http://127.0.0.1:00001']) {
    await assert.rejects(completeGrant(raw(attacker), { broker: override, testOrigin: attacker }));
    await assert.rejects(revokeGrant(raw(attacker), { broker: override, testOrigin: attacker }));
    assert.throws(() => beginSignIn({ broker: attacker, testOrigin: override, openExternal() {} }));
  }
  assert.equal(leaked, 0);
});
test('native credential requests refuse redirects at every exchange boundary', async t => {
  for (const stage of ['token', 'challenge', 'door', 'session', 'revoke']) {
    let leaked = 0, computer, broker;
    const attacker = await fixture(t, (_req, res) => { leaked++; json(res, {}); });
    const redirect = res => { res.writeHead(307, { Location: attacker }); res.end(); };
    computer = await fixture(t, async (req, res) => {
      await body(req);
      if ((stage === 'challenge' && req.url.endsWith('/challenge')) || (stage === 'session' && req.url.endsWith('/session'))) redirect(res);
      else json(res, req.url.endsWith('/challenge') ? { nonce } : { doorCookie: cookie() });
    });
    broker = await fixture(t, async (req, res) => {
      await body(req);
      if (req.url.endsWith(`/${stage}`)) redirect(res);
      else json(res, req.url.endsWith('/token') ? raw(computer) : req.url.endsWith('/door') ? { assertion } : { revoked: true });
    });
    const options = { broker, testOrigin: computer };
    if (stage === 'token') await assert.rejects(refreshGrant(raw(computer), options));
    else if (stage === 'revoke') await assert.rejects(revokeGrant(raw(computer), options));
    else await assert.rejects(completeGrant(raw(computer), options));
    assert.equal(leaked, 0, stage);
  }
});
test('door challenge, assertion, cookie and response size are bounded and validated', async t => {
  for (const invalid of ['nonce', 'assertion', 'cookie', 'size']) {
    let brokerRequests = 0, sessionRequests = 0;
    const computer = await fixture(t, async (req, res) => {
      await body(req);
      if (req.url.endsWith('/challenge')) {
        if (invalid === 'size') res.end(' '.repeat(32_769));
        else json(res, { nonce: invalid === 'nonce' ? 'short' : nonce });
      } else { sessionRequests++; json(res, { doorCookie: { ...cookie(), ...(invalid === 'cookie' ? { name: 'store-cookie' } : {}) } }); }
    });
    const broker = await fixture(t, async (req, res) => {
      await body(req); brokerRequests++;
      json(res, { assertion: invalid === 'assertion' ? 'not an assertion' : assertion });
    });
    await assert.rejects(completeGrant(raw(computer), { broker, testOrigin: computer }));
    if (['nonce', 'size'].includes(invalid)) assert.equal(brokerRequests, 0);
    if (invalid === 'assertion') assert.equal(sessionRequests, 0);
  }
});
test('cancellation and request deadlines stop every native door exchange phase', async t => {
  for (const stage of ['challenge', 'door', 'session']) {
    for (const mode of ['cancel', 'timeout']) {
      const started = Promise.withResolvers();
      const computer = await fixture(t, async (req, res) => {
        await body(req);
        if (req.url.endsWith(`/${stage}`)) { started.resolve(); return; }
        json(res, req.url.endsWith('/challenge') ? { nonce } : { doorCookie: cookie() });
      });
      const broker = await fixture(t, async (req, res) => {
        await body(req);
        if (stage === 'door') { started.resolve(); return; }
        json(res, { assertion });
      });
      const controller = new AbortController();
      const operation = completeGrant(raw(computer), { broker, testOrigin: computer, signal: controller.signal,
        requestTimeout: mode === 'timeout' ? 200 : 5000 });
      const rejection = assert.rejects(operation);
      await Promise.race([started.promise, operation]);
      if (mode === 'cancel') controller.abort();
      await rejection;
    }
  }
});
test('cancelled sign-in revokes a raw grant while each door phase is in flight', async t => {
  for (const stage of ['challenge', 'door', 'session']) {
    const started = Promise.withResolvers(), revoked = Promise.withResolvers();
    const computer = await fixture(t, async (req, res) => {
      await body(req);
      if (req.url.endsWith(`/${stage}`)) { started.resolve(); return; }
      json(res, req.url.endsWith('/challenge') ? { nonce } : { doorCookie: cookie() });
    });
    const broker = await fixture(t, async (req, res) => {
      const data = await body(req);
      if (req.url.endsWith('/token')) json(res, raw(computer));
      else if (req.url.endsWith('/revoke')) {
        assert.equal(data.refresh_token, credential); json(res, { revoked: true }); revoked.resolve();
      } else if (stage === 'door') started.resolve();
      else json(res, { assertion });
    });
    const login = beginSignIn({ broker, testOrigin: computer, openExternal: url => fetch(callback(url)).catch(() => {}) });
    t.after(login.cancel);
    const rejected = assert.rejects(login.result, /cancelled/);
    await Promise.race([started.promise, login.result]);
    login.cancel(); await rejected; await revoked.promise;
  }
});
test('refresh rejects changed device/account binding before any computer request and revokes the new grant', async t => {
  let computerRequests = 0, revoked = 0;
  const computer = await fixture(t, (_req, res) => { computerRequests++; json(res, {}); });
  const broker = await fixture(t, async (req, res) => {
    const data = await body(req);
    if (req.url.endsWith('/revoke')) { assert.equal(data.refresh_token, credential); revoked++; json(res, { revoked: true }); }
    else json(res, { ...raw(computer), deviceId: 'abcdefab-1234-1234-1234-123456789abc' });
  });
  await assert.rejects(refreshGrant(raw(computer), { broker, testOrigin: computer }), /binding/);
  assert.equal(computerRequests, 0); assert.equal(revoked, 1);
});
test('real broker revoke is bounded and local cleanup runs even on refusal or outage', async t => {
  for (const mode of ['refuse', 'timeout', 'ok']) {
    let revoked = 0, cleaned = 0;
    const broker = await fixture(t, async (req, res) => {
      assert.equal(req.url, '/account/desktop/revoke');
      assert.deepEqual(await body(req), { refresh_token: credential }); revoked++;
      if (mode === 'timeout') return;
      if (mode === 'refuse') res.statusCode = 503;
      json(res, { revoked: true });
    });
    const scope = createAccountScope({ options: { broker, testOrigin: broker, requestTimeout: 100 } });
    scope.track(raw(broker));
    const confirmed = await scope.close(async () => { assert.equal(revoked, 1, 'revoke attempted before local cleanup'); cleaned++; });
    assert.equal(confirmed, mode === 'ok', 'offline/refused revocation must not be reported as confirmed');
    assert.equal(revoked, 1); assert.equal(cleaned, 1);
  }
});
test('successful HTTP without explicit revocation confirmation is refused', async t => {
  const broker = await fixture(t, async (req, res) => { await body(req); json(res, {}); });
  await assert.rejects(revokeGrant(raw(broker), { broker, testOrigin: broker }), /not confirmed/);
});
test('sign-out revokes the in-flight rotated family, aborts work, and cannot resurrect attachment', async t => {
  const revoked = [], cleaned = [];
  const broker = await fixture(t, async (req, res) => {
    assert.equal(req.url, '/account/desktop/revoke'); revoked.push((await body(req)).refresh_token);
    json(res, { revoked: true });
  });
  const scope = createAccountScope({ options: { broker, testOrigin: broker } });
  scope.track(raw(broker));
  const rotated = { ...raw(broker), refreshToken: `${credential}-rotated` };
  const gate = Promise.withResolvers(), started = Promise.withResolvers(); let aborted = false;
  const operation = scope.run(async options => {
    options.onGrant(rotated);
    options.signal.addEventListener('abort', () => { aborted = true; });
    started.resolve(); await gate.promise; return rotated;
  });
  const rejected = assert.rejects(operation, /cancelled/);
  await started.promise;
  await scope.close(async () => { cleaned.push(true); });
  assert.ok(aborted); assert.deepEqual(revoked, [rotated.refreshToken]);
  gate.resolve(); await rejected;
  assert.equal(cleaned.length, 1);
  const late = { ...raw(broker), refreshToken: `${credential}-late` };
  await scope.track(late);
  assert.ok(revoked.includes(late.refreshToken));
});
test('sign-out during a real rotating refresh revokes the new family reference and aborts session exchange', async t => {
  const started = Promise.withResolvers(), revoked = [];
  const computer = await fixture(t, async (req, res) => {
    await body(req);
    if (req.url.endsWith('/challenge')) json(res, { nonce });
    else started.resolve(); // Hold the session exchange across sign-out.
  });
  const rotated = { ...raw(computer), refreshToken: `${credential}-rotated` };
  const broker = await fixture(t, async (req, res) => {
    const data = await body(req);
    if (req.url.endsWith('/token')) json(res, rotated);
    else if (req.url.endsWith('/door')) json(res, { assertion });
    else { revoked.push(data.refresh_token); json(res, { revoked: true }); }
  });
  const scope = createAccountScope({ options: { broker, testOrigin: computer } });
  scope.track(raw(computer));
  const operation = scope.run(options => refreshGrant(raw(computer), options));
  const rejected = assert.rejects(operation);
  await Promise.race([started.promise, operation]);
  let cleaned = false;
  await scope.close(async () => { assert.ok(revoked.includes(rotated.refreshToken)); cleaned = true; });
  await rejected;
  assert.ok(cleaned); assert.ok(revoked.every(value => value === rotated.refreshToken));
});
test('sign-out during startup load revokes a subsequently discovered remembered grant', async t => {
  let revoked = 0, attached = 0;
  const broker = await fixture(t, async (req, res) => { await body(req); revoked++; json(res, { revoked: true }); });
  const scope = createAccountScope({ options: { broker, testOrigin: broker } });
  const loaded = Promise.withResolvers(); let current = true;
  const operation = restoreAccount({ load: () => loaded.promise, refresh: () => assert.fail('refresh after logout'),
    current: () => current, attach: () => attached++, failed: () => assert.fail('stale failure'), discard: scope.track });
  current = false; await scope.close(async () => {});
  loaded.resolve(raw(broker)); await operation;
  assert.equal(revoked, 1); assert.equal(attached, 0);
});
test('main registration uses broker device identity and preserves sandbox/IPC/permission boundary', async () => {
  const source = await readFile(new URL('../../../../desktop/client/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /deviceId: grant\.deviceId/);
  assert.doesNotMatch(source, /deviceIdentity/);
  assert.match(source, /sandbox: true, contextIsolation: true, nodeIntegration: false/);
  assert.match(source, /setPermissionRequestHandler\([\s\S]*?callback\(false\)/);
  assert.match(source, /event\.senderFrame !== win\.webContents\.mainFrame/);
});
