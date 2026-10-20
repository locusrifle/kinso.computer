// Start the store with what is in ~/.imperfect/credentials/locker.env.
// Everything secret lives there, mode 0600, never in this tree.
//
//   LOCKER_PORT=4322
//   STORE_HOSTS=imperfect.computer,www.imperfect.computer   (first = the address in links and the install sentence)
//   LOCKER_PRODUCT=~/.imperfect/product   (imperfect.git + downloads/; imperfect-os.git + os-release.json + os-downloads/)
// App binaries use tools/pin.mjs; the public OS repo/ISO use locker/tools/publish-os.mjs.
// OS publication is optional: missing files disable installer download, not app access.
//   DEMO_ORIGIN=https://noah.imperfect.computer   (the public Noah computer framed by the launch)
//   STRIPE_SECRET_KEY=sk_live_...
//   STRIPE_WEBHOOK_SECRET=whsec_...
//   STRIPE_RENT_PRICE=price_... (US$40/month recurring; Noah, 15 Oct)
//   STRIPE_OS_PRICE=price_...   (AUD 400 one-time lifetime)
//   RENT_GRACE_DAYS=7          (unpaid time before stop intent)
//   RENT_RETENTION_DAYS=30     (after stop; records a date, never deletes)
// Rental/OS offers need secret key + webhook secret + their own price to open.
// Public-source support (/shop/code) uses custom USD amounts and needs only Stripe.
// Stripe Customer Portal must permit cancellation and payment-method updates.
//   MAIL_INBOX=locus@imperfect.computer    (the AgentMail inbox mail goes from; its
//                                          key is credentials/agentmail-api-key)
//   ACCOUNTS_BASE=https://imperfect.computer  (canonical origin, independent of STORE_HOSTS)
//   ACCOUNTS_SIGNING_KEY_FILE=~/.imperfect/credentials/accounts-signing-key.pem
//   ACCOUNTS_OPERATOR_TOKEN_FILE=~/.imperfect/credentials/accounts-operator-token
// These are the exact defaults. Account files must be private regular files
// inside ~/.imperfect/credentials (even with IMPERFECT_PREFIX). No inline keys.
// Username/password accounts need no external sign-in setup or email delivery.
// Nothing generates a signer in state; provision an Ed25519 PEM in credentials.
//   SITE_LOCKS_FILE=~/.imperfect/credentials/site-locks.json   (the launch page's lock: its
//                                         passwords and the workbench each opens; site-locks.mjs)
//   SITE_DOOR_FILE=~/.imperfect/credentials/site-door-secret   (the workbenches' doors' shared secret)
// Both must be private files inside ~/.imperfect/credentials. Without the first, the lock opens nothing.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { openStore } from './store.mjs';
import { createStripe } from './stripe.mjs';
import { createMail } from './mail.mjs';
import { createLockerServer } from './server.mjs';
import { createTell, watchInbox } from './tell.mjs';

export function parseEnvFile(textValue) {
  const out = {};
  for (const line of String(textValue).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 0) continue;
    let value = trimmed.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[trimmed.slice(0, at).trim()] = value;
  }
  return out;
}

const expand = p => String(p).replace(/^~(?=$|\/)/, homedir());

export async function loadConfig(env = process.env) {
  const prefix = resolve(expand(env.IMPERFECT_PREFIX || '~/.imperfect'));
  const file = env.LOCKER_ENV || join(prefix, 'credentials', 'locker.env');
  const fromFile = existsSync(file) ? parseEnvFile(await readFile(file, 'utf8')) : {};
  const get = name => env[name] ?? fromFile[name] ?? '';
  const stateDir = join(prefix, 'locker');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  await chmod(join(stateDir, 'locker.db'), 0o600).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const credentials = join(homedir(), '.imperfect', 'credentials');
  async function accountFile(setting, defaultName) {
    const wanted = resolve(expand(get(setting) || join(credentials, defaultName)));
    if (!wanted.startsWith(credentials + sep)) throw new Error('account credentials must be inside ~/.imperfect/credentials');
    try {
      const actual = await realpath(wanted);
      if (!actual.startsWith(credentials + sep)) throw new Error('account credentials must not resolve outside ~/.imperfect/credentials');
      const info = await stat(actual);
      if (!info.isFile() || (info.mode & 0o077) || info.size > 16 * 1024) throw new Error('account credential files must be private regular files');
      return (await readFile(actual, 'utf8')).trim();
    } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  }
  const accounts = {
    base: get('ACCOUNTS_BASE') || 'https://imperfect.computer',
    signerPrivateKey: await accountFile('ACCOUNTS_SIGNING_KEY_FILE', 'accounts-signing-key.pem'),
    operatorToken: await accountFile('ACCOUNTS_OPERATOR_TOKEN_FILE', 'accounts-operator-token'),
  };
  if (accounts.operatorToken && (accounts.operatorToken.length < 32 || /\s/.test(accounts.operatorToken))) throw new Error('account operator credential must contain at least 32 characters with no whitespace');
  const rentalDays = (name, fallback) => {
    const value = Number(get(name) || fallback);
    if (!Number.isInteger(value) || value < 1 || value > 365) throw new Error(`${name} must be an integer from 1 to 365`);
    return value;
  };
  return {
    prefix,
    stateDir,
    dbPath: join(stateDir, 'locker.db'),
    port: Number(get('LOCKER_PORT') || 4322),
    secure: get('LOCKER_INSECURE') !== '1',
    hosts: get('STORE_HOSTS') || 'imperfect.computer,www.imperfect.computer',
    productDir: resolve(expand(get('LOCKER_PRODUCT') || join(prefix, 'product'))),
    demoOrigin: get('DEMO_ORIGIN'),
    siteLocks: {
      file: resolve(expand(get('SITE_LOCKS_FILE') || join(credentials, 'site-locks.json'))),
      doorFile: resolve(expand(get('SITE_DOOR_FILE') || join(credentials, 'site-door-secret'))),
    },
    accounts,
    rentals: { graceDays: rentalDays('RENT_GRACE_DAYS', 7), retentionDays: rentalDays('RENT_RETENTION_DAYS', 30) },
    stripe: { secretKey: get('STRIPE_SECRET_KEY'), webhookSecret: get('STRIPE_WEBHOOK_SECRET'), rentPrice: get('STRIPE_RENT_PRICE'), osPrice: get('STRIPE_OS_PRICE') },
    mail: { key: (await readFile(join(prefix, 'credentials', 'agentmail-api-key'), 'utf8').catch(() => '')).trim(), inbox: get('MAIL_INBOX') || undefined },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  process.umask(0o077);
  const config = await loadConfig();
  const store = openStore(config.dbPath);
  const stripe = config.stripe.secretKey ? createStripe({ secretKey: config.stripe.secretKey }) : null;
  const mail = createMail(config.mail);
  // A sale or a letter opens a session in the imperfect on this computer.
  const tell = createTell({ prefix: config.prefix, cwd: resolve(import.meta.dirname, '..') });
  if (mail.configured) watchInbox({ mail, store, tell, inbox: mail.inbox });
  const app = await createLockerServer({ store, stripe, mail, tell, config, productDir: config.productDir, port: config.port });
  const address = await app.listen();
  console.log(`imperfect store on ${address.address}:${address.port} for ${app.hosts.join(', ')} (links say ${app.base})`
    + `${stripe ? '' : ' (no Stripe key: the till is closed)'}${mail.configured ? '' : ' (no mail key: notes go to the log)'}`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    store.close();
    process.exit(0);
  });
}
