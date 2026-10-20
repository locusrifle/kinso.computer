// Disposable loopback services: real Stripe HTTP transport, no credentials or providers.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openStore } from '../store.mjs';
import { createStripe, signWebhook, STRIPE_VERSION } from '../stripe.mjs';
import { createLockerServer } from '../server.mjs';
import { digest } from '../account-security.mjs';

export const DAY = 86400_000;
export const WEBHOOK = 'whsec_offers_fixture';
export const OPERATOR = 'offers-fixture-operator';
const token = () => randomBytes(32).toString('base64url');
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

export async function fakeStripeHTTP() {
  const sessions = new Map(), subscriptions = new Map(), keys = new Map(), calls = [], errors = [];
  const fixture = { sessions, subscriptions, calls, errors, checkoutGate: null, subscriptionGate: null };
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer test');
      assert.equal(req.headers['stripe-version'], STRIPE_VERSION);
      const url = new URL(req.url, 'http://fixture');
      let body = ''; for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      calls.push({ method: req.method, path: url.pathname, search: url.search, form, key: req.headers['idempotency-key'] });
      let value;
      if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        const key = req.headers['idempotency-key'];
        assert.ok(key, 'all checkouts have an idempotency key');
        if (keys.has(key)) value = sessions.get(keys.get(key));
        else {
          const id = `cs_fixture_${sessions.size + 1}`;
          const metadata = Object.fromEntries([...form].filter(([name]) => /^metadata\[/.test(name)).map(([name, value]) => [name.slice(9, -1), value]));
          value = { id, mode: form.get('mode'), status: 'open', payment_status: 'unpaid', metadata,
            ...(form.has('client_reference_id') ? { client_reference_id: form.get('client_reference_id') } : {}),
            url: fixture.browserOrigin ? `${fixture.browserOrigin}/fake-stripe/checkout/${id}` : `https://checkout.stripe.com/c/${id}` };
          sessions.set(id, value); keys.set(key, id);
        }
        await fixture.checkoutGate;
      } else if (req.method === 'GET' && url.pathname.startsWith('/v1/checkout/sessions/')) {
        value = sessions.get(decodeURIComponent(url.pathname.split('/').at(-1)));
      } else if (req.method === 'GET' && url.pathname.startsWith('/v1/subscriptions/')) {
        assert.equal(url.searchParams.get('expand[]'), 'latest_invoice');
        value = structuredClone(subscriptions.get(decodeURIComponent(url.pathname.split('/').at(-1))));
        await fixture.subscriptionGate;
      } else if (req.method === 'POST' && url.pathname === '/v1/billing_portal/sessions') {
        value = { id: 'bps_fixture', url: fixture.browserOrigin ? `${fixture.browserOrigin}/fake-stripe/portal` : 'https://billing.stripe.com/p/session/fixture' };
      } else throw new Error(`unexpected fake Stripe request: ${req.method} ${req.url}`);
      res.writeHead(value ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value ?? { error: { message: 'No such fixture object' } }));
    } catch (error) {
      errors.push(error.message);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  const base = await listen(server);
  return Object.assign(fixture, {
    base, client: createStripe({ base, secretKey: 'test' }), close: () => close(server),
    async waitFor(predicate) {
      for (let i = 0; i < 500; i++) { if (predicate(calls)) return; await delay(10); }
      throw new Error('fake Stripe request did not arrive');
    },
  });
}

export async function offersFixture(t, { disabled = false, stripeSettings = {}, sendImpl } = {}) {
  const stripe = await fakeStripeHTTP();
  let at = Date.now(), sequence = 0, webhookRequests = 0, app;
  const store = openStore(':memory:', { now: () => at }), sent = [], logs = [];
  // The forwarding socket establishes the canonical host+port before accounts are made.
  let upstream;
  const proxy = createServer((req, res) => {
    if (req.url.startsWith('/fake-stripe/checkout/')) {
      const session = stripe.sessions.get(req.url.split('/').at(-1));
      if (!session) { res.writeHead(404); res.end(); return; }
      const target = session.mode === 'subscription' ? `${origin}/account?checkout=complete` : `${origin}/os/thanks?session_id=${session.id}`;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><h1>Fixture Stripe checkout</h1><a href="${target}">Return to imperfect</a>`); return;
    }
    if (req.url === '/fake-stripe/portal') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><h1>Fixture Stripe portal</h1><a href="${origin}/account">Return to account</a>`); return;
    }
    const forward = request(`${upstream}${req.url}`, { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    forward.on('error', error => { res.writeHead(502); res.end(error.message); });
    req.pipe(forward);
  });
  const origin = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    if (app) { app.server.closeAllConnections(); await app.close(); }
    await stripe.close(); store.close();
    assert.deepEqual(stripe.errors, [], 'fake Stripe saw only expected local requests');
  });
  const config = { hosts: [new URL(origin).host, '127.0.0.1'], secure: false,
    accounts: { base: origin, allowInsecureTest: true, operatorToken: OPERATOR },
    rentals: { graceDays: 7, retentionDays: 30 },
    stripe: { rentPrice: 'price_rent', osPrice: 'price_os', webhookSecret: WEBHOOK, ...stripeSettings } };
  app = await createLockerServer({ store, stripe: disabled ? null : stripe.client,
    mail: { configured: true, async send(note) { if (sendImpl) return sendImpl(note); sent.push(note); return { delivered: true }; } }, config, now: () => at, port: 0,
    log: { info() {}, warn(message) { logs.push(message); }, error(message) { logs.push(message); } } });
  app.server.on('request', req => { if (req.url === '/webhooks/stripe') webhookRequests++; });
  upstream = `http://127.0.0.1:${(await app.listen()).port}`;
  const call = (path, init = {}) => fetch(`${origin}${path}`, { ...init, redirect: 'manual' });
  const seed = (username = 'alder') => {
    const account = store.createAccount({ username, name: `${username} Person`, passwordHash: 'synthetic-offers-hash-not-for-login' });
    store.markRecoverySaved(account.id);
    const sessionToken = token(), csrf = token();
    store.saveAccountSession({ tokenHash: digest(sessionToken), accountId: account.id, csrf, expiresAt: at + 365 * DAY });
    return { account, csrf, token: sessionToken, cookie: `imperfect_account=${sessionToken}` };
  };
  const post = (path, owner, values = {}, headers = {}) => call(path, { method: 'POST',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...(owner ? { cookie: owner.cookie } : {}), ...headers },
    body: new URLSearchParams({ ...(owner ? { csrf: owner.csrf } : {}), ...values }).toString() });
  const webhook = (type, object, { id = `evt_offers_${++sequence}`, created = Math.floor(at / 1000), signature } = {}) => {
    const body = JSON.stringify({ id, type, created, data: { object } });
    return call('/webhooks/stripe', { method: 'POST', body,
      headers: { 'stripe-signature': signature ?? signWebhook(body, WEBHOOK, Math.floor(at / 1000)) } });
  };
  const subscription = owner => {
    const rental = store.rental(owner.account.id);
    const sub = { id: `sub_${owner.account.username}`, status: 'active', customer: `cus_${owner.account.username}`,
      metadata: { product: 'rent', account: owner.account.id, attempt: rental.attempt }, start_date: Math.floor(at / 1000),
      current_period_end: Math.floor(at / 1000) + 30 * 86400,
      items: { data: [{ price: { id: 'price_rent' } }] },
      latest_invoice: { status: 'paid', paid: true, customer_email: `${owner.account.username}@example.invalid` } };
    stripe.subscriptions.set(sub.id, sub); return sub;
  };
  const settleOS = (session, email = 'os@example.invalid') => Object.assign(session, {
    status: 'complete', payment_status: 'paid', customer: 'cus_os', customer_details: { email },
  });
  return { stripe, store, sent, logs, origin, config, call, post, seed, webhook, subscription, settleOS,
    now: () => at, receivedWebhooks: () => webhookRequests, setNow(value) { at = value; } };
}
