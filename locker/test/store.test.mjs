import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, validEmail, KEY_PATTERN } from '../store.mjs';

test('a purchase issues one key, however many times the webhook lands', () => {
  const store = openStore();
  const first = store.issueLicense({ email: 'A@Example.com', stripeSession: 'cs_1' });
  const again = store.issueLicense({ email: 'a@example.com', stripeSession: 'cs_1' });
  assert.equal(first.key, again.key);
  assert.match(first.key, KEY_PATTERN);
  assert.equal(first.product, 'code');
  assert.equal(store.buyer(first.buyer_id).email, 'a@example.com');
  assert.equal(store.listLicenses().length, 1);
});

test('keys of the wrong shape and revoked keys do not open', () => {
  const store = openStore();
  const license = store.issueLicense({ email: 'b@example.com' });
  assert.ok(store.activeLicense(license.key));
  assert.equal(store.activeLicense('ic_nope'), null);
  assert.equal(store.activeLicense(`ic_${'0'.repeat(40)}`), null);
  assert.equal(store.activeLicense(`im_${'0'.repeat(40)}`), null);
  store.revokeLicense(license.key);
  assert.equal(store.activeLicense(license.key), null);
});

test('a returning buyer keeps one row and gains a Stripe customer', () => {
  const store = openStore();
  const one = store.issueLicense({ email: 'c@example.com', stripeSession: 'cs_a' });
  const two = store.issueLicense({ email: 'c@example.com', stripeSession: 'cs_b', stripeCustomer: 'cus_1' });
  assert.equal(one.buyer_id, two.buyer_id);
  assert.notEqual(one.key, two.key);
  assert.equal(store.buyer(one.buyer_id).stripe_customer, 'cus_1');
  assert.equal(store.licensesByEmail('C@example.com').length, 2);
});

test('members are numbered in the order they joined, once each, and old stores are numbered on opening', async () => {
  const store = openStore();
  const first = store.issueLicense({ email: 'a@example.com' });
  const second = store.issueLicense({ email: 'b@example.com' });
  store.issueLicense({ email: 'a@example.com', stripeSession: 'cs_again' });
  assert.deepEqual([store.buyer(first.buyer_id).number, store.buyer(second.buyer_id).number], [1, 2]);
  assert.equal(store.issueLicense({ email: 'c@example.com' }) && store.buyerByEmail('c@example.com').number, 3);

  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const path = join(mkdtempSync(join(tmpdir(), 'numbers-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE buyers (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, stripe_customer TEXT, created_at INTEGER NOT NULL); INSERT INTO buyers VALUES ('later', 'l@example.com', NULL, 20), ('first', 'f@example.com', NULL, 10);");
  old.close();
  const reopened = openStore(path);
  assert.deepEqual([reopened.buyer('first').number, reopened.buyer('later').number], [1, 2]);
  assert.equal(reopened.ensureBuyer('n@example.com').number, 3);
  reopened.close();
});

test('a handle is chosen once, is unique, and is not a reserved word unless the operator gives it', () => {
  const store = openStore();
  const sam = store.issueLicense({ email: 'sam@example.com' });
  const kim = store.issueLicense({ email: 'kim@example.com' });
  assert.throws(() => store.claimHandle(sam.buyer_id, 'Not Valid'), /lower-case/);
  assert.throws(() => store.claimHandle(sam.buyer_id, '-sam'), /lower-case/);
  assert.throws(() => store.claimHandle(sam.buyer_id, 'main'), /reserved/);
  assert.throws(() => store.claimHandle(sam.buyer_id, 'locus'), /reserved/);
  assert.equal(store.claimHandle(sam.buyer_id, 'Sam').handle, 'sam');
  assert.equal(store.claimHandle(sam.buyer_id, 'sam').handle, 'sam');
  assert.throws(() => store.claimHandle(sam.buyer_id, 'samuel'), /already sam/);
  assert.throws(() => store.claimHandle(kim.buyer_id, 'sam'), /taken/);
  assert.equal(store.claimHandle(kim.buyer_id, 'locus', { operator: true }).handle, 'locus');
});

test('a version is a name for a commit: nobody\'s key changes', () => {
  const store = openStore();
  const license = store.issueLicense({ email: 'v@example.com' });
  store.issueLicense({ email: 'v@example.com' });
  const gone = store.issueLicense({ email: 'w@example.com' });
  store.revokeLicense(gone.key);
  assert.equal(store.release({ version: '1.1', commit: 'abc', notes: '- a change' }).version, '1.1');
  assert.ok(store.activeLicense(license.key));
  assert.deepEqual(store.members(), ['v@example.com']);
});

test('events are remembered so a webhook is handled once', () => {
  const store = openStore();
  assert.equal(store.firstSeen('evt_1', 'x'), true);
  assert.equal(store.firstSeen('evt_1', 'x'), false);
});

test('emails are checked and lowered', () => {
  assert.equal(validEmail(' Locus@Example.COM '), 'locus@example.com');
  assert.equal(validEmail('nope'), '');
  assert.equal(validEmail(''), '');
});
