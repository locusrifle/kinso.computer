import test from 'node:test';
import assert from 'node:assert/strict';
import { readBrand } from '../public/js/brand.js';

const windowAt = (origin, search = '') => ({ location: { origin, search }, get sessionStorage() { throw new Error('new visitor: no storage'); } });
test('the dedicated Kinso computer keeps its brand after the ticket door drops the query', () => {
  assert.equal(readBrand(windowAt('https://computer.kinso.computer')).id, 'kinso');
  assert.equal(readBrand(windowAt('https://computer.kinso.computer', '?for=kinso')).agent, 'Kinso');
  assert.equal(readBrand(windowAt('https://computer.kinso.computer', '?for=imperfect')).id, 'imperfect');
  for (const origin of ['http://computer.kinso.computer', 'https://computer.kinso.computer:444', 'https://sub.computer.kinso.computer', 'https://computer.kinso.computer.evil.test', 'https://noah.imperfect.computer']) {
    assert.equal(readBrand(windowAt(origin)).id, 'imperfect', origin);
  }
});

test('a copy of imperfect opens as its own default brand when nothing names one (Kinso\'s repository says kinso)', async () => {
  const { default: fallback } = await import('../public/js/brand-default.js');
  assert.equal(fallback, 'imperfect', 'this repository is imperfect\'s own');
  const local = windowAt('http://127.0.0.1:5067');
  assert.equal(readBrand(local).id, 'imperfect');
  assert.equal(readBrand(local, 'kinso').id, 'kinso');
  assert.equal(readBrand(local, 'kinso').agent, 'Kinso');
  assert.equal(readBrand(windowAt('http://127.0.0.1:5067', '?for=imperfect'), 'kinso').id, 'imperfect', 'an address that names a brand still wins');
  for (const unknown of ['someone', '', null, 'constructor']) assert.equal(readBrand(local, unknown).id, 'imperfect', String(unknown));
});
