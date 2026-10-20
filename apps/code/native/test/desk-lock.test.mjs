import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, symlink, writeFile, utimes, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {lockState, touchOf, watchLock} from '../../../../desktop/electron/lock.mjs';

// imperfect OS's lock, as imperfect sees it: `held` there AND its keeper's
// guard flocked, by the kernel's word; never the file alone.
const until = async (check, why) => {
 const end = Date.now() + 15000;
 while (!check()) { assert.ok(Date.now() < end, why); await new Promise(resolve => setTimeout(resolve, 20)); }
};

test('locked only while the keeper holds its guard, with when it began', {skip: process.platform !== 'linux', timeout: 60000}, async () => {
 // The real keeper lives on runtime tmpfs. On btrfs, stat's subvolume
 // device differs from the superblock device recorded in /proc/locks.
 const dir = await mkdtemp(join(process.env.XDG_RUNTIME_DIR || '/dev/shm', 'imperfect-lock-'));
 try {
  assert.equal(lockState(dir), null);
  await writeFile(join(dir, 'held'), '');
  await utimes(join(dir, 'held'), 1760083200, 1760083200.5);
  await writeFile(join(dir, 'keeper'), '');
  assert.equal(lockState(dir), null, 'a file left behind by a killed keeper is not a lock');
  // One reaped process owns the guard. With flock's default fork, its
  // launcher can exit before the killed sleep child releases the inherited fd.
  const keeper = spawn('flock', ['--no-fork', join(dir, 'keeper'), 'sleep', '120'], {stdio: 'ignore', detached: true});
  let watch, spawnError;
  const exited = new Promise(resolve => { keeper.once('error', error => { spawnError = error; resolve(); }); keeper.once('exit', resolve); });
  try {
   await until(() => { if (spawnError) throw spawnError; return lockState(dir); }, 'keeper acquired its guard');
   assert.deepEqual(lockState(dir), {epoch: 1760083200.5, touched: null});
   const heard = [];
   watch = watchLock(s => heard.push(s), {dir, every: 20, recheck: 40});
   // the locker keeps the touch beside it: heard at the next look, as part of the same lock
   await writeFile(join(dir, 'touched'), JSON.stringify({epoch: 1760083200.5, touched: 1760083205.25}));
   await until(() => heard.some(s => s?.touched === 1760083205.25), 'watch heard this lock’s touch before removing held');
   await rm(join(dir, 'held'));
   await until(() => heard.at(-1) === null, 'watch heard the unlock');
   assert.deepEqual(heard, [{epoch: 1760083200.5, touched: null}, {epoch: 1760083200.5, touched: 1760083205.25}, null]);
  } finally {
   watch?.stop();
   if (keeper.exitCode === null && !keeper.signalCode && keeper.pid) process.kill(-keeper.pid, 'SIGKILL');
   await exited;
  }
  // the guard let go: not locked, whatever the file says
  await writeFile(join(dir, 'held'), '');
  assert.equal(lockState(dir), null);
 } finally { await rm(dir, {recursive: true, force: true}); }
});

// `touched`, the locker's: only a time, and only this lock's. Anything else in it, or a touch on another lock,
// is not a touch.
test('the touch is believed only as two finite times naming this lock, from a small file', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'imperfect-touch-'));
 const epoch = 1760083200.5, now = 1760083300;
 const said = async text => { await writeFile(join(dir, 'touched'), text); return touchOf(dir, epoch, now); };
 try {
  assert.equal(touchOf(dir, epoch, now), null, 'none yet');
  const touched = await said(JSON.stringify({epoch, touched: 1760083205.25}));
  assert.equal(touched, 1760083205.25);
  assert.equal(await said(JSON.stringify({epoch: epoch + 0.0004, touched: 1760083205.25})), 1760083205.25, 'the epoch as the locker writes it, to the µs');
  for (const [why, text] of [
   ['an earlier lock\'s touch', JSON.stringify({epoch: epoch - 60, touched: epoch - 50})],
   ['before this lock began', JSON.stringify({epoch, touched: epoch - 5})],
   ['in the future', JSON.stringify({epoch, touched: now + 3600})],
   ['not a number', JSON.stringify({epoch, touched: '1760083205.25'})],
   ['not finite', '{"epoch": 1760083200.5, "touched": 1e999}'],
   ['no epoch', JSON.stringify({touched: 1760083205.25})],
   ['not JSON', 'touch:1760083205250'],
   ['too big', JSON.stringify({epoch, touched: 1760083205.25, pad: 'x'.repeat(300)})],
   ['nothing', ''],
  ]) assert.equal(await said(text), null, why);
  await rm(join(dir, 'touched')); await mkdir(join(dir, 'touched'));
  assert.equal(touchOf(dir, epoch, now), null, 'not a file');
  await rm(join(dir, 'touched'), {recursive: true});
  await writeFile(join(dir, 'elsewhere'), JSON.stringify({epoch, touched: epoch + 1}));
  await symlink(join(dir, 'elsewhere'), join(dir, 'touched'));
  assert.equal(touchOf(dir, epoch, now), null, 'a symlink');
  await rm(join(dir, 'touched'));
  assert.equal(spawnSync('mkfifo', [join(dir, 'touched')]).status, 0);
  // A child timeout makes this regression fail rather than hang the test runner.
  const read = spawnSync(process.execPath, ['--input-type=module', '-e', `import {touchOf} from ${JSON.stringify(new URL('../../../../desktop/electron/lock.mjs', import.meta.url).href)}; if (touchOf(${JSON.stringify(dir)}, ${epoch}, ${now}) !== null) process.exit(1);`], {timeout: 15000});
  assert.equal(read.status, 0, String(read.error || read.stderr));
 } finally { await rm(dir, {recursive: true, force: true}); }
});
