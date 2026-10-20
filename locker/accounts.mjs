// Accounts and the key to a registered computer. No checkout identities are used.
import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { digest, equal } from './account-security.mjs';
import { createPasswordAccounts, accountAddress } from './password-accounts.mjs';
import { createDesktopAccounts, desktopNext } from './desktop-accounts.mjs';


const random = () => randomBytes(32).toString('base64url');
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const escape = text => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const safeNext = value => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/account';
  try {
    const url = new URL(value, 'https://local');
    if (url.hash) return '/account';
    return desktopNext(url) ?? (['/account/computer', '/account/rent'].includes(url.pathname) ? `${url.pathname}${url.search}` : '/account');
  } catch { return '/account'; }
};
function cookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    // Duplicate security cookies fail closed (including cookie tossing).
    result[name] = Object.hasOwn(result, name) ? '' : part.slice(at + 1).trim();
  }
  return result;
}

export function createAccounts({ store, config, now = Date.now, limiter, rentals, codeSentence = () => 'git clone is not configured here' } = {}) {
  config = { ...config, base: config?.base ?? 'https://imperfect.computer' };
  const base = new URL(config.base);
  if (base.origin !== config.base || base.username || base.password || (base.protocol !== 'https:' && !(config.allowInsecureTest && base.protocol === 'http:'))) throw new Error('accounts needs a canonical HTTPS origin');
  const secure = base.protocol === 'https:';
  const sessionCookie = secure ? '__Host-imperfect_account' : 'imperfect_account';
  const cookie = (name, value, age) => `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax`;
  let privateKey = null, publicKey = '';
  if (config.signerPrivateKey) {
    privateKey = config.signerPrivateKey.type === 'private' ? config.signerPrivateKey : createPrivateKey(config.signerPrivateKey);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('accounts signer must be Ed25519');
    publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  }
  // A bounded per-address and global budget for registry/rental mutations.
  const counts = new Map();
  function allow(req) {
    const key = `ip:${accountAddress(req)}`;
    if (limiter) return limiter.allow(`accounts:${key}`);
    const at = now();
    for (const [k, v] of counts) if (at - v.at >= 60_000) counts.delete(k);
    if (!counts.has(key) && counts.size >= 10_000) return false;
    let allowed = true;
    for (const [k, maximum] of [[key, 30], ['global', 300]]) {
      const row = counts.get(k) ?? { at, count: 0 };
      row.count++; counts.set(k, row);
      if (row.count > maximum) allowed = false;
    }
    return allowed;
  }
  const session = req => {
    const token = cookies(req)[sessionCookie];
    return opaque(token) ? store.accountSession(digest(token)) : null;
  };
  const redirect = (res, location, headers = {}) => { res.writeHead(303, { location, ...headers }); res.end(); };
  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  function page(res, status, body, formOrigin = "'self' https://checkout.stripe.com https://billing.stripe.com") {
    res.setHeader('content-security-policy', `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action ${formOrigin}; frame-ancestors 'none'; base-uri 'none'`);
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>imperfect account</title><link rel="stylesheet" href="/landing.css?v=plain-1"><link rel="stylesheet" href="/shared/accounts.css?v=buy-3"></head><body><a class="skip" href="#main">Skip to content</a><header class="header"><a class="brand" href="/"><img src="/assets/wordmark/imperfect-logo-silver.png" alt="imperfect" width="102" height="56"></a><nav aria-label="Main"><a href="/account">Your account</a></nav></header><main class="handoff" id="main"><h1>imperfect account</h1>${body}</main></body></html>`);
  }
  async function form(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw problem('request too large', 413);
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const type = String(req.headers['content-type'] ?? '').split(';')[0];
    if (type === 'application/json') return JSON.parse(body);
    if (type !== 'application/x-www-form-urlencoded') throw problem('invalid request');
    return Object.fromEntries(new URLSearchParams(body));
  }
  function mutation(req, row, data) {
    // Body reading yields: another request may have signed out this session.
    const active = row ? store.accountSession(row.token_hash) : null;
    if (req.headers.origin !== config.base || !active || !equal(data?.csrf, active.csrf)) throw problem('that form could not be verified', 403);
  }
  function accountPage(res, row, account, next) {
    const hidden = `<input type="hidden" name="csrf" value="${escape(row.csrf)}"><input type="hidden" name="next" value="${escape(next)}">`;
    const computer = store.computerByUsername(account.username);
    const rental = rentals?.policy(store.rental(account.id));
    const rentalBody = rental ? `<p>Rental: ${escape(rental.status)}${rental.source === 'tester' ? ' — you’re a tester, no card needed' : ''}.</p>${rental.source === 'tester' && rental.status === 'active' && computer?.state !== 'ready' ? '<p>You’re a tester: your computer is being made.</p>' : ''}${rental.periodEnd ? `<p>Current period ends ${escape(new Date(rental.periodEnd).toISOString().slice(0, 10))}${rental.cancelAtPeriodEnd ? '; cancellation is scheduled' : ''}.</p>` : ''}${rental.stopAt ? `<p>Stop scheduled: ${escape(new Date(rental.stopAt).toISOString())}. Data retention until ${escape(new Date(rental.deleteAfter).toISOString())}; contact Noah for help.</p>` : ''}${rental.source === 'stripe' && rental.customer ? `<form method="post" action="/account/portal">${hidden}<button type="submit">Manage or cancel rental</button></form>` : ''}` : '';
    const rentButton = rentals?.enabled() && (!rental || ['canceled', 'pending'].includes(rental.status)) ? `<form method="post" action="/account/rent">${hidden}<button type="submit">Rent — US$40/month</button></form><p>Noah retains root access for support. Sydney; bring your own AI subscription. No backups yet: keep copies of important work.</p>` : !rental ? '<p>Monthly billing is not open yet. <a href="/">About renting</a></p>' : '';
    const licences = store.accountLicenses(account.id);
    // Legacy members retain their keyed install line; public GitHub clones need no key.
    const code = licences.find(l => l.product === 'code' && l.status === 'active');
    const codeBody = code ? `<h2>your copy of the code</h2><p>Your own clone of the repository, with its updates. Paste this into the agent you already use, on your Linux computer:</p><p><code>${escape(codeSentence(code.key))}</code></p>` : '';
    const licenses = licences.filter(l => l.product !== 'code').map(l => `<p>Imperfect ${escape(l.product)} licence: ${escape(l.status)}. <code>${escape(l.key)}</code> <a href="/os/install">OS installation guide</a></p>`).join('');
    const origin = `https://${escape(account.username)}.imperfect.computer`;
    // A rented computer is made from the rental itself (tools/rental-sync.mjs); until its registry row is ready it is being set up.
    const computerLine = computer?.state === 'ready' ? `ready at ${origin}`
      : computer?.state === 'stopped' ? 'stopped; your data is kept, contact Noah'
        : computer || rental?.status === 'active' ? 'being set up' : 'not provisioned';
    page(res, 200, `<p>${escape(account.name)}</p><p><a href="${origin}">${escape(account.username)}.imperfect.computer</a></p><p>Computer: ${computerLine}</p>${rentalBody}${rentButton}${codeBody}${licenses}${passwords.securityHTML(row, account)}${desktop.devicesHTML(row, account)}<form method="post" action="/account/logout">${hidden}<button type="submit">Sign out</button></form>`);
  }
  function provisioned(computer) {
    return { computerId: computer.computer_id, username: computer.username, state: computer.state, origin: `https://${computer.username}.imperfect.computer`, owner: computer.owner, store: config.base, publicKey };
  }
  function issueAssertion({ computer, account, nonce, deviceId }) {
    const registered = store.computerById(computer?.computer_id ?? computer?.computerId ?? '');
    const owner = account?.id ? store.account(account.id) : null;
    if (!privateKey || !registered || registered.state !== 'ready' || registered.owner !== owner?.id || registered.username !== owner?.username || !opaque(nonce)
      || (deviceId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(deviceId))) throw problem('this computer is not available', 403);
    const iat = Math.floor(now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode({ iss: config.base, aud: registered.computer_id, sub: account.id, iat, exp: iat + 60, jti: random(), nonce, ...(deviceId === undefined ? {} : { purpose: 'desktop', device: deviceId }) })}`;
    return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
  }
  const desktop = createDesktopAccounts({ store, now, page, redirect, json, form, mutation, issueAssertion });
  const passwords = createPasswordAccounts({ store, config, now, page, form, mutation, redirect, cookie, cookies, sessionCookie, safeNext });
  async function handle(req, res, url = new URL(req.url, config.base)) {
    const path = url.pathname;
    if (!(path === '/account' || path.startsWith('/account/') || path.startsWith('/api/accounts/'))) return false;
    res.setHeader('cache-control', 'no-store');
    // HTML form POSTs need their Origin for CSRF and the door callback.
    // no-referrer makes Chromium send Origin: null; strict-origin exposes
    // only our public origin, never reset tokens, challenges or assertions.
    res.setHeader('referrer-policy', 'strict-origin');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (String(req.headers.host ?? '').toLowerCase() !== base.host.toLowerCase()) throw problem('use the canonical account address', 400);
      if (path.startsWith('/api/accounts/')) {
        if (!config.operatorToken || !equal(req.headers.authorization, `Bearer ${config.operatorToken}`)) return json(res, 401, { error: 'not authorized' });
        if (!allow(req)) return json(res, 429, { error: 'slow down' });
        if (req.method === 'GET' && path === '/api/accounts/rentals' && rentals) {
          const want = url.searchParams.get('want');
          if (want && !['provision', 'stop'].includes(want)) throw problem('invalid rental intent');
          return json(res, 200, { rentals: rentals.list(want) });
        }
        if (!privateKey) return json(res, 503, { error: 'accounts signer unavailable' });
        if (req.method === 'POST' && path === '/api/accounts/computers') return json(res, 200, provisioned(store.registerComputer(await form(req))));
        if (req.method === 'GET' && path.startsWith('/api/accounts/computers/')) {
          const computer = store.computerByUsername(path.slice('/api/accounts/computers/'.length));
          if (!computer) return json(res, 404, { error: 'not found' });
          return json(res, 200, provisioned(computer));
        }
        return json(res, 404, { error: 'not found' });
      }
      const row = session(req), account = row ? store.account(row.account_id) : null;
      const next = safeNext(url.searchParams.get('next'));
      if (await passwords.handle(req, res, url, row, account, next)) return;
      if (path.startsWith('/account/desktop/')) return await desktop.handle(req, res, url, row, account);
      if (req.method === 'GET' && path === '/account/rent') return redirect(res, '/account?next=/account/rent');
      if (req.method === 'POST' && ['/account/rent', '/account/portal'].includes(path) && rentals) {
        if (!allow(req)) throw problem('slow down', 429);
        const data = await form(req);
        mutation(req, row, data);
        if (!account?.username) throw problem('choose your username first');
        return redirect(res, path === '/account/rent' ? await rentals.checkout(account) : await rentals.portal(account));
      }
      if (req.method === 'GET' && path === '/account') return accountPage(res, row, account, next);
      if (req.method === 'GET' && path === '/account/computer') {
        const computer = store.computerById(url.searchParams.get('computer') ?? '');
        const nonce = url.searchParams.get('nonce');
        if (!computer || !opaque(nonce)) throw problem('this computer is not available', 404);
        const returnTo = `${path}${url.search}`;
        if (!account || !account.username) return redirect(res, `/account?next=${encodeURIComponent(returnTo)}`);
        if (!allow(req)) throw problem('slow down', 429);
        const assertion = issueAssertion({ computer, account, nonce });
        const origin = provisioned(computer).origin;
        return page(res, 200, `<p>Continue to ${escape(computer.username)}.imperfect.computer</p><form method="post" action="${escape(origin)}/door/callback"><input type="hidden" name="assertion" value="${escape(assertion)}"><button type="submit">Continue</button></form>`, origin);
      }
      page(res, 404, '<p>Nothing here.</p>');
    } catch (error) {
      // No upstream messages, codes, tokens, nonces, stacks or request URLs in logs.
      const status = error.status ?? 400;
      if (path.startsWith('/api/accounts/') || ['/account/desktop/token', '/account/desktop/introspect', '/account/desktop/door', '/account/desktop/revoke'].includes(path)) json(res, status, { error: error.status ? error.message : 'request failed' });
      else page(res, status, `<p role="alert">${escape(error.status ? error.message : 'Request failed. Try again.')}</p><p><a href="/account">Back to your account</a></p>`);
    }
    return true;
  }
  // Route helpers return undefined; only a non-account path returns false.
  return { publicKey, issueAssertion, signedIn: req => { const row = session(req); return row ? store.account(row.account_id) : null; }, handle: async (...args) => (await handle(...args)) !== false };
}
