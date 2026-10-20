import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createRentals, grantTester, rentalPolicy } from '../rentals.mjs';
import { offersFixture, DAY } from './offers-fixture.mjs';

async function activate(f, owner) {
  await f.post('/account/rent', owner);
  const sub = f.subscription(owner);
  assert.equal((await f.webhook('customer.subscription.updated', sub)).status, 200);
  return sub;
}
test('concurrent expired checkout retries share the replacement reservation', async t => {
  const f = await offersFixture(t), owner = f.seed();
  await f.post('/account/rent', owner);
  [...f.stripe.sessions.values()][0].status = 'expired';
  const responses = await Promise.all([f.post('/account/rent', owner), f.post('/account/rent', owner)]);
  assert.equal(responses[0].headers.get('location'), responses[1].headers.get('location'));
  assert.equal(f.stripe.sessions.size, 2);
  assert.equal(f.store.rentals().length, 1);
});
test('failed first payment never provisions a computer during incomplete checkout', async t => {
  const f = await offersFixture(t), owner = f.seed();
  await f.post('/account/rent', owner); const sub = f.subscription(owner);
  sub.status = 'incomplete';
  sub.latest_invoice = { status: 'open', attempted: true, paid: false, created: Math.floor(f.now() / 1000), customer_email: 'alder@example.invalid' };
  assert.equal((await f.webhook('invoice.payment_failed', { subscription: sub.id })).status, 200);
  const row = f.store.rental(owner.account.id);
  assert.equal(row.status, 'pending');
  assert.equal(rentalPolicy(row).want, 'stop');
  assert.equal((await f.call('/account', { headers: { cookie: owner.cookie } })).status, 200);
  assert.equal(f.sent.length, 0);
});
test('unpaid and paused subscriptions retain ownership and can recover', async t => {
  const f = await offersFixture(t), owner = f.seed(), sub = await activate(f, owner);
  for (const status of ['unpaid', 'paused']) {
    sub.status = status;
    assert.equal((await f.webhook('customer.subscription.updated', sub)).status, 200);
    assert.equal(f.store.rental(owner.account.id).status, 'past_due');
    assert.equal((await f.post('/account/rent', owner)).status, 409);
    assert.throws(() => grantTester(f.store, 'alder'), /cancel the Stripe rental/);
    sub.status = 'active';
    assert.equal((await f.webhook('invoice.paid', { subscription: sub.id })).status, 200);
    assert.equal(f.store.rental(owner.account.id).status, 'active');
  }
});
test('a newly paused subscription with an old paid invoice gets a fresh grace window', async t => {
  const f = await offersFixture(t), owner = f.seed(), sub = await activate(f, owner);
  sub.latest_invoice.created = Math.floor((f.now() - 90 * DAY) / 1000);
  sub.status = 'paused';
  assert.equal((await f.webhook('customer.subscription.updated', sub)).status, 200);
  const row = f.store.rental(owner.account.id), policy = rentalPolicy(row, { now: f.now() });
  assert.equal(row.unpaidSince, f.now());
  assert.equal(policy.stopAt, f.now() + 7 * DAY); assert.equal(policy.want, 'provision');
});
test('slow outbox delivery cannot hold the verified billing queue or purchase responses', async t => {
  let release, started = false;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await offersFixture(t, { sendImpl: async note => { if (note.subject === 'slow') { started = true; await gate; } return { delivered: true }; } });
  t.after(() => release());
  f.store.queueRentalMail('slow', { to: 'old@example.invalid', subject: 'slow', text: 'slow' });
  const first = { id: 'cs_slow_1', metadata: { product: 'code' }, payment_status: 'paid', customer_details: { email: 'one@example.invalid' } };
  const second = { ...first, id: 'cs_slow_2', customer_details: { email: 'two@example.invalid' } };
  assert.equal((await f.webhook('checkout.session.completed', first)).status, 200);
  assert.equal(started, true);
  const response = await Promise.race([f.webhook('checkout.session.completed', second), delay(1500).then(() => { throw new Error('slow mail held the billing queue'); })]);
  assert.equal(response.status, 200);
  assert.ok(f.store.licenseBySession(second.id));
  release();
});
test('each unpaid episode sends one recovery message, replays do not', async t => {
  const f = await offersFixture(t), owner = f.seed(), sub = await activate(f, owner);
  for (let cycle = 1; cycle <= 2; cycle++) {
    f.setNow(f.now() + DAY);
    sub.status = 'past_due';
    sub.latest_invoice = { status: 'open', attempted: true, paid: false, created: Math.floor(f.now() / 1000), customer_email: 'alder@example.invalid' };
    await f.webhook('invoice.payment_failed', { subscription: sub.id });
    sub.status = 'active'; sub.latest_invoice.paid = true; sub.latest_invoice.status = 'paid';
    await f.webhook('invoice.paid', { subscription: sub.id }, { id: `evt_recovered_${cycle}` });
    await f.webhook('invoice.paid', { subscription: sub.id }, { id: `evt_recovered_${cycle}` });
  }
  assert.equal(f.sent.filter(note => note.subject.endsWith('active')).length, 3);
});
test('unfinished unsigned requests cannot block a signed webhook; event is recorded only after fulfillment', async t => {
  const f = await offersFixture(t), owner = f.seed();
  await f.post('/account/rent', owner); const sub = f.subscription(owner);
  const slow = request(`${f.origin}/webhooks/stripe`, { method: 'POST', headers: { 'content-length': 1000 } });
  slow.on('error', () => {}); slow.flushHeaders(); slow.write('{');
  t.after(() => slow.destroy());
  let release;
  f.stripe.subscriptionGate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const pending = f.webhook('customer.subscription.updated', sub, { id: 'evt_interrupted' });
  await f.stripe.waitFor(calls => calls.some(call => call.path === `/v1/subscriptions/${sub.id}`));
  assert.equal(f.store.seenEvent('evt_interrupted'), false, 'no event claim can survive an interrupted network read');
  release();
  const response = await Promise.race([pending, delay(3000).then(() => { throw new Error('signed webhook blocked by unsigned body'); })]);
  assert.equal(response.status, 200); assert.equal(f.store.seenEvent('evt_interrupted'), true);
  slow.destroy();
});
test('undelivered outbox mail stays pending without blocking legacy licences or OS issuance', async t => {
  let delivering = false;
  const sent = [];
  const f = await offersFixture(t, { sendImpl: async note => { if (!delivering) throw new Error('provider unavailable'); sent.push(note); return { delivered: true }; } });
  f.store.queueRentalMail('old', { to: 'old@example.invalid', subject: 'old', text: 'old' });
  const offline = createRentals({ store: f.store, stripe: f.stripe.client, config: f.config, base: f.origin,
    mail: { async send() { return { delivered: false }; } } });
  await offline.flushMail(); assert.equal(f.store.pendingRentalMail().length, 1);
  const broken = createRentals({ store: f.store, stripe: f.stripe.client, config: f.config, base: f.origin,
    mail: { async send() { throw new Error('offline'); } } });
  await broken.flushMail(); assert.equal(f.store.pendingRentalMail().length, 1);
  const note = { id: 'cs_legacy_recovery', metadata: { product: 'code' }, payment_status: 'paid', customer_details: { email: 'legacy@example.invalid' } };
  assert.equal((await f.webhook('checkout.session.completed', note)).status, 200);
  assert.equal(f.store.licenseBySession(note.id).product, 'code');
  assert.equal(f.store.pendingRentalMail().length, 1);
  await f.post('/os/buy', null);
  const session = [...f.stripe.sessions.values()][0]; f.settleOS(session);
  assert.equal((await f.webhook('checkout.session.completed', session, { id: 'evt_mail_os' })).status, 200);
  assert.equal(f.store.licenseBySession(session.id).product, 'os');
  assert.equal(f.store.pendingRentalMail().length, 2);
  delivering = true;
  assert.equal((await f.webhook('checkout.session.completed', session, { id: 'evt_mail_os' })).status, 200);
  assert.equal(f.store.pendingRentalMail().length, 0);
  assert.equal(sent.filter(note => note.subject === 'old').length, 1);
});
test('expired checkout event releases reservations without provisioning or billing', async t => {
  const f = await offersFixture(t), owner = f.seed();
  await f.post('/account/rent', owner);
  const session = [...f.stripe.sessions.values()][0]; session.status = 'expired';
  assert.equal((await f.webhook('checkout.session.expired', session)).status, 200);
  assert.equal(f.store.rental(owner.account.id).status, 'canceled');
  grantTester(f.store, 'alder');
  assert.equal(f.store.rental(owner.account.id).source, 'tester');
});
