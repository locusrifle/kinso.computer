import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createFollow, packagesToInstall } from '../../../system/follow.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

// The store, the PC's checkout that commits, and this computer's that follows.
async function world() {
  const top = await mkdtemp(join(tmpdir(), 'follow-'));
  const store = join(top, 'store.git'), pc = join(top, 'pc'), here = join(top, 'here');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', store]);
  execFileSync('git', ['clone', '--quiet', store, pc], { stdio: 'ignore' });
  git(pc, 'checkout', '--quiet', '-b', 'main');
  const commit = async (file, text) => { await writeFile(join(pc, file), text); git(pc, 'add', file); git(pc, 'commit', '--quiet', '-m', file); git(pc, 'push', '--quiet', 'origin', 'main'); };
  await commit('a.txt', 'one');
  execFileSync('git', ['clone', '--quiet', '--branch', 'main', store, here], { stdio: 'ignore' });
  const said = [], restarts = [];
  let working = false, settles = true;
  const follow = createFollow({ root: here, busy: () => working, restart: async () => { restarts.push(git(here, 'rev-parse', 'HEAD')); return settles ? undefined : false; }, log: line => said.push(line),
    run: (file, args, options) => (file === 'npm' ? Promise.resolve(said.push(`npm ${args[0]}`)) : Promise.resolve(execFileSync(file, args, { encoding: 'utf8', ...options, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim())) });
  return { top, here, commit, follow, said, restarts, work: on => { working = on; }, settle: on => { settles = on; } };
}

test('a commit on the PC is taken here, and imperfect restarts once no agent is working', async () => {
  const { top, here, commit, follow, said, restarts, work } = await world();
  try {
    assert.equal(await follow.tick(), 'current');
    await commit('a.txt', 'two');
    work(true);
    assert.equal(await follow.tick(), 'waiting', 'taken, but a turn is running');
    assert.equal(await readFile(join(here, 'a.txt'), 'utf8'), 'two');
    assert.deepEqual(restarts, []);
    assert.equal(await follow.tick(), 'waiting');
    work(false);
    assert.equal(await follow.tick(), 'restarting');
    assert.equal(restarts.length, 1);
    assert.equal(await follow.tick(), 'current', 'restarted once');
    await commit('package-lock.json', '{}');
    assert.equal(await follow.tick(), 'restarting');
    assert.ok(!said.some(line => line.startsWith('npm')), 'nothing is installed under a running imperfect');
    assert.ok(said.includes('new packages; they are installed when imperfect restarts'));
    assert.equal(said.filter(line => line.startsWith('updated;')).length, 1, 'waiting is said once');
  } finally { await rm(top, { recursive: true, force: true }); }
});

test('a restart that could not settle stands down and is tried again', async () => {
  const { top, commit, follow, restarts, settle } = await world();
  try {
    await commit('a.txt', 'two');
    settle(false);
    assert.equal(await follow.tick(), 'waiting', 'unseen work held the handoff; it was lifted');
    assert.equal(await follow.tick(), 'waiting');
    settle(true);
    assert.equal(await follow.tick(), 'restarting');
    assert.equal(restarts.length, 3);
    assert.equal(await follow.tick(), 'current');
  } finally { await rm(top, { recursive: true, force: true }); }
});

test('a checkout with changes of its own, or commits of its own, is left alone', async () => {
  const { top, here, commit, follow, said, restarts } = await world();
  try {
    await writeFile(join(here, 'a.txt'), 'mine');
    await commit('b.txt', 'b');
    assert.equal(await follow.tick(), 'local changes');
    assert.equal(await readFile(join(here, 'a.txt'), 'utf8'), 'mine', 'nothing of its own is lost');
    assert.equal(await follow.tick(), 'local changes');
    assert.equal(said.length, 1, 'and it says so once');
    git(here, 'checkout', '--quiet', 'a.txt');
    await writeFile(join(here, 'c.txt'), 'c'); git(here, 'add', 'c.txt'); git(here, 'commit', '--quiet', '-m', 'c', '--author', 't <t@t>');
    assert.equal(await follow.tick(), 'diverged');
    assert.deepEqual(restarts, []);
  } finally { await rm(top, { recursive: true, force: true }); }
});

test('packages to install: what the lockfile names and node_modules does not hold, as npm last installed it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'packages-'));
  try {
    const lock = packages => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } });
    await writeFile(join(root, 'package-lock.json'), lock({
      'node_modules/pi': { version: '1.0.1' }, 'node_modules/ws': { version: '8.0.0' },
      'node_modules/claude-darwin': { version: '2.0.0', optional: true }, 'node_modules/electron': { version: '44.0.0', dev: true },
    }));
    assert.deepEqual(await packagesToInstall(root), ['pi', 'ws'], 'nothing installed yet');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', '.package-lock.json'), lock({ 'node_modules/pi': { version: '1.0.0' }, 'node_modules/ws': { version: '8.0.0' } }));
    assert.deepEqual(await packagesToInstall(root), ['pi'], 'a new version; another platform\'s build and dev packages may be missing');
    await writeFile(join(root, 'node_modules', '.package-lock.json'), lock({ 'node_modules/pi': { version: '1.0.1' }, 'node_modules/ws': { version: '8.0.0' }, 'node_modules/electron': { version: '44.0.0' } }));
    assert.deepEqual(await packagesToInstall(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
