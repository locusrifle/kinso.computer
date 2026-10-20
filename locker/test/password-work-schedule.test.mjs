import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { verifyPassword } from '../passwords.mjs';

test('wrong/current/legacy/unknown/malformed verification uses identical work, not just similar wall-clock delays', async t => {
  const calls = [];
  t.mock.method(crypto, 'scrypt', (_password, _salt, length, options, callback) => {
    calls.push({ N: options.N, r: options.r, p: options.p, length, maxmem: options.maxmem });
    queueMicrotask(() => callback(null, Buffer.alloc(length)));
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const encoded = N => `scrypt$v1$N=${N},r=8,p=1$${'ab'.repeat(16)}$${'00'.repeat(32)}`;
  const schedules = [];
  for (const record of [encoded(16384), encoded(32768), encoded(65536), encoded(131072), null, 'corrupt']) {
    calls.length = 0;
    const result = await verifyPassword('A disposable verification phrase', record);
    assert.equal(result.ok, typeof record === 'string' && record.startsWith('scrypt$'));
    schedules.push([...calls]);
  }
  for (const schedule of schedules) {
    assert.deepEqual(schedule.map(call => call.N), [16384, 32768, 65536, 131072]);
    assert.deepEqual(schedule, schedules[0]);
  }
  calls.length = 0;
  assert.equal((await verifyPassword(null, encoded(16384))).ok, false);
  assert.deepEqual(calls, schedules[0], 'invalid password shape does not shortcut crypto');
});
