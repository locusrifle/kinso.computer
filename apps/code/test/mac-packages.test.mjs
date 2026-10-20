import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMacPackages } from '../../../desktop/mac/packages.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mac-packages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = join(root, 'package-lock.json'), marker = join(root, 'node_modules/.imperfect-lock');
  writeFileSync(lock, '{"lockfileVersion":3,"packages":{}}');
  const calls = [];
  const run = (file, args, options) => { calls.push({ file, args, options }); mkdirSync(join(root, 'node_modules'), { recursive: true }); return { status: 0 }; };
  const options = { node: '/test/node/bin/node', env: { PATH: '/usr/bin' }, run, log: () => {} };
  return { root, lock, marker, calls, options };
}

test('Mac startup rebuilds on any lockfile change, once, using the installed Node npm', async t => {
  const w = await fixture(t);
  const original = readFileSync(w.lock, 'utf8');
  assert.equal(installMacPackages(w.root, w.options), true);
  assert.equal(installMacPackages(w.root, w.options), false);
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].file, '/test/node/bin/npm');
  assert.deepEqual(w.calls[0].args, ['ci', '--no-audit', '--no-fund', '--loglevel=error']);
  assert.equal(w.calls[0].options.env.PATH, '/test/node/bin:/usr/bin');
  assert.equal(w.calls[0].options.cwd, w.root);
  // No version change: integrity, platform metadata and removal-only changes
  // must still invalidate the receipt, unlike the Linux version comparison.
  writeFileSync(w.lock, `${original}\n`);
  assert.equal(installMacPackages(w.root, w.options), true);
  assert.equal(w.calls.length, 2);
  assert.match(await readFile(w.marker, 'utf8'), /^[a-f0-9]{64}\n$/);
  assert.equal(await readFile(w.lock, 'utf8'), `${original}\n`, 'helper leaves the committed lockfile alone');
});

test('failed rebuild never stamps success or allows the server to load stale dependencies', async t => {
  const w = await fixture(t);
  assert.throws(() => installMacPackages(w.root, { ...w.options, run: () => ({ status: 1 }) }), /npm ci failed/);
  await assert.rejects(readFile(w.marker, 'utf8'), { code: 'ENOENT' });
  assert.throws(() => installMacPackages(w.root, { ...w.options, run: () => ({ status: null, error: new Error('timeout') }) }), /npm ci failed/);
  assert.equal(installMacPackages(w.root, w.options), true, 'next keeper startup retries');
});

test('installer can decline a rebuild beneath a running keeper without mutating dependencies', async t => {
  const w = await fixture(t);
  assert.throws(() => installMacPackages(w.root, { ...w.options, beforeInstall: () => { throw new Error('machine still running'); } }), /machine still running/);
  assert.deepEqual(w.calls, []);
  await assert.rejects(readFile(w.marker, 'utf8'), { code: 'ENOENT' });
});

test('startup uses the idle fence for PC followers and installs Mac dependencies before importing the server', async () => {
  const start = await readFile(new URL('../../../system/start.mjs', import.meta.url), 'utf8');
  assert.match(start, /source: config\.authority\.gitUrl, idleOnly: true/);
  assert.ok(start.indexOf('installMacPackages(resolve') < start.indexOf("await import('./server.mjs')"));
  assert.match(start, /process\.platform === 'darwin'/);
});
