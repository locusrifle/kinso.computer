import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Writable } from 'node:stream';
import { here } from '../../../system/memory.mjs';

// A command can fail while the asynchronous destination is still completing.
// Control the stream barrier explicitly: no disk speed or timer decides which
// lifetime finishes first, and no test retry conceals leftover partial writes.
test('failed memory command waits for its destination before reporting failure', { timeout: 30000 }, async () => {
  let finish, finalReady, closed, observed = false;
  const final = new Promise(resolve => { finalReady = resolve; });
  const exit = new Promise(resolve => { closed = resolve; });
  const bytes = [];
  const destination = new Writable({
    write(chunk, encoding, done) { bytes.push(Buffer.from(chunk)); done(); },
    final(done) { finish = done; finalReady(); },
  });
  const spawn = childProcess.spawn;
  mock.method(fs, 'createWriteStream', () => destination);
  mock.method(childProcess, 'spawn', (...args) => {
    const child = spawn(...args);
    // Flush the drained source's handle independently of the deliberately
    // held destination finalizer, just as a real file pipeline can do.
    child.stdout.once('end', () => setImmediate(() => child.stdout.destroy()));
    child.once('close', closed);
    return child;
  });
  syncBuiltinESMExports();
  const result = here()('printf partial; exit 7', '/unused-memory-stream-destination');
  result.then(() => { observed = true; }, () => { observed = true; });
  try {
    await Promise.all([exit, final]);
    await new Promise(resolve => setImmediate(resolve)); // Drain child-close promise reactions.
    assert.equal(observed, false, 'failure cannot escape while the destination is still outstanding');
    finish();
    await assert.rejects(result, /ended with 7/);
    assert.equal(destination.writableFinished, true);
    assert.equal(Buffer.concat(bytes).toString(), 'partial');
  } finally {
    finish?.();
    await result.catch(() => {});
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('failed memory destination stops and reaps its producer', { timeout: 30000 }, async () => {
  const failure = new Error('destination write failed');
  const destination = new Writable({ write(chunk, encoding, done) { done(failure); } });
  const spawn = childProcess.spawn;
  let child;
  mock.method(fs, 'createWriteStream', () => destination);
  mock.method(childProcess, 'spawn', (...args) => { child = spawn(...args); return child; });
  syncBuiltinESMExports();
  try {
    // exec makes this producer the actual child, not an orphaned shell grandchild.
    const command = `exec ${JSON.stringify(process.execPath)} -e 'setInterval(() => process.stdout.write("bytes"), 10)'`;
    await assert.rejects(here()(command, '/unused-memory-stream-destination'), error => error === failure);
    assert.equal(child.signalCode, 'SIGTERM');
    assert.equal(destination.destroyed, true);
  } finally {
    if (child?.pid && child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});
