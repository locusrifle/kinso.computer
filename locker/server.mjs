// The store for the imperfect repo: one loopback server behind the Cloudflare
// tunnel. It keeps legacy members' keys, adds optional OS licences and rented
// computers, and accepts support for the free public source code.
// Offers stay closed until their billing is configured.
//
// Where it is sold is a setting, not a fact of the code: every hostname in
// `hosts` answers with the store, the first is the one written into links and
// the install sentence. Its front page is the static website (the opener),
// which any other name gets whole, so this process can stand in for
// tools/serve.mjs behind the tunnel.
//
// Money goes through Stripe Checkout; the browser never sees a card here.
// Every POST that changes something is a same-site form post or a signed
// webhook.
//
// What a key opens is the product itself: a git repository the buyer's agent
// clones and later fetches from (git.mjs), plus the few prebuilt binaries
// that repository pins by checksum (the desktop window and the Android app),
// which do not belong in git history.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { verifyWebhook } from './stripe.mjs';
import { saleWords } from './tell.mjs';
import { createAccounts } from './accounts.mjs';
import { createRentals } from './rentals.mjs';
import { createSiteLocks } from './site-locks.mjs';
import { createShop } from './shop.mjs';
import { KINSO_HOSTS } from '../website/variant.mjs';

const PAID_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
// A 100% promotion code completes the session with nothing to pay: a gift,
// and it opens the repo like a paid one.
const settled = session => session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
import { KEY_PATTERN, validEmail } from './store.mjs';
import { REPO_NAME, OS_REPO_NAME, createGitHost, isGitPath, keyFromAuthorization } from './git.mjs';
import { createOSProduct, isOSDownloadPath } from './os-product.mjs';

const run = promisify(execFile);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.sh': 'text/x-shellscript; charset=utf-8', '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.md': 'text/markdown; charset=utf-8', '.apk': 'application/vnd.android.package-archive',
};
// What Cloudflare and browsers may keep. Pages, scripts and styles for a
// few minutes with a stale copy allowed while a fresh one is fetched;
// pictures and fonts for a day. Anything asked for without ?v=
// is checked fresh every time, so a change reaches a returning visitor at
// once. Anything with a key or a person's details in it says no-store
// where it is sent.
const FRESH = 'public, max-age=300, stale-while-revalidate=86400';
const LONG = 'public, max-age=86400, stale-while-revalidate=604800';
const DOWNLOAD_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
// Legacy store art compiles its own WebAssembly.
const STORE_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'";
// Only the concept may be nested inside Kinso's computer and launch page.
// Every ancestor must match: no wildcard, no store/account embedding.
const KINSO_CONCEPT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; form-action 'none'; frame-ancestors 'self' https://computer.kinso.computer https://kinso.computer https://www.kinso.computer; base-uri 'none'";
// The website (the launch) draws with WebGL and ends on a Mac whose window is
// its own page (website/mac/app.html), and can open a live computer: the
// workbench its lock's password opens (site-locks.mjs). It may frame itself and
// those workbenches' origins, or, with no lock file, the demo's.
const siteCsp = (demo, frames = null) => `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'${demo ? ` ${demo}` : ''}; frame-src 'self'${frames?.length ? ` ${frames.join(' ')}` : demo ? ` ${demo}` : ''}; form-action 'none'; frame-ancestors 'self'; base-uri 'none'`;

// kinso.computer is the same launch page made for Kinso (website/variant.mjs renames it as it runs); its front page is
// named for Kinso before then too, for link previews and the tab's first title.
export function kinsoFront(page) {
  const title = 'Kinso Computer', words = 'Kinso, as a computer: a concept by Noah Fleming.';
  return page.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<meta name="description" content=")[^"]*/, `$1${words}`)
    .replace(/(<meta property="og:site_name" content=")[^"]*/, `$1${title}`)
    .replace(/(<meta property="og:title" content=")[^"]*/, `$1${title}`)
    .replace(/(<meta property="og:description" content=")[^"]*/, `$1${words}`)
    // Kinso's mark, from the rebuild of their page (served at /kinso/a/ below; never in this source), as a small card.
    .replace(/(<meta property="og:image" content=")[^"]*/, '$1https://kinso.computer/kinso/a/aa106999c9d67289.png')
    .replace(/(<meta name="twitter:card" content=")[^"]*/, '$1summary');
}

// Only the public launch/store names, reached through the PC's loopback tunnel.
// Cloudflare overwrites X-Forwarded-Proto with the visitor's scheme; the origin
// connection is always HTTP. Missing/ambiguous headers and local dev stay alone.
export function websiteHttpsRedirect(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (req.headers.upgrade || req.socket.encrypted) return null;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return null;
  if (req.headers['x-forwarded-proto'] !== 'http') return null;
  if (!/^(?:www\.)?imperfect\.computer(?::80)?$/i.test(req.headers.host ?? '')) return null;
  // Append the original origin-form target, not a parsed/normalized URL, to a
  // fixed origin: preserve escaping/query bytes without trusting Host for Location.
  if (!req.url?.startsWith('/') || /[\r\n]/.test(req.url)) return null;
  return `https://imperfect.computer${req.url}`;
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// {{name}} is escaped; {{{name}}} is trusted markup made here, never input.
export function render(template, vars = {}) {
  return String(template)
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, name) => String(vars[name] ?? ''))
    .replace(/\{\{(\w+)\}\}/g, (_, name) => escapeHtml(vars[name] ?? ''));
}

// A handful of the same request from one address in one minute is a person;
// a hundred is a script. Only the routes that send mail or start checkouts
// are counted.
export function createLimiter({ perMinute = 12, now = Date.now } = {}) {
  const seen = new Map();
  return {
    allow(key) {
      const at = now();
      const row = seen.get(key) ?? { start: at, count: 0 };
      if (at - row.start > 60_000) { row.start = at; row.count = 0; }
      row.count += 1;
      seen.set(key, row);
      if (seen.size > 10_000) for (const [k, v] of seen) if (at - v.start > 60_000) seen.delete(k);
      return row.count <= perMinute;
    },
  };
}

// What a buyer is given: a clone line, and the one sentence they paste into
// whatever agent they already use, with that line inside it. The key rides
// in the remote URL, so every later `git fetch` is already allowed.
export function buyerWords({ hosts, secure = true }) {
  const base = `${secure ? 'https' : 'http'}://${hosts[0]}`;
  const cloneUrl = key => `${secure ? 'https' : 'http'}://buyer:${key}@${hosts[0]}/${REPO_NAME}`;
  const installCommand = key => `git clone ${cloneUrl(key)} ~/imperfect`;
  return {
    base,
    installCommand,
    installSentence: key => `install imperfect: ${installCommand(key)}, then follow the agents file inside.`,
    updateSentence: () => 'Update the imperfect repo on this computer: follow the Updates section of ~/imperfect/AGENTS.md.',
    phoneLink: key => `${base}/android?key=${key}`,
  };
}

export async function assetVersion(publicDir) {
  const hash = createHash('sha256');
  for (const dir of ['store', 'shared']) {
    const names = (await readdir(join(publicDir, dir)).catch(() => [])).filter(name => /\.(js|css|json|md|svg)$/.test(name)).sort();
    for (const name of names) hash.update(name).update(await readFile(join(publicDir, dir, name)));
  }
  return hash.digest('hex').slice(0, 12);
}

export async function createLockerServer(options) {
  const {
    store, stripe = null, mail, config, log = console, tell = async () => {},
    publicDir = resolve(import.meta.dirname, 'public'),
    websiteDir = resolve(import.meta.dirname, '../website'),
    productDir = '',
    host = '127.0.0.1', port = 4322,
    limiter = createLimiter(),
    now = Date.now,
  } = options;
  const hosts = (Array.isArray(config.hosts) ? config.hosts : String(config.hosts ?? 'imperfect.computer').split(','))
    .map(name => String(name).trim().toLowerCase()).filter(Boolean);
  if (!hosts.length) throw new Error('the store needs at least one hostname');
  const secure = config.secure !== false;
  const base = `${secure ? 'https' : 'http'}://${hosts[0]}`;
  const demo = /^https?:\/\/[a-z0-9.:-]+$/i.test(String(config.demoOrigin ?? '')) ? String(config.demoOrigin) : '';
  // The launch page's lock: only with a lock file configured (start.mjs); without one, /unlock opens nothing.
  const siteLocks = options.siteLocks ?? (config.siteLocks ? createSiteLocks({ ...config.siteLocks, secure: config.secure !== false, log }) : null);
  const SITE_CSP = async () => siteCsp(demo, await siteLocks?.frameOrigins());
  const { installSentence, phoneLink } = buyerWords({ hosts, secure });
  const rentals = createRentals({ store, stripe, config, base: config.accounts?.base ?? base, mail, now });
  const accounts = options.accounts ?? createAccounts({ store, config: config.accounts, rentals, codeSentence: installSentence });
  const osOpen = () => Boolean(stripe && config.stripe?.osPrice && config.stripe?.webhookSecret);
  async function issueOS(session) {
    if (session.mode !== 'payment' || session.metadata?.product !== 'os' || !settled(session)) throw Object.assign(new Error('That purchase is not confirmed yet; refresh shortly.'), { status: 402 });
    const license = store.issueLicense({ email: session.customer_details?.email ?? session.customer_email, stripeSession: session.id,
      stripeCustomer: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null,
      product: 'os', accountId: session.client_reference_id === session.metadata?.account ? session.client_reference_id : null });
    store.queueRentalMail(`os:${session.id}`, { to: store.buyer(license.buyer_id).email, subject: 'Your imperfect OS lifetime licence',
      text: `Thank you. Your imperfect OS lifetime licence: ${license.key}\n\nRepository access and updates: ${installSentence(license.key)}\n\nInstallation guide: ${base}/os/install\nThe bootable installer download is not published yet. Contact Noah before changing your disks. Bring your own AI subscription.\n` });
    return license;
  }
  const offerPage = body => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>imperfect OS</title><link rel="stylesheet" href="/landing.css?v=plain-1"></head><body><header class="header"><a class="brand" href="/"><img src="/assets/wordmark/imperfect-logo-silver.png" alt="imperfect" width="102" height="56"></a></header><main class="handoff">${body}</main></body></html>`;
  const osGuide = '<h1>install imperfect OS</h1><p>Your licence opens the imperfect repository and its updates. The bootable OS installer download is not published here yet.</p><p>You need a supported x86-64 computer, a backup of your files, a USB drive and an internet connection. Installation can replace the operating system and erase disks: do not repartition until the installer and hardware guide are confirmed.</p><p>Bring your own supported Claude or ChatGPT subscription. Contact <a href="mailto:noah@imperfect.computer">Noah</a> for the current NixOS installation steps and hardware compatibility before installing.</p>';

  // Pages name their scripts and styles with ?v=<a hash of them>, so a
  // change reaches visitors at once however long Cloudflare keeps a copy.
  const assets = await assetVersion(publicDir);
  const templates = new Map();
  async function page(name, vars = {}) {
    if (!templates.has(name) || config.reloadPages) templates.set(name, await readFile(join(publicDir, name), 'utf8'));
    return render(templates.get(name), { v: assets, ...vars });
  }
  const html = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': TYPES['.html'], 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const json = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'content-type': TYPES['.json'], ...headers });
    res.end(JSON.stringify(value));
  };
  const redirect = (res, location, headers = {}) => { res.writeHead(303, { location, ...headers }); res.end(); };
  const text = (res, status, body, type = TYPES['.txt']) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
  async function fail(res, status, message, after = '', back = 'back to the start') {
    html(res, status, await page('error.html', { status, message, after, back }));
  }
  // Under "the till is not open yet": an address to write to when it is.
  const NOTIFY = `<form class="notify" method="post" action="/notify">
  <label for="notify-email">notify me when it opens</label>
  <div class="row"><input id="notify-email" type="email" name="email" required autocomplete="email" placeholder="you@example.com"><button type="submit">notify me</button></div>
</form>`;

  async function readBody(req, limit = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function readForm(req) {
    const raw = (await readBody(req)).toString('utf8');
    const type = String(req.headers['content-type'] ?? '');
    if (type.startsWith('application/json')) return JSON.parse(raw || '{}');
    return Object.fromEntries(new URLSearchParams(raw));
  }
  // A form post from another site is refused. Browsers send Origin on every
  // POST; curl sends none, and that is fine for a signed webhook or a test.
  function sameSite(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return hosts.includes(new URL(origin).hostname); } catch { return false; }
  }
  const clientKey = req => String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '');
  const shop = createShop({ stripe, rentals, store, tell, secure, limiter, clientKey, readBody, json, html, escapeHtml, now });

  async function sendFile(res, root, urlPath, { cache = FRESH, extraHeaders = {} } = {}) {
    let pathname = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
    if (pathname.endsWith('/')) pathname += 'index.html';
    const full = resolve(root, `.${pathname}`);
    if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) return false;
    let info;
    try { info = await stat(full); } catch { return false; }
    if (info.isDirectory()) { redirect(res, `${pathname}/`); return true; }
    const headers = { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': cache, ...extraHeaders };
    // Only this trusted icon needs inline CSS for its system-scheme inks;
    // keep all scripts and other loads forbidden in the SVG document.
    if (pathname === '/favicon.svg') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'";
    // A part of the file, as Safari asks for a video's or a sound's.
    const asked = /^bytes=(\d*)-(\d*)$/.exec(res.req?.headers.range ?? '');
    if (asked && (asked[1] || asked[2])) {
      const start = asked[1] ? Number(asked[1]) : Math.max(0, info.size - Number(asked[2]));
      const end = asked[1] && asked[2] ? Math.min(Number(asked[2]), info.size - 1) : info.size - 1;
      if (start > end) { res.writeHead(416, { 'content-range': `bytes */${info.size}` }); res.end(); return true; }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 });
      createReadStream(full, { start, end }).pipe(res);
      return true;
    }
    res.writeHead(200, { ...headers, 'content-length': info.size });
    createReadStream(full).pipe(res);
    return true;
  }

  // -- the product ----------------------------------------------------------
  // <productDir>/imperfect.git is the repository members clone;
  // <productDir>/downloads holds the binaries it pins in binaries.json, kept
  // by content so a buyer who stays on an older commit still gets its file.
  const repo = productDir ? join(productDir, REPO_NAME) : '';
  const downloads = productDir ? join(productDir, 'downloads') : '';
  const serveGit = createGitHost({ repo, store, keyPattern: KEY_PATTERN, limiter, clientKey, log });
  const serveOSGit = createGitHost({
    repo: productDir ? join(productDir, OS_REPO_NAME) : '', name: OS_REPO_NAME,
    product: 'os', readOnly: true, store, keyPattern: KEY_PATTERN, limiter, clientKey, log,
  });
  const serveOS = createOSProduct({ productDir, store, limiter, clientKey });
  async function pinned() {
    if (!repo) return null;
    try {
      const { stdout } = await run('git', ['--git-dir', repo, 'show', 'HEAD:binaries.json'], { maxBuffer: 1024 * 1024 });
      return JSON.parse(stdout);
    } catch { return null; }
  }
  async function version() {
    if (!repo) return '';
    try { return (await run('git', ['--git-dir', repo, 'log', '-1', '--format=%h %cs'])).stdout.trim(); } catch { return ''; }
  }
  function keyFrom(req, search) {
    const fromQuery = new URLSearchParams(search).get('key') ?? '';
    return KEY_PATTERN.test(fromQuery) ? fromQuery : keyFromAuthorization(req.headers.authorization, KEY_PATTERN);
  }

  // -- the store ------------------------------------------------------------
  async function storefront(req, res, path, search) {
    if (await shop.handle(req, res, new URL(path + search, base))) return;
    if (req.method === 'GET' && path === '/host.html') {
      let body = await readFile(join(websiteDir, 'host.html'), 'utf8');
      if (osOpen()) {
        body = body.replace('<div class="notice"><p><strong>The new OS checkout is being prepared.</strong> There is no AUD 400 purchase on this page yet. Installation requirements and the lifetime terms will be confirmed before you buy.</p></div>', '<div class="notice"><p>The installer download is not published yet. <a href="/os/install">Read the installation requirements</a> before buying. Seller: Noah.</p></div>')
          .replace('<a class="button" href="mailto:noah@imperfect.computer?subject=imperfect%20OS">Ask about imperfect OS <span aria-hidden="true">↗</span></a>', '<form method="post" action="/os/buy"><button class="button" type="submit">Buy imperfect OS — AUD 400 lifetime</button></form>');
      }
      return html(res, 200, body);
    }
    if (req.method === 'GET' && path === '/os/install') return html(res, 200, offerPage(osGuide));
    if (req.method === 'POST' && path === '/os/buy') {
      // Anonymous buyers have no ambient authority; require an exact same-origin form.
      if (!hosts.some(hostname => req.headers.origin === `${secure ? 'https' : 'http'}://${hostname}`)) return fail(res, 403, 'that form came from somewhere else');
      if (!limiter.allow(`os:${clientKey(req)}`)) return fail(res, 429, 'slow down');
      if (!osOpen()) return redirect(res, '/host.html');
      const account = accounts.signedIn?.(req);
      const session = await stripe.checkoutSession({ mode: 'payment', line_items: [{ price: config.stripe.osPrice, quantity: 1 }],
        success_url: `${base}/os/thanks?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${base}/host.html`,
        customer_creation: 'always', allow_promotion_codes: true, managed_payments: { enabled: false },
        ...(account ? { client_reference_id: account.id } : {}), metadata: { product: 'os', ...(account ? { account: account.id } : {}) } }, { idempotencyKey: randomUUID() });
      return redirect(res, session.url);
    }
    if (req.method === 'GET' && path === '/os/thanks') {
      const sessionId = new URLSearchParams(search).get('session_id') ?? '';
      if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId) || !stripe) return fail(res, 400, 'no purchase to thank you for');
      let license = store.licenseBySession(sessionId);
      if (!license) license = await issueOS(await stripe.retrieveSession(sessionId));
      void rentals.flushMail().catch(() => log.warn('purchase mail awaiting retry'));
      if (license.product !== 'os') return fail(res, 400, 'that is not an OS purchase');
      return html(res, 200, offerPage(`<h1>thank you</h1><p>Your imperfect OS lifetime licence:</p><p><code>${escapeHtml(license.key)}</code></p><p>Keep this key private. Repository access and updates:</p><p><code>${escapeHtml(installSentence(license.key))}</code></p><p><a href="/os/install">Continue to the OS installation guide</a></p><p>The installer download is not published yet; contact Noah before changing your disks.</p>`));
    }
    if (req.method === 'POST' && path === '/notify') {
      if (!sameSite(req)) return fail(res, 403, 'that form came from somewhere else');
      if (!limiter.allow(`notify:${clientKey(req)}`)) return fail(res, 429, 'slow down');
      const email = validEmail((await readForm(req)).email);
      if (!email) return fail(res, 400, 'that does not look like an email address', NOTIFY);
      store.wait(email);
      return html(res, 200, await page('error.html', { status: '', message: `done. ${email} gets one email, the day the till opens.`, after: '', back: 'back to the computer' }));
    }
    // POST /buy is retired: existing members never need to start another
    // $150 checkout. Keep /thanks and the code webhook for their keys and
    // payments already in flight; new source support grants no membership.
    if (req.method === 'GET' && path === '/thanks') {
      const sessionId = new URLSearchParams(search).get('session_id') ?? '';
      if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId) || !stripe) return fail(res, 400, 'no purchase to thank you for');
      let license = store.licenseBySession(sessionId);
      if (!license) {
        // The webhook is usually first. When the browser beats it, the
        // session is checked with Stripe directly and the key issued here.
        const session = await stripe.retrieveSession(sessionId).catch(() => null);
        if (!session || !settled(session) || session.metadata?.product !== 'code') return fail(res, 402, 'that purchase has not gone through yet; refresh in a moment');
        license = store.issueLicense({ email: session.customer_details?.email ?? session.customer_email, stripeSession: session.id, stripeCustomer: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null });
      }
      const buyer = store.buyer(license.buyer_id);
      return html(res, 200, await page('store/thanks.html', {
        key: license.key, sentence: installSentence(license.key), email: buyer.email, base,
        welcome: buyer.number === 1 ? "you're the very first member" : `you're member no. ${String(buyer.number).padStart(4, '0')}`,
        number: buyer.number, padded: String(buyer.number).padStart(4, '0'),
      }));
    }
    // A pinned binary, by the exact name binaries.json gives it.
    if (req.method === 'GET' && path.startsWith('/download/')) {
      const license = store.activeLicense(keyFrom(req, search));
      if (!license) return text(res, 403, 'this key does not open anything\n');
      const name = path.slice('/download/'.length);
      if (!DOWNLOAD_FILE.test(name) || !downloads) return text(res, 404, 'no such file\n');
      const sent = await sendFile(res, downloads, `/${name}`, { cache: 'private, max-age=31536000, immutable', extraHeaders: { 'content-disposition': `attachment; filename="${name}"` } });
      if (!sent) return text(res, 404, 'no such file\n');
      return;
    }
    // The phone's own link: whatever Android app the newest commit pins, so
    // a buyer can also fetch it from the phone's browser and tap to install.
    if (req.method === 'GET' && path === '/android') {
      const license = store.activeLicense(keyFrom(req, search));
      if (!license) return fail(res, 403, 'that key does not open anything');
      const android = (await pinned())?.android;
      if (!android?.file || !DOWNLOAD_FILE.test(android.file)) return fail(res, 404, 'the android app has not been published yet');
      const sent = await sendFile(res, downloads, `/${android.file}`, { cache: 'private, no-store', extraHeaders: { 'content-disposition': `attachment; filename="imperfect-code.apk"` } });
      if (!sent) return fail(res, 404, 'the android app has not been published yet');
      return;
    }
    // What a page names with ?v= may be kept; what is asked for bare (a
    // module another imports) is checked every time, so a change to it is
    // never hidden behind a cached copy.
    const cache = /[?&]v=/.test(search) ? FRESH : 'no-cache';
    if (req.method === 'GET' && await sendFile(res, join(publicDir, 'store'), path, { cache })) return;
    // Everything else, the front page included, is the website.
    res.setHeader('content-security-policy', await SITE_CSP());
    if (req.method === 'GET' && await sendFile(res, websiteDir, path, { cache: path === '/' ? 'no-cache' : FRESH })) return;
    return fail(res, 404, 'nothing here');
  }

  // -- Stripe's word --------------------------------------------------------
  async function webhook(req, res) {
    const payload = await readBody(req, 1024 * 1024);
    let event;
    try { event = verifyWebhook(payload, req.headers['stripe-signature'], config.stripe?.webhookSecret, { now }); }
    catch (error) { return text(res, 400, `${error.message}\n`); }
    // Only complete, verified requests can enter the billing state queue.
    if (webhookQueued >= 256) return text(res, 503, 'billing busy; retry\n');
    webhookQueued++;
    const next = webhookTail.then(() => processWebhook(event, res));
    webhookTail = next.catch(() => {}).finally(() => { webhookQueued--; });
    return next;
  }
  async function processWebhook(event, res) {
    if (store.seenEvent(event.id)) {
      void rentals.flushMail().catch(() => log.warn('purchase mail awaiting retry'));
      return json(res, 200, { received: true, duplicate: true });
    }
    try {
      const object = event.data?.object ?? {};
      await rentals.event(event);
      if (PAID_EVENTS.has(event.type)) await shop.paidSale(object);
      if (PAID_EVENTS.has(event.type) && object.metadata?.product === 'os' && settled(object)) {
        await issueOS(object);
      }
      // A bank payment completes the session unpaid and settles days later, as
      // async_payment_succeeded; a card is paid at completed.
      if (PAID_EVENTS.has(event.type) && object.metadata?.product === 'code' && settled(object)) {
        const email = object.customer_details?.email ?? object.customer_email;
        const customer = typeof object.customer === 'string' ? object.customer : object.customer?.id ?? null;
        const license = store.issueLicense({ email, stripeSession: object.id, stripeCustomer: customer });
        const number = store.buyer(license.buyer_id)?.number;
        await tell(saleWords({ number, email }));
        await mail.send({
          to: email,
          subject: `your imperfect repo: member no. ${String(number).padStart(4, '0')}`,
          text: `thank you, member no. ${String(number).padStart(4, '0')}.\n\npaste this into the agent you already use, on your linux computer:\n\n${installSentence(license.key)}\n\nthe android app: ${phoneLink(license.key)}\n(your agent can also put it on your phone over wireless debugging.)\n\nthis key is yours for good. every new version comes to this address with what changed: give that email to your agent and it walks you through the update.\n`,
        }).catch(error => log.warn(`purchase mail failed: ${error.message}`));
      }
    } catch (error) {
      log.error(`webhook ${event.type} ${event.id}: ${error.message}`);
      store.forgetEvent(event.id); // so Stripe's retry is handled, not skipped as a duplicate
      return text(res, 500, 'handler failed\n');
    }
    // Mark completion only after durable entitlement effects, never before a
    // network await: an interrupted handler can always be retried.
    store.firstSeen(event.id, event.type);
    void rentals.flushMail().catch(() => log.warn('purchase mail awaiting retry'));
    return json(res, 200, { received: true });
  }

  // Verified handlers must not interleave and overwrite newer state.
  let webhookTail = Promise.resolve(), webhookQueued = 0;
  const server = createServer({ requestTimeout: 60_000 }, async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('content-security-policy', STORE_CSP);
    if (secure) res.setHeader('strict-transport-security', 'max-age=31536000');
    const httpsLocation = secure ? websiteHttpsRedirect(req) : null;
    if (httpsLocation) {
      res.writeHead(308, { location: httpsLocation });
      res.end();
      return;
    }
    // HEAD is GET without the body (Node leaves the body off by itself). Link
    // checkers ask with HEAD; X shows a bare t.co link for a site that
    // answers them with 404.
    req.isHead = req.method === 'HEAD';
    if (req.isHead) req.method = 'GET';
    let url;
    try { url = new URL(req.url ?? '/', 'http://local'); } catch { return text(res, 400, 'bad path\n'); }
    const path = url.pathname;
    const requestHost = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    const isStore = hosts.includes(requestHost);
    try {
      if (req.method === 'POST' && path === '/webhooks/stripe') return await webhook(req, res);
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, site: isStore ? 'store' : 'website', till: Boolean(stripe), mail: mail.configured, version: await version() });
      // The launch page's lock, wherever the page is served: the password checked here, never in the page.
      if (path === '/unlock') {
        if (siteLocks && await siteLocks.handle(req, res, url, clientKey)) return;
        return json(res, 401, { ok: false }, { 'cache-control': 'no-store' });
      }
      // Git clients carry no browser cookies or pages: they get plain answers.
      if (isStore && await accounts.handle(req, res, url)) return;
      if (isStore && isGitPath(path)) {
        res.removeHeader('content-security-policy');
        return await serveGit(req, res, path, url.search);
      }
      if (isStore && isGitPath(path, OS_REPO_NAME)) {
        res.removeHeader('content-security-policy');
        return await serveOSGit(req, res, path, url.search);
      }
      if (isStore && isOSDownloadPath(path)) return await serveOS(req, res, path, url.search);
      // The typeface and block art belong to the website; every name shares them.
      if (req.method === 'GET' && path.startsWith('/assets/')) {
        res.removeHeader('content-security-policy');
        if (await sendFile(res, websiteDir, path, { cache: LONG })) return;
        return text(res, 404, 'not found\n');
      }
      // Kinso's concept page, logo and type stay in the ignored rebuild. Serve that page on kinso.computer itself,
      // including its relative styles/scripts; never redirect the visitor to imperfect.computer's Shop.
      if (req.method === 'GET' && path.startsWith('/kinso/')) {
        res.setHeader('content-security-policy', KINSO_CONCEPT_CSP);
        if (await sendFile(res, join(publicDir, 'store/kinso'), path.slice('/kinso'.length), { cache: /\.html?$/.test(path) || path.endsWith('/') ? FRESH : LONG })) return;
        return text(res, 404, 'not found\n');
      }
      // kinso.computer's source, paid for once (/source, its checkout and status: shop.mjs).
      if (KINSO_HOSTS.includes(requestHost) && await shop.kinso(req, res, url)) return;
      // kinso.computer's install command (variant.mjs): the same rootless script as imperfect.computer/install, cloning
      // Kinso's own repository (github.com/locusrifle/kinso.computer).
      if (req.method === 'GET' && path === '/install' && KINSO_HOSTS.includes(requestHost)) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(await readFile(new URL('./public/install-kinso.sh', import.meta.url), 'utf8'));
      }
      if (req.method === 'GET' && (path === '/' || path === '/index.html') && KINSO_HOSTS.includes(requestHost)) {
        res.setHeader('content-security-policy', await SITE_CSP());
        return html(res, 200, kinsoFront(await readFile(join(websiteDir, 'index.html'), 'utf8')), { 'cache-control': 'no-cache' });
      }
      if (req.method === 'GET' && path.startsWith('/shared/')) {
        if (await sendFile(res, join(publicDir, 'shared'), path.slice('/shared'.length))) return;
        return text(res, 404, 'not found\n');
      }
      if (isStore) return await storefront(req, res, path, url.search);
      // The website keeps its own policy (siteCsp).
      res.setHeader('content-security-policy', await SITE_CSP());
      if (req.method === 'GET' && await sendFile(res, websiteDir, path)) return;
      return text(res, 404, 'not found\n');
    } catch (error) {
      log.error(`${req.method} ${requestHost}${path}: ${error.stack || error.message}`);
      if (!res.headersSent) return fail(res, error.status || 500, error.status ? error.message : 'something broke; it has been noted').catch(() => res.end());
      res.end();
    }
  });

  return {
    server,
    hosts,
    base,
    listen: () => new Promise((done, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => done(server.address()));
    }),
    close: () => new Promise(done => server.close(done)),
  };
}
