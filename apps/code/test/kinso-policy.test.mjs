import test from 'node:test';
import assert from 'node:assert/strict';
import { productPolicy } from './fixtures/product-policy.mjs';

const COMPUTER = 'https://computer.kinso.computer';
const BASE = "default-src 'self'; connect-src 'self'; media-src 'self' blob: ; img-src 'self' data: blob: ; style-src 'self'; script-src 'self'; frame-src 'self' ; frame-ancestors 'none'";
const KINSO = BASE.replace("frame-src 'self'", "frame-src 'self' https://kinso.computer/kinso/");

test('the real hosted HTTP policy adds only the exact concept path on Kinso’s canonical computer origin', async () => {
  const result = await productPolicy();
  assert.equal(result.status, 200);
  assert.equal(result.policy, KINSO);
  // URLs are compared as origins, not arbitrary strings or host suffixes.
  assert.equal((await productPolicy({ origins: [`${COMPUTER}:443/`] })).policy, KINSO);
});

test('every other hosted origin keeps the entire previous policy unchanged, regardless of request Host', async () => {
  for (const origins of [[], ['https://noah.imperfect.computer'], ['https://kinso.computer'], ['http://computer.kinso.computer'],
    ['https://computer.kinso.computer.evil.invalid'], ['https://other.computer.kinso.computer'], ['https://computer.kinso.computer:444'],
    ['https://elsewhere.invalid', COMPUTER]]) {
    const result = await productPolicy({ origins, requestHost: 'computer.kinso.computer' });
    assert.equal(result.policy, BASE, JSON.stringify(origins));
  }
});

test('a non-hosted computer keeps its shown-page sources and all other directives unchanged, even on the Kinso origin', async () => {
  const result = await productPolicy({ hosted: false });
  assert.equal(result.status, 200);
  // Its ephemeral page listener remains permitted in the same three places.
  assert.equal(result.policy.replaceAll(/http:\/\/127\.0\.0\.1:\d+/g, '{pages}'), BASE.replaceAll('blob: ;', 'blob: {pages};').replace("frame-src 'self' ;", "frame-src 'self' {pages};"));
  assert.ok(!result.policy.includes('https://kinso.computer/kinso/'));
});
