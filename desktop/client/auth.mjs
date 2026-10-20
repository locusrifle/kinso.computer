import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const token = value => typeof value === 'string' && /^[A-Za-z0-9._~-]{24,4096}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const BROKER = 'https://imperfect.computer';
function fixtureOrigin(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value)) throw new Error('Invalid fixture origin');
  if (new URL(value).origin !== value) throw new Error('Invalid fixture origin');
  return value;
}
function trustedBroker({ broker = BROKER, testOrigin } = {}) {
  if (testOrigin !== undefined) fixtureOrigin(testOrigin);
  if (broker !== BROKER && !(testOrigin && fixtureOrigin(broker))) throw new Error('Untrusted account broker');
  return broker;
}
export function validateRawGrant(grant, { testOrigin, allowExpired = false } = {}) {
  if (!grant || typeof grant.username !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/.test(grant.username) ||
      !token(grant.accessToken) || grant.accessToken.length < 32 || !token(grant.refreshToken) || !uuid(grant.deviceId) ||
      !Number.isSafeInteger(grant.expiresAt) || (!allowExpired && grant.expiresAt <= Date.now())) throw new Error('Invalid or expired account grant');
  const expected = testOrigin === undefined ? `https://${grant.username}.imperfect.computer` : fixtureOrigin(testOrigin);
  if (grant.computerOrigin !== expected) throw new Error('Account computer origin does not match');
  return { username: grant.username, computerOrigin: expected, accessToken: grant.accessToken,
    refreshToken: grant.refreshToken, expiresAt: grant.expiresAt, deviceId: grant.deviceId };
}
export function validateGrant(grant, options = {}) {
  const raw = validateRawGrant(grant, options);
  const cookie = grant.doorCookie;
  if (!cookie || cookie.name !== '__Host-imperfect_door' || !token(cookie.value) ||
      !Number.isSafeInteger(cookie.expiresAt) || cookie.expiresAt <= Date.now()) throw new Error('Invalid computer session');
  return { ...raw, doorCookie: { name: cookie.name, value: cookie.value, expiresAt: cookie.expiresAt } };
}
async function jsonRequest(url, body, { signal, requestTimeout = 15_000 } = {}, accessToken) {
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', credentials: 'omit', headers: { 'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(Math.min(15_000, requestTimeout)), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Account request refused'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 32_768) throw new Error('Invalid account response');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function completeGrant(grant, options = {}) {
  const broker = trustedBroker(options);
  // Validate the owner-derived origin BEFORE even the unauthenticated challenge.
  const raw = validateRawGrant(grant, options);
  if (options.testOrigin && grant.doorCookie) return validateGrant(grant, options); // Explicit legacy fixture only.
  const challenge = await jsonRequest(`${raw.computerOrigin}/door/desktop/challenge`, {}, options);
  if (typeof challenge?.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce)) throw new Error('Invalid computer challenge');
  const door = await jsonRequest(`${broker}/account/desktop/door`, { nonce: challenge.nonce }, options, raw.accessToken);
  if (typeof door?.assertion !== 'string' || door.assertion.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(door.assertion)) throw new Error('Invalid computer assertion');
  const session = await jsonRequest(`${raw.computerOrigin}/door/desktop/session`, { assertion: door.assertion }, options);
  return validateGrant({ ...raw, doorCookie: session?.doorCookie }, options);
}
export async function revokeGrant(grant, options = {}) {
  const broker = trustedBroker(options);
  if (!token(grant?.refreshToken)) return;
  const response = await jsonRequest(`${broker}/account/desktop/revoke`, { refresh_token: grant.refreshToken },
    { ...options, requestTimeout: Math.min(options.requestTimeout ?? 5000, 5000) });
  if (response?.revoked !== true) throw new Error('Device revocation not confirmed');
}
async function exchange(body, options = {}, previous) {
  const broker = trustedBroker(options);
  let raw;
  try {
    const received = await jsonRequest(`${broker}/account/desktop/token`, body, options);
    raw = validateRawGrant(received, options);
    options.onGrant?.(raw); // Track rotating credentials BEFORE the asynchronous door exchange.
    if (previous && ['username', 'computerOrigin', 'deviceId'].some(key => raw[key] !== previous[key])) throw new Error('Account binding changed');
    return await completeGrant(received, options);
  } catch (error) {
    // A token response followed by a failed/aborted door exchange must not leak a live family.
    if (raw) await revokeGrant(raw, { broker, testOrigin: options.testOrigin }).catch(() => {});
    throw error;
  }
}
export function beginSignIn({ openExternal, broker = BROKER, timeout = 120_000, testOrigin, signal, onGrant, requestTimeout, deviceName = 'imperfect desktop' } = {}) {
  trustedBroker({ broker, testOrigin });
  if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 80 || /[\x00-\x1f\x7f]/.test(deviceName)) throw new Error('Invalid device name');
  const state = random(), verifier = random();
  let redirect, timer, settled = false, callbackConsumed = false, resolve, reject;
  const abort = new AbortController();
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const cancel = () => finish(new Error('Sign-in cancelled'));
  function finish(error, value) {
    if (settled) return;
    settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); server.close();
    if (error) { abort.abort(); server.closeAllConnections(); reject(error); } else resolve(value);
  }
  const server = createServer(async (request, response) => {
    let url;
    try {
      if (typeof request.url !== 'string' || request.url.length > 4096 || !request.url.startsWith('/callback?')) throw new Error();
      url = new URL(request.url, redirect);
    } catch { response.writeHead(400); response.end('Sign-in callback refused.'); return; }
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (request.method !== 'GET' || request.headers.host !== new URL(redirect).host || url.pathname !== '/callback' ||
        url.searchParams.getAll('state').length !== 1 || !equal(url.searchParams.get('state'), state) ||
        url.searchParams.getAll('code').length !== 1 || !/^[A-Za-z0-9._~-]{16,1024}$/.test(url.searchParams.get('code') ?? '')) {
      response.writeHead(400); response.end('Sign-in callback refused.'); return;
    }
    if (settled || callbackConsumed) { response.writeHead(409); response.end('Already used.'); return; }
    callbackConsumed = true; server.close();
    try {
      const grant = await exchange({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: redirect, code_verifier: verifier },
        { broker, testOrigin, signal: abort.signal, onGrant, requestTimeout });
      if (settled) return;
      response.end('Signed in. You can return to imperfect.'); finish(null, grant);
    } catch {
      if (settled) return;
      response.writeHead(400); response.end('Sign-in failed. Return to imperfect and try again.');
      finish(new Error('Sign-in exchange failed'));
    }
  });
  server.maxConnections = 16;
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.on('error', () => finish(new Error('Could not open sign-in callback')));
  timer = setTimeout(() => finish(new Error('Sign-in timed out')), Math.min(timeout, 120_000));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  else server.listen(0, '127.0.0.1', async () => {
    if (settled) { server.close(); return; }
    redirect = `http://127.0.0.1:${server.address().port}/callback`;
    const url = new URL(`${broker}/account/desktop/authorize`);
    url.search = new URLSearchParams({ redirect_uri: redirect, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', device_name: deviceName });
    try { await openExternal(url.href); } catch { finish(new Error('Could not open the system browser')); }
  });
  return { result, cancel };
}
export async function refreshGrant(grant, options = {}) {
  trustedBroker(options);
  const previous = validateRawGrant(grant, { ...options, allowExpired: true });
  return exchange({ grant_type: 'refresh_token', refresh_token: previous.refreshToken }, options, previous);
}

// Each account generation owns its HTTP work and credentials. Closing a scope
// aborts requests, revokes even late rotating grants, and ALWAYS performs cleanup.
export function createAccountScope({ revoke = revokeGrant, options = {} } = {}) {
  const controllers = new Set(), credentials = new Map();
  let closed = false;
  const quietlyRevoke = grant => Promise.resolve().then(() => revoke(grant, options)).then(() => true, () => false);
  function track(grant) {
    if (!token(grant?.refreshToken)) return;
    if (closed) return quietlyRevoke(grant);
    // One current refresh reference per family; historical tokens also revoke
    // the entire family, so sign-out never grows into thousands of requests.
    credentials.set(uuid(grant.deviceId) ? grant.deviceId : grant.refreshToken, { refreshToken: grant.refreshToken });
  }
  return {
    track,
    async run(work) {
      if (closed) throw new Error('Account cancelled');
      const controller = new AbortController(); controllers.add(controller);
      try {
        const next = await work({ ...options, signal: controller.signal, onGrant: track });
        if (closed) { await quietlyRevoke(next); throw new Error('Account cancelled'); }
        track(next); return next;
      } finally { controllers.delete(controller); }
    },
    async close(cleanup) {
      closed = true;
      for (const controller of controllers) controller.abort();
      try { return (await Promise.all([...credentials.values()].map(quietlyRevoke))).every(Boolean); }
      finally { credentials.clear(); await cleanup(); }
    },
    cancel() { for (const controller of controllers) controller.abort(); },
  };
}

// A restore is never allowed to make itself current after asynchronous work.
export async function restoreAccount({ load, refresh, attach, current, failed, discard = () => {} }) {
  const cached = await load();
  if (!cached) return;
  if (!current()) { await discard(cached); return; }
  let next;
  try { next = validateGrant(cached); }
  catch {
    if (!current()) { await discard(cached); return; }
    try { next = await refresh(cached); }
    catch { if (current()) failed(); return; }
  }
  if (!current()) { await discard(next); return; }
  try { await attach(next); } catch { if (current()) failed(); }
}
