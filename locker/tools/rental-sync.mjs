#!/usr/bin/env node
// Operator-only. Turns rental intent into computers: provisions each active
// rental that has none, and stops each ended one. One pass is idempotent; the
// provisioner's own lock and state make a rerun, or a crash mid-pass, safe.
// Never deletes: retention and deletion stay with the operator.
//
//   node tools/rental-sync.mjs            one pass
//   node tools/rental-sync.mjs --loop 60  a pass every 60 seconds (the systemd unit)
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRentals } from '../rentals.mjs';
import { createMail } from '../mail.mjs';
import { run as provision, localRegistry, providerConfig, signerPublicKey, ProvisionError } from './provision.mjs';

// Testers get the bigger computer (business notes); paid renters keep the provisioner's d2-4 default.
const TESTER_FLAVOR = 'd2-8';
// Messages an operator can act on; anything else prints as a fixed line, never as raw text.
const operatorError = message => Object.assign(new Error(message), { operator: true });

// The renter comes from the account (name, email, owner), not a hand-written renters entry.
// A manual entry in provision.json still wins for its own fields (flavor, or an email for an account without one).
export function renterFor(account, row, config) {
  const manual = config.renters?.[account.username] ?? {};
  const flavor = manual.flavor ?? (row.source === 'tester' ? TESTER_FLAVOR : undefined);
  return { email: account.email || row.email || manual.email || '', ownerAccountId: account.id, ...(flavor ? { flavor } : {}) };
}

export async function syncOnce({ store, config, base, mail, prefix, signerPem, out = process.stdout, now = Date.now, sleep, fetch, run = provision }) {
  const rentals = createRentals({ store, config: {}, base, mail, now });
  const registry = localRegistry({ store, storeUrl: base, publicKey: signerPem });
  const options = (name, renters) => ({ prefix, store, registry, now, sleep, fetch, out,
    config: { ...config, storeUrl: base, renters: { ...config.renters, ...(renters ? { [name]: renters } : {}) } } });
  const summary = { provisioned: 0, stopped: 0, skipped: 0, failed: 0 };
  const fail = (name, error) => {
    summary.failed++;
    out.write(`${name} ${error instanceof ProvisionError ? error.message : 'sync failed; inspect local state and rerun'}\n`);
  };
  // Once per computer: queueRentalMail ignores a repeat id, and flushMail retries until the mail is sent.
  const queueReady = (row, renter) => store.queueRentalMail(`ready:${row.accountId}:${row.username}`, { to: renter.email, subject: 'Your imperfect computer is ready',
    text: `Your imperfect computer is ready at https://${row.username}.imperfect.computer\n\nOpen it and sign in with your imperfect username and password. Your account page, ${base}/account, has the link.\nNoah keeps root access for support. No backups yet: keep copies of important work.` });
  for (const row of rentals.list('provision')) {
    const name = row.username, state = row.computer?.state;
    // Stopped computers are retained; the provisioner refuses to reprovision them.
    if (state === 'stopped') { summary.skipped++; continue; }
    const renter = renterFor(store.account(row.accountId), row, config);
    if (state === 'ready') { if (renter.email) queueReady(row, renter); summary.skipped++; continue; }
    if (!renter.email) { summary.skipped++; out.write(`${name} needs an email on the account before it can be made\n`); continue; }
    try {
      await run(['provision', name], options(name, renter));
    } catch (error) { fail(name, error); continue; }
    summary.provisioned++;
    if (store.computerByUsername(name)?.state === 'ready') queueReady(row, renter);
  }
  for (const row of rentals.list('stop')) {
    const name = row.username, computer = store.computerByUsername(name);
    if (!computer || computer.state === 'stopped') { summary.skipped++; continue; }
    try {
      await run(['deprovision', name, 'stop'], options(name));
      summary.stopped++;
    } catch (error) { fail(name, error); }
  }
  await rentals.flushMail();
  return summary;
}

export async function loop({ every, pass, out = process.stdout, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  for (;;) {
    try { await pass(); } catch { out.write('rental sync pass failed; inspect local state and rerun\n'); }
    await sleep(every * 1000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const every = args[0] === '--loop' ? Number(args[1] ?? 60) : null;
  try {
    if (args.length && every === null) throw operatorError('Usage: rental-sync.mjs [--loop SECONDS]');
    if (every !== null && !(Number.isInteger(every) && every >= 30 && every <= 3600)) throw operatorError('--loop takes 30 to 3600 seconds');
    const { loadConfig } = await import('../start.mjs');
    const { openStore } = await import('../store.mjs');
    const prefix = join(homedir(), '.imperfect');
    const dbPath = join(prefix, 'locker', 'locker.db');
    const dbInfo = await lstat(dbPath).catch(() => null);
    if (!dbInfo?.isFile() || dbInfo.uid !== process.getuid()) throw operatorError('An existing owned local store database is required.');
    const locker = await loadConfig();
    const store = openStore(dbPath);
    const mail = createMail(locker.mail);
    const base = locker.accounts.base;
    const signerPem = await signerPublicKey(prefix);
    const config = await providerConfig(prefix);
    const pass = () => syncOnce({ store, config, base, mail, prefix, signerPem });
    try {
      if (every === null) process.stdout.write(`${JSON.stringify(await pass())}\n`);
      else await loop({ every, pass });
    } finally { store.close(); }
  } catch (error) {
    process.stderr.write(`${error instanceof ProvisionError || error.operator ? error.message : 'rental sync failed; inspect local state and rerun'}\n`);
    process.exitCode = 2;
  }
}
