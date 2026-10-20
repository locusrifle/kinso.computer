// Store-owned browser credentials. Passwords and recovery codes never enter logs.
import { randomBytes } from 'node:crypto';
import { digest, equal } from './account-security.mjs';
import { hashPassword, verifyPassword, validatePassword, generateRecoveryCodes, recoveryDigest } from './passwords.mjs';

const random = () => randomBytes(32).toString('base64url');
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const escape = text => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const LOGIN_FAILED = 'Sign-in failed. Try again.';
const RECOVERY_FAILED = 'Recovery failed. Try again.';
const FORM_SECONDS = 900, SESSION_SECONDS = 30 * 86400;
const usernameKey = value => typeof value === 'string' ? value.trim().toLowerCase().slice(0, 256) : '';

// Socket addresses, not caller-controlled forwarding headers. The locker is
// loopback-bound behind its ingress; the global and username budgets still
// apply when that ingress aggregates clients onto one socket address.
export const accountAddress = req => String(req.socket?.remoteAddress ?? '').slice(0, 128);
export function createAccountThrottle({ now = Date.now } = {}) {
  const counts = new Map();
  return {
    allow(req, username, { address = true } = {}) {
      const at = now();
      for (const [key, row] of counts) if (at - row.at >= 60_000) counts.delete(key);
      const keys = address ? [[`ip:${accountAddress(req)}`, 30], ['global', 300]] : [];
      if (username !== undefined) keys.push([`user:${usernameKey(username)}`, 5]);
      if (counts.size + keys.filter(([key]) => !counts.has(key)).length > 10_000) return false;
      let allowed = true;
      for (const [key, limit] of keys) {
        const row = counts.get(key) ?? { at, count: 0 };
        row.count++; counts.set(key, row);
        if (row.count > limit) allowed = false;
      }
      return allowed;
    },
  };
}

export function createPasswordAccounts({ store, config, now, page, form, mutation, redirect, cookie, cookies, sessionCookie, safeNext }) {
  const formCookie = config.base.startsWith('https:') ? '__Host-imperfect_form' : 'imperfect_form';
  const flows = new Map();
  const throttle = createAccountThrottle({ now });
  const flowThrottle = createAccountThrottle({ now });
  function slow(req, res, username, options) {
    if (throttle.allow(req, username, options)) return;
    res.setHeader('retry-after', '60');
    throw problem('Slow down. Try again in a minute.', 429);
  }
  function cleanFlows() {
    for (const [key, flow] of flows) if (flow.expiresAt <= now()) flows.delete(key);
  }
  function anonymous(req, res) {
    cleanFlows();
    const prior = cookies(req)[formCookie];
    const known = opaque(prior) ? flows.get(digest(prior)) : null;
    if (known) return { ...known, key: digest(prior) };
    // New bindings get a separate allocation budget. Reusing a recognized
    // browser binding does not spend it; cookie-less GET floods cannot occupy
    // the whole 15-minute pool and deny sign-in to everyone else.
    if (!flowThrottle.allow(req)) {
      res.setHeader('retry-after', '60');
      throw problem('Slow down. Try again in a minute.', 429);
    }
    if (flows.size >= 10_000) throw problem('Slow down. Try again in a minute.', 429);
    const binding = random(), flow = { csrf: random(), expiresAt: now() + FORM_SECONDS * 1000 };
    const key = digest(binding); flows.set(key, flow);
    res.setHeader('set-cookie', cookie(formCookie, binding, FORM_SECONDS));
    return { ...flow, key };
  }
  function anonymousMutation(req, data) {
    cleanFlows();
    const binding = cookies(req)[formCookie];
    const key = opaque(binding) ? digest(binding) : '';
    const flow = flows.get(key);
    if (req.headers.origin !== config.base || !flow || !equal(data?.csrf, flow.csrf)) throw problem('that form could not be verified', 403);
    return key;
  }
  const hidden = (csrf, next = '/account') => `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="next" value="${escape(next)}">`;
  const usernameInput = '<label>Username<input name="username" required minlength="3" maxlength="20" autocomplete="username" autocapitalize="none" spellcheck="false"></label>';
  const passwordInput = (label = 'Password', name = 'password', autocomplete = 'new-password') => `<label>${label}<input type="password" name="${name}" required minlength="10" maxlength="512" pattern="[\\s\\S]{10,256}" autocomplete="${autocomplete}"></label>`;
  const guidance = '<p>10–256 characters. Passphrases welcome; no composition rules. Avoid common passwords and your username.</p>';
  function loginPage(req, res, next, note = '', status = 200) {
    const flow = anonymous(req, res);
    return page(res, status, `${note ? `<p role="alert">${escape(note)}</p>` : ''}<h2>sign in</h2><form method="post" action="/account/login">${hidden(flow.csrf, next)}${usernameInput}${passwordInput('Password', 'password', 'current-password')}<button type="submit">Sign in</button></form><p><a href="/account/signup?next=${encodeURIComponent(next)}">Create an account</a></p><p><a href="/account/recover">Use a recovery code</a></p>`);
  }
  function signupPage(req, res, next, note = '', status = 200) {
    const flow = anonymous(req, res);
    return page(res, status, `${note ? `<p role="alert">${escape(note)}</p>` : ''}<h2>create an account</h2><p>Your immutable username becomes your computer’s address. Use 3–20 lowercase letters, digits or hyphens; start and end with a letter or digit. Reserved names are unavailable.</p><form method="post" action="/account/signup">${hidden(flow.csrf, next)}${usernameInput}<label>Display name<input name="name" required maxlength="100" autocomplete="name"></label>${passwordInput()}${guidance}<label>Email (optional)<input type="email" name="email" maxlength="254" autocomplete="email"></label><p>Email is stored unverified, for receipts and future recovery. It cannot sign you in or link accounts. No email is needed today.</p><button type="submit">Create account</button></form><p><a href="/account?next=${encodeURIComponent(next)}">Sign in instead</a></p>`);
  }
  function recoveryPage(req, res, note = '', status = 200) {
    const flow = anonymous(req, res);
    return page(res, status, `${note ? `<p role="alert">${escape(note)}</p>` : ''}<h2>recover your account</h2><p>Use one of your single-use recovery codes to choose a new password. If you have none, ask Noah for a one-time reset link. Resetting signs out account sessions and desktop devices, not existing computer web sessions; sign those out on each computer. Email recovery will be available when email works.</p><form method="post" action="/account/recover">${hidden(flow.csrf)}${usernameInput}<label>Recovery code<input name="code" required maxlength="100" autocomplete="off" spellcheck="false"></label>${passwordInput('New password')}${guidance}<button type="submit">Reset password</button></form>`);
  }
  function savedPage(res, row, codes, next) {
    // Render only this response. Plaintext codes are never retained in a DB,
    // cookie, URL, server map or a subsequent account page.
    return page(res, 200, `<h2>save your recovery codes</h2><p>These eight single-use codes are shown only once. Keep them somewhere private outside this computer. Each can reset your password without email.</p><ul class="recovery-codes">${codes.map(code => `<li><code>${escape(code)}</code></li>`).join('')}</ul><form method="post" action="/account/recovery/saved">${hidden(row.csrf, next)}<label><input type="checkbox" name="saved" value="yes" required> I saved these recovery codes</label><button type="submit">I saved these</button></form>`);
  }
  function signIn(req, res, account, flowKey, { keep = false } = {}) {
    const token = random(), row = { token_hash: digest(token), account_id: account.id, csrf: random() };
    if (!store.saveAccountSession({ tokenHash: row.token_hash, accountId: account.id, csrf: row.csrf, expiresAt: now() + SESSION_SECONDS * 1000, credentialVersion: account.credential_version })) throw problem(LOGIN_FAILED);
    const prior = cookies(req)[sessionCookie];
    if (opaque(prior) && !keep) store.deleteAccountSession(digest(prior));
    if (flowKey) flows.delete(flowKey);
    res.setHeader('set-cookie', [cookie(sessionCookie, token, SESSION_SECONDS), cookie(formCookie, '', 0)]);
    return row;
  }
  function securityHTML(row, account) {
    return `<h2>account security</h2>${account.email ? `<p>Email: ${escape(account.email)} (unverified; never used to sign in).</p>` : '<p>No email saved. Email is optional and is not used to sign in.</p>'}${account.recovery_saved_at === null ? '<p role="alert">Save your recovery codes. If you missed them, regenerate them below; old codes will stop working.</p>' : ''}<form method="post" action="/account/password">${hidden(row.csrf)}${passwordInput('Current password', 'current_password', 'current-password')}${passwordInput('New password')}${guidance}<button type="submit">Change password</button></form><p>Changing your password signs out other account sessions and desktop devices, not existing computer web sessions.</p><form method="post" action="/account/recovery/regenerate">${hidden(row.csrf)}${passwordInput('Current password', 'current_password', 'current-password')}<button type="submit">Regenerate recovery codes</button></form><form method="post" action="/account/logout-everywhere">${hidden(row.csrf)}<button type="submit">Sign out everywhere</button></form><p>Sign out everywhere revokes all account sessions and desktop devices. Existing computer web sessions must be signed out on each computer.</p>`;
  }
  const paths = new Set(['/account/signup', '/account/login', '/account/recover', '/account/reset', '/account/password', '/account/recovery/saved', '/account/recovery/regenerate', '/account/logout', '/account/logout-everywhere']);
  return {
    securityHTML,
    async handle(req, res, url, row, account, next) {
      const path = url.pathname;
      if (path === '/account' && req.method === 'GET' && !account) { loginPage(req, res, next); return true; }
      if (!paths.has(path)) return false;
      if (req.method === 'GET') {
        if (path === '/account/signup') { signupPage(req, res, next); return true; }
        if (path === '/account/recover') { recoveryPage(req, res); return true; }
        if (path === '/account/reset') {
          const token = url.searchParams.get('token');
          const reset = opaque(token) ? store.resetToken(digest(token)) : null;
          if (!reset) throw problem(RECOVERY_FAILED);
          const flow = anonymous(req, res);
          page(res, 200, `<h2>${reset.purpose === 'codes' ? 'regenerate recovery codes' : 'reset password'}</h2><p>This signs out account sessions and desktop devices. Existing computer web sessions must be signed out on each computer.</p><form method="post" action="/account/reset">${hidden(flow.csrf)}<input type="hidden" name="token" value="${escape(token)}">${reset.purpose === 'password' ? `${passwordInput('New password')}${guidance}` : '<p>This replaces all old recovery codes and signs out all account sessions and desktop devices.</p>'}<button type="submit">${reset.purpose === 'codes' ? 'Generate codes' : 'Reset password'}</button></form>`);
          return true;
        }
        page(res, 404, '<p>Nothing here.</p>'); return true;
      }
      if (req.method !== 'POST') { page(res, 404, '<p>Nothing here.</p>'); return true; }
      // Body size is bounded before parsing; budget every expensive credential
      // operation independently of any caller-controlled forwarding headers.
      // Revocation must remain available even after credential-work budgets
      // are exhausted. Its session/Origin/CSRF checks below still apply.
      if (!['/account/logout', '/account/logout-everywhere'].includes(path)) slow(req, res);
      const data = await form(req);
      if (['/account/signup', '/account/login', '/account/recover', '/account/reset'].includes(path)) {
        const flowKey = anonymousMutation(req, data);
        slow(req, res, path === '/account/signup' ? undefined : data.username ?? (path === '/account/reset' ? `reset:${digest(data.token ?? '')}` : ''), { address: false });
        if (path === '/account/signup') {
          let created;
          const codes = generateRecoveryCodes();
          try {
            validatePassword(data.password, data.username);
            const passwordHash = await hashPassword(data.password);
            anonymousMutation(req, data);
            created = store.createAccount({ username: data.username, name: data.name, passwordHash, email: data.email ?? '', recoveryHashes: codes.map(recoveryDigest) });
          } catch (error) {
            if (error.status && error.status !== 403 && error.status !== 429) { signupPage(req, res, safeNext(data.next), error.message, error.status); return true; }
            throw error;
          }
          const issued = signIn(req, res, created, flowKey);
          savedPage(res, issued, codes, safeNext(data.next)); return true;
        }
        if (path === '/account/login') {
          const found = typeof data.username === 'string' ? store.accountByUsername(data.username) : null;
          const checked = await verifyPassword(data.password, found?.password_hash);
          if (!found || !checked.ok) { loginPage(req, res, safeNext(data.next), LOGIN_FAILED, 400); return true; }
          anonymousMutation(req, data);
          if (checked.needsUpgrade) {
            const upgraded = await hashPassword(data.password);
            anonymousMutation(req, data);
            if (!store.upgradePassword(found.id, found.password_hash, upgraded)) throw problem(LOGIN_FAILED);
          }
          signIn(req, res, found, flowKey);
          redirect(res, safeNext(data.next)); return true;
        }
        if (path === '/account/recover') {
          // Always perform the same password-hashing work whether the account
          // or code exists. Codes have 128+ random bits; SHA-256 is appropriate.
          const found = typeof data.username === 'string' ? store.accountByUsername(data.username) : null;
          let passwordHash, valid = true;
          try { validatePassword(data.password, data.username); } catch { valid = false; }
          passwordHash = await hashPassword(valid ? data.password : random());
          anonymousMutation(req, data);
          try {
            if (!valid || !found) throw problem(RECOVERY_FAILED);
            store.replacePassword(found.id, { passwordHash, recoveryHash: recoveryDigest(data.code) });
          } catch { recoveryPage(req, res, RECOVERY_FAILED, 400); return true; }
          flows.delete(flowKey);
          redirect(res, '/account', { 'set-cookie': [cookie(sessionCookie, '', 0), cookie(formCookie, '', 0)] }); return true;
        }
        const reset = opaque(data.token) ? store.resetToken(digest(data.token)) : null;
        if (!reset) throw problem(RECOVERY_FAILED);
        const found = store.account(reset.account_id);
        if (reset.purpose === 'codes') {
          const codes = generateRecoveryCodes();
          store.replaceRecoveryCodes(found.id, codes.map(recoveryDigest), { resetHash: digest(data.token) });
          const issued = signIn(req, res, store.account(found.id), flowKey);
          savedPage(res, issued, codes, '/account'); return true;
        }
        validatePassword(data.password, found.username);
        const passwordHash = await hashPassword(data.password);
        anonymousMutation(req, data);
        try { store.replacePassword(found.id, { passwordHash, resetHash: digest(data.token) }); }
        catch { throw problem(RECOVERY_FAILED); }
        flows.delete(flowKey);
        redirect(res, '/account', { 'set-cookie': [cookie(sessionCookie, '', 0), cookie(formCookie, '', 0)] }); return true;
      }
      mutation(req, row, data);
      slow(req, res, ['/account/password', '/account/recovery/regenerate'].includes(path) ? account.username : undefined, { address: false });
      if (path === '/account/logout' || path === '/account/logout-everywhere') {
        store.revokeAccountDesktopDevices(account.id);
        if (path === '/account/logout-everywhere') store.signOutEverywhere(account.id);
        else store.deleteAccountSession(row.token_hash);
        redirect(res, '/account', { 'set-cookie': cookie(sessionCookie, '', 0) }); return true;
      }
      if (path === '/account/recovery/saved') {
        if (data.saved !== 'yes') throw problem('Confirm that you saved your recovery codes.');
        store.markRecoverySaved(account.id);
        redirect(res, safeNext(data.next)); return true;
      }
      const checked = await verifyPassword(data.current_password, account.password_hash);
      mutation(req, row, data);
      if (!checked.ok) throw problem('The current password could not be verified.');
      if (path === '/account/recovery/regenerate') {
        const codes = generateRecoveryCodes();
        store.replaceRecoveryCodes(account.id, codes.map(recoveryDigest), { expectedHash: account.password_hash });
        savedPage(res, row, codes, '/account'); return true;
      }
      validatePassword(data.password, account.username);
      const passwordHash = await hashPassword(data.password);
      mutation(req, row, data);
      store.replacePassword(account.id, { expectedHash: account.password_hash, passwordHash, keepSessionHash: row.token_hash });
      // Rotate the current browser credential too; an old stolen session ID
      // does not survive a password change, even for this browser.
      signIn(req, res, store.account(account.id));
      redirect(res, '/account'); return true;
    },
  };
}
