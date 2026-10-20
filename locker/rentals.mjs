// Rental intent only. No cloud API calls and no automatic data deletion.
import { randomUUID } from 'node:crypto';

const DAY = 86400_000;
const error = (message, status = 409) => Object.assign(new Error(message), { status });
const id = value => typeof value === 'string' ? value : value?.id;
export function rentalPolicy(row, { now = Date.now(), graceDays = 7, retentionDays = 30 } = {}) {
  if (!row) return null;
  const expired = row.source === 'tester' && row.until && now >= row.until;
  const stopAt = expired ? row.until : row.status === 'canceled' ? row.canceledAt : row.status === 'past_due' ? row.unpaidSince + graceDays * DAY : null;
  return { ...row, status: expired ? 'canceled' : row.status, stopAt, deleteAfter: stopAt == null ? null : stopAt + retentionDays * DAY,
    want: (row.status === 'active' && !expired) || (row.status === 'past_due' && now < stopAt) ? 'provision' : 'stop' };
}
export function grantTester(store, username, until = null, now = Date.now()) {
  const account = store.accountByUsername(username);
  if (!account) throw error('no such account', 404);
  return store.rentalTransaction(() => {
    const prior = store.rental(account.id);
    if (prior?.source === 'stripe' && prior.status !== 'canceled') throw error('cancel the Stripe rental before granting a tester');
    if (until != null && (!Number.isFinite(until) || until <= now)) throw error('until must be a future date', 400);
    return store.saveRental({ accountId: account.id, source: 'tester', status: 'active', startedAt: prior?.startedAt ?? now, until });
  });
}
export function revokeTester(store, username, now = Date.now()) {
  return store.rentalTransaction(() => {
    const account = store.accountByUsername(username), row = account && store.rental(account.id);
    if (!row || row.source !== 'tester') throw error('no tester rental; cancel paid rentals in Stripe');
    return store.saveRental({ ...row, status: 'canceled', canceledAt: now, until: null });
  });
}
export function createRentals({ store, stripe, config, base, mail, now = Date.now }) {
  const settings = config.rentals ?? {};
  const policy = row => rentalPolicy(row, { ...settings, now: now() });
  const enabled = () => Boolean(stripe && config.stripe?.rentPrice && config.stripe?.webhookSecret);
  async function checkout(account) {
    if (!enabled()) throw error('Monthly billing is not open yet.', 503);
    const reserve = () => store.saveRental({ accountId: account.id, source: 'stripe', status: 'pending', attempt: randomUUID(), reservedAt: now() });
    // Atomic with operator grants in another process; no transaction spans await.
    let row = store.rentalTransaction(() => {
      const prior = store.rental(account.id), existing = policy(prior);
      if (existing && ['active', 'past_due'].includes(existing.status)) throw error('You already have a rental. Manage it from your account.');
      if (prior?.status !== 'pending') return reserve();
      if (!prior.checkoutId && now() - prior.reservedAt >= DAY) throw error('Checkout confirmation is missing. Contact Noah before trying again.');
      return prior;
    });
    if (row.checkoutId) {
      const session = await stripe.retrieveSession(row.checkoutId);
      const outcome = store.rentalTransaction(() => {
        const current = store.rental(account.id);
        if (current?.attempt !== row.attempt || current.status !== 'pending') return { retry: true };
        if (session.status === 'open') return { url: session.url };
        if (session.status === 'complete') throw error('Your payment is being confirmed. Refresh your account shortly.');
        if (session.status !== 'expired') throw error('Checkout confirmation is missing. Contact Noah before trying again.');
        return { row: reserve() };
      });
      if (outcome.retry) return checkout(account);
      if (outcome.url) return outcome.url;
      row = outcome.row;
    }
    const session = await stripe.checkoutSession({ mode: 'subscription', line_items: [{ price: config.stripe.rentPrice, quantity: 1 }],
      client_reference_id: account.id, metadata: { product: 'rent', account: account.id, attempt: row.attempt },
      subscription_data: { metadata: { product: 'rent', account: account.id, attempt: row.attempt } },
      success_url: `${base}/account?checkout=complete`, cancel_url: `${base}/account`, allow_promotion_codes: true,
      expires_at: Math.floor((row.reservedAt + DAY) / 1000), managed_payments: { enabled: false } }, { idempotencyKey: `rent-${row.attempt}` });
    store.rentalTransaction(() => {
      const current = store.rental(account.id);
      if (current?.attempt === row.attempt) store.saveRental({ ...current, checkoutId: session.id });
    });
    return session.url;
  }
  async function portal(account) {
    const row = store.rental(account.id);
    if (!stripe || row?.source !== 'stripe' || !row.customer) throw error('There is no Stripe rental to manage.');
    return (await stripe.portalSession({ customer: row.customer, return_url: `${base}/account` })).url;
  }
  async function event(event) {
    const object = event.data?.object ?? {};
    let subscription;
    if (event.type === 'checkout.session.expired' && object.metadata?.product === 'rent' && stripe) {
      const session = await stripe.retrieveSession(object.id);
      if (session.metadata?.product !== 'rent' || !session.metadata?.account) return;
      store.rentalTransaction(() => {
        const prior = store.rental(session.metadata.account);
        if (session.status === 'expired' && !session.subscription && prior?.source === 'stripe' && prior.status === 'pending' && prior.attempt === session.metadata?.attempt && session.client_reference_id === prior.accountId) {
          store.saveRental({ ...prior, status: 'canceled', canceledAt: now() });
        }
      });
      return;
    }
    if (event.type.startsWith('checkout.session.')) {
      if (object.metadata?.product !== 'rent') return;
      if (object.client_reference_id !== object.metadata.account) throw error('checkout account mismatch');
      subscription = id(object.subscription);
    } else if (event.type.startsWith('customer.subscription.')) subscription = object.id;
    else if (['invoice.paid', 'invoice.payment_failed'].includes(event.type)) subscription = id(object.subscription) ?? id(object.parent?.subscription_details?.subscription);
    else return;
    if (!subscription || !stripe) return;
    // Re-read Stripe's current truth, rather than ordering event snapshots by
    // second-resolution timestamps. Serialized by the webhook caller.
    const sub = await stripe.retrieveSubscription(subscription);
    if (sub.metadata?.product !== 'rent') return;
    const accountId = sub.metadata.account;
    const prior = store.rental(accountId);
    if (!prior || prior.source !== 'stripe' || prior.attempt !== sub.metadata.attempt || (prior.subscription && prior.subscription !== subscription)) return;
    if (config.stripe?.rentPrice && !sub.items?.data?.some(item => id(item.price) === config.stripe.rentPrice)) throw error('unexpected rental price');
    // Cancellation is terminal for this subscription, including late completions.
    const canceled = prior.status === 'canceled' || ['canceled', 'incomplete_expired'].includes(sub.status);
    const active = ['active', 'trialing'].includes(sub.status);
    const invoice = sub.latest_invoice;
    const invoiceUnpaid = invoice && typeof invoice === 'object' && invoice.status === 'open' && invoice.attempted && !invoice.paid;
    const status = canceled ? 'canceled' : sub.status === 'incomplete' ? 'pending' : active && !invoiceUnpaid ? 'active' : ['past_due', 'unpaid', 'paused'].includes(sub.status) || invoiceUnpaid ? 'past_due' : 'pending';
    const debtAt = invoice && typeof invoice === 'object' && ['open', 'uncollectible'].includes(invoice.status) && !invoice.paid
      ? (invoice.status_transitions?.finalized_at || invoice.created) * 1000 || now() : now();
    const row = { ...prior, status, subscription, customer: id(sub.customer), email: invoice?.customer_email ?? prior.email,
      startedAt: prior.startedAt ?? sub.start_date * 1000, periodEnd: (sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end) * 1000 || null,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end), canceledAt: canceled ? prior.canceledAt ?? ((sub.ended_at || sub.canceled_at) * 1000 || now()) : null,
      unpaidSince: status === 'past_due' ? prior.unpaidSince ?? debtAt : null, updatedAt: now() };
    let mailId, note;
    if (row.email && row.status !== prior.status && ['past_due', 'active', 'canceled'].includes(row.status)) {
      const state = policy(row);
      mailId = `${subscription}:${status}:${row.unpaidSince ?? row.canceledAt ?? prior.unpaidSince ?? 'paid'}`;
      note = { to: row.email, subject: `Your imperfect rental: ${status}`,
        text: status === 'past_due' ? `Payment has not gone through. Manage it at ${base}/account. Your computer is scheduled to stop after ${settings.graceDays ?? 7} days unpaid (${new Date(state.stopAt).toISOString()}). Data retention is ${settings.retentionDays ?? 30} days after stopping (${new Date(state.deleteAfter).toISOString()}); contact Noah for help. No data is deleted automatically by billing.` : `Your rental is ${status}. See your computer and manage billing at ${base}/account.\n${status === 'canceled' ? `Data retention is ${settings.retentionDays ?? 30} days after stopping. Contact Noah to recover your work.` : ''}` };
    }
    store.rentalTransaction(() => {
      const current = store.rental(accountId);
      if (current?.source === 'stripe' && current.attempt === prior.attempt) store.saveRental(row, { mailId, note });
    });
  }
  let mailTail = Promise.resolve();
  function flushMail() {
    const next = mailTail.then(async () => {
      for (const note of store.pendingRentalMail()) {
        try {
          const result = await mail.send({ to: note.to, subject: note.subject, text: note.text });
          if (result?.delivered !== false) store.sentRentalMail(note.id);
        } catch { /* Outage never blocks durable entitlement; retry on the next webhook/thanks. */ }
      }
    });
    mailTail = next.catch(() => {});
    return next;
  }
  function list(want) {
    return store.rentals().map(policy).filter(row => !want || row.want === want).map(row => {
      const account = store.account(row.accountId);
      return { ...row, username: account.username, computer: store.computerByUsername(account.username), origin: `https://${account.username}.imperfect.computer` };
    });
  }
  return { policy, enabled, checkout, portal, event, flushMail, list };
}
