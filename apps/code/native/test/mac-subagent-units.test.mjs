import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, Subagents } from '../subagent.mjs';
import { unitCommands } from '../../../../system/units.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mac-worker-bridge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let state = 'active', launched, stopError;
  const units = {
    state: async () => { if (state instanceof Error) throw state; return state; },
    active: async () => state === 'active',
    start: async options => { launched = options; },
    stop: async () => { if (stopError) throw stopError; state = 'inactive'; },
  };
  const run = unitCommands(units), bridge = (cmd, args) => command(cmd, args, run);
  const manager = new Subagents({ root: join(dir, 'tasks'), owner: 'parent', agentDir: dir, launch: bridge, control: bridge });
  const task = manager.start({ task: 'A local fake worker; no model execution', cwd: dir });
  await new Promise(resolve => setImmediate(resolve));
  manager.save({ ...task, status: 'running', startedAt: new Date(Date.now() - 20_000).toISOString() });
  await writeFile(join(task.path, 'claim'), 'runner');
  return { task, manager, bridge, get launched() { return launched; }, set state(value) { state = value; }, set stopError(value) { stopError = value; } };
}

test('Mac command bridge preserves stdout, including inactive, just like the native command path', async () => {
  const show = ['--user', 'show', '--property=ActiveState', '--value', 'worker'];
  for (const state of ['active', 'activating', 'inactive', 'failed']) {
    const units = unitCommands({ state: async () => state });
    assert.equal(await command('systemctl', show, units), state);
  }
  await assert.rejects(command('systemctl', show, async () => { throw new Error('unknown'); }), /unknown/);
});

test('the actual Durable launch arguments pass through the Mac bridge and keep restart/runtime policy', async t => {
  const f = await fixture(t);
  assert.equal(f.launched.restart, 'on-failure'); assert.equal(f.launched.restartSeconds, 2);
  assert.equal(f.launched.maxSeconds, 7200); assert.equal(f.launched.umask, 0o077); assert.equal(f.launched.quiet, true);
  assert.ok(f.launched.command[1].endsWith('/subagent-runner.mjs'));
});

test('Mac reconcile preserves restarting workers but settles known dead workers without inventing zero usage', async t => {
  const f = await fixture(t);
  for (const state of ['active', 'activating', new Error('unknown unit state')]) { f.state = state; await f.manager.reconcile(); assert.equal(f.manager.read(f.task.id).status, 'running'); }
  f.state = 'inactive'; await f.manager.reconcile();
  const result = f.manager.result(f.task.id);
  assert.equal(result.status, 'failed'); assert.equal(result.usageReliable, false); assert.equal(result.usage, null);
});

test('Mac cancellation can verify a failed stop against known inactive state, but not a restarting unit', async t => {
  const f = await fixture(t); f.stopError = new Error('already gone'); f.state = 'inactive';
  assert.equal((await f.manager.cancel(f.task.id)).status, 'cancelled');
  const running = await fixture(t); running.stopError = new Error('unknown'); running.state = 'activating';
  await assert.rejects(running.manager.cancel(running.task.id), /Could not verify/);
  assert.equal(running.manager.read(running.task.id).status, 'running');
});
