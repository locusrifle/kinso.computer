#!/usr/bin/env node
// The operator's view of the store: who has what, hand a key to someone by
// hand, take one back. Reads the same database the service does.
//
//   node locker/tools/license.mjs list
//   node locker/tools/license.mjs issue <email> [--product code|os]
//   node locker/tools/license.mjs revoke <key>
//   node locker/tools/license.mjs find <email>
//   node locker/tools/license.mjs handle <email> <handle>   set or change it (reserved words too: locus)

import { resolve } from 'node:path';
import { openStore } from '../store.mjs';
import { loadConfig } from '../start.mjs';

const when = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export function run(store, [command, ...args], out = process.stdout) {
  if (command === 'list') {
    for (const row of store.listLicenses()) out.write(`${row.key}  ${row.status.padEnd(8)} ${String(row.downloads).padStart(3)}  ${when(row.created_at)}  ${row.email}${row.handle ? `  ${row.handle}` : ''}  ${row.product}\n`);
  } else if (command === 'issue') {
    if (args.length !== 1 && !(args.length === 3 && args[1] === '--product')) throw new Error('usage: issue <email> [--product code|os]');
    const license = store.issueLicense({ email: args[0], product: args[2] ?? 'code' });
    out.write(`${license.key}\n`);
  } else if (command === 'revoke') {
    const license = store.revokeLicense(args[0]);
    if (!license) throw new Error('no such key');
    out.write(`${license.key} ${license.status}\n`);
  } else if (command === 'handle') {
    const buyer = store.buyerByEmail(args[0]);
    if (!buyer) throw new Error('no such member');
    out.write(`${store.claimHandle(buyer.id, args[1], { operator: true }).handle}\n`);
  } else if (command === 'find') {
    for (const row of store.licensesByEmail(args[0])) out.write(`${row.key}  ${row.status}  ${row.product}\n`);
  } else {
    throw new Error('usage: license.mjs list|issue <email> [--product code|os]|revoke <key>|find <email>|handle <email> <handle>');
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const config = await loadConfig();
  const store = openStore(config.dbPath);
  try { run(store, process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 2; }
  finally { store.close(); }
}
