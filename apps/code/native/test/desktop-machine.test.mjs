import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, normalizeDeviceHandsAccount } from '../../../../system/machine.mjs';

test('native pairing is opt-in and carries only an absolute token file path in machine config', () => {
  assert.equal(Object.hasOwn(normalizeConfig(), 'deviceHandsTokenFile'), false);
  assert.equal(normalizeConfig({ deviceHandsTokenFile: '/private/native-device-token' }).deviceHandsTokenFile, '/private/native-device-token');
  for (const path of ['', 'relative/path', null, 123, '/private/invalid\0path']) {
    assert.throws(() => normalizeConfig({ deviceHandsTokenFile: path }), /absolute private file path/);
  }
});

test('public account pairing configuration is canonical HTTPS, complete, secret-free and opt-in', () => {
  assert.deepEqual(normalizeConfig(), { port: 5067, origins: [], authority: { id: '', name: '' }, hosted: false });
  const account = { store: 'https://imperfect.computer', computerId: 'computer-uuid', owner: 'owner-uuid' };
  assert.deepEqual(normalizeConfig({ deviceHandsAccount: account }).deviceHandsAccount, account);
  for (const value of [null, {}, [], { ...account, owner: '' }, { ...account, computerId: 'bad id' }, { ...account, signer: 'never' }, ...['http://127.0.0.1:1', 'https://imperfect.computer/', 'https://u:p@imperfect.computer', 'https://imperfect.computer?x', 'https://imperfect.computer/#x'].map(store => ({ ...account, store }))]) {
    assert.throws(() => normalizeConfig({ deviceHandsAccount: value }), /Invalid device hands account/);
  }
  assert.equal(normalizeDeviceHandsAccount({ ...account, store: 'http://127.0.0.1:1' }, { testInsecure: true }).store, 'http://127.0.0.1:1');
  assert.throws(() => normalizeDeviceHandsAccount({ ...account, store: 'http://remote.test' }, { testInsecure: true }), /Invalid/);
});
