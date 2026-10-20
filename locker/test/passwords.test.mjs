import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hashPassword, verifyPassword, validatePassword, generateRecoveryCodes, recoveryDigest } from '../passwords.mjs';
import { digest, equal } from '../account-security.mjs';

const phrase = 'a quiet orange river flows';
const oldHash = (version = 1, N = 16384) => {
  const salt = Buffer.alloc(16, 3);
  const key = scryptSync(phrase, salt, 32, { N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return `scrypt$v${version}$N=${N},r=8,p=1$${salt.toString('hex')}$${key.toString('hex')}`;
};
const bad = { ok: false, needsUpgrade: false };

test('SHA256 digest and constant-time string comparator have strict string semantics', () => {
  assert.equal(digest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(equal('a', 'a'), true);
  assert.equal(equal('', ''), true);
  for (const [a, b] of [['a', 'b'], ['a', 'aa'], [null, null], [undefined, ''], [3, '3'], ['\ud800', '\ufffd'], ['\ud800', '\ud801']]) assert.equal(equal(a, b), false);
  assert.equal(equal('🙂', '🙂'), true);
});

test('password rules allow passphrases and unicode, without composition or whitespace rules', () => {
  for (const value of [phrase, 'all lower case words', '          ', 'é'.repeat(10), '🙂'.repeat(10), 'x'.repeat(256), '🙂'.repeat(256)]) assert.doesNotThrow(() => validatePassword(value, 'sampler'));
  for (const value of ['', 'x'.repeat(9), 'x'.repeat(257), '🙂'.repeat(257), 'x'.repeat(10) + '\ud800', null, {}, 123]) assert.throws(() => validatePassword(value, 'sampler'), error => error.status === 400 && error.message === 'choose a password of 10–256 characters; a passphrase works well');
  for (const value of ['password123', 'PASSWORD123', 'ｐａｓｓｗｏｒｄ１２３', '1234567890', '12345678901', 'password123456', 'password1!', '1qaz2wsx3edc', 'qwertyuiop', 'abandonment', 'electrically']) assert.throws(() => validatePassword(value, 'sampler'), /too common/);
  assert.throws(() => validatePassword('what about SAMPLER now', 'sampler'), /username/);
  assert.doesNotThrow(() => validatePassword('sampler is inside here', 'different'));
});

test('shipped denylist has actual reproducible offline source, not invented combinations', () => {
  const file = readFileSync(new URL('../common-passwords.txt', import.meta.url));
  assert.equal(createHash('sha256').update(file).digest('hex'), 'a209692299ff87431db030aa9996c1e51e286f32ce567d78f600d5ae7068ec7f');
  assert.equal(file.toString().trimEnd().split('\n').length, 54763);
  assert.match(readFileSync(new URL('../common-passwords.README.md', import.meta.url), 'utf8'), /not a ranked breach/);
});

test('scrypt hashes are parameterised, strongly salted, and never contain plaintext', async () => {
  const first = await hashPassword(phrase), second = await hashPassword(phrase);
  assert.match(first, /^scrypt\$v2\$N=131072,r=8,p=1\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  assert.equal(first.includes(phrase), false);
  assert.deepEqual(await verifyPassword(phrase, first), { ok: true, needsUpgrade: false });
  assert.deepEqual(await verifyPassword(`${phrase} `, first), bad);
  assert.deepEqual(await verifyPassword(phrase.toUpperCase(), first), bad);
  for (const input of [null, 'short', 'x'.repeat(257), 'x'.repeat(10) + '\ud800']) await assert.rejects(hashPassword(input), error => error.status === 400);
});

test('historical supported versions and lower work factors upgrade only after successful verification', async () => {
  for (const encoded of [oldHash(), oldHash(2), oldHash(1, 32768)]) {
    assert.deepEqual(await verifyPassword(phrase, encoded), { ok: true, needsUpgrade: true });
    assert.deepEqual(await verifyPassword('wrong password', encoded), bad);
  }
});

test('unknown users, malformed formats and unbounded parameters fail closed with dummy work', async () => {
  const encoded = oldHash();
  const malformed = [null, '', {}, encoded.replace('v1', 'v0'), encoded.replace('v1', 'v3'), encoded.replace('16384', '8192'), encoded.replace('16384', '16385'), encoded.replace('16384', '262144'), encoded.replace('16384', '016384'), encoded.replace('r=8', 'r=999'), encoded.replace('p=1', 'p=2'), encoded.toUpperCase(), encoded + '$extra', encoded.replace(/\$[a-f0-9]{64}$/, '$abcd')];
  for (const value of malformed) assert.deepEqual(await verifyPassword(phrase, value), bad);
  assert.deepEqual(await verifyPassword(null, encoded), bad);
  assert.deepEqual(await verifyPassword('x'.repeat(1_000_000), encoded), bad);
});

test('parallel scrypt runs queue, and the bounded queue fails safely instead of allocating unbounded memory', async () => {
  const jobs = Array.from({ length: 34 }, () => verifyPassword(phrase, null));
  const results = await Promise.allSettled(jobs);
  const rejected = results.filter(row => row.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.status, 429);
  assert.equal(rejected[0].reason.message, 'busy; try again shortly');
  for (const row of results.filter(row => row.status === 'fulfilled')) assert.deepEqual(row.value, bad);
  assert.deepEqual(await verifyPassword(phrase, null), bad, 'queue releases correctly');
});

test('eight independent recovery codes have 128 random bits and a presentation-independent digest', () => {
  const codes = generateRecoveryCodes(), other = generateRecoveryCodes();
  assert.equal(codes.length, 8);
  assert.equal(new Set([...codes, ...other]).size, 16);
  for (const code of codes) {
    assert.match(code, /^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/);
    const hash = recoveryDigest(code);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.notEqual(hash, code);
    assert.equal(hash, recoveryDigest(` \n${code.toUpperCase().replaceAll('-', ' ')}\t`));
    assert.equal(hash, digest(code.replaceAll('-', '')));
  }
});
