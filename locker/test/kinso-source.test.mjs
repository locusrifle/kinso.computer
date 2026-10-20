// kinso.computer's source, paid for once (Noah: "one off payment for the source"): Get yours opens
// kinso.computer/source for US$39 through Stripe, then the install command. A paywall, not a lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { openStore } from '../store.mjs';
import { createLockerServer } from '../server.mjs';
import { KINSO_PRODUCT } from '../shop.mjs';
import { VARIANTS } from '../../website/variant.mjs';

const KINSO = VARIANTS.kinso;

async function boot(t, { configured = true } = {}) {
  const created = [], retrieved = [], told = [], sessions = new Map();
  const stripe = configured ? {
    async checkoutSession(params, options) { created.push({ params, options }); return { id: 'cs_test_kinso', url: 'https://checkout.stripe.com/c/pay/cs_test_kinso' }; },
    async retrieveSession(id) { retrieved.push(id); if (!sessions.has(id)) throw new Error('not found'); return sessions.get(id); },
  } : null;
  const store = openStore();
  const app = await createLockerServer({ store, stripe, tell: async words => told.push(words), mail: { configured: false, async send() {} },
    config: { secure: false, hosts: 'shop.test', stripe: {} }, port: 0, log: { info() {}, warn() {}, error() {} } });
  const address = await app.listen();
  t.after(async () => { await app.close(); store.close(); });
  const call = (path, { method = 'GET', body, headers = {}, host = 'kinso.computer' } = {}) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: address.port, path, method, headers: { host, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) }); });
    });
    req.on('error', reject); req.end(body);
  });
  const buy = (headers = { origin: 'http://kinso.computer' }, host) => call('/source/checkout', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}', host });
  return { call, buy, created, retrieved, told, sessions };
}

test('Kinso sells its source once, for US$39, through Stripe', () => {
  assert.deepEqual({ ...KINSO.source }, { price: 39, label: 'US$39', page: '/source', checkout: '/source/checkout', status: '/source/status' });
  assert.equal(VARIANTS.imperfect.source, undefined, 'imperfect.computer gives its source away as before');
});

test('the checkout is one US$39 payment, and comes back to kinso.computer/source', async t => {
  const f = await boot(t);
  const response = await f.buy();
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), { url: 'https://checkout.stripe.com/c/pay/cs_test_kinso', session: 'cs_test_kinso' });
  assert.equal(f.created.length, 1);
  const { params, options } = f.created[0];
  assert.equal(params.mode, 'payment', 'once, not a subscription');
  assert.deepEqual(params.line_items.map(item => [item.quantity, item.price_data.currency, item.price_data.unit_amount]), [[1, 'usd', 3900]]);
  assert.match(params.line_items[0].price_data.product_data.name, /Kinso Computer/);
  assert.deepEqual(params.metadata, { product: KINSO_PRODUCT });
  assert.equal(params.success_url, 'http://kinso.computer/source?session={CHECKOUT_SESSION_ID}');
  assert.equal(params.cancel_url, 'http://kinso.computer/source?cancelled=1');
  assert.ok(options.idempotencyKey);

  assert.equal((await f.buy({ origin: 'https://evil.test' })).status, 403, 'only from kinso.computer itself');
  assert.equal((await f.buy({ origin: 'http://www.kinso.computer' }, 'www.kinso.computer')).status, 200, 'www too');
  assert.notEqual((await f.buy({ origin: 'http://shop.test' }, 'shop.test')).status, 200, 'not sold on imperfect.computer');
  assert.equal(f.created.length, 2);
});

test('without a Stripe key the till says so instead of taking money', async t => {
  const f = await boot(t, { configured: false });
  const response = await f.buy();
  assert.equal(response.status, 503);
  assert.match(response.json().error, /till/);
});

test('the command is shown only for a paid Kinso session, and Noah hears about it once', async t => {
  const f = await boot(t);
  f.sessions.set('cs_test_unpaid', { id: 'cs_test_unpaid', payment_status: 'unpaid', metadata: { product: KINSO_PRODUCT } });
  f.sessions.set('cs_test_support', { id: 'cs_test_support', payment_status: 'paid', metadata: { product: 'source-support' }, amount_total: 100 });
  f.sessions.set('cs_test_paid', { id: 'cs_test_paid', payment_status: 'paid', metadata: { product: KINSO_PRODUCT }, amount_total: 3900, customer_details: { email: 'frank@kinso.ai' } });

  const status = async id => (await f.call(`/source/status?session=${id}`)).json();
  assert.deepEqual(await status('cs_test_unpaid'), { paid: false });
  assert.deepEqual(await status('cs_test_support'), { paid: false }, 'paying for imperfect is not paying for Kinso');
  assert.deepEqual(await status('nonsense'), { paid: false });
  assert.deepEqual(await status('cs_test_paid'), { paid: true, command: KINSO.install });
  assert.deepEqual(await status('cs_test_paid'), { paid: true, command: KINSO.install });

  const thanks = await f.call('/source?session=cs_test_paid');
  assert.equal(thanks.status, 200);
  assert.ok(thanks.text.includes(KINSO.install.replaceAll('&', '&amp;')), 'the command, to copy');
  assert.match(thanks.text, /data-paid="1"/);

  const kinsoTold = f.told.filter(words => words.name === 'sale: kinso source');
  assert.equal(kinsoTold.length, 1, 'told once, however often the browser asks');
  assert.match(kinsoTold[0].prompt, /US\$39\.00/);
  assert.match(kinsoTold[0].prompt, /frank@kinso\.ai/);
  assert.match(kinsoTold[0].prompt, /Kinso Computer source/);
});

test('kinso.computer/source asks for the payment, in Kinso\'s look, under its own strict policy', async t => {
  const f = await boot(t);
  const page = await f.call('/source');
  assert.equal(page.status, 200);
  assert.match(page.text, /Pay US\$39/);
  assert.match(page.text, /<strong>US\$39<\/strong> once/);
  assert.doesNotMatch(page.text, /curl -fsSL/, 'no command before paying');
  assert.match(page.text, /not a Kinso product/);
  assert.match(page.text, /\/kinso\/a\/[0-9a-f]{16}\.png/, 'Kinso\'s mark, from the git-ignored copy');
  const policy = page.headers['content-security-policy'];
  assert.match(policy, /script-src 'self'; style-src 'self';/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.doesNotMatch(policy, /unsafe-/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match((await f.call('/source?cancelled=1')).text, /No payment was taken/);
  assert.match((await f.call('/source?session=cs_test_missing')).text, /isn’t confirmed yet/);
  const css = await f.call('/source/page.css');
  assert.equal(css.status, 200); assert.match(css.headers['content-type'], /^text\/css/);
  for (const [, url] of css.text.matchAll(/url\(['"]?([^'")]+)/g)) assert.match(url, /^\/kinso\/a\/[0-9a-f]{16}\.woff2$/, url);
  const js = await f.call('/source/page.js');
  assert.equal(js.status, 200); assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.notEqual((await f.call('/source', { host: 'elsewhere.test' })).text.includes('Pay US$39'), true, 'only on Kinso\'s names');
});
