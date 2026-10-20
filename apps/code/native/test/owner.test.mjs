import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createGueyServer } from '../../../../system/server.mjs';
import { ownerHolds, ownerRecord, parseOwner, startedAt } from '../owner.mjs';

const always = () => true;
const never = () => false;

test('a lock is read as the record it is, or not at all', () => {
  assert.deepEqual(parseOwner('{"pid":42,"boot":"b","started":"991"}'), { pid: 42, boot: 'b', started: '991' });
  assert.equal(parseOwner('1210'), null);
  assert.equal(parseOwner(''), null);
  assert.equal(parseOwner('not a lock'), null);
  assert.equal(parseOwner('{"pid":0}'), null);
});

// The testbed's console refused to start for good because pid 1210 from the
// previous boot was alive again as somebody else's process. A boot this lock
// did not come from cannot be holding anything.
test('a lock from an earlier boot is stale however alive that number looks', async () => {
  const held = { pid: 1210, boot: 'yesterday', started: '4242' };
  assert.equal(await ownerHolds(held, { boot: 'today', alive: always }), false);
  assert.equal(await ownerHolds(held, { boot: 'yesterday', alive: never }), false);
});

// Within one boot a pid can still be handed out again, and the new holder began
// at a different moment.
test('a reused pid in this boot is not the machine that wrote the lock', async () => {
  const read = async path => (String(path).includes('/stat') ? 'name (a b) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 x' : '');
  const same = { pid: 99, boot: 'now', started: '777' };
  const moved = { pid: 99, boot: 'now', started: '31' };
  assert.equal(await ownerHolds(same, { boot: 'now', alive: always, read }), true);
  assert.equal(await ownerHolds(moved, { boot: 'now', alive: always, read }), false);
});

test('a process name with spaces and brackets does not shift the start time', async () => {
  const read = async () => 'x (imperfect (code) x) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 555 rest';
  assert.equal(await startedAt(7, read), '555');
  assert.equal(await startedAt(7, async () => { throw new Error('no such process'); }), '');
});

function stubRuntime(cwd) {
  return {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', cwd, busy: false, failed: null, messages: [] }),
    async command() { return {}; },
    async close() {},
  };
}

// The whole point, at the machine's own door: a lock left behind by a machine
// that is gone must not keep the next one out.
test('a machine starts over a lock left by a boot that has ended', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-owner-'));
  const stateDir = join(root, 'state');
  await mkdtemp(join(tmpdir(), 'unused-'));
  await rm(stateDir, { recursive: true, force: true });
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir, runtime: stubRuntime(root) });
  await app.close();
  // Somebody else's boot, holding a pid that certainly exists here: our own.
  await writeFile(join(stateDir, 'owner.pid'), JSON.stringify({ pid: process.pid, boot: 'a-boot-that-ended', started: '1' }));
  const again = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir, runtime: stubRuntime(root) });
  try {
    const written = JSON.parse(await readFile(join(stateDir, 'owner.pid'), 'utf8'));
    assert.equal(written.pid, process.pid);
    assert.equal(written.boot, (await ownerRecord()).boot);
  } finally {
    await again.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a machine that really is running still keeps the next one out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-owner-live-'));
  const stateDir = join(root, 'state');
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir, runtime: stubRuntime(root) });
  try {
    await assert.rejects(
      createGueyServer({ port: 0, host: '127.0.0.1', stateDir, runtime: stubRuntime(root) }),
      /state is owned by process/,
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
