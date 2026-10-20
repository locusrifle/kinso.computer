import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grantTester, revokeTester, rentalPolicy } from '../rentals.mjs';
import { run as testerCommand } from '../tools/accounts.mjs';
import { DAY, OPERATOR, offersFixture } from './offers-fixture.mjs';

const checkoutCalls = f => f.stripe.calls.filter(c => c.method === 'POST' && c.path === '/v1/checkout/sessions');
const accountHTML = async (f, owner) => (await f.call('/account', { headers: { cookie: owner.cookie } })).text();
const operatorList = async (f, want = '') => {
  const response = await f.call(`/api/accounts/rentals${want ? `?want=${want}` : ''}`, { headers: { authorization: `Bearer ${OPERATOR}` } });
  assert.equal(response.status, 200); return (await response.json()).rentals;
};
async function activate(f, owner) {
  assert.equal((await f.post('/account/rent', owner)).status, 303);
  const sub = f.subscription(owner);
  assert.equal((await f.webhook('customer.subscription.created', { id: sub.id })).status, 200);
  return sub;
}

test('rental checkout is authenticated, CSRF-bound and idempotent across concurrent POSTs', async t => {
  const f = await offersFixture(t), owner = f.seed();
  assert.equal((await f.call('/account/rent')).headers.get('location'), '/account?next=/account/rent');
  assert.equal((await f.post('/account/rent', null)).status, 403);
  assert.equal((await f.post('/account/rent', owner, { csrf: 'wrong' })).status, 403);
  assert.equal((await f.post('/account/rent', owner, {}, { origin: 'https://evil.invalid' })).status, 403);
  assert.equal(checkoutCalls(f).length, 0);
  let release;
  f.stripe.checkoutGate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const first = f.post('/account/rent', owner), second = f.post('/account/rent', owner);
  await f.stripe.waitFor(calls => calls.filter(c => c.method === 'POST' && c.path === '/v1/checkout/sessions').length === 2);
  assert.equal(f.store.rentals().length, 1, 'reservation happens before network awaits');
  release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map(r => r.status), [303, 303]);
  assert.equal(responses[0].headers.get('location'), responses[1].headers.get('location'));
  assert.equal(f.stripe.sessions.size, 1);
  const [request, concurrent] = checkoutCalls(f);
  assert.equal(request.key, concurrent.key);
  assert.match(request.key, /^rent-/);
  const params = request.form;
  assert.equal(params.get('mode'), 'subscription');
  assert.equal(params.get('line_items[0][price]'), 'price_rent');
  assert.equal(params.get('line_items[0][quantity]'), '1');
  assert.equal(params.get('client_reference_id'), owner.account.id);
  assert.equal(params.get('metadata[product]'), 'rent');
  assert.equal(params.get('subscription_data[metadata][account]'), owner.account.id);
  assert.equal(params.get('subscription_data[metadata][attempt]'), f.store.rental(owner.account.id).attempt);
  assert.equal(params.get('success_url'), `${f.origin}/account?checkout=complete`);
  assert.equal(params.get('cancel_url'), `${f.origin}/account`);
  assert.equal(params.get('allow_promotion_codes'), 'true');
  assert.equal(params.get('managed_payments[enabled]'), 'false');
  assert.equal(Number(params.get('expires_at')), Math.floor((f.now() + DAY) / 1000));
  assert.equal((await f.post('/account/rent', owner)).headers.get('location'), responses[0].headers.get('location'));
  assert.equal(checkoutCalls(f).length, 2, 'open session is retrieved, not recreated');
  const session = [...f.stripe.sessions.values()][0]; session.status = 'complete';
  assert.equal((await f.post('/account/rent', owner)).status, 409, 'completed checkout waits for confirmation');
  assert.equal(checkoutCalls(f).length, 2);
  session.status = 'expired';
  assert.equal((await f.post('/account/rent', owner)).status, 303);
  assert.equal(f.stripe.sessions.size, 2, 'expired checkout gets a fresh attempt');
  assert.equal(f.store.rentals().length, 1);
  assert.notEqual(checkoutCalls(f).at(-1).key, request.key);
});

test('signed replay and out-of-order snapshots use canonical subscription truth; cancellation is terminal', async t => {
  const f = await offersFixture(t), owner = f.seed();
  const sub = await activate(f, owner);
  assert.equal(f.store.rental(owner.account.id).status, 'active');
  assert.equal(f.sent.length, 1);
  assert.equal((await f.post('/account/rent', owner)).status, 409);
  const stale = { ...sub, status: 'past_due' };
  const response = await f.webhook('customer.subscription.updated', stale, { id: 'evt_stale', created: 1 });
  assert.equal(response.status, 200);
  assert.equal(f.store.rental(owner.account.id).status, 'active', 'event snapshot never overwrites Stripe truth');
  const reads = f.stripe.calls.length;
  assert.equal((await (await f.webhook('customer.subscription.updated', stale, { id: 'evt_stale', created: 1 })).json()).duplicate, true);
  assert.equal(f.stripe.calls.length, reads, 'exact replay has no Stripe or mail side effects');
  assert.equal(f.sent.length, 1);
  sub.status = 'canceled'; sub.canceled_at = Math.floor(f.now() / 1000);
  assert.equal((await f.webhook('customer.subscription.deleted', { ...sub, status: 'active' })).status, 200);
  const canceled = f.store.rental(owner.account.id);
  assert.equal(canceled.status, 'canceled');
  sub.status = 'active';
  const session = [...f.stripe.sessions.values()][0];
  assert.equal((await f.webhook('checkout.session.completed', { ...session, subscription: sub.id })).status, 200);
  assert.equal(f.store.rental(owner.account.id).status, 'canceled', 'late completion cannot resurrect canceled subscription');
  assert.equal(f.store.rental(owner.account.id).canceledAt, canceled.canceledAt);
  assert.equal(f.sent.length, 2);
  assert.equal(f.store.listLicenses().length, 0, 'rental never issues a lifetime repository key');
  const intent = (await operatorList(f, 'stop'))[0];
  assert.equal(intent.stopAt, canceled.canceledAt);
  assert.equal(intent.deleteAfter, intent.stopAt + 30 * DAY);
});

test('concurrent webhooks serialize Stripe reads so a delayed response cannot overwrite newer truth', async t => {
  const f = await offersFixture(t), owner = f.seed(), sub = await activate(f, owner);
  const reads = () => f.stripe.calls.filter(c => c.path.startsWith('/v1/subscriptions/')).length;
  const before = reads(), received = f.receivedWebhooks();
  let release;
  f.stripe.subscriptionGate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const first = f.webhook('customer.subscription.updated', { id: sub.id }, { created: 10 });
  await f.stripe.waitFor(() => reads() === before + 1);
  // The first response captured active state, but Stripe changes while it waits.
  sub.status = 'past_due';
  sub.latest_invoice = { status: 'open', attempted: true, paid: false, created: Math.floor(f.now() / 1000), customer_email: 'alder@example.invalid' };
  f.stripe.subscriptionGate = null;
  const second = f.webhook('invoice.payment_failed', { subscription: sub.id }, { created: 5 });
  await f.stripe.waitFor(() => f.receivedWebhooks() === received + 2);
  assert.equal(reads(), before + 1, 'second delivered event cannot read Stripe until the first finishes');
  release();
  assert.deepEqual((await Promise.all([first, second])).map(r => r.status), [200, 200]);
  assert.equal(reads(), before + 2);
  assert.equal(f.store.rental(owner.account.id).status, 'past_due');
});

test('an unconfirmed day-old checkout reservation fails closed instead of billing twice', async t => {
  const f = await offersFixture(t), owner = f.seed();
  f.store.saveRental({ accountId: owner.account.id, source: 'stripe', status: 'pending', attempt: 'missing-confirmation', reservedAt: f.now() - DAY });
  const response = await f.post('/account/rent', owner);
  assert.equal(response.status, 409);
  assert.match(await response.text(), /confirmation is missing/);
  assert.equal(f.stripe.calls.length, 0);
});

test('invoice failure keeps seven days of service and thirty days retention; paid recovery clears the stop intent', async t => {
  const f = await offersFixture(t), owner = f.seed();
  const sub = await activate(f, owner), failedAt = Math.floor(f.now() / 1000) * 1000;
  // Even an active subscription can carry an attempted unpaid expanded invoice.
  sub.latest_invoice = { status: 'open', attempted: true, paid: false, created: failedAt / 1000,
    customer_email: 'alder@example.invalid', status_transitions: { finalized_at: failedAt / 1000 } };
  assert.equal((await f.webhook('invoice.payment_failed', { parent: { subscription_details: { subscription: sub.id } } })).status, 200);
  const row = f.store.rental(owner.account.id);
  assert.equal(row.status, 'past_due'); assert.equal(row.unpaidSince, failedAt);
  const state = rentalPolicy(row, { now: failedAt + 7 * DAY - 1 });
  assert.equal(state.want, 'provision'); assert.equal(state.stopAt, failedAt + 7 * DAY);
  assert.equal(state.deleteAfter, failedAt + 37 * DAY);
  f.setNow(failedAt + 7 * DAY);
  assert.equal((await operatorList(f, 'stop'))[0].want, 'stop', 'grace ends exactly at seven days');
  f.setNow(failedAt + 37 * DAY);
  assert.equal(rentalPolicy(f.store.rental(owner.account.id), { now: f.now() }).want, 'stop');
  assert.ok(f.store.rental(owner.account.id), 'retention is an intent, never an automatic deletion');
  f.setNow(failedAt + 8 * DAY);
  assert.equal((await f.webhook('invoice.payment_failed', { subscription: { id: sub.id } })).status, 200);
  assert.equal(f.store.rental(owner.account.id).unpaidSince, failedAt, 'repeated failures cannot extend grace');
  assert.equal(f.sent.filter(m => m.subject.endsWith('past_due')).length, 1);
  const warning = f.sent.find(m => m.subject.endsWith('past_due'));
  assert.match(warning.text, /7 days unpaid/); assert.match(warning.text, /30 days after stopping/);
  assert.ok(warning.text.includes(new Date(state.stopAt).toISOString()));
  assert.ok(warning.text.includes(new Date(state.deleteAfter).toISOString()));
  sub.latest_invoice = { ...sub.latest_invoice, status: 'paid', paid: true };
  assert.equal((await f.webhook('invoice.paid', { subscription: sub.id })).status, 200);
  const recovered = rentalPolicy(f.store.rental(owner.account.id), { now: f.now() });
  assert.equal(recovered.status, 'active'); assert.equal(recovered.unpaidSince, null);
  assert.equal(recovered.stopAt, null); assert.equal(recovered.deleteAfter, null); assert.equal(recovered.want, 'provision');
  assert.equal((await operatorList(f, 'stop')).length, 0);
  assert.equal(f.store.rentals().length, 1);
});

test('webhooks reject forged signatures and wrong prices, permit retry, and ignore unrelated attempts', async t => {
  const f = await offersFixture(t), owner = f.seed();
  await f.post('/account/rent', owner); const sub = f.subscription(owner);
  assert.equal((await f.webhook('customer.subscription.updated', { id: sub.id }, { signature: 't=0,v1=bad' })).status, 400);
  assert.equal(f.store.rental(owner.account.id).status, 'pending');
  sub.items.data[0].price.id = 'price_wrong';
  assert.equal((await f.webhook('customer.subscription.updated', { id: sub.id }, { id: 'evt_retry' })).status, 500);
  assert.equal(f.store.rental(owner.account.id).status, 'pending');
  sub.items.data[0].price.id = 'price_rent';
  assert.equal((await f.webhook('customer.subscription.updated', { id: sub.id }, { id: 'evt_retry' })).status, 200);
  sub.metadata.attempt = 'different-attempt'; sub.status = 'canceled';
  assert.equal((await f.webhook('customer.subscription.deleted', { id: sub.id })).status, 200);
  assert.equal(f.store.rental(owner.account.id).status, 'active');
  assert.equal((await f.call('/api/accounts/rentals')).status, 401);
  assert.equal((await f.call('/api/accounts/rentals?want=delete', { headers: { authorization: `Bearer ${OPERATOR}` } })).status, 400);
});

test('customer portal redirects only the owning authenticated Stripe renter', async t => {
  const f = await offersFixture(t), owner = f.seed(), other = f.seed('birch');
  assert.equal((await f.post('/account/portal', owner)).status, 409);
  const sub = await activate(f, owner);
  assert.equal((await f.post('/account/portal', other)).status, 409);
  assert.equal((await f.post('/account/portal', owner, { csrf: 'wrong' })).status, 403);
  const response = await f.post('/account/portal', owner);
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), 'https://billing.stripe.com/p/session/fixture');
  const request = f.stripe.calls.find(c => c.path === '/v1/billing_portal/sessions');
  assert.equal(request.form.get('customer'), sub.customer);
  assert.equal(request.form.get('return_url'), `${f.origin}/account`);
  assert.match(await accountHTML(f, owner), /Manage or cancel rental/);
});

test('operator tester grants, expiry and revocation need no card or Stripe request', async t => {
  const f = await offersFixture(t), owner = f.seed(), at = f.now();
  const out = { value: '', write(text) { this.value += text; } };
  testerCommand(f.store, ['grant', 'alder', '--tester'], out, { now: at });
  assert.equal(f.store.rental(owner.account.id).source, 'tester');
  assert.equal((await operatorList(f, 'provision'))[0].username, 'alder');
  assert.match(await accountHTML(f, owner), /you’re a tester, no card needed/);
  assert.match(await accountHTML(f, owner), /your computer is being made/);
  assert.equal((await f.post('/account/rent', owner)).status, 409);
  const until = at + DAY;
  grantTester(f.store, 'alder', until, at);
  assert.equal(rentalPolicy(f.store.rental(owner.account.id), { now: until - 1 }).want, 'provision');
  f.setNow(until);
  const expired = (await operatorList(f, 'stop'))[0];
  assert.equal(expired.status, 'canceled'); assert.equal(expired.stopAt, until); assert.equal(expired.deleteAfter, until + 30 * DAY);
  assert.throws(() => grantTester(f.store, 'alder', at, until), /future date/);
  assert.throws(() => grantTester(f.store, 'missing', null, at), /no such account/);
  assert.throws(() => testerCommand(f.store, ['grant', 'alder', '--tester', '--until', '2030-02-30'], out), /invalid until date/);
  testerCommand(f.store, ['revoke', 'alder'], out, { now: until });
  assert.equal(f.store.rental(owner.account.id).canceledAt, until);
  testerCommand(f.store, ['list'], out, { now: until });
  assert.match(out.value, /alder\ttester\tcanceled\tstop/);
  assert.equal(f.stripe.calls.length, 0);
  const paid = f.seed('cedar'); await activate(f, paid);
  assert.throws(() => grantTester(f.store, 'cedar', null, until), /cancel the Stripe rental/);
  assert.throws(() => revokeTester(f.store, 'cedar', until), /cancel paid rentals in Stripe/);
});

test('anonymous OS purchase: paid thanks and signed webhook issue one licence and one email', async t => {
  const f = await offersFixture(t);
  assert.equal((await f.post('/os/buy', null, {}, { origin: 'https://evil.invalid' })).status, 403);
  const response = await f.post('/os/buy', null);
  assert.equal(response.status, 303);
  const session = [...f.stripe.sessions.values()][0], params = checkoutCalls(f)[0].form;
  assert.equal(response.headers.get('location'), session.url);
  assert.equal(params.get('mode'), 'payment'); assert.equal(params.get('line_items[0][price]'), 'price_os');
  assert.equal(params.get('metadata[product]'), 'os'); assert.equal(params.has('client_reference_id'), false);
  assert.equal(params.has('metadata[account]'), false);
  assert.equal(params.get('success_url'), `${f.origin}/os/thanks?session_id={CHECKOUT_SESSION_ID}`);
  assert.equal(params.get('cancel_url'), `${f.origin}/host.html`);
  assert.equal(params.get('customer_creation'), 'always'); assert.equal(params.get('allow_promotion_codes'), 'true');
  assert.equal(params.get('managed_payments[enabled]'), 'false');
  const thanksPath = `/os/thanks?session_id=${session.id}`;
  assert.equal((await f.call(thanksPath)).status, 402);
  assert.equal(f.store.listLicenses().length, 0);
  f.settleOS(session);
  const thanks = await f.call(thanksPath), html = await thanks.text();
  assert.equal(thanks.status, 200); assert.equal(thanks.headers.get('cache-control'), 'no-store');
  const license = f.store.licenseBySession(session.id);
  assert.equal(license.product, 'os'); assert.ok(f.store.activeLicense(license.key));
  assert.ok(html.includes(license.key)); assert.match(html, /OS installation guide/);
  assert.match(html, /installer download is not published yet/);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].to, 'os@example.invalid');
  assert.ok(f.sent[0].text.includes(license.key)); assert.match(f.sent[0].text, /Repository access and updates/);
  assert.equal((await f.webhook('checkout.session.completed', session, { id: 'evt_os_paid' })).status, 200);
  assert.equal((await f.webhook('checkout.session.completed', session, { id: 'evt_os_paid' })).status, 200);
  assert.equal((await f.call(thanksPath)).status, 200);
  assert.equal(f.store.listLicenses().length, 1); assert.equal(f.sent.length, 1);
  assert.equal((await f.call('/os/thanks?session_id=bad')).status, 400);
  const guide = await (await f.call('/os/install')).text();
  assert.match(guide, /erase disks/); assert.match(guide, /backup/);
});

test('OS linkage is optional and explicit, never inferred from buyer email', async t => {
  const f = await offersFixture(t), owner = f.seed();
  await f.post('/os/buy', owner);
  const linked = [...f.stripe.sessions.values()][0];
  assert.equal(linked.client_reference_id, owner.account.id); assert.equal(linked.metadata.account, owner.account.id);
  f.settleOS(linked, 'same@example.invalid'); linked.payment_status = 'no_payment_required';
  assert.equal((await f.webhook('checkout.session.completed', linked)).status, 200);
  assert.equal(f.store.accountLicenses(owner.account.id).length, 1);
  assert.match(await accountHTML(f, owner), /Imperfect os licence: active/);
  await f.post('/os/buy', null);
  const anonymous = [...f.stripe.sessions.values()][1]; f.settleOS(anonymous, 'same@example.invalid');
  assert.equal((await f.webhook('checkout.session.async_payment_succeeded', anonymous)).status, 200);
  assert.equal(f.store.accountLicenses(owner.account.id).length, 1, 'shared buyer email does not establish an account identity');
  await f.post('/os/buy', owner);
  const mismatch = [...f.stripe.sessions.values()][2]; f.settleOS(mismatch); mismatch.metadata.account = 'different-account';
  assert.equal((await f.webhook('checkout.session.completed', mismatch)).status, 200);
  assert.equal(f.store.accountLicenses(owner.account.id).length, 1, 'mismatched Stripe references do not link a licence');
  assert.equal(f.store.listLicenses().length, 3); assert.equal(f.sent.length, 3);
});

test('missing billing configuration leaves explanatory pages clean and mutation routes closed', async t => {
  for (const options of [{ disabled: true }, { stripeSettings: { webhookSecret: '' } }, { stripeSettings: { rentPrice: '', osPrice: '' } }]) {
    await t.test(JSON.stringify(options), async t => {
      const f = await offersFixture(t, options), owner = f.seed();
      const account = await accountHTML(f, owner);
      assert.match(account, /Monthly billing is not open yet/); assert.doesNotMatch(account, /action="\/account\/rent"/);
      assert.equal((await f.post('/account/rent', owner)).status, 503);
      const host = await (await f.call('/host.html')).text();
      assert.doesNotMatch(host, /action="\/os\/buy"/);
      assert.match(host, /Ask about imperfect OS/);
      const offer = await (await f.call('/shop/offer')).json();
      assert.equal(offer.rent.open, false);
      const buy = await f.post('/os/buy', null);
      assert.equal(buy.status, 303); assert.equal(buy.headers.get('location'), '/host.html');
      assert.equal(f.stripe.calls.length, 0);
    });
  }
});

test('the account page says a rented computer is being set up, then where it is ready, then that it is stopped', async t => {
  const f = await offersFixture(t), owner = f.seed(), name = owner.account.username;
  f.store.saveRental({ accountId: owner.account.id, source: 'stripe', status: 'active', startedAt: f.now(), subscription: 'sub_setup' });
  assert.match(await accountHTML(f, owner), /Computer: being set up/);
  f.store.registerComputer({ username: name, computerId: name, state: 'provisioning' });
  assert.match(await accountHTML(f, owner), /Computer: being set up/);
  f.store.registerComputer({ username: name, computerId: name, state: 'ready' });
  assert.match(await accountHTML(f, owner), new RegExp(`Computer: ready at https://${name}\\.imperfect\\.computer<`));
  f.store.registerComputer({ username: name, computerId: name, state: 'stopped' });
  assert.match(await accountHTML(f, owner), /Computer: stopped; your data is kept/);
});
