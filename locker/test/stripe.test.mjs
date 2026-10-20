import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStripe, encodeForm, signWebhook, verifyWebhook } from '../stripe.mjs';

test('nested params take Stripe\'s bracket form', () => {
  const encoded = encodeForm({ mode: 'payment', line_items: [{ price: 'price_1', quantity: 1 }], metadata: { product: 'code' } }).toString();
  assert.equal(encoded, 'mode=payment&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Bproduct%5D=code');
});

test('a signed webhook verifies, a tampered one does not, an old one does not', () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const now = () => 1_700_000_000_000;
  const header = signWebhook(payload, secret, 1_700_000_000);
  assert.equal(verifyWebhook(payload, header, secret, { now }).id, 'evt_1');
  assert.throws(() => verifyWebhook(payload.replace('evt_1', 'evt_2'), header, secret, { now }), /does not match/);
  assert.throws(() => verifyWebhook(payload, signWebhook(payload, secret, 1_700_000_000 - 600), secret, { now }), /too old/);
  assert.throws(() => verifyWebhook(payload, '', secret, { now }), /missing/);
});

test('the client sends a bearer key and form bodies, and surfaces Stripe errors', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/v1/checkout/sessions')) return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/c/1' }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: 'No such session', code: 'resource_missing' } }), { status: 404 });
  };
  const stripe = createStripe({ secretKey: 'sk_test', fetchImpl });
  const session = await stripe.checkoutSession({ mode: 'payment' }, { idempotencyKey: 'k1' });
  assert.equal(session.id, 'cs_1');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk_test');
  assert.equal(calls[0].init.headers['idempotency-key'], 'k1');
  assert.equal(calls[0].init.body, 'mode=payment');
  await assert.rejects(() => stripe.retrieveSession('cs_missing'), /No such session/);
});
