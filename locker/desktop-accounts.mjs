// Native credentials never authenticate browser routes or contain door cookies.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { digest } from './account-security.mjs';

const random = () => randomBytes(32).toString('base64url');
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
  && Buffer.from(value, 'base64url').toString('base64url') === value;
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const escape = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const verifier = value => typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
export function desktopIntent(params) {
  const names = ['redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'device_name'];
  if ([...params.keys()].some(name => !names.includes(name)) || names.some(name => params.getAll(name).length > 1)) throw problem('invalid desktop request');
  const redirect = params.get('redirect_uri');
  const port = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/callback$/.exec(redirect ?? '')?.[1];
  if (!port || Number(port) > 65535 || !opaque(params.get('state')) || !opaque(params.get('code_challenge')) || params.get('code_challenge_method') !== 'S256') throw problem('invalid desktop request');
  const label = params.get('device_name') ?? 'imperfect desktop';
  if (!label.trim() || label.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(label)) throw problem('invalid device name');
  return { redirectUri: redirect, state: params.get('state'), challenge: params.get('code_challenge'), label: label.trim() };
}
export function desktopNext(url) {
  if (url.pathname !== '/account/desktop/authorize' || url.hash || url.search.length > 2048) return null;
  try { desktopIntent(url.searchParams); return `${url.pathname}${url.search}`; } catch { return null; }
}

export function createDesktopAccounts({ store, now, page, redirect, json, form, mutation, issueAssertion }) {
  // Polling devices cannot share the browser's 30/min start budget. Bounded
  // global/address maps and windows also limit invalid credential probing.
  const counts = new Map();
  function allow(req) {
    const at = now(), key = `ip:${String(req.socket.remoteAddress ?? '').slice(0, 128)}`;
    for (const [k, v] of counts) if (at - v.at >= 60_000) counts.delete(k);
    if (!counts.has(key) && counts.size >= 10_000) return false;
    let allowed = true;
    for (const [k, maximum] of [[key, 600], ['global', 60_000]]) {
      const row = counts.get(k) ?? { at, count: 0 };
      row.count++; counts.set(k, row);
      if (row.count > maximum) allowed = false;
    }
    return allowed;
  }
  const boundComputer = account => {
    const computer = account?.username ? store.computerByUsername(account.username) : null;
    if (!computer || computer.state !== 'ready' || computer.owner !== account.id || computer.username !== account.username) throw problem('this computer is not available', 403);
    return computer;
  };
  const grant = device => {
    if (!device) throw problem('invalid desktop credential', 401);
    return { username: device.username, computerOrigin: `https://${device.username}.imperfect.computer`, expiresAt: device.access_expires_at, deviceId: device.device_id };
  };
  function access(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
    return match && opaque(match[1]) ? store.desktopAccess(digest(match[1])) : null;
  }
  const nativePaths = new Set(['/account/desktop/token', '/account/desktop/introspect', '/account/desktop/door', '/account/desktop/revoke']);
  return {
    devicesHTML(row, account) {
      const devices = store.desktopDevices(account.id);
      return `<h2>desktop devices</h2><p>Revoking a device stops its hardware connection and refresh credentials. It does not sign out existing computer web sessions.</p>${devices.length ? `<ul>${devices.map(d => `<li><p>${escape(d.label)} — ${escape(d.device_id)}</p><p>Added ${escape(new Date(d.created_at).toISOString())}; last used ${escape(new Date(d.last_used_at).toISOString())}${d.revoked_at === null ? '' : '; revoked'}</p>${d.revoked_at === null ? `<form method="post" action="/account/desktop/devices/revoke"><input type="hidden" name="csrf" value="${escape(row.csrf)}"><input type="hidden" name="device_id" value="${escape(d.device_id)}"><button type="submit">Revoke device</button></form>` : ''}</li>`).join('')}</ul>` : '<p>No desktop devices.</p>'}`;
    },
    async handle(req, res, url, row, account) {
      const path = url.pathname;
      if (!path.startsWith('/account/desktop/')) return false;
      // Authorization queries never reach loopback redirects except state/code.
      if (url.search.length > 2048) throw problem('invalid desktop request');
      if (nativePaths.has(path)) {
        const inactive = () => json(res, 401, { active: false });
        // Presence, not truthiness: Origin:null and Origin:"" are browsers too.
        if (Object.hasOwn(req.headers, 'origin')) return json(res, 403, { error: 'native requests only' });
        if (req.method !== 'POST' || url.search) return json(res, 400, { error: 'invalid desktop request' });
        if (!allow(req)) return json(res, 429, { error: 'slow down' });
        if (String(req.headers['content-type'] ?? '').split(';')[0] !== 'application/json') return json(res, 400, { error: 'JSON required' });
        try {
          const data = await form(req);
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw problem('invalid desktop request');
          if (path === '/account/desktop/token') {
            const accessToken = random(), refreshToken = random();
            const tokens = { accessHash: digest(accessToken), refreshHash: digest(refreshToken), accessExpiresAt: now() + 300_000 };
            let device;
            if (data.grant_type === 'authorization_code') {
              if (!opaque(data.code)) throw problem('invalid desktop credential', 401);
              // Do not normalize or resolve the redirect: exact string binding.
              // Invalid proofs still consume a known code, including bad shapes.
              const redirectUri = typeof data.redirect_uri === 'string' && data.redirect_uri.length <= 128 ? data.redirect_uri : '';
              const challenge = verifier(data.code_verifier) ? createHash('sha256').update(data.code_verifier).digest('base64url') : '';
              device = store.redeemDesktopCode({ ...tokens, codeHash: digest(data.code), redirectUri, challenge, deviceId: randomUUID() });
            } else if (data.grant_type === 'refresh_token' && opaque(data.refresh_token)) {
              device = store.rotateDesktopRefresh({ ...tokens, tokenHash: digest(data.refresh_token) });
            } else throw problem('invalid desktop credential', 401);
            return json(res, 200, { ...grant(device), accessToken, refreshToken });
          }
          if (path === '/account/desktop/revoke') {
            if (!opaque(data.refresh_token)) throw problem('invalid desktop credential', 401);
            store.revokeDesktopRefresh(digest(data.refresh_token));
            return json(res, 200, { revoked: true });
          }
          const device = access(req);
          if (!device) return inactive();
          if (path === '/account/desktop/introspect') {
            if (data.computerId !== device.computer_id || data.owner !== device.account_id) return inactive();
            return json(res, 200, { active: true, computerId: device.computer_id, owner: device.account_id, computerOrigin: `https://${device.username}.imperfect.computer`, deviceId: device.device_id, expiresAt: device.access_expires_at });
          }
          const assertion = issueAssertion({ computer: { computer_id: device.computer_id }, account: { id: device.account_id }, nonce: data.nonce, deviceId: device.device_id });
          return json(res, 200, { assertion });
        } catch (error) {
          if (path === '/account/desktop/introspect' && error.status !== 413) return inactive();
          return json(res, error.status ?? 400, { error: error.status === 413 ? 'request too large' : 'desktop request failed' });
        }
      }
      if (path === '/account/desktop/devices/revoke' && req.method === 'POST') {
        if (!allow(req)) throw problem('slow down', 429);
        const data = await form(req);
        mutation(req, row, data);
        store.revokeDesktopDevice(account.id, typeof data.device_id === 'string' ? data.device_id : '');
        return redirect(res, '/account');
      }
      if (path !== '/account/desktop/authorize' || !['GET', 'POST'].includes(req.method)) return page(res, 404, '<p>Nothing here.</p>');
      if (!allow(req)) throw problem('slow down', 429);
      let intent;
      if (req.method === 'GET') {
        intent = desktopIntent(url.searchParams);
        if (!account?.username) return redirect(res, `/account?next=${encodeURIComponent(`${path}${url.search}`)}`);
      } else {
        const data = await form(req);
        mutation(req, row, data);
        const fields = new URLSearchParams();
        for (const key of ['redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'device_name']) if (typeof data[key] === 'string') fields.set(key, data[key]);
        intent = desktopIntent(fields);
      }
      const computer = boundComputer(account);
      if (req.method === 'GET') {
        const fields = { csrf: row.csrf, redirect_uri: intent.redirectUri, state: intent.state, code_challenge: intent.challenge, code_challenge_method: 'S256', device_name: intent.label };
        return page(res, 200, `<h2>authorize desktop device</h2><p>Allow ${escape(intent.label)} to open ${escape(account.username)}.imperfect.computer and connect its hardware? Hardware permissions still require your opt-in in the app.</p><form method="post" action="/account/desktop/authorize">${Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${key}" value="${escape(value)}">`).join('')}<button type="submit">Authorize device</button></form><p><a href="/account">Cancel</a></p>`, `'self' ${new URL(intent.redirectUri).origin}`);
      }
      const code = random();
      if (!store.saveDesktopCode({ codeHash: digest(code), accountId: account.id, computerId: computer.computer_id, username: account.username, redirectUri: intent.redirectUri, challenge: intent.challenge, label: intent.label, expiresAt: now() + 60_000 })) throw problem('this computer is not available', 403);
      return redirect(res, `${intent.redirectUri}?${new URLSearchParams({ code, state: intent.state })}`);
    },
  };
}
