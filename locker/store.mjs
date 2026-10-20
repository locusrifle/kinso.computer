// Everything the store remembers: who bought imperfect, which key opens
// it, and which versions have gone out. One SQLite file, no dependencies.
//
// A key is a member's for good: it clones the repository and fetches every
// version after it. Revoking it is the only way it stops. A handle names who
// may push (git.mjs); today that is only Locus, given his by license.mjs.
//
// Money and identity are the two things this project cannot afford to lose,
// so every write here is a single statement or a transaction, and every
// lookup by a Stripe id is idempotent: a webhook delivered twice issues one
// key, not two.

import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const PRODUCT = 'code';
export const OS_PRODUCT = 'os';
const PRODUCTS = new Set([PRODUCT, OS_PRODUCT]);
export const KEY_PATTERN = /^ic_[a-f0-9]{40}$/;
// A pusher's name (git.mjs, hooks/pre-receive.mjs).
export const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
// Words a branch folder must not be, and Locus, whose folder is main
// (license.mjs can still hand out any of them).
const RESERVED = new Set(['main', 'master', 'head', 'heads', 'tags', 'refs', 'imperfect', 'admin', 'store', 'community', 'locus']);

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
export const RESERVED_USERNAMES = new Set(['www', 'store', 'demo', 'mail', 'admin', 'api', 'noah', 'locus', 'vaita', 'imperfect', 'root', 'support', 'help', 'status', 'auth', 'account', 'accounts', 'login', 'logout', 'signup', 'billing', 'checkout', 'payments', 'operator', 'system', 'static', 'assets', 'cdn', 'ftp', 'smtp', 'imap', 'pop', 'webmail', 'ns1', 'ns2', 'dns', 'localhost', 'test', 'testing', 'development', 'staging', 'dev', 'app', 'apps', 'cloud', 'computer', 'computers', 'door', 'security', 'abuse', 'postmaster', 'autoconfig', 'autodiscover', 'mta-sts', 'community', 'main', 'master']);
export const COMPUTER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const COMPUTER_STATES = new Set(['provisioning', 'ready', 'stopped', 'failed']);
const accountError = (message, status = 400) => Object.assign(new Error(message), { status });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rentals (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_licenses (
  key TEXT PRIMARY KEY REFERENCES licenses(key),
  account_id TEXT NOT NULL REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS rental_mail (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS buyers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  stripe_customer TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS licenses (
  key TEXT PRIMARY KEY,
  buyer_id TEXT NOT NULL REFERENCES buyers(id),
  product TEXT NOT NULL,
  stripe_session TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  downloads INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS licenses_buyer ON licenses(buyer_id);
CREATE TABLE IF NOT EXISTS releases (
  version TEXT PRIMARY KEY,
  commit_id TEXT NOT NULL,
  notes TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS waiting (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  password_hash TEXT,
  email TEXT NOT NULL DEFAULT '',
  email_verified_at INTEGER,
  recovery_saved_at INTEGER,
  credential_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_recovery (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  code_hash TEXT NOT NULL,
  PRIMARY KEY(account_id, code_hash)
);
CREATE TABLE IF NOT EXISTS account_resets (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('password', 'codes')),
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS account_resets_purpose ON account_resets(account_id, purpose);
CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  computer_id TEXT NOT NULL REFERENCES account_computers(computer_id),
  username TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  label TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_devices (
  device_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  computer_id TEXT NOT NULL REFERENCES account_computers(computer_id),
  username TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS desktop_devices_account ON desktop_devices(account_id);
CREATE TABLE IF NOT EXISTS desktop_refresh (
  token_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS desktop_access (
  token_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES desktop_devices(device_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_refresh_device ON desktop_refresh(device_id);
CREATE INDEX IF NOT EXISTS desktop_access_device ON desktop_access(device_id);
CREATE TABLE IF NOT EXISTS account_computers (
  computer_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL UNIQUE REFERENCES accounts(id),
  username TEXT NOT NULL UNIQUE REFERENCES accounts(username),
  state TEXT NOT NULL CHECK(state IN ('provisioning','ready','stopped','failed'))
);
`;

const id = () => randomBytes(12).toString('hex');
const newKey = () => `ic_${randomBytes(20).toString('hex')}`;
const normalEmail = email => String(email ?? '').trim().toLowerCase();

export function validEmail(email) {
  const value = normalEmail(email);
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : '';
}

export function openStore(path = ':memory:', { now = Date.now } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Old development accounts keep their immutable username/registry binding,
  // but have no usable password until an operator hands them a reset link.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [column, definition] of Object.entries({ password_hash: 'TEXT', email: "TEXT NOT NULL DEFAULT ''", email_verified_at: 'INTEGER', recovery_saved_at: 'INTEGER', credential_version: 'INTEGER NOT NULL DEFAULT 0' })) {
      if (!db.prepare("SELECT 1 FROM pragma_table_info('accounts') WHERE name = ?").get(column)) db.exec(`ALTER TABLE accounts ADD COLUMN ${column} ${definition}`);
    }
    db.exec(`DROP TABLE IF EXISTS identities; DROP TABLE IF EXISTS oauth_states;
      DELETE FROM account_sessions WHERE account_id IN (SELECT id FROM accounts WHERE password_hash IS NULL);
      DELETE FROM desktop_codes WHERE account_id IN (SELECT id FROM accounts WHERE password_hash IS NULL);`);
    db.prepare('UPDATE desktop_devices SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id IN (SELECT id FROM accounts WHERE password_hash IS NULL)').run(now());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  // Handles came after the first buyers (2026-09-26).
  if (!db.prepare("SELECT 1 FROM pragma_table_info('buyers') WHERE name = 'handle'").get()) db.exec('ALTER TABLE buyers ADD COLUMN handle TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS buyers_handle ON buyers(handle)');
  // Every member has a number, in the order they joined: the one written on
  // the drive the thanks page hands them. Kept in its own column because
  // SQLite may renumber a table's hidden rowids. (Added 2026-09-26; the
  // members before it are numbered by when they joined.)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('buyers') WHERE name = 'number'").get()) {
    db.exec('ALTER TABLE buyers ADD COLUMN number INTEGER');
    const earlier = db.prepare('SELECT id FROM buyers ORDER BY created_at, rowid').all();
    earlier.forEach((row, i) => db.prepare('UPDATE buyers SET number = ? WHERE id = ?').run(i + 1, row.id));
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS buyers_number ON buyers(number)');
  const q = new Map();
  const prepare = sql => {
    if (!q.has(sql)) q.set(sql, db.prepare(sql));
    return q.get(sql);
  };
  const one = (sql, ...args) => prepare(sql).get(...args) ?? null;
  const all = (sql, ...args) => prepare(sql).all(...args);
  const run = (sql, ...args) => prepare(sql).run(...args);
  // Re-entrant: an inner call joins the outer transaction, so ensuring the
  // buyer inside issuing a key is still one atomic write.
  let depth = 0;
  const transaction = fn => {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth += 1;
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { depth -= 1; }
  };

  // All grant operations re-check the immutable registry binding in the same
  // transaction as issuance. Rotated refresh hashes remain as reuse tombstones.
  const desktopReady = row => {
    const computer = store.computerById(row.computer_id);
    const account = store.account(row.account_id);
    return computer?.state === 'ready' && computer.owner === row.account_id
      && computer.username === row.username && account?.username === row.username;
  };
  const issueDesktopTokens = (device, { accessHash, refreshHash, accessExpiresAt }) => {
    const expiry = Math.min(accessExpiresAt, now() + 300_000, device.expires_at);
    if (!Number.isSafeInteger(expiry) || expiry <= now()) return null;
    run('DELETE FROM desktop_access WHERE expires_at <= ?', now());
    run('INSERT INTO desktop_access VALUES (?, ?, ?)', accessHash, device.device_id, expiry);
    run('INSERT INTO desktop_refresh VALUES (?, ?, NULL)', refreshHash, device.device_id);
    run('UPDATE desktop_devices SET last_used_at = ? WHERE device_id = ?', now(), device.device_id);
    return { ...device, access_expires_at: expiry };
  };
  const store = {
    rentalTransaction(fn) { return transaction(fn); },
    rental(accountId) { const row = one('SELECT data FROM rentals WHERE account_id = ?', accountId); return row ? JSON.parse(row.data) : null; },
    saveRental(row, { mailId, note } = {}) {
      return transaction(() => {
        if (!store.account(row.accountId)) throw accountError('no such account', 404);
        run('INSERT INTO rentals VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET data = excluded.data', row.accountId, JSON.stringify(row));
        if (mailId && note) store.queueRentalMail(mailId, note);
        return row;
      });
    },
    rentals() { return all('SELECT data FROM rentals').map(row => JSON.parse(row.data)); },
    queueRentalMail(id, note) { run('INSERT OR IGNORE INTO rental_mail (id, data) VALUES (?, ?)', id, JSON.stringify(note)); },
    pendingRentalMail() { return all('SELECT id, data FROM rental_mail WHERE sent = 0').map(row => ({ id: row.id, ...JSON.parse(row.data) })); },
    sentRentalMail(id) { run('UPDATE rental_mail SET sent = 1 WHERE id = ?', id); },
    linkLicense(key, accountId) {
      if (store.account(accountId)) run('INSERT OR IGNORE INTO account_licenses VALUES (?, ?)', key, accountId);
    },
    accountLicenses(accountId) { return all('SELECT l.* FROM licenses l JOIN account_licenses a ON a.key = l.key WHERE a.account_id = ?', accountId); },
    // Accounts are separate from checkout buyers. Email is unverified metadata.
    account(accountId) { return one('SELECT * FROM accounts WHERE id = ?', accountId); },
    accountByUsername(username) { return one('SELECT * FROM accounts WHERE username = ?', username); },
    createAccount({ username, name, passwordHash, email = '', recoveryHashes = [] }) {
      if (typeof passwordHash !== 'string' || !passwordHash || passwordHash.length > 200) throw accountError('invalid password');
      const cleanEmail = email === '' ? '' : validEmail(email);
      if (typeof email !== 'string' || (email !== '' && !cleanEmail)) throw accountError('enter a valid email or leave it blank');
      return transaction(() => {
        const accountId = randomUUID();
        run('INSERT INTO accounts (id, created_at, password_hash, email) VALUES (?, ?, ?, ?)', accountId, now(), passwordHash, cleanEmail);
        store.claimUsername(accountId, username, name);
        store.replaceRecoveryCodes(accountId, recoveryHashes);
        return store.account(accountId);
      });
    },
    // Transparent login upgrades retain existing sessions/devices and their
    // credential version. A concurrent password reset makes this CAS fail.
    upgradePassword(accountId, expectedHash, passwordHash) {
      if (typeof expectedHash !== 'string' || typeof passwordHash !== 'string' || !passwordHash || passwordHash.length > 200) return false;
      return transaction(() => run('UPDATE accounts SET password_hash = ? WHERE id = ? AND password_hash = ?', passwordHash, accountId, expectedHash).changes === 1);
    },
    replacePassword(accountId, { expectedHash, passwordHash, keepSessionHash = null, recoveryHash = null, resetHash = null }) {
      return transaction(() => {
        const account = store.account(accountId);
        if (!account || (expectedHash !== undefined && account.password_hash !== expectedHash)
          || typeof passwordHash !== 'string' || !passwordHash || passwordHash.length > 200) throw accountError('that request could not be completed');
        if (recoveryHash !== null && !one('DELETE FROM account_recovery WHERE account_id = ? AND code_hash = ? RETURNING code_hash', accountId, recoveryHash)) throw accountError('that request could not be completed');
        if (resetHash !== null && !one("DELETE FROM account_resets WHERE account_id = ? AND token_hash = ? AND purpose = 'password' AND expires_at > ? RETURNING token_hash", accountId, resetHash, now())) throw accountError('that request could not be completed');
        run('UPDATE accounts SET password_hash = ?, credential_version = credential_version + 1 WHERE id = ?', passwordHash, accountId);
        // Revocation and the version bump commit together. A login whose scrypt
        // started before this transaction cannot save a stale browser session.
        store.removeAccountSessions(accountId, keepSessionHash);
        store.revokeAccountDesktopDevices(accountId);
        run('DELETE FROM account_resets WHERE account_id = ?', accountId);
        return store.account(accountId);
      });
    },
    replaceRecoveryCodes(accountId, hashes, { resetHash = null, expectedHash = null } = {}) {
      if (!Array.isArray(hashes) || ![0, 8].includes(hashes.length) || new Set(hashes).size !== hashes.length || hashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw accountError('invalid recovery codes');
      return transaction(() => {
        const account = store.account(accountId);
        if (!account || (expectedHash !== null && account.password_hash !== expectedHash)) throw accountError('that request could not be completed');
        if (resetHash !== null && !one("DELETE FROM account_resets WHERE account_id = ? AND token_hash = ? AND purpose = 'codes' AND expires_at > ? RETURNING token_hash", accountId, resetHash, now())) throw accountError('that request could not be completed');
        run('DELETE FROM account_recovery WHERE account_id = ?', accountId);
        for (const hash of hashes) run('INSERT INTO account_recovery VALUES (?, ?)', accountId, hash);
        run('UPDATE accounts SET recovery_saved_at = NULL WHERE id = ?', accountId);
        // Replacing recovery credentials invalidates every previously handed
        // out operator link, including links for a different reset purpose.
        run('DELETE FROM account_resets WHERE account_id = ?', accountId);
        // A codes-reset link is itself a recovered credential: revoke existing
        // logins and prevent any already-verifying login from surviving it.
        if (resetHash !== null) store.signOutEverywhere(accountId);
        return store.account(accountId);
      });
    },
    markRecoverySaved(accountId) { run('UPDATE accounts SET recovery_saved_at = ? WHERE id = ?', now(), accountId); },
    recoveryAvailable(accountId, hash) { return one('SELECT code_hash FROM account_recovery WHERE account_id = ? AND code_hash = ?', accountId, hash); },
    resetToken(hash) { return one('SELECT * FROM account_resets WHERE token_hash = ? AND expires_at > ?', hash, now()); },
    issueAccountReset(accountId, { tokenHash, purpose = 'password', expiresAt }) {
      if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash) || !['password', 'codes'].includes(purpose) || !Number.isSafeInteger(expiresAt) || expiresAt <= now() || expiresAt > now() + 86400_000) throw accountError('invalid reset request');
      return transaction(() => {
        if (!store.account(accountId)) throw accountError('no such account', 404);
        run('DELETE FROM account_resets WHERE expires_at <= ?', now());
        run('DELETE FROM account_resets WHERE account_id = ? AND purpose = ?', accountId, purpose);
        run('INSERT INTO account_resets VALUES (?, ?, ?, ?)', tokenHash, accountId, purpose, expiresAt);
        return store.resetToken(tokenHash);
      });
    },
    signOutEverywhere(accountId) {
      return transaction(() => {
        run('UPDATE accounts SET credential_version = credential_version + 1 WHERE id = ?', accountId);
        store.removeAccountSessions(accountId);
        store.revokeAccountDesktopDevices(accountId);
        run('DELETE FROM account_resets WHERE account_id = ?', accountId);
        return store.account(accountId);
      });
    },
    removeAccountSessions(accountId, exceptHash = null) {
      return transaction(() => {
        if (exceptHash === null) run('DELETE FROM account_sessions WHERE account_id = ?', accountId);
        else run('DELETE FROM account_sessions WHERE account_id = ? AND token_hash != ?', accountId, exceptHash);
      });
    },
    claimUsername(accountId, username, name) {
      if (typeof username !== 'string' || !USERNAME_PATTERN.test(username) || RESERVED_USERNAMES.has(username)) throw accountError('choose 3–20 lowercase letters, digits or hyphens, starting and ending with a letter or digit; reserved names are unavailable');
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw accountError('enter your name (1–100 characters)');
      return transaction(() => {
        const account = store.account(accountId);
        if (!account) throw accountError('sign in first', 401);
        if (account.username && account.username !== username) throw accountError('your username is already chosen', 409);
        const taken = store.accountByUsername(username);
        if (taken && taken.id !== accountId) throw accountError('that username is taken', 409);
        run('UPDATE accounts SET username = ?, name = ? WHERE id = ?', username, name.trim(), accountId);
        return store.account(accountId);
      });
    },
    saveAccountSession({ tokenHash, accountId, csrf, expiresAt, credentialVersion }, version = credentialVersion) {
      return transaction(() => {
        const account = store.account(accountId);
        if (!account || (version !== undefined && account.credential_version !== version)) return false;
        run('DELETE FROM account_sessions WHERE expires_at <= ?', now());
        run('INSERT INTO account_sessions VALUES (?, ?, ?, ?)', tokenHash, accountId, csrf, expiresAt);
        return true;
      });
    },
    accountSession(tokenHash) { return one('SELECT * FROM account_sessions WHERE token_hash = ? AND expires_at > ?', tokenHash, now()); },
    deleteAccountSession(tokenHash) { run('DELETE FROM account_sessions WHERE token_hash = ?', tokenHash); },
    computerById(computerId) { return one('SELECT * FROM account_computers WHERE computer_id = ?', computerId); },
    computerByUsername(username) { return one('SELECT * FROM account_computers WHERE username = ?', username); },
    registerComputer({ username, computerId, state }) {
      if (typeof username !== 'string' || typeof computerId !== 'string' || !COMPUTER_ID_PATTERN.test(computerId) || !COMPUTER_STATES.has(state)) throw accountError('invalid registration');
      return transaction(() => {
        const account = store.accountByUsername(username);
        if (!account) throw accountError('no such account', 404);
        const existing = store.computerByUsername(username);
        const byId = store.computerById(computerId);
        if ((existing && (existing.computer_id !== computerId || existing.owner !== account.id)) || (byId && (byId.owner !== account.id || byId.username !== username))) throw accountError('computer ownership and id are immutable', 409);
        run('INSERT INTO account_computers (computer_id, owner, username, state) VALUES (?, ?, ?, ?) ON CONFLICT(computer_id) DO UPDATE SET state = excluded.state', computerId, account.id, username, state);
        return store.computerById(computerId);
      });
    },

    saveDesktopCode({ codeHash, accountId, computerId, username, redirectUri, challenge, label, expiresAt }) {
      return transaction(() => {
        if (!desktopReady({ account_id: accountId, computer_id: computerId, username })) return false;
        run('DELETE FROM desktop_codes WHERE expires_at <= ?', now());
        run('INSERT INTO desktop_codes VALUES (?, ?, ?, ?, ?, ?, ?, ?)', codeHash, accountId, computerId, username, redirectUri, challenge, label, Math.min(expiresAt, now() + 60_000));
        return true;
      });
    },
    redeemDesktopCode({ codeHash, redirectUri, challenge, deviceId, accessHash, refreshHash, accessExpiresAt }) {
      return transaction(() => {
        // A failed proof also burns the code; a replay can never mint a device.
        const code = one('DELETE FROM desktop_codes WHERE code_hash = ? RETURNING *', codeHash);
        if (!code || code.expires_at <= now() || code.redirect_uri !== redirectUri || code.challenge !== challenge || !desktopReady(code)) return null;
        run('DELETE FROM desktop_devices WHERE expires_at <= ?', now());
        if (one('SELECT COUNT(*) AS n FROM desktop_devices WHERE account_id = ? AND revoked_at IS NULL', code.account_id).n >= 100) return null;
        run('INSERT INTO desktop_devices VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)', deviceId, code.account_id, code.computer_id, code.username, code.label, now(), now(), now() + 30 * 86400_000);
        return issueDesktopTokens(one('SELECT * FROM desktop_devices WHERE device_id = ?', deviceId), { accessHash, refreshHash, accessExpiresAt });
      });
    },
    rotateDesktopRefresh({ tokenHash, accessHash, refreshHash, accessExpiresAt }) {
      return transaction(() => {
        const token = one('SELECT * FROM desktop_refresh WHERE token_hash = ?', tokenHash);
        if (!token) return null;
        const device = one('SELECT * FROM desktop_devices WHERE device_id = ?', token.device_id);
        if (token.used_at !== null) {
          run('UPDATE desktop_devices SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ?', now(), token.device_id);
          return null; // Commit revocation, never throw/roll it back.
        }
        if (!device || device.revoked_at !== null || device.expires_at <= now() || !desktopReady(device)) return null;
        run('UPDATE desktop_refresh SET used_at = ? WHERE token_hash = ?', now(), tokenHash);
        return issueDesktopTokens(device, { accessHash, refreshHash, accessExpiresAt });
      });
    },
    desktopAccess(tokenHash) {
      return transaction(() => {
        const device = one('SELECT d.*, a.expires_at AS access_expires_at FROM desktop_access a JOIN desktop_devices d USING(device_id) WHERE a.token_hash = ? AND a.expires_at > ? AND d.expires_at > ? AND d.revoked_at IS NULL', tokenHash, now(), now());
        if (!device || !desktopReady(device)) return null;
        run('UPDATE desktop_devices SET last_used_at = ? WHERE device_id = ?', now(), device.device_id);
        return device;
      });
    },
    revokeDesktopRefresh(tokenHash) {
      run('UPDATE desktop_devices SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = (SELECT device_id FROM desktop_refresh WHERE token_hash = ?)', now(), tokenHash);
    },
    revokeDesktopDevice(accountId, deviceId) {
      run('UPDATE desktop_devices SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id = ? AND device_id = ?', now(), accountId, deviceId);
    },
    revokeAccountDesktopDevices(accountId) {
      return transaction(() => {
        run('DELETE FROM desktop_codes WHERE account_id = ?', accountId);
        run('UPDATE desktop_devices SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id = ?', now(), accountId);
      });
    },
    desktopDevices(accountId) {
      return all('SELECT device_id, label, created_at, last_used_at, expires_at, revoked_at FROM desktop_devices WHERE account_id = ? AND expires_at > ? ORDER BY (revoked_at IS NOT NULL), created_at DESC LIMIT 100', accountId, now());
    },

    // -- buyers -----------------------------------------------------------
    buyer(buyerId) { return one('SELECT * FROM buyers WHERE id = ?', buyerId); },
    buyerByEmail(email) { return one('SELECT * FROM buyers WHERE email = ?', normalEmail(email)); },
    ensureBuyer(email, { stripeCustomer = null } = {}) {
      const clean = validEmail(email);
      if (!clean) throw new Error('a valid email is required');
      return transaction(() => {
        const found = store.buyerByEmail(clean);
        if (found) {
          if (stripeCustomer && found.stripe_customer !== stripeCustomer) {
            run('UPDATE buyers SET stripe_customer = ? WHERE id = ?', stripeCustomer, found.id);
            return store.buyer(found.id);
          }
          return found;
        }
        const buyerId = id();
        run('INSERT INTO buyers (id, email, stripe_customer, created_at, number) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(number), 0) + 1 FROM buyers))', buyerId, clean, stripeCustomer, now());
        return store.buyer(buyerId);
      });
    },

    // Chosen once. A member cannot rename themself: their branches are
    // already under the old name in everyone's clones.
    claimHandle(buyerId, handle, { operator = false } = {}) {
      const wanted = String(handle ?? '').trim().toLowerCase();
      if (!HANDLE_PATTERN.test(wanted) || (!operator && RESERVED.has(wanted))) throw new Error('a handle is 1 to 24 lower-case letters, digits and dashes (not starting or ending with a dash), and not a reserved word');
      return transaction(() => {
        const buyer = store.buyer(buyerId);
        if (!buyer) throw new Error('no such member');
        if (buyer.handle === wanted) return buyer;
        if (buyer.handle && !operator) throw new Error(`your handle is already ${buyer.handle}`);
        if (one('SELECT 1 FROM buyers WHERE handle = ?', wanted)) throw new Error(`${wanted} is taken`);
        run('UPDATE buyers SET handle = ? WHERE id = ?', wanted, buyerId);
        return store.buyer(buyerId);
      });
    },

    // -- licenses ---------------------------------------------------------
    license(key) { return one('SELECT * FROM licenses WHERE key = ?', String(key ?? '')); },
    licenseBySession(sessionId) { return one('SELECT * FROM licenses WHERE stripe_session = ?', String(sessionId ?? '')); },
    licensesByEmail(email) {
      const buyer = store.buyerByEmail(email);
      return buyer ? all('SELECT * FROM licenses WHERE buyer_id = ? ORDER BY created_at', buyer.id) : [];
    },
    // Issuing is keyed on the Stripe checkout session when there is one, so a
    // retried webhook or a refreshed thank-you page returns the same key.
    issueLicense({ email, stripeSession = null, stripeCustomer = null, product = PRODUCT, accountId = null }) {
      if (!PRODUCTS.has(product)) throw new Error('unknown licence product');
      return transaction(() => {
        if (stripeSession) {
          const existing = store.licenseBySession(stripeSession);
          if (existing) {
            if (existing.product !== product) throw new Error('checkout session belongs to a different product');
            return existing;
          }
        }
        const buyer = store.ensureBuyer(email, { stripeCustomer });
        const key = newKey();
        run('INSERT INTO licenses (key, buyer_id, product, stripe_session, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', key, buyer.id, product, stripeSession, 'active', now());
        if (accountId) store.linkLicense(key, accountId);
        return store.license(key);
      });
    },
    // A key that opens something. Revoked and misshapen keys are the same
    // answer: null.
    activeLicense(key, product = PRODUCT) {
      if (!PRODUCTS.has(product) || !KEY_PATTERN.test(String(key ?? ''))) return null;
      const row = store.license(key);
      // OS includes the app; legacy app licences never acquire OS access.
      const entitled = row && (row.product === product || (product === PRODUCT && row.product === OS_PRODUCT));
      return entitled && row.status === 'active' ? row : null;
    },
    countDownload(key) { run('UPDATE licenses SET downloads = downloads + 1, last_used_at = ? WHERE key = ?', now(), key); },
    revokeLicense(key) { run("UPDATE licenses SET status = 'revoked' WHERE key = ?", key); return store.license(key); },
    // -- releases ---------------------------------------------------------
    // -- told when the till opens -------------------------------------------
    wait(email) {
      const clean = validEmail(email);
      if (!clean) throw new Error('a valid email is required');
      run('INSERT OR IGNORE INTO waiting (email, created_at) VALUES (?, ?)', clean, now());
      return clean;
    },
    waiting() { return all('SELECT * FROM waiting ORDER BY created_at').map(row => row.email); },

    latestRelease() { return one('SELECT * FROM releases ORDER BY created_at DESC, rowid DESC LIMIT 1'); },
    // A version is a name for a commit; every key goes on opening.
    release({ version, commit, notes }) {
      run('INSERT INTO releases (version, commit_id, notes, created_at) VALUES (?, ?, ?, ?)', String(version), String(commit), String(notes), now());
      return store.latestRelease();
    },
    // Who hears about a version: every member with a key that still opens.
    members() { return all("SELECT DISTINCT b.email FROM buyers b JOIN licenses l ON l.buyer_id = b.id WHERE l.status = 'active' ORDER BY b.email").map(row => row.email); },
    listLicenses() { return all('SELECT l.*, b.email, b.handle FROM licenses l JOIN buyers b ON b.id = l.buyer_id ORDER BY l.created_at'); },

    // -- webhook idempotency ---------------------------------------------
    seenEvent(eventId) { return Boolean(one('SELECT 1 FROM events WHERE id = ?', String(eventId))); },
    firstSeen(eventId, kind) {
      try { run('INSERT INTO events (id, kind, seen_at) VALUES (?, ?, ?)', String(eventId), String(kind), now()); return true; }
      catch (error) { if (/UNIQUE/.test(error.message)) return false; throw error; }
    },
    forgetEvent(eventId) { run('DELETE FROM events WHERE id = ?', String(eventId)); },

    close() { db.close(); },
  };
  return store;
}
