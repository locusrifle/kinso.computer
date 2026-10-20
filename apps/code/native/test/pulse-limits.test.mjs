import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { browserLease } from '../../../../tools/test-browser.mjs';
import { testGate } from '../../../../tools/test-gate.mjs';
import { Subagents } from '../subagent.mjs';
import { systemdUser } from '../../../../system/projects.mjs';
import { buildUnitInvocation } from '../../../../tools/worker.mjs';

test('a third test browser is refused while both kernel leases are occupied; release permits the next one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-cap-')); t.after(() => rm(root, { recursive: true, force: true }));
  const first = await browserLease({ root }), second = await browserLease({ root });
  t.after(first); t.after(second);
  await assert.rejects(browserLease({ root, timeout: 250 }), /two-browser test cap/);
  await first(); const third = await browserLease({ root, timeout: 500 }); await third();
  await first(); await second(); // Releases are idempotent.
});
// OS prefix drop-ins cover these actual native launch paths. Do not replace
// them with a second executor or apply tiny test-unit limits to model workers.
test('managed native jobs retain the unit prefixes covered by OS worker limits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-launch-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const capture = async (file, args) => { calls.push([file, args]); return { stdout: '' }; };
  const manager = new Subagents({ root, owner: 'limits-test', launch: capture });
  const task = manager.start({ task: 'synthetic launch only', cwd: root });
  await Promise.resolve();
  assert.match(task.unit, /^imperfect-subagent-[a-f0-9]+$/);
  assert.equal(calls[0][0], 'systemd-run'); assert.ok(calls[0][1].includes(`--unit=${task.unit}`));
  assert.ok(calls[0][1].includes('--user')); assert.ok(calls[0][1].includes('--property=RuntimeMaxSec=7200'));
  await systemdUser({ run: capture }).start('imperfect-project-limits', { cwd: root, command: ['true'], env: {} });
  assert.equal(calls[1][0], 'systemd-run'); assert.ok(calls[1][1].includes('--unit=imperfect-project-limits')); assert.ok(calls[1][1].includes('--user'));
  const worker = buildUnitInvocation({ unit: 'imperfect-worker-limits.service' }, join(root, 'config.json'));
  assert.equal(worker.command, 'systemd-run'); assert.ok(worker.args.includes('--slice=imperfect-workers.slice'));
  assert.ok(worker.args.includes('--unit=imperfect-worker-limits.service')); assert.ok(worker.args.includes('--property=KillMode=control-group'));
});
test('full gate launcher keeps the last successful receipt after failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-gate-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let exit = 0, time = '2026-10-12T10:00:00.000Z';
  const launch = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', exit)); return child; };
  await testGate({ stateDir: dir, command: ['fake'], launch, now: () => time });
  exit = 1; time = '2026-10-12T11:00:00.000Z'; await testGate({ stateDir: dir, command: ['fake'], launch, now: () => time });
  const receipt = JSON.parse(await readFile(join(dir, 'test-gate.json')));
  assert.equal(receipt.exit, 1); assert.equal(receipt.lastSuccess, '2026-10-12T10:00:00.000Z'); assert.equal(receipt.scope, 'full');
});
