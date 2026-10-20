import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../store.mjs';
import { digest } from '../account-security.mjs';
import { run } from '../tools/accounts.mjs';

const hashes = prefix => Array.from({ length: 8 }, (_, i) => digest(`${prefix}-${i}`));
const fail = error => error.status === 400 && error.message === 'that request could not be completed';
function fixture(t, path) {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const store = openStore(path, { now });
  t.after(() => store.close());
  const create = (username = 'alice', extra = {}) => store.createAccount({ username, name: 'Alice Example', passwordHash: 'old-hash', recoveryHashes: hashes(username), ...extra });
  const session = (account, hash, version = account.credential_version) => store.saveAccountSession({ accountId: account.id, tokenHash: hash, csrf: 'csrf', expiresAt: now() + 600_000, credentialVersion: version });
  return { store, now, create, session, advance: amount => { clock += amount; } };
}
function databasePath(t) {
  const folder = mkdtempSync(join(tmpdir(), 'account-store-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return join(folder, 'test.sqlite');
}
function desktop(f, account, label) {
  const computerId = `computer-${account.username}`;
  f.store.registerComputer({ username: account.username, computerId, state: 'ready' });
  const code = { codeHash: `${label}-code`, accountId: account.id, computerId, username: account.username, redirectUri: 'http://127.0.0.1:9001/callback', challenge: 'challenge', label, expiresAt: f.now() + 60_000 };
  assert.equal(f.store.saveDesktopCode(code), true);
  const device = f.store.redeemDesktopCode({ codeHash: code.codeHash, redirectUri: code.redirectUri, challenge: code.challenge, deviceId: `${label}-device`, accessHash: `${label}-access`, refreshHash: `${label}-refresh`, accessExpiresAt: f.now() + 300_000 });
  assert.ok(device);
  f.store.saveDesktopCode({ ...code, codeHash: `${label}-unused` });
  return code;
}

test('createAccount claims username/name/password/email and recovery atomically; usernames stay immutable', t => {
  const f = fixture(t), account = f.create('alice', { email: ' Alice@Example.COM ', name: '  Alice Example  ' });
  assert.equal(account.username, 'alice');
  assert.equal(account.name, 'Alice Example');
  assert.equal(account.email, 'alice@example.com');
  assert.equal(account.password_hash, 'old-hash');
  assert.equal(account.email_verified_at, null);
  assert.equal(account.recovery_saved_at, null);
  assert.equal(account.credential_version, 0);
  assert.equal(f.store.accountByUsername('alice').id, account.id);
  assert.ok(f.store.recoveryAvailable(account.id, hashes('alice')[0]));
  assert.throws(() => f.create('alice'), error => error.status === 409 && error.message === 'that username is taken');
  assert.throws(() => f.store.claimUsername(account.id, 'alicia', 'Alice'), /already chosen/);
  assert.equal(f.store.accountByUsername('alicia'), null);
  assert.equal(f.create('bob').email, '');
});

test('all username/name/email rules are enforced before a failed signup can leave a row', t => {
  const path = databasePath(t), f = fixture(t, path);
  for (const username of ['aa', 'a'.repeat(21), 'Alice', '-alice', 'alice-', 'alice.bob', 'admin', 'www', 'noah', 'login', 'account']) assert.throws(() => f.create(username), error => error.status === 400);
  for (const name of ['', '   ', 'a'.repeat(101), 'Alice\nExample', null]) assert.throws(() => f.create('valid-user', { name }), error => error.status === 400);
  for (const email of ['broken', '@example.com', 'a@', 'a b@example.com', 3, null]) assert.throws(() => f.create('valid-user', { email }), error => error.status === 400);
  assert.throws(() => f.create('valid-user', { passwordHash: '' }), error => error.status === 400);
  assert.throws(() => f.create('valid-user', { recoveryHashes: [digest('only-one')] }), /invalid recovery/);
  const observer = new DatabaseSync(path);
  try { assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 0); }
  finally { observer.close(); }
  assert.equal(f.create('valid-user').username, 'valid-user');
});

test('two store connections cannot claim one username, or overwrite a password verified before a reset', t => {
  const path = databasePath(t), first = fixture(t, path), second = fixture(t, path);
  const account = first.create();
  assert.throws(() => second.create(), error => error.status === 409);
  assert.equal(second.session(account, 'pre-reset'), true);
  const changed = first.store.replacePassword(account.id, { expectedHash: 'old-hash', passwordHash: 'new-hash' });
  assert.equal(changed.credential_version, 1);
  assert.throws(() => second.store.replacePassword(account.id, { expectedHash: 'old-hash', passwordHash: 'stale-hash' }), fail);
  assert.equal(second.store.account(account.id).password_hash, 'new-hash');
  assert.equal(second.session(account, 'stale-login'), false);
  assert.equal(second.store.accountSession('stale-login'), null);
  assert.equal(second.store.accountSession('pre-reset'), null);
  assert.equal(second.session(changed, 'fresh-login'), true);
});

test('password replacement revokes all other browser sessions, desktop devices and pending codes', t => {
  const f = fixture(t), alice = f.create(), bob = f.create('bob');
  f.session(alice, 'keep'); f.session(alice, 'remove'); f.session(bob, 'bob-session');
  const code = desktop(f, alice, 'alice'), bobCode = desktop(f, bob, 'bob');
  assert.ok(f.store.desktopAccess('alice-access'));
  f.store.issueAccountReset(alice.id, { tokenHash: digest('reset'), expiresAt: f.now() + 1000 });
  f.store.replacePassword(alice.id, { expectedHash: 'old-hash', passwordHash: 'changed-hash', keepSessionHash: 'keep' });
  assert.ok(f.store.accountSession('keep'));
  assert.equal(f.store.accountSession('remove'), null);
  assert.ok(f.store.accountSession('bob-session'));
  assert.equal(f.store.desktopAccess('alice-access'), null);
  assert.ok(f.store.desktopDevices(alice.id)[0].revoked_at);
  assert.equal(f.store.rotateDesktopRefresh({ tokenHash: 'alice-refresh', accessHash: 'replay', refreshHash: 'replay', accessExpiresAt: f.now() + 1000 }), null);
  const redeem = source => f.store.redeemDesktopCode({ codeHash: `${source.label}-unused`, redirectUri: source.redirectUri, challenge: source.challenge, deviceId: `${source.label}-device2`, accessHash: `${source.label}-access2`, refreshHash: `${source.label}-refresh2`, accessExpiresAt: f.now() + 1000 });
  assert.equal(redeem(code), null);
  assert.ok(redeem(bobCode));
  assert.ok(f.store.desktopAccess('bob-access'));
  assert.equal(f.store.resetToken(digest('reset')), null);
});

test('recovery codes are account-scoped and single-use; failures roll back every mutation', t => {
  const f = fixture(t), alice = f.create(), bob = f.create('bob');
  f.session(alice, 'stay-until-success');
  const recoveryHash = hashes('alice')[0];
  for (const options of [
    { recoveryHash: hashes('bob')[0] },
    { recoveryHash, expectedHash: 'stale' },
    { recoveryHash, resetHash: digest('nonexistent') },
  ]) {
    assert.throws(() => f.store.replacePassword(alice.id, { passwordHash: 'changed', ...options }), fail);
    assert.ok(f.store.recoveryAvailable(alice.id, recoveryHash));
    assert.equal(f.store.account(alice.id).password_hash, 'old-hash');
    assert.equal(f.store.account(alice.id).credential_version, 0);
    assert.ok(f.store.accountSession('stay-until-success'));
  }
  f.store.replacePassword(alice.id, { passwordHash: 'changed', recoveryHash });
  assert.equal(f.store.recoveryAvailable(alice.id, recoveryHash), null);
  assert.ok(f.store.recoveryAvailable(alice.id, hashes('alice')[1]));
  assert.ok(f.store.recoveryAvailable(bob.id, hashes('bob')[0]));
  assert.equal(f.store.accountSession('stay-until-success'), null);
  assert.throws(() => f.store.replacePassword(alice.id, { passwordHash: 'replayed', recoveryHash }), fail);
  assert.equal(f.store.account(alice.id).password_hash, 'changed');
});

test('operator reset tokens expire, are purpose-bound, replace older tokens and cannot be replayed', t => {
  const f = fixture(t), alice = f.create(), bob = f.create('bob');
  const issue = (token, purpose = 'password', accountId = alice.id) => f.store.issueAccountReset(accountId, { tokenHash: digest(token), purpose, expiresAt: f.now() + 1000 });
  issue('old'); issue('fresh'); issue('codes', 'codes');
  assert.equal(f.store.resetToken(digest('old')), null);
  assert.equal(f.store.resetToken(digest('fresh')).purpose, 'password');
  assert.equal(f.store.resetToken(digest('codes')).account_id, alice.id);
  assert.throws(() => f.store.replacePassword(bob.id, { passwordHash: 'changed', resetHash: digest('fresh') }), fail);
  assert.throws(() => f.store.replacePassword(alice.id, { passwordHash: 'changed', resetHash: digest('codes') }), fail);
  assert.throws(() => f.store.replaceRecoveryCodes(alice.id, hashes('new'), { resetHash: digest('fresh') }), fail);
  assert.ok(f.store.resetToken(digest('fresh')));
  f.store.replacePassword(alice.id, { passwordHash: 'changed', resetHash: digest('fresh') });
  assert.equal(f.store.resetToken(digest('fresh')), null);
  assert.equal(f.store.resetToken(digest('codes')), null, 'password replacement invalidates all operator links');
  assert.throws(() => f.store.replacePassword(alice.id, { passwordHash: 'replay', resetHash: digest('fresh') }), fail);
  issue('expired'); f.advance(1000);
  assert.equal(f.store.resetToken(digest('expired')), null);
  assert.throws(() => f.store.replacePassword(alice.id, { passwordHash: 'late', resetHash: digest('expired') }), fail);
  assert.equal(f.store.account(alice.id).password_hash, 'changed');
});

test('recovery regeneration revokes old codes, consumes codes-reset atomically and clears saved confirmation', t => {
  const f = fixture(t), alice = f.create();
  f.session(alice, 'codes-reset-session');
  desktop(f, alice, 'codes-reset');
  f.store.markRecoverySaved(alice.id);
  assert.equal(f.store.account(alice.id).recovery_saved_at, f.now());
  f.store.issueAccountReset(alice.id, { tokenHash: digest('earlier-password-link'), purpose: 'password', expiresAt: f.now() + 1000 });
  f.store.issueAccountReset(alice.id, { tokenHash: digest('codes-reset'), purpose: 'codes', expiresAt: f.now() + 1000 });
  const fresh = hashes('fresh');
  assert.throws(() => f.store.replaceRecoveryCodes(alice.id, fresh, { expectedHash: 'stale', resetHash: digest('codes-reset') }), fail);
  assert.ok(f.store.recoveryAvailable(alice.id, hashes('alice')[0]));
  assert.ok(f.store.resetToken(digest('codes-reset')));
  assert.throws(() => f.store.replaceRecoveryCodes(alice.id, Array(8).fill(digest('duplicate')), { resetHash: digest('codes-reset') }), /invalid recovery/);
  const row = f.store.replaceRecoveryCodes(alice.id, fresh, { expectedHash: 'old-hash', resetHash: digest('codes-reset') });
  assert.equal(row.recovery_saved_at, null);
  assert.equal(row.credential_version, 1);
  assert.equal(f.store.resetToken(digest('earlier-password-link')), null, 'codes recovery invalidates cross-purpose operator links');
  assert.equal(f.store.accountSession('codes-reset-session'), null);
  assert.equal(f.store.desktopAccess('codes-reset-access'), null);
  assert.equal(f.session(alice, 'login-during-codes-reset'), false);
  for (const hash of hashes('alice')) assert.equal(f.store.recoveryAvailable(alice.id, hash), null);
  for (const hash of fresh) assert.ok(f.store.recoveryAvailable(alice.id, hash));
  assert.equal(f.store.resetToken(digest('codes-reset')), null);
  assert.throws(() => f.store.replaceRecoveryCodes(alice.id, hashes('replay'), { resetHash: digest('codes-reset') }), fail);
  assert.ok(f.store.recoveryAvailable(alice.id, fresh[0]));
  f.store.markRecoverySaved(alice.id);
  f.store.issueAccountReset(alice.id, { tokenHash: digest('before-regeneration'), expiresAt: f.now() + 1000 });
  f.store.replaceRecoveryCodes(alice.id, hashes('again'), { expectedHash: 'old-hash' });
  assert.equal(f.store.account(alice.id).recovery_saved_at, null);
  assert.equal(f.store.resetToken(digest('before-regeneration')), null, 'password-confirmed regeneration also invalidates pending links');
});

test('login hash upgrades use CAS without revoking sessions or changing credential version', t => {
  const f = fixture(t), account = f.create();
  f.session(account, 'existing');
  desktop(f, account, 'upgrade');
  assert.equal(f.store.upgradePassword(account.id, 'wrong-hash', 'upgraded-hash'), false);
  assert.equal(f.store.upgradePassword(account.id, 'old-hash', 'upgraded-hash'), true);
  assert.equal(f.store.account(account.id).password_hash, 'upgraded-hash');
  assert.equal(f.store.account(account.id).credential_version, 0);
  assert.ok(f.store.accountSession('existing'));
  assert.ok(f.store.desktopAccess('upgrade-access'));
  assert.equal(f.session(account, 'login-after-upgrade'), true);
  assert.equal(f.store.upgradePassword(account.id, 'old-hash', 'stale-upgrade'), false);
  f.store.replacePassword(account.id, { passwordHash: 'reset-hash' });
  assert.equal(f.store.upgradePassword(account.id, 'upgraded-hash', 'upgrade-after-reset'), false);
  assert.equal(f.session(account, 'stale-login-after-reset'), false);
});

test('sign-out-everywhere atomically invalidates sessions/devices and pending login work', t => {
  const f = fixture(t), account = f.create(), other = f.create('other');
  f.session(account, 'existing'); f.session(other, 'other-session');
  desktop(f, account, 'everywhere');
  f.store.issueAccountReset(account.id, { tokenHash: digest('account-link'), expiresAt: f.now() + 1000 });
  f.store.issueAccountReset(other.id, { tokenHash: digest('other-link'), expiresAt: f.now() + 1000 });
  const signedOut = f.store.signOutEverywhere(account.id);
  assert.equal(f.store.resetToken(digest('account-link')), null);
  assert.ok(f.store.resetToken(digest('other-link')), 'revocation remains account scoped');
  assert.equal(signedOut.credential_version, 1);
  assert.equal(signedOut.password_hash, 'old-hash');
  assert.equal(f.store.accountSession('existing'), null);
  assert.equal(f.store.desktopAccess('everywhere-access'), null);
  assert.equal(f.session(account, 'stale-login'), false);
  assert.ok(f.store.accountSession('other-session'));
  assert.equal(f.session(signedOut, 'new-login'), true);
});

test('browser session saving is version-checked; removal and exclusions are account-scoped', t => {
  const f = fixture(t), alice = f.create(), bob = f.create('bob');
  assert.equal(f.session(alice, 'one'), true);
  assert.equal(f.session(alice, 'two'), true);
  assert.equal(f.session(bob, 'other-account'), true);
  assert.equal(f.store.saveAccountSession({ accountId: alice.id, tokenHash: 'positional', csrf: 'c', expiresAt: f.now() + 1000 }, 99), false);
  assert.equal(f.store.saveAccountSession({ accountId: 'missing', tokenHash: 'missing', csrf: 'c', expiresAt: f.now() + 1000 }), false);
  f.store.removeAccountSessions(alice.id, 'one');
  assert.ok(f.store.accountSession('one')); assert.equal(f.store.accountSession('two'), null);
  f.store.removeAccountSessions(alice.id);
  assert.equal(f.store.accountSession('one'), null); assert.ok(f.store.accountSession('other-account'));
});

test('migration preserves dev accounts with NULL passwords, removes OAuth tables and reopens twice', t => {
  const path = databasePath(t), old = new DatabaseSync(path);
  old.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, username TEXT UNIQUE, name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    INSERT INTO accounts VALUES ('legacy', 'legacy-user', 'Legacy Person', 123);
    CREATE TABLE identities (provider TEXT, subject TEXT, account_id TEXT REFERENCES accounts(id));
    INSERT INTO identities VALUES ('google', 'old-subject', 'legacy');
    CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY); INSERT INTO oauth_states VALUES ('old-state');
    CREATE TABLE account_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
    INSERT INTO account_sessions VALUES ('old-session', 'legacy', 'csrf', 999999);
    CREATE TABLE account_computers (computer_id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE REFERENCES accounts(id), username TEXT NOT NULL UNIQUE REFERENCES accounts(username), state TEXT NOT NULL);
    INSERT INTO account_computers VALUES ('legacy-computer', 'legacy', 'legacy-user', 'ready');
    CREATE TABLE desktop_devices (device_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), computer_id TEXT NOT NULL REFERENCES account_computers(computer_id), username TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
    INSERT INTO desktop_devices VALUES ('legacy-device', 'legacy', 'legacy-computer', 'legacy-user', 'Legacy desktop', 10, 10, 999999, NULL);`);
  old.close();
  for (let pass = 0; pass < 2; pass++) {
    const store = openStore(path, { now: () => 1000 });
    try {
      const account = store.accountByUsername('legacy-user');
      assert.equal(account.id, 'legacy'); assert.equal(account.name, 'Legacy Person');
      assert.equal(account.password_hash, null); assert.equal(account.email, '');
      assert.equal(account.credential_version, 0);
      assert.equal(store.ensureIdentity, undefined); assert.equal(store.saveOAuthState, undefined);
      assert.equal(store.accountSession('old-session'), null);
      assert.equal(store.desktopDevices('legacy')[0].revoked_at, 1000);
      assert.equal(store.computerByUsername('legacy-user').computer_id, 'legacy-computer');
    } finally { store.close(); }
    const inspection = new DatabaseSync(path);
    try {
      assert.equal(inspection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('identities','oauth_states')").get().n, 0);
      const columns = inspection.prepare("SELECT name, type FROM pragma_table_info('accounts')").all();
      assert.equal(columns.find(row => row.name === 'credential_version').type, 'INTEGER');
    } finally { inspection.close(); }
  }
  const migrated = openStore(path, { now: () => 1000 });
  try {
    migrated.issueAccountReset('legacy', { tokenHash: digest('operator'), expiresAt: 2000 });
    const row = migrated.replacePassword('legacy', { expectedHash: null, passwordHash: 'usable-password-hash', resetHash: digest('operator') });
    assert.equal(row.password_hash, 'usable-password-hash'); assert.equal(row.credential_version, 1);
  } finally { migrated.close(); }
});

test('operator commands synchronously print only hashed-storage one-time links, with independent purposes', t => {
  const f = fixture(t), alice = f.create();
  let output = '';
  const out = { write(value) { output += value; } };
  const settings = { now: f.now, base: 'https://store.example' };
  const command = name => {
    output = '';
    assert.equal(run(f.store, [name, 'alice'], out, settings), undefined);
    assert.match(output, /^https:\/\/store\.example\/account\/reset\?token=[A-Za-z0-9_-]{43}\n$/);
    const token = new URL(output.trim()).searchParams.get('token');
    const row = f.store.resetToken(digest(token));
    assert.equal(row.account_id, alice.id); assert.equal(row.expires_at, f.now() + 86400_000);
    assert.equal(f.store.resetToken(token), null);
    return { token, row };
  };
  const one = command('reset-password'), two = command('reset-password'), codes = command('regenerate-codes');
  assert.notEqual(one.token, two.token);
  assert.equal(one.row.purpose, 'password'); assert.equal(codes.row.purpose, 'codes');
  assert.equal(f.store.resetToken(digest(one.token)), null);
  assert.ok(f.store.resetToken(digest(two.token)));
  assert.ok(f.store.resetToken(digest(codes.token)));
  assert.equal(f.store.account(alice.id).password_hash, 'old-hash', 'issuing a link does not change credentials');
  assert.throws(() => run(f.store, ['reset-password', 'missing'], out, settings), /no such account/);
  assert.throws(() => run(f.store, ['regenerate-codes', 'alice', 'extra'], out, settings), /usage/);
  for (const base of ['http://store.example', 'https://store.example/', 'https://user:pass@store.example', 'invalid']) assert.throws(() => run(f.store, ['reset-password', 'alice'], out, { ...settings, base }), /canonical HTTPS/);
  output = '';
  run(f.store, ['reset-password', 'alice'], out, { now: f.now });
  assert.match(output, /^https:\/\/imperfect\.computer\/account\/reset\?token=/);
});

test('operator grant/revoke/list API remains synchronous and unchanged beside recovery commands', t => {
  const f = fixture(t); f.create();
  let output = '';
  const out = { write(value) { output += value; } }, settings = { now: f.now };
  assert.equal(run(f.store, ['grant', 'alice', '--tester'], out, settings), undefined);
  assert.equal(output, 'alice\ttester\tactive\n');
  output = ''; run(f.store, ['list'], out, settings);
  assert.match(output, /^alice\ttester\tactive\tprovision\n$/);
  output = ''; run(f.store, ['revoke', 'alice'], out, settings);
  assert.match(output, /^alice\ttester\tcanceled\n$/);
});

test('reset issuance validates purpose, digest and bounded lifetime before invalidating existing links', t => {
  const f = fixture(t), account = f.create();
  const tokenHash = digest('valid'), expiresAt = f.now() + 1000;
  f.store.issueAccountReset(account.id, { tokenHash, expiresAt });
  for (const patch of [{ tokenHash: 'raw-token' }, { purpose: 'email' }, { expiresAt: f.now() }, { expiresAt: f.now() + 86400_001 }, { expiresAt: 1.5 }]) assert.throws(() => f.store.issueAccountReset(account.id, { tokenHash, expiresAt, ...patch }), error => error.status === 400);
  assert.ok(f.store.resetToken(tokenHash));
});
