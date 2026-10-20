import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFollow, followsMain } from '../../../system/follow.mjs';
import { EventEmitter } from 'node:events';
import { createHandoff } from '../../../system/server.mjs';

const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, GIT_AUTHOR_NAME: 'Member', GIT_AUTHOR_EMAIL: 'member@example.test', GIT_COMMITTER_NAME: 'Member', GIT_COMMITTER_EMAIL: 'member@example.test',
} }).trim();
async function world() {
  const top = await mkdtemp(join(tmpdir(), 'hosted-follow-'));
  const store = join(top, 'store.git'), upstream = join(top, 'upstream'), root = join(top, 'renter'), stateDir = join(top, 'state');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', store]);
  execFileSync('git', ['clone', '--quiet', store, upstream], { stdio: 'ignore' });
  const commit = async (text, subject = 'Your computer is easier to use', body = '') => {
    await writeFile(join(upstream, 'a.txt'), text);
    git(upstream, 'add', '.'); git(upstream, 'commit', '--quiet', '-m', subject, '-m', body);
    git(upstream, 'push', '--quiet', 'origin', 'main');
    return git(upstream, 'rev-parse', 'HEAD');
  };
  await commit('one');
  execFileSync('git', ['clone', '--quiet', store, root], { stdio: 'ignore' });
  const logs = [], activations = [];
  let busy = false, settle = true, beforeApply = null;
  const make = (options = {}) => createFollow({ root, stateDir, idleOnly: true, busy: () => busy,
    log: line => logs.push(line), restart: async apply => {
      if (!settle) return false;
      await beforeApply?.();
      const taken = apply ? await apply() : true;
      if (taken) activations.push(git(root, 'rev-parse', 'HEAD'));
      return taken;
    }, ...options });
  return { top, root, upstream, store, stateDir, commit, logs, activations, make,
    work: value => { busy = value; }, settle: value => { settle = value; }, before: fn => { beforeApply = fn; } };
}

test('hosted members follow without authority; self-hosted members still opt in', () => {
  assert.equal(followsMain({ hosted: true, authority: {} }, ''), true);
  assert.equal(followsMain({ hosted: false, authority: {} }, 'member'), false);
  assert.equal(followsMain({ hosted: false, authority: { id: 'pc' } }, 'laptop'), true);
  assert.equal(followsMain({ hosted: false, authority: { id: 'pc' } }, 'pc'), false);
  assert.equal(followsMain({ authority: { id: 'pc' } }, ''), false);
});

test('fake store update leaves HEAD untouched while busy, and carries member messages across restart', async () => {
  const w = await world();
  try {
    const original = git(w.root, 'rev-parse', 'HEAD');
    const target = await w.commit('two', 'Your browser now fits your phone', 'It follows the panel size.');
    const follow = w.make();
    w.work(true);
    assert.equal(await follow.tick(), 'waiting');
    assert.equal(git(w.root, 'rev-parse', 'HEAD'), original);
    assert.equal(await readFile(join(w.root, 'a.txt'), 'utf8'), 'one');
    assert.deepEqual(w.activations, []);
    w.work(false); w.settle(false);
    assert.equal(await follow.tick(), 'waiting');
    assert.equal(git(w.root, 'rev-parse', 'HEAD'), original, 'handoff stood down without touching checkout');
    w.settle(true);
    assert.equal(await follow.tick(), 'restarting');
    assert.deepEqual(w.activations, [target]);
    assert.equal(follow.snapshot().applied.commits[0].subject, 'Your browser now fits your phone');
    const restarted = w.make();
    await restarted.ready;
    assert.equal(restarted.snapshot().applied.to, target);
    assert.equal(await restarted.tick(), 'current');
    assert.equal(restarted.snapshot().applied.commits[0].body, 'It follows the panel size.');
    assert.equal(w.activations.length, 1);
  } finally { await rm(w.top, { recursive: true, force: true }); }
});

test('local edits, untracked files, local commits and other branches never get overwritten', async () => {
  const w = await world();
  try {
    const follow = w.make();
    const original = git(w.root, 'rev-parse', 'HEAD');
    await w.commit('two');
    await writeFile(join(w.root, 'a.txt'), 'mine');
    assert.equal(await follow.tick(), 'local changes');
    assert.match(follow.snapshot().message, /left alone/);
    git(w.root, 'restore', 'a.txt');
    await writeFile(join(w.root, 'personal.txt'), 'mine');
    assert.equal(await follow.tick(), 'local changes');
    assert.equal(git(w.root, 'rev-parse', 'HEAD'), original);
    git(w.root, 'add', '.'); git(w.root, 'commit', '--quiet', '-m', 'My own change');
    const own = git(w.root, 'rev-parse', 'HEAD');
    assert.equal(await follow.tick(), 'diverged');
    assert.equal(git(w.root, 'rev-parse', 'HEAD'), own);
    git(w.root, 'checkout', '--quiet', '-b', 'my-computer');
    assert.equal(await follow.tick(), 'diverged');
    assert.deepEqual(w.activations, []);
  } finally { await rm(w.top, { recursive: true, force: true }); }
});

test('changes made while the handoff settles are rechecked under its final fence', async () => {
  const w = await world();
  try {
    await w.commit('two');
    const follow = w.make();
    w.before(() => writeFile(join(w.root, 'a.txt'), 'my last turn'));
    assert.equal(await follow.tick(), 'local changes');
    assert.equal(await readFile(join(w.root, 'a.txt'), 'utf8'), 'my last turn');
    assert.deepEqual(w.activations, []);
  } finally { await rm(w.top, { recursive: true, force: true }); }
});

test('failed fetch and other Git failures never expose credential-bearing errors', async () => {
  const w = await world();
  try {
    // Synthetic value only: never read a real credential.
    const synthetic = 'https://buyer:FAKE-KEY-FOR-TEST@store.invalid/imperfect.git';
    const follow = w.make({ run: async () => { throw new Error(`fatal: unable to access ${synthetic}`); } });
    assert.equal(await follow.tick(), 'unreachable');
    assert.equal(await follow.tick(), 'unreachable');
    assert.equal(w.logs.length, 1);
    assert.doesNotMatch(JSON.stringify([w.logs, follow.snapshot()]), /FAKE-KEY-FOR-TEST|buyer:/);
    const fetchOK = w.make({ run: async (_, args) => {
      if (args.includes('fetch')) return '';
      throw new Error(synthetic);
    } });
    assert.equal(await fetchOK.tick(), 'unreachable');
    assert.doesNotMatch(JSON.stringify([w.logs, fetchOK.snapshot()]), /FAKE-KEY-FOR-TEST/);
  } finally { await rm(w.top, { recursive: true, force: true }); }
});

test('a failed merge receipt is not shown as an applied update after restart', async () => {
  const w = await world();
  try {
    await w.commit('two');
    const follow = w.make({ run: async (_, args) => {
      if (args.includes('merge')) throw new Error('synthetic merge failure');
      return git(args[1], ...args.slice(2));
    } });
    assert.equal(await follow.tick(), 'unreachable');
    const restarted = w.make(); await restarted.ready;
    assert.equal(restarted.snapshot().applied, null);
    assert.equal(await restarted.tick(), 'restarting');
  } finally { await rm(w.top, { recursive: true, force: true }); }
});

test('a fake store activates under the existing handoff only after background work naturally settles', { timeout: 10000 }, async () => {
  const w = await world();
  let keepAlive;
  try {
    const original = git(w.root, 'rev-parse', 'HEAD');
    const target = await w.commit('two');
    let background = ['member worker'], fenced = false, activation, complete;
    const runtime = {
      events: new EventEmitter(),
      requestQuiesce() { fenced = true; },
      resumeDelivery() { fenced = false; },
      waitForIdle: async () => {},
      isIdle: () => true,
      background: () => background,
    };
    const handoff = createHandoff(runtime, async () => {
      assert.equal(fenced, true, 'checkout changes only under the final handoff fence');
      assert.deepEqual(background, []);
      complete(await activation());
    }, { settle: 5, poll: 5, log: () => {} });
    const follow = w.make({ restart: take => new Promise(resolve => {
      activation = take; complete = resolve; handoff.request();
    }) });
    keepAlive = setInterval(() => {}, 10);
    const ticking = follow.tick().finally(() => clearInterval(keepAlive));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(git(w.root, 'rev-parse', 'HEAD'), original);
    assert.equal(fenced, false, 'background wait leaves conversation delivery open');
    background = [];
    assert.equal(await ticking, 'restarting');
    assert.equal(git(w.root, 'rev-parse', 'HEAD'), target);
  } finally { clearInterval(keepAlive); await rm(w.top, { recursive: true, force: true }); }
});

test('the final handoff fence cannot be lifted during async activation; a declined activation resumes safely', { timeout: 10000 }, async () => {
  let fenced = false, finish;
  const activation = new Promise(resolve => { finish = resolve; });
  const runtime = {
    events: new EventEmitter(),
    requestQuiesce() { fenced = true; },
    resumeDelivery() { fenced = false; },
    waitForIdle: async () => {},
    isIdle: () => true,
    background: () => [],
  };
  const handoff = createHandoff(runtime, () => activation, { settle: 1, poll: 1, log: () => {} });
  const until = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, 'handoff reached expected state');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  handoff.request();
  await until(() => handoff.snapshot().phase === 'restarting');
  assert.equal(fenced, true);
  assert.equal(handoff.resume().accepted, false);
  assert.equal(handoff.request().accepted, false);
  assert.equal(fenced, true, 'new prompts cannot race the checkout move');
  finish(false);
  await until(() => handoff.snapshot().phase === 'running' && !fenced);
  assert.equal(handoff.resume().accepted, true);
});

test('member history is ordered, includes bodies and redacts credentials in URLs', async () => {
  const w = await world();
  try {
    await w.commit('two', 'The first improvement', 'More detail.');
    await w.commit('three', 'The second improvement', 'Synthetic URL https://buyer:FAKE-KEY-FOR-TEST@store.invalid/repo');
    const follow = w.make();
    assert.equal(await follow.tick(), 'restarting');
    const receipt = follow.snapshot().applied;
    assert.deepEqual(receipt.commits.map(c => c.subject), ['The first improvement', 'The second improvement']);
    assert.doesNotMatch(JSON.stringify(receipt), /FAKE-KEY-FOR-TEST|buyer:/);
    assert.doesNotMatch(await readFile(join(w.stateDir, 'computer-update.json'), 'utf8'), /FAKE-KEY-FOR-TEST/);
  } finally { await rm(w.top, { recursive: true, force: true }); }
});
