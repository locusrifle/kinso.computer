import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../store.mjs';
import { syncOnce, renterFor } from '../tools/rental-sync.mjs';
import { ProvisionError } from '../tools/provision.mjs';

const BASE = 'https://imperfect.computer';

// A stand-in provisioner: it moves the registry the way the real one does, and records what it was asked.
function fakeRun(store, { fail = null } = {}) {
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, renters: options.config.renters });
    if (fail) throw fail;
    store.registerComputer({ username: args[1], computerId: args[1], state: args[0] === 'provision' ? 'ready' : 'stopped' });
  };
  return { calls, run };
}

function fixture() {
  const store = openStore(':memory:');
  const sent = [], mail = { send: async message => { sent.push(message); return { delivered: true }; } };
  const out = { text: '', write(value) { this.text += value; } };
  const pass = (run, extra = {}) => syncOnce({ store, config: {}, base: BASE, mail, prefix: '/unused', signerPem: 'unused', out, now: () => 1000 * 86400000, sleep: async () => {}, run, ...extra });
  return { store, sent, out, pass };
}

test('a tester rental makes a computer from the account: owner and email from the account, d2-8, ready mail once', async () => {
  const f = fixture();
  const alice = f.store.createAccount({ username: 'alice', name: 'Alice', passwordHash: 'fixture-hash', email: 'alice@example.test' });
  f.store.saveRental({ accountId: alice.id, source: 'tester', status: 'active', startedAt: 1 });
  const { calls, run } = fakeRun(f.store);
  assert.deepEqual(await f.pass(run), { provisioned: 1, stopped: 0, skipped: 0, failed: 0 });
  assert.deepEqual(calls.map(c => c.args), [['provision', 'alice']]);
  assert.deepEqual(calls[0].renters.alice, { email: 'alice@example.test', ownerAccountId: alice.id, flavor: 'd2-8' });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, 'alice@example.test');
  assert.match(f.sent[0].text, /https:\/\/alice\.imperfect\.computer/);
  // Idempotent: a second pass finds the computer ready, provisions nothing and does not mail again.
  assert.deepEqual(await f.pass(run), { provisioned: 0, stopped: 0, skipped: 1, failed: 0 });
  assert.equal(calls.length, 1);
  assert.equal(f.sent.length, 1);
});

test('a paid rental keeps the d2-4 default, and uses the rental email when the account has none', async () => {
  const f = fixture();
  const tom = f.store.createAccount({ username: 'tom', name: 'Tom', passwordHash: 'fixture-hash' });
  f.store.saveRental({ accountId: tom.id, source: 'stripe', status: 'active', startedAt: 1, email: 'tom@example.test', subscription: 'sub_1' });
  const { calls, run } = fakeRun(f.store);
  await f.pass(run);
  assert.deepEqual(calls[0].renters.tom, { email: 'tom@example.test', ownerAccountId: tom.id });
  assert.equal(f.sent[0].to, 'tom@example.test');
});

test('a manual renters entry still sets a flavor, but the owner always comes from the account', () => {
  const account = { id: 'account-x', username: 'x', email: '' };
  assert.deepEqual(renterFor(account, { source: 'stripe', email: 'x@example.test' }, { renters: { x: { flavor: 'd2-8', ownerAccountId: 'account-other' } } }),
    { email: 'x@example.test', ownerAccountId: 'account-x', flavor: 'd2-8' });
});

test('ended rentals stop the running computer once; retained (stopped) computers are never reprovisioned', async () => {
  const f = fixture();
  const bob = f.store.createAccount({ username: 'bob', name: 'Bob', passwordHash: 'fixture-hash', email: 'bob@example.test' });
  f.store.saveRental({ accountId: bob.id, source: 'stripe', status: 'canceled', canceledAt: 1, startedAt: 1 });
  f.store.registerComputer({ username: 'bob', computerId: 'bob', state: 'ready' });
  const carol = f.store.createAccount({ username: 'carol', name: 'Carol', passwordHash: 'fixture-hash', email: 'carol@example.test' });
  f.store.saveRental({ accountId: carol.id, source: 'stripe', status: 'active', startedAt: 1, subscription: 'sub_2' });
  f.store.registerComputer({ username: 'carol', computerId: 'carol', state: 'stopped' });
  const { calls, run } = fakeRun(f.store);
  assert.deepEqual(await f.pass(run), { provisioned: 0, stopped: 1, skipped: 1, failed: 0 });
  assert.deepEqual(calls.map(c => c.args), [['deprovision', 'bob', 'stop']]);
  assert.equal(f.store.computerByUsername('bob').state, 'stopped');
  assert.deepEqual(await f.pass(run), { provisioned: 0, stopped: 0, skipped: 2, failed: 0 });
  assert.equal(calls.length, 1);
});

test('a renter with no email anywhere is skipped and named, never provisioned', async () => {
  const f = fixture();
  const dan = f.store.createAccount({ username: 'dan', name: 'Dan', passwordHash: 'fixture-hash' });
  f.store.saveRental({ accountId: dan.id, source: 'tester', status: 'active', startedAt: 1 });
  const { calls, run } = fakeRun(f.store);
  assert.deepEqual(await f.pass(run), { provisioned: 0, stopped: 0, skipped: 1, failed: 0 });
  assert.equal(calls.length, 0);
  assert.match(f.out.text, /dan needs an email on the account/);
});

test('a failed provisioning is reported without mail, and the next pass retries it', async () => {
  const f = fixture();
  const eve = f.store.createAccount({ username: 'eve', name: 'Eve', passwordHash: 'fixture-hash', email: 'eve@example.test' });
  f.store.saveRental({ accountId: eve.id, source: 'tester', status: 'active', startedAt: 1 });
  const broken = fakeRun(f.store, { fail: new ProvisionError('Instance readiness timed out; rerun to reconcile.') });
  assert.deepEqual(await f.pass(broken.run), { provisioned: 0, stopped: 0, skipped: 0, failed: 1 });
  assert.match(f.out.text, /eve Instance readiness timed out; rerun to reconcile\./);
  assert.equal(f.sent.length, 0);
  const { calls, run } = fakeRun(f.store);
  assert.deepEqual(await f.pass(run), { provisioned: 1, stopped: 0, skipped: 0, failed: 0 });
  assert.equal(calls.length, 1);
  assert.equal(f.sent.length, 1);
});

test('an unexpected error does not leak its text; the pass records only a fixed message', async () => {
  const f = fixture();
  const fay = f.store.createAccount({ username: 'fay', name: 'Fay', passwordHash: 'fixture-hash', email: 'fay@example.test' });
  f.store.saveRental({ accountId: fay.id, source: 'tester', status: 'active', startedAt: 1 });
  const { run } = fakeRun(f.store, { fail: new Error('FAKE-RAW-SECRET-IN-STACK') });
  await f.pass(run);
  assert.match(f.out.text, /fay sync failed; inspect local state and rerun/);
  assert.doesNotMatch(f.out.text, /FAKE-RAW-SECRET/);
});
