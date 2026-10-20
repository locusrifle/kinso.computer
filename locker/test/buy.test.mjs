import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { execFileSync } from 'node:child_process';
import { openStore } from '../store.mjs';
import { createLockerServer, createLimiter } from '../server.mjs';
import { INSTALL_COMMAND } from '../shop.mjs';
import { signWebhook } from '../stripe.mjs';

async function boot(t, { configured = true, rentPrice = '', webhookSecret = '', limiter, store = openStore(), now } = {}) {
  const created = [], retrieved = [], told = [], sessions = new Map();
  const stripe = configured ? {
    async checkoutSession(params, options) { created.push({ params, options }); return { id: 'cs_test_checkout', url: 'https://checkout.stripe.com/test' }; },
    async retrieveSession(id) { retrieved.push(id); if (!sessions.has(id)) throw new Error('not found'); return sessions.get(id); },
  } : null;
  const app = await createLockerServer({ store, stripe, tell: async words => told.push(words), mail: { configured: false, async send() {} },
    config: { secure: false, hosts: 'shop.test', stripe: { rentPrice, webhookSecret } }, port: 0, limiter, now,
    log: { info() {}, warn() {}, error() {} } });
  const address = await app.listen();
  t.after(async () => { await app.close(); store.close(); });
  const call = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path, method, headers: { host: 'shop.test', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }); });
    });
    req.on('error', reject); req.end(body);
  });
  const post = value => call('/shop/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://shop.test' }, body: JSON.stringify(value) });
  return { call, post, created, retrieved, told, sessions, store };
}

test('Shop offer uses the existing rental gate, independently of the legacy fixed code price', async t => {
  for (const settings of [{ configured: false }, {}, { rentPrice: 'price_rent' }, { rentPrice: 'price_rent', webhookSecret: 'whsec_test' }]) {
    const f = await boot(t, settings);
    const response = await f.call('/shop/offer');
    assert.deepEqual(response.json(), { rent: { open: Boolean(settings.rentPrice && settings.webhookSecret), price: 40, currency: 'usd', period: 'month', href: '/account' }, code: { open: settings.configured !== false, min: 1, currency: 'usd' } });
    assert.equal(response.headers['cache-control'], 'no-store');
  }
});

test('standalone Shop is a no-store CSP-clean page with same-origin external assets', async t => {
  const f = await boot(t);
  const response = await f.call('/shop?os=mac');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-type'], /^text\/html/);
  const csp = response.headers['content-security-policy'];
  assert.match(csp, /script-src 'self'/); assert.match(csp, /style-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.match(response.text, /A computer of your own\./);
  assert.match(response.text, /just give me the code/);
  assert.doesNotMatch(response.text, /<style\b|\sstyle=|\son\w+=|<script(?![^>]*\bsrc=)/i);
  for (const path of ['/shop.js', '/shop.css', '/shop-platform.mjs', '/shop-thanks.js']) {
    const asset = await f.call(path);
    assert.equal(asset.status, 200, path);
    assert.match(asset.headers['content-type'], path.endsWith('.css') ? /^text\/css/ : /^text\/javascript/);
    assert.doesNotMatch(asset.text, /window\.open\(|setInterval\(|\/shop\/code\/status/);
  }
  const script = await f.call('/shop.js');
  assert.match(script.text, /location\.assign\(url\)/);
  assert.doesNotMatch(script.text, /mac\/|shell\.mjs|postMessage/);
});

test('optional validated visitor OS survives checkout success and cancellation; invalid values never reach Stripe', async t => {
  const f = await boot(t);
  for (const os of ['mac', 'linux', 'windows', 'mobile']) {
    assert.equal((await f.post({ amount: 1, os })).status, 200);
    const params = f.created.at(-1).params;
    assert.equal(params.success_url, `https://imperfect.computer/shop/thanks?session={CHECKOUT_SESSION_ID}&os=${os}`);
    assert.equal(params.cancel_url, `https://imperfect.computer/shop/thanks?cancelled=1&os=${os}`);
  }
  const g = await boot(t);
  for (const os of ['macos', 'phone', 'MAC', '', null, [], {}, ['mac'], 'mac&session=evil', true]) {
    assert.equal((await g.post({ amount: 1, os })).status, 400, JSON.stringify(os));
  }
  assert.equal(g.created.length, 0);
});

test('source amount validation is numeric, bounded and rejects fractional cents', async t => {
  const f = await boot(t);
  for (const amount of [0.99, 1.005, 10000.01, '1', null, true, {}, [], -1, 1.00000000001]) {
    const response = await f.post({ amount });
    assert.equal(response.status, 400, JSON.stringify(amount)); assert.ok(response.json().error);
  }
  // Fresh IP/rate bucket to separate validation from the public limiter.
  const g = await boot(t);
  for (const value of [{}, null, [], { amount: '7.50' }]) assert.equal((await g.post(value)).status, 400);
  assert.equal(f.created.length, 0);
});

test('checkout uses dollars converted to cents and exactly the public-source contract', async t => {
  const f = await boot(t);
  for (const [amount, cents] of [[1, 100], [7.50, 750], [1.10, 110], [10000, 1000000]]) {
    const response = await f.post({ amount });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { url: 'https://checkout.stripe.com/test', session: 'cs_test_checkout' });
    const { params, options } = f.created.at(-1);
    assert.deepEqual(params.line_items, [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents, product_data: { name: 'imperfect source code', description: 'Free on GitHub. Your payment supports Noah and imperfect.' } } }]);
    assert.equal(params.mode, 'payment'); assert.equal(params.metadata.product, 'source-support');
    assert.equal(params.success_url, 'https://imperfect.computer/shop/thanks?session={CHECKOUT_SESSION_ID}');
    assert.equal(params.cancel_url, 'https://imperfect.computer/shop/thanks?cancelled=1');
    assert.deepEqual(params.managed_payments, { enabled: false }); assert.ok(options.idempotencyKey);
  }
  assert.equal(new Set(f.created.map(row => row.options.idempotencyKey)).size, 4);
});

test('checkout errors are JSON: closed Stripe, origin, size, parsing and rate limits', async t => {
  const closed = await boot(t, { configured: false });
  assert.equal((await closed.post({ amount: 1 })).status, 503);
  const f = await boot(t);
  for (const origin of ['http://evil.test', 'https://shop.test', 'http://shop.test:9999', 'null']) {
    const response = await f.call('/shop/code', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{"amount":1}' });
    assert.equal(response.status, 403); assert.ok(response.json().error);
  }
  for (const body of ['{', 'x'.repeat(4097)]) {
    const response = await f.call('/shop/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(response.status, body.length > 4096 ? 413 : 400); assert.ok(response.json().error);
  }
  const limited = await boot(t, { limiter: createLimiter({ perMinute: 1 }) });
  assert.equal((await limited.post({ amount: 1 })).status, 200);
  assert.equal((await limited.post({ amount: 1 })).status, 429);
});

test('status validates IDs, distinguishes paid from unpaid/gifts/unknown, and briefly caches paid answers', async t => {
  let at = Date.now();
  const f = await boot(t, { now: () => at });
  for (const id of ['', 'cs_bad', 'cs_test_a/b', 'cs_live_', 'cs_test_<script>']) {
    assert.deepEqual((await f.call(`/shop/code/status?session=${encodeURIComponent(id)}`)).json(), { paid: false });
  }
  assert.equal(f.retrieved.length, 0);
  for (const payment_status of ['unpaid', 'no_payment_required', 'paid']) {
    f.sessions.set('cs_test_example', { id: 'cs_test_example', payment_status });
    const response = await f.call('/shop/code/status?session=cs_test_example');
    assert.deepEqual(response.json(), payment_status === 'paid' ? { paid: true, command: INSTALL_COMMAND } : { paid: false });
  }
  const count = f.retrieved.length;
  await f.call('/shop/code/status?session=cs_test_example');
  assert.equal(f.retrieved.length, count);
  at += 30001; await f.call('/shop/code/status?session=cs_test_example');
  assert.equal(f.retrieved.length, count + 1);
  assert.deepEqual((await f.call('/shop/code/status?session=cs_live_unknown')).json(), { paid: false });
});

test('thank-you page has paid, cancelled and unknown states and a CSP-compatible copy button', async t => {
  const f = await boot(t);
  f.sessions.set('cs_test_paid', { id: 'cs_test_paid', payment_status: 'paid' });
  const paid = await f.call('/shop/thanks?session=cs_test_paid');
  assert.match(paid.text, /<h1>Thank you<\/h1>/); assert.ok(paid.text.includes(INSTALL_COMMAND));
  assert.match(paid.text, /id="copy-command"/); assert.match(paid.text, /src="\/shop-thanks.js"/);
  assert.equal(paid.headers['cache-control'], 'no-store'); assert.equal(paid.headers['referrer-policy'], 'no-referrer');
  assert.match((await f.call('/shop-thanks.js')).text, /navigator.clipboard.writeText/);
  for (const path of ['/shop/thanks', '/shop/thanks?session=cs_test_missing', '/shop/thanks?session=%3Cscript%3E']) {
    const page = await f.call(path); assert.match(page.text, /Payment not confirmed/); assert.ok(page.text.includes(INSTALL_COMMAND), 'the code is free either way'); assert.doesNotMatch(page.text, /Thank you/);
  }
  const cancelled = await f.call('/shop/thanks?cancelled=1');
  assert.match(cancelled.text, /No payment was taken/); assert.match(cancelled.text, /href="\/"/); assert.ok(cancelled.text.includes(INSTALL_COMMAND), 'the code is free either way'); assert.doesNotMatch(cancelled.text, /Thank you/);
});

test('all thank-you outcomes have validated OS instructions, a switch and a safely wrapped free command', async t => {
  const f = await boot(t);
  f.sessions.set('cs_test_paidOS', { id: 'cs_test_paidOS', payment_status: 'paid' });
  for (const outcome of ['session=cs_test_paidOS', 'cancelled=1', 'session=cs_test_missingOS']) {
    for (const [os, label, hint] of [
      ['mac', 'Install on your Mac', 'Open Terminal and paste this.'],
      ['linux', 'Install on Linux', 'Paste this in a terminal.'],
      ['windows', 'Install on Linux', 'On Windows, run it inside WSL (Ubuntu).'],
      ['mobile', 'Install on Linux', 'Run this on your computer.'],
    ]) {
      const response = await f.call(`/shop/thanks?${outcome}&os=${os}`);
      assert.equal(response.status, 200);
      assert.ok(response.text.includes(label)); assert.ok(response.text.includes(hint));
      assert.ok(response.text.includes(INSTALL_COMMAND));
      assert.match(response.text, /data-platform="linux"/); assert.match(response.text, /data-platform="mac"/);
      assert.match(response.text, /<pre[^>]*><code id="install-command">/);
      assert.doesNotMatch(response.text, /<style\b|\sstyle=|\son\w+=|<script(?![^>]*\bsrc=)/i);
    }
  }
  for (const query of ['os=mac&os=linux', 'os=mac&os=mac', 'os=%3Cscript%3E', 'os=MAC']) {
    const response = await f.call('/shop/thanks?cancelled=1&' + query);
    assert.match(response.text, /Install on Linux/); assert.doesNotMatch(response.text, /Install on your Mac|<script>/);
  }
});

test('paid support notifies Noah once per session across polling and distinct webhook events; creates no licence', async t => {
  const f = await boot(t, { webhookSecret: 'whsec_test' });
  const session = { id: 'cs_test_support', payment_status: 'paid', amount_total: 750, metadata: { product: 'source-support' }, customer_details: { email: 'supporter@example.test' } };
  f.sessions.set(session.id, session);
  await Promise.all(Array.from({ length: 5 }, () => f.call('/shop/code/status?session=' + session.id)));
  for (const [id, type] of [['evt_1', 'checkout.session.completed'], ['evt_2', 'checkout.session.async_payment_succeeded']]) {
    const body = JSON.stringify({ id, type, data: { object: session } });
    const response = await f.call('/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signWebhook(body, 'whsec_test') } });
    assert.equal(response.status, 200);
  }
  assert.equal(f.told.length, 1); assert.match(f.told[0].prompt, /US\$7.50/);
  assert.ok(f.store.seenEvent(`source-sale:${session.id}`)); assert.equal(f.store.licenseBySession(session.id), null);
});

test('a webhook-first support sale notifies without a browser, and persistent session dedup survives other events', async t => {
  const f = await boot(t, { webhookSecret: 'whsec_test' });
  const session = { id: 'cs_live_support', payment_status: 'paid', amount_total: 100, metadata: { product: 'source-support' } };
  for (const id of ['evt_first', 'evt_second']) {
    const body = JSON.stringify({ id, type: 'checkout.session.completed', data: { object: session } });
    const response = await f.call('/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signWebhook(body, 'whsec_test') } });
    assert.equal(response.status, 200);
  }
  assert.equal(f.told.length, 1);
  f.sessions.set(session.id, session);
  await f.call('/shop/code/status?session=' + session.id);
  assert.equal(f.told.length, 1);
  assert.equal(f.store.licenseBySession(session.id), null);
  // The durable event marker (not just a process-local cache) suppresses a
  // notification even for a session first encountered by this server.
  const other = { ...session, id: 'cs_test_previous' };
  f.store.firstSeen('source-sale:' + other.id, 'source-support');
  f.sessions.set(other.id, other);
  assert.equal((await f.call('/shop/code/status?session=' + other.id)).json().paid, true);
  assert.equal(f.told.length, 1);
});

test('legacy GET addresses redirect home; install is a quoted, rootless POSIX script', async t => {
  const f = await boot(t);
  for (const path of ['/buy', '/buy.html', '/rent.html']) {
    const response = await f.call(path); assert.equal(response.status, 302); assert.equal(response.headers.location, '/');
  }
  const response = await f.call('/install');
  assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(response.text, /^#!\/bin\/sh\n/); assert.match(response.text, /set -eu/);
  assert.match(response.text, /https:\/\/github.com\/locusrifle\/imperfect/);
  assert.match(response.text, /dest="\$HOME\/imperfect"/); assert.match(response.text, /merge --ff-only FETCH_HEAD/);
  assert.match(response.text, /\.\/install.sh <\/dev\/null/); assert.doesNotMatch(response.text, /sudo/);
  execFileSync('sh', ['-n'], { input: response.text });
});
