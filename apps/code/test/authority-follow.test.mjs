import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFollow } from '../../../system/follow.mjs';

const source = 'ssh://pcuser@desktop/home/pcuser/imperfect';
const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' };
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
async function world(t) {
  const top = await mkdtemp(join(tmpdir(), 'authority-follow-'));
  t.after(() => rm(top, { recursive: true, force: true }));
  const pc = join(top, 'pc'), root = join(top, 'mac');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', pc]);
  const commit = async text => { await writeFile(join(pc, 'app.txt'), text); git(pc, 'add', '.'); git(pc, 'commit', '--quiet', '-m', text); return git(pc, 'rev-parse', 'HEAD'); };
  await commit('one');
  execFileSync('git', ['clone', '--quiet', pc, root], { stdio: 'ignore' });
  // Synthetic member URL: must never be contacted or rewritten by this follower.
  const origin = 'https://member:FAKE-TEST-KEY@store.invalid/repo';
  git(root, 'remote', 'set-url', 'origin', origin);
  let busy = false, before = null;
  const fetches = [], activations = [], logs = [];
  const make = (options = {}) => createFollow({ root, source, idleOnly: true, busy: () => busy, log: message => logs.push(message),
    restart: async take => { await before?.(); const result = await take(); if (result) activations.push(git(root, 'rev-parse', 'HEAD')); return result; },
    run: async (file, args, options) => {
      assert.equal(file, 'git');
      if (args.includes('fetch')) {
        fetches.push({ args, options });
        assert.equal(args[args.indexOf('--') + 1], source);
        assert.match(options.env.GIT_SSH_COMMAND, /BatchMode=yes/);
        assert.match(options.env.GIT_SSH_COMMAND, /StrictHostKeyChecking=yes/);
        assert.equal(options.env.GIT_SSH_VARIANT, 'ssh');
        // Substitute only transport: no network or SSH config is touched.
        args = args.map(arg => arg === source ? pc : arg);
      }
      return git(args[1], ...args.slice(2));
    }, ...options });
  return { pc, root, origin, commit, make, fetches, activations, logs, work: value => { busy = value; }, before: value => { before = value; } };
}

test('Mac follows the explicit PC main, not its member origin, only under the idle handoff', async t => {
  const w = await world(t), follow = w.make();
  const initial = git(w.root, 'rev-parse', 'HEAD');
  const target = await w.commit('two');
  w.work(true);
  assert.equal(await follow.tick(), 'waiting');
  assert.equal(git(w.root, 'rev-parse', 'HEAD'), initial);
  assert.deepEqual(w.activations, []);
  w.work(false);
  assert.equal(await follow.tick(), 'restarting');
  assert.deepEqual(w.activations, [target]);
  assert.equal(await readFile(join(w.root, 'app.txt'), 'utf8'), 'two');
  assert.equal(git(w.root, 'config', 'remote.origin.url'), w.origin);
  assert.equal(await follow.tick(), 'current');
  assert.equal(w.fetches.length, 3);
});

test('branch work, dirty main and local commits remain paused, including at the authority revision', async t => {
  const w = await world(t), follow = w.make();
  git(w.root, 'checkout', '--quiet', '-b', 'mac/development');
  assert.equal(await follow.tick(), 'diverged', 'even when HEAD equals authority main');
  git(w.root, 'checkout', '--quiet', 'main');
  await writeFile(join(w.root, 'personal.txt'), 'keep');
  assert.equal(await follow.tick(), 'local changes', 'even without an incoming commit');
  git(w.root, 'add', '.'); git(w.root, 'commit', '--quiet', '-m', 'branch work');
  await w.commit('two');
  const own = git(w.root, 'rev-parse', 'HEAD');
  assert.equal(await follow.tick(), 'diverged');
  assert.equal(follow.snapshot().state, 'paused');
  assert.equal(git(w.root, 'rev-parse', 'HEAD'), own);
  assert.deepEqual(w.activations, []);
});

test('PC update rechecks the checkout after handoff settlement', async t => {
  const w = await world(t), follow = w.make();
  const initial = git(w.root, 'rev-parse', 'HEAD');
  await w.commit('two');
  w.before(() => writeFile(join(w.root, 'app.txt'), 'last turn'));
  assert.equal(await follow.tick(), 'local changes');
  assert.equal(git(w.root, 'rev-parse', 'HEAD'), initial);
  assert.deepEqual(w.activations, []);
});

test('PC offline or untrusted SSH host fails closed without printing transport details', async t => {
  const w = await world(t);
  const follow = w.make({ run: async () => { throw new Error(`cannot fetch ${source}`); } });
  assert.equal(await follow.tick(), 'unreachable');
  assert.deepEqual(w.activations, []);
  assert.doesNotMatch(JSON.stringify([w.logs, follow.snapshot()]), /pcuser|ssh:\/\/|FAKE-TEST-KEY/);
  assert.throws(() => w.make({ source: 'ssh://bad:password@desktop/repo' }), /authority.gitUrl/);
});
