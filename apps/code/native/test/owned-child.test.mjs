import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnOwnedChild } from './fixtures/owned-child.mjs';

const start = code => spawnOwnedChild(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });

test('owned child teardown escalates when SIGTERM is ignored', { timeout: 5000 }, async t => {
  const fixture = start(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');`);
  t.after(() => fixture.stop());
  assert.deepEqual((await once(fixture.child, 'message'))[0], 'ready');
  await fixture.stop(100);
  assert.equal(fixture.child.exitCode, null);
  assert.equal(fixture.child.signalCode, 'SIGKILL');
});

test('owned child teardown observes a signal exit that happened before cleanup', { timeout: 5000 }, async t => {
  const fixture = start(`setInterval(() => {}, 1000); process.send('ready');`);
  t.after(() => fixture.stop());
  await once(fixture.child, 'message');
  const exited = once(fixture.child, 'exit');
  fixture.child.kill('SIGTERM');
  await exited;
  await fixture.stop(100);
  assert.equal(fixture.child.exitCode, null);
  assert.equal(fixture.child.signalCode, 'SIGTERM');
});

test('owned child teardown reaps descendants holding pipes after parent exit', { timeout: 5000 }, async t => {
  const fixture = spawnOwnedChild(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');"],
      { stdio: ['ignore', 1, 2, 'ipc'] });
    child.once('message', () => { process.send(child.pid); child.disconnect(); child.unref(); process.disconnect(); });
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => fixture.stop());
  fixture.child.stdout.resume(); fixture.child.stderr.resume();
  const closed = once(fixture.child, 'close');
  const exited = once(fixture.child, 'exit');
  const [pid] = await once(fixture.child, 'message');
  await exited;
  assert.equal(fixture.child.exitCode, 0);
  await fixture.stop(100);
  await closed;
  // The descendant cannot retain an open writer after the owned group is killed.
  assert.equal(fixture.child.stdout.readableEnded, true);
  assert.equal(fixture.child.stderr.readableEnded, true);
  assert.ok(Number.isInteger(pid));
});

test('owned child teardown handles failure to spawn', { timeout: 5000 }, async () => {
  const fixture = spawnOwnedChild('/no-such-imperfect-fixture-command', [], { stdio: 'ignore' });
  const [error] = await once(fixture.child, 'error');
  assert.equal(error.code, 'ENOENT');
  await fixture.stop(100);
});
