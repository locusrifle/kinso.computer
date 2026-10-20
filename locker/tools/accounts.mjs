#!/usr/bin/env node
// Operator-only tester grants and recovery links; never contacts another service.
import { randomBytes } from 'node:crypto';
import { digest } from '../account-security.mjs';
import { resolve } from 'node:path';
import { openStore } from '../store.mjs';
import { loadConfig } from '../start.mjs';
import { grantTester, revokeTester, rentalPolicy } from '../rentals.mjs';

export function run(store, [command, username, ...args], out = process.stdout, settings = {}) {
  let row;
  if (command === 'list' && !username) {
    for (const rental of store.rentals()) {
      const account = store.account(rental.accountId), state = rentalPolicy(rental, settings);
      out.write(`${account.username}\t${state.source}\t${state.status}\t${state.want}${state.until ? `\tuntil ${new Date(state.until).toISOString().slice(0, 10)}` : ''}\n`);
    }
    return;
  }
  if (['reset-password', 'regenerate-codes'].includes(command) && username && !args.length) {
    const account = store.accountByUsername(username);
    if (!account) throw new Error('no such account');
    const base = settings.base ?? 'https://imperfect.computer';
    let origin;
    try { origin = new URL(base); } catch { throw new Error('accounts needs a canonical HTTPS origin'); }
    if (origin.origin !== base || origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('accounts needs a canonical HTTPS origin');
    const token = randomBytes(32).toString('base64url');
    const at = (settings.now ?? Date.now)();
    store.issueAccountReset(account.id, { tokenHash: digest(token), purpose: command === 'reset-password' ? 'password' : 'codes', expiresAt: at + 86400_000 });
    out.write(`${base}/account/reset?token=${token}\n`);
    return;
  }
  if (command === 'grant' && args[0] === '--tester' && (args.length === 1 || (args.length === 3 && args[1] === '--until'))) {
    let until = null;
    if (args[1]) {
      const value = args[2];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('until must be YYYY-MM-DD (expires at UTC midnight)');
      until = Date.parse(`${value}T00:00:00Z`);
      if (!Number.isFinite(until) || new Date(until).toISOString().slice(0, 10) !== value) throw new Error('invalid until date');
    }
    row = grantTester(store, username, until, settings.now);
  } else if (command === 'revoke' && !args.length) row = revokeTester(store, username, settings.now);
  else throw new Error('usage: accounts.mjs grant <username> --tester [--until YYYY-MM-DD] | revoke <username> | list | reset-password <username> | regenerate-codes <username>');
  out.write(`${username}\t${row.source}\t${row.status}\n`);
}
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  process.umask(0o077);
  const config = await loadConfig();
  const store = openStore(config.dbPath);
  try { run(store, process.argv.slice(2), process.stdout, { ...config.rentals, base: config.accounts.base }); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
  finally { store.close(); }
}
