// Public source support is deliberately separate from legacy keyed memberships.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { validEmail } from './store.mjs';

import { INSTALL_COMMAND, validOS, resolveOS, installInstructions } from './public/store/shop-platform.mjs';
import { KINSO_HOSTS, VARIANTS } from '../website/variant.mjs';
export { INSTALL_COMMAND };
const SESSION = /^cs_(?:test|live)_[A-Za-z0-9]{1,240}$/;
const PRODUCT = 'source-support';
// kinso.computer's source: one payment, then the install command (Noah: "one off payment for the source"). A paywall,
// not a lock; the repository it installs stays public.
const KINSO = VARIANTS.kinso;
export const KINSO_PRODUCT = 'kinso-source';
const KINSO_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
const kinsoFile = name => new URL(`./public/kinso-source/${name}`, import.meta.url);

export function amountCents(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1 || amount > 10000) return null;
  // Check decimal precision before rounding the binary floating-point product.
  // For example, 1.10 is valid even though 1.10 * 100 is not exactly integral.
  return /^\d+(?:\.\d{1,2})?$/.test(String(amount)) ? Math.round(amount * 100) : null;
}

const storeFile = name => new URL(`./public/store/${name}`, import.meta.url);
async function kinsoPage(company) {
  if (company !== 'kinso') return readFile(storeFile('shop.html'), 'utf8');
  return readFile(storeFile('kinso/index.html'), 'utf8').catch(() => readFile(storeFile('kinso.html'), 'utf8'));
}

export function createShop({ stripe, rentals, store, tell, secure, limiter, clientKey, readBody, json, html, escapeHtml, now }) {
  const paidCache = new Map();
  const checking = new Map();
  const notifying = new Map();
  const answer = (res, status, value) => json(res, status, value, { 'cache-control': 'no-store' });
  async function paidSale(session) {
    const product = session.metadata?.product;
    if (session.payment_status !== 'paid' || ![PRODUCT, KINSO_PRODUCT].includes(product) || !SESSION.test(session.id)) return;
    const key = `${product === PRODUCT ? 'source-sale' : 'kinso-sale'}:${session.id}`;
    if (store.seenEvent(key)) return;
    if (notifying.has(key)) return notifying.get(key);
    const job = (async () => {
      const email = validEmail(session.customer_details?.email ?? session.customer_email) || 'email not provided';
      const amount = Number.isSafeInteger(session.amount_total) ? `US$${(session.amount_total / 100).toFixed(2)}` : 'a contribution';
      if (product === KINSO_PRODUCT) {
        await tell({ name: 'sale: kinso source', prompt: `Someone paid ${amount} for the Kinso Computer source on kinso.computer (${email}). Noah is watching for Frank and the Kinso team to pay: tell him in a sentence who it was. Stripe session: ${session.id}.` });
      } else {
        await tell({ name: 'sale: source support', prompt: `Someone supported imperfect source code with ${amount} (${email}). The code is free on GitHub; no membership key is needed. Tell Noah in a sentence. Stripe session: ${session.id}.` });
      }
      store.firstSeen(key, product);
    })();
    notifying.set(key, job);
    try { await job; } finally { notifying.delete(key); }
  }
  async function status(id) {
    if (!SESSION.test(id) || !stripe) return { paid: false };
    if ((paidCache.get(id) ?? 0) > now()) return { paid: true, command: INSTALL_COMMAND };
    if (checking.has(id)) return checking.get(id);
    const job = (async () => {
      let session;
      try { session = await stripe.retrieveSession(id); }
      catch { return { paid: false }; }
      if (session.payment_status !== 'paid') return { paid: false };
      await paidSale(session);
      for (const [key, expiry] of paidCache) if (expiry <= now()) paidCache.delete(key);
      if (paidCache.size >= 1000) paidCache.delete(paidCache.keys().next().value);
      paidCache.set(id, now() + 30_000);
      return { paid: true, command: INSTALL_COMMAND };
    })();
    checking.set(id, job);
    try { return await job; } finally { checking.delete(id); }
  }
  // kinso.computer's source: paid for once, then the command. Polled by the Code window while Stripe's tab is open.
  const kinsoPaid = new Map(), kinsoChecking = new Map();
  async function kinsoStatus(id) {
    if (!SESSION.test(id) || !stripe) return { paid: false };
    if ((kinsoPaid.get(id) ?? 0) > now()) return { paid: true, command: KINSO.install };
    if (kinsoChecking.has(id)) return kinsoChecking.get(id);
    const job = (async () => {
      let session;
      try { session = await stripe.retrieveSession(id); }
      catch { return { paid: false }; }
      if (session.payment_status !== 'paid' || session.metadata?.product !== KINSO_PRODUCT) return { paid: false };
      await paidSale(session);
      for (const [key, expiry] of kinsoPaid) if (expiry <= now()) kinsoPaid.delete(key);
      if (kinsoPaid.size >= 1000) kinsoPaid.delete(kinsoPaid.keys().next().value);
      kinsoPaid.set(id, now() + 30_000);
      return { paid: true, command: KINSO.install };
    })();
    kinsoChecking.set(id, job);
    try { return await job; } finally { kinsoChecking.delete(id); }
  }
  // Kinso's mark (from the git-ignored rebuild of their page, /kinso/a/) and type (kinso-source/page.css); the words are
  // the concept's.
  const MARK = '/kinso/a/aa106999c9d67289.png';
  const kinsoSourcePage = (body, attrs = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>The source · Kinso Computer</title><link rel="icon" href="${MARK}"><link rel="stylesheet" href="/source/page.css?v=1"><script type="module" src="/source/page.js?v=1"></script></head><body${attrs}><main class="source"><a class="source-mark" href="/" aria-label="kinso.computer"><img src="${MARK}" alt="" width="46" height="51"></a>${body}<p class="source-small source-foot">A concept by Noah Fleming, a Kinso customer: not a Kinso product.</p></main></body></html>`;
  const payBlock = note => `<p class="source-price"><strong>${KINSO.source.label}</strong> once</p><button type="button" id="source-pay" class="source-pill">Pay ${KINSO.source.label} <span aria-hidden="true">›</span></button><p id="source-status" class="source-small" role="status">${note}</p>`;
  const ask = note => `<p class="source-label">The source</p><h1>Kinso Computer, yours to install.</h1><p class="source-lead">One command. Paste it into your own agent, Claude Code or Codex, and it installs Kinso Computer on your computer.</p>${payBlock(note)}`;
  async function kinso(req, res, url) {
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!KINSO_HOSTS.includes(host)) return false;
    const path = url.pathname, origin = `${secure ? 'https' : 'http'}://${req.headers.host}`;
    if (req.method === 'POST' && path === KINSO.source.checkout) {
      if (req.headers.origin && req.headers.origin !== origin) { answer(res, 403, { error: 'that request came from somewhere else' }); return true; }
      if (!limiter.allow(`kinso-source:${clientKey(req)}`)) { answer(res, 429, { error: 'slow down' }); return true; }
      if (!stripe) { answer(res, 503, { error: 'the till is not open yet' }); return true; }
      try {
        const session = await stripe.checkoutSession({ mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: KINSO.source.price * 100,
          product_data: { name: 'Kinso Computer: the source', description: 'One payment. The command that installs Kinso Computer through your own agent. A concept by Noah Fleming, not a Kinso product.' } } }],
          success_url: `${origin}${KINSO.source.page}?session={CHECKOUT_SESSION_ID}`, cancel_url: `${origin}${KINSO.source.page}?cancelled=1`,
          metadata: { product: KINSO_PRODUCT }, managed_payments: { enabled: false } }, { idempotencyKey: randomUUID() });
        answer(res, 200, { url: session.url, session: session.id });
      } catch { answer(res, 502, { error: 'checkout could not be opened; please try again' }); }
      return true;
    }
    if (req.method === 'GET' && path === KINSO.source.status) {
      answer(res, 200, await kinsoStatus(url.searchParams.get('session') ?? '')); return true;
    }
    const asset = { '/source/page.css': 'text/css; charset=utf-8', '/source/page.js': 'text/javascript; charset=utf-8' }[path];
    if (req.method === 'GET' && asset) {
      res.writeHead(200, { 'content-type': asset, 'cache-control': 'public, max-age=300' });
      res.end(await readFile(kinsoFile(path.slice('/source/'.length)))); return true;
    }
    if (req.method === 'GET' && (path === KINSO.source.page || path === `${KINSO.source.page}/`)) {
      const id = url.searchParams.get('session') ?? '';
      let body, attrs = '';
      if (url.searchParams.get('cancelled') === '1') body = ask('No payment was taken.');
      else if (id && (await kinsoStatus(id)).paid) {
        attrs = ' data-paid="1"';
        body = `<p class="source-label">Thank you</p><h1>It’s yours.</h1><p class="source-lead">Paste this into your own agent and it installs Kinso Computer for you.</p><div class="source-line"><code id="source-command">${escapeHtml(KINSO.install)}</code><button type="button" id="source-copy">Copy</button></div><p class="source-small"><a href="/">Back to kinso.computer</a></p>`;
      } else if (id) body = ask('That payment isn’t confirmed yet. If you’ve just paid, refresh in a moment.');
      else body = ask('Paid through Stripe. The command appears here once it clears.');
      html(res, 200, kinsoSourcePage(body, attrs), { 'content-security-policy': KINSO_CSP, 'referrer-policy': 'no-referrer' }); return true;
    }
    return false;
  }
  const thanksPage = body =>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shop · imperfect</title><link rel="stylesheet" href="/landing.css?v=plain-1"><link rel="stylesheet" href="/shop.css"><script type="module" src="/shop-thanks.js"></script></head><body class="shop-thanks"><header class="header"><a class="brand" href="/"><img src="/assets/wordmark/imperfect-logo-silver.png" alt="imperfect" width="102" height="56"></a></header><main class="handoff">${body}<p><a href="/">Back to imperfect</a></p></main></body></html>`;
  async function handle(req, res, url) {
    const path = url.pathname;
    if (req.method === 'GET' && ['/buy', '/buy.html', '/rent.html'].includes(path)) {
      res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); res.end(); return true;
    }
    if (req.method === 'GET' && path === '/shop') {
      // A launch link made for Kinso (?for=kinso) opens the Shop as Kinso might sell it: Noah's "if I were you".
      // kinso/ is kinso.ai's own page, rebuilt with the concept's words (~/workbench/kinso/clone); it is Kinso's
      // work, so it lives only where the store runs and never in this source. Without it, kinso.html stands in.
      html(res, 200, await kinsoPage(url.searchParams.get('for'))); return true;
    }
    if (req.method === 'GET' && path === '/shop/offer') {
      answer(res, 200, { rent: { open: rentals.enabled(), price: 40, currency: 'usd', period: 'month', href: '/account' }, code: { open: Boolean(stripe), min: 1, currency: 'usd' } }); return true;
    }
    if (req.method === 'POST' && path === '/shop/code') {
      // Match the exact origin, not just its hostname (including scheme/port).
      // Non-browser clients may omit Origin, like the store's other POSTs.
      // This handler is only reached on configured store hosts. Preserve a
      // loopback development port, but never accept another host's authority.
      if (req.headers.origin && req.headers.origin !== `${secure ? 'https' : 'http'}://${req.headers.host}`) {
        answer(res, 403, { error: 'that request came from somewhere else' }); return true;
      }
      if (!limiter.allow(`shop-code:${clientKey(req)}`)) { answer(res, 429, { error: 'slow down' }); return true; }
      let body;
      try {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new Error('JSON required');
        body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
      } catch (error) { answer(res, error.status === 413 ? 413 : 400, { error: error.status === 413 ? 'body too large' : 'send JSON with a numeric amount' }); return true; }
      const cents = amountCents(body?.amount);
      if (cents === null) { answer(res, 400, { error: 'amount must be a number from US$1 to US$10000, with at most two decimals' }); return true; }
      if (Object.hasOwn(body, 'os') && !validOS(body.os)) {
        answer(res, 400, { error: 'os must be mac, linux, windows or mobile' }); return true;
      }
      const osQuery = validOS(body.os) ? `&os=${body.os}` : '';
      if (!stripe) { answer(res, 503, { error: 'the till is not open yet' }); return true; }
      try {
        const session = await stripe.checkoutSession({ mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents,
          product_data: { name: 'imperfect source code', description: 'Free on GitHub. Your payment supports Noah and imperfect.' } } }],
          success_url: `https://imperfect.computer/shop/thanks?session={CHECKOUT_SESSION_ID}${osQuery}`, cancel_url: `https://imperfect.computer/shop/thanks?cancelled=1${osQuery}`,
          metadata: { product: PRODUCT }, managed_payments: { enabled: false } }, { idempotencyKey: randomUUID() });
        answer(res, 200, { url: session.url, session: session.id });
      } catch { answer(res, 502, { error: 'checkout could not be opened; please try again' }); }
      return true;
    }
    if (req.method === 'GET' && path === '/shop/code/status') {
      answer(res, 200, await status(url.searchParams.get('session') ?? '')); return true;
    }
    if (req.method === 'GET' && path === '/shop/thanks') {
      // The code is free (Noah: "just give me the code"), so every outcome shows it; paying only says thank you.
      const info = installInstructions(resolveOS(url.searchParams));
      const command = `<section id="install-panel" class="shop-install" aria-labelledby="install-label"><h3 id="install-label">${info.label}</h3><div class="shop-platforms" role="group" aria-label="Install operating system"><button type="button" data-platform="linux" aria-pressed="${info.platform === 'linux'}">Linux</button><button type="button" data-platform="mac" aria-pressed="${info.platform === 'mac'}">macOS</button></div><p id="install-hint" class="shop-small">${info.hint}</p><pre tabindex="0" aria-label="Install command"><code id="install-command">${escapeHtml(INSTALL_COMMAND)}</code></pre><button type="button" id="copy-command">Copy command</button><p id="copy-status" role="status"></p></section>`;
      let body;
      if (url.searchParams.get('cancelled') === '1') body = `<h1>No payment was taken</h1><p>The code is free either way.</p>${command}`;
      else if ((await status(url.searchParams.get('session') ?? '')).paid) body = `<h1>Thank you</h1><p>Your support helps Noah keep making imperfect.</p><p>The code is free and open source on <a href="https://github.com/locusrifle/imperfect">GitHub</a>.</p>${command}`;
      else body = `<h1>Payment not confirmed</h1><p>This payment is unpaid, unknown, or could not be checked yet. If you just paid, refresh in a moment.</p><p>The code is free either way.</p>${command}`;
      html(res, 200, thanksPage(body), { 'referrer-policy': 'no-referrer' }); return true;
    }
    if (req.method === 'GET' && path === '/install') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(await readFile(new URL('./public/install.sh', import.meta.url), 'utf8')); return true;
    }
    return false;
  }
  return { handle, kinso, paidSale };
}
