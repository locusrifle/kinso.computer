import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
test('offer settings load from isolated locker.env, with clean defaults and bounded policy', async t => {
  const home = await mkdtemp(join(tmpdir(), 'offers-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'locker.env');
  const load = async text => {
    await writeFile(file, text);
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
      import { loadConfig } from ${JSON.stringify(new URL('../start.mjs', import.meta.url).href)};
      try { const c = await loadConfig(); console.log(JSON.stringify({stripe:c.stripe, rentals:c.rentals})); }
      catch (e) { console.log(JSON.stringify({error:e.message})); }
    `], { env: { HOME: home, PATH: process.env.PATH, LOCKER_ENV: file } });
    return JSON.parse(stdout);
  };
  assert.deepEqual(await load(''), { stripe: { secretKey: '', webhookSecret: '', rentPrice: '', osPrice: '' }, rentals: { graceDays: 7, retentionDays: 30 } });
  assert.deepEqual(await load('STRIPE_RENT_PRICE=price_rent\nSTRIPE_OS_PRICE=price_os\nSTRIPE_PRICE=price_legacy\nRENT_GRACE_DAYS=9\nRENT_RETENTION_DAYS=40'), {
    stripe: { secretKey: '', webhookSecret: '', rentPrice: 'price_rent', osPrice: 'price_os' }, rentals: { graceDays: 9, retentionDays: 40 } });
  for (const value of ['0', '-1', '2.5', '366', 'no']) assert.match((await load(`RENT_GRACE_DAYS=${value}`)).error, /RENT_GRACE_DAYS/);
});
