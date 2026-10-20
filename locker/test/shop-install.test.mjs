import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const script = await readFile(new URL('../public/install.sh', import.meta.url), 'utf8');
async function fixture(t, { existing = false, origin = 'https://github.com/locusrifle/imperfect', dirty = false, branch = 'main', diverged = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shop-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home with spaces'), bin = join(root, 'bin');
  await mkdir(home); await mkdir(bin);
  const dest = join(home, 'imperfect'), log = join(root, 'git.jsonl'), ran = join(root, 'installed');
  const install = '#!/bin/sh\nset -eu\nprintf installed > "$INSTALL_RAN"\n';
  if (existing) { await mkdir(join(dest, '.git'), { recursive: true }); await writeFile(join(dest, 'install.sh'), install, { mode: 0o755 }); }
  await writeFile(join(bin, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GIT_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'clone') {
  const dest = args.at(-1); fs.mkdirSync(dest, {recursive:true}); fs.writeFileSync(dest+'/install.sh', ${JSON.stringify(install)}, {mode:0o755});
} else {
  const command = args[2];
  if (command === 'remote') process.stdout.write(${JSON.stringify(origin)});
  else if (command === 'status') process.stdout.write(${JSON.stringify(dirty ? ' M changed.txt' : '')});
  else if (command === 'symbolic-ref') process.stdout.write(${JSON.stringify(branch)});
  else if (command === 'merge' && ${diverged}) process.exit(1);
}
`);
  await chmod(join(bin, 'git'), 0o755);
  const run = () => spawnSync('sh', [], { input: script, encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GIT_LOG: log, INSTALL_RAN: ran } });
  return { run, dest, ran, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

test('piped public installer clones to a quoted HOME and runs the checkout installer', async t => {
  const f = await fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await f.calls(), [['clone', '--branch', 'main', '--', 'https://github.com/locusrifle/imperfect', f.dest]]);
  assert.equal(await readFile(f.ran, 'utf8'), 'installed');
});

test('repeat installer fast-forwards only the expected public repo and runs install.sh', async t => {
  const f = await fixture(t, { existing: true }), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const calls = await f.calls();
  assert.ok(calls.some(args => args.slice(2).join(' ') === 'fetch --quiet origin refs/heads/main'));
  assert.ok(calls.some(args => args.slice(2).join(' ') === 'merge --ff-only FETCH_HEAD'));
  assert.equal(await readFile(f.ran, 'utf8'), 'installed');
});

test('installer leaves wrong origins, dirty branches and diverged history alone', async t => {
  for (const settings of [{ origin: 'https://example.test/other.git' }, { dirty: true }, { branch: 'my-work' }, { diverged: true }]) {
    const f = await fixture(t, { existing: true, ...settings }), result = f.run();
    assert.notEqual(result.status, 0, JSON.stringify(settings));
    await assert.rejects(readFile(f.ran), { code: 'ENOENT' });
    assert.ok(!(await f.calls()).some(args => args.includes('--hard') || args.includes('reset')));
  }
});
