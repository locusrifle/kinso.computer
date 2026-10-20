import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUnits, parseRun, unitCommands } from '../../../system/units.mjs';

const place = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'units-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 50))) if (await check()) return true;
  return false;
};

test('systemd-run as imperfect calls it is read as a unit', () => {
  const asked = parseRun(['--user', '--quiet', '--collect', '--unit=imperfect-subagent-ab12', '--property=UMask=0077', '--property=RuntimeMaxSec=7200',
    '--property=StandardOutput=null', '--property=StandardError=null', '--setenv=IMPERFECT_PREFIX=/p', '--working-directory=/w', '--', '/bin/node', 'runner.mjs', '/x']);
  assert.deepEqual(asked, { name: 'imperfect-subagent-ab12', cwd: '/w', env: { IMPERFECT_PREFIX: '/p' }, umask: 0o077, maxSeconds: 7200, quiet: true, restart: 'no', restartSeconds: 0, command: ['/bin/node', 'runner.mjs', '/x'] });
  assert.throws(() => parseRun(['--user', '--unit=x', '--scope', '--', 'true']), /not understood/);
  assert.throws(() => parseRun(['--user', '--', 'true']), /needs a name/);
  assert.throws(() => parseRun(['--user', '--unit=x']), /no command/);
});

test('a unit runs on its own, is active while it lives, says so to systemctl, and stops with everything it started', async t => {
  const root = await place(t);
  const run = unitCommands(createUnits({ dir: join(root, 'units'), logs: join(root, 'logs') }));
  // A shell that starts a child of its own: both go with the unit.
  await run('systemd-run', ['--user', '--unit=imperfect-project-demo', '--collect', '--quiet', `--working-directory=${root}`, '--setenv=GREETING=hello',
    '--', '/bin/sh', '-c', 'echo "$GREETING from $(pwd)"; sleep 30 & echo $! > child.pid; wait']);
  await run('systemctl', ['--user', 'is-active', '--quiet', 'imperfect-project-demo']);
  assert.ok(await until(async () => (await readFile(join(root, 'logs', 'imperfect-project-demo.log'), 'utf8').catch(() => '')).includes(`hello from ${root}`)));
  assert.ok(await until(() => stat(join(root, 'child.pid')).then(() => true, () => false)));
  const child = Number(await readFile(join(root, 'child.pid'), 'utf8'));
  const listed = await run('systemctl', ['--user', 'list-units', '--plain', '--no-legend', '--state=active', 'imperfect-project-*']);
  assert.equal(listed.stdout.trim().split(/\s+/)[0], 'imperfect-project-demo.service');
  await assert.rejects(run('systemd-run', ['--user', '--unit=imperfect-project-demo', '--', 'true']), /already exists/);
  await run('systemctl', ['--user', 'stop', 'imperfect-project-demo']);
  await assert.rejects(run('systemctl', ['--user', 'is-active', '--quiet', 'imperfect-project-demo']), /inactive/);
  assert.ok(await until(() => { try { process.kill(child, 0); return false; } catch { return true; } }), 'the child it started went with it');
  assert.equal((await run('systemctl', ['--user', 'list-units', 'imperfect-project-*'])).stdout, '');
  // Stopping one that is not there is not a failure, as systemd's --collect units are not.
  await run('systemctl', ['--user', 'stop', 'imperfect-project-demo']);
});

test('a unit asked for no output and a umask gets them; one past its time is stopped when asked after', async t => {
  const root = await place(t);
  let clock = Date.now();
  const units = createUnits({ dir: join(root, 'units'), logs: join(root, 'logs'), now: () => clock });
  const run = unitCommands(units);
  await run('systemd-run', ['--user', '--unit=imperfect-subagent-1', '--property=UMask=0077', '--property=RuntimeMaxSec=60', '--property=StandardOutput=null',
    `--working-directory=${root}`, '--', '/bin/sh', '-c', 'umask > mask; echo noisy; exec sleep 30']);
  assert.ok(await until(() => readFile(join(root, 'mask'), 'utf8').then(text => text.trim() === '0077', () => false)));
  await assert.rejects(stat(join(root, 'logs', 'imperfect-subagent-1.log')));
  assert.equal(await units.active('imperfect-subagent-1'), true);
  clock += 61_000;
  assert.equal(await units.active('imperfect-subagent-1'), false);
  assert.equal(await units.record('imperfect-subagent-1'), null);
});

test('a pid now another process\'s is not the unit', async t => {
  const root = await place(t);
  let first = true;
  const units = createUnits({ dir: join(root, 'units'), logs: join(root, 'logs'), started: async () => (first ? (first = false, 'then') : 'a stranger') });
  await units.start(parseRun(['--user', '--unit=imperfect-project-x', '--', '/bin/sh', '-c', 'exec sleep 5']));
  const { pid } = await units.record('imperfect-project-x');
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.equal(await units.active('imperfect-project-x'), false);
});

test('Durable restart flags are accepted without silently accepting unsupported policies', () => {
  const parsed = parseRun(['--unit=worker', '--property=Restart=on-failure', '--property=RestartSec=2s', '--property=RuntimeMaxSec=7200', '--', 'runner']);
  assert.equal(parsed.restart, 'on-failure'); assert.equal(parsed.restartSeconds, 2); assert.equal(parsed.maxSeconds, 7200);
  assert.equal(parseRun(['--unit=worker', '--property=RestartSec=0.25s', '--', 'runner']).restartSeconds, 0.25);
  for (const flag of ['--property=Restart=always', '--property=RestartSec=-1s', '--property=RestartSec=forever']) assert.throws(() => parseRun(['--unit=worker', flag, '--', 'runner']), /not understood/);
});

test('show returns known ActiveState values, including inactive, rather than rejecting them', async () => {
  let state = 'active';
  const run = unitCommands({ state: async name => { assert.equal(name, 'worker'); return state; } });
  for (state of ['active', 'activating', 'inactive', 'failed']) {
    assert.deepEqual(await run('systemctl', ['--user', 'show', '--property=ActiveState', '--value', 'worker.service']), { stdout: `${state}\n`, stderr: '' });
  }
  await assert.rejects(run('systemctl', ['show', '--property=MainPID', '--value', 'worker']), /only/);
  await assert.rejects(run('systemctl', ['show', '--property=ActiveState', '--value', 'worker', '--unknown']), /only/);
});

test('stop rechecks identity before escalation, never signals a reused or unverifiable PID', async t => {
  const root = await place(t), signals = [];
  let identity = 'original';
  const units = createUnits({ dir: root, started: async () => identity, stopWaitMs: 0,
    kill: (pid, signal) => { if (signal !== 0) { signals.push([pid, signal]); identity = 'replacement'; } } });
  const held = { pid: 12345, started: 'original', token: 'fake-owned-unit', state: 'active' };
  await writeFile(join(root, 'worker.json'), JSON.stringify(held));
  await units.stop('worker');
  assert.deepEqual(signals, [[-12345, 'SIGTERM']]);
  signals.length = 0;
  await writeFile(join(root, 'worker.json'), JSON.stringify(held));
  await units.stop('worker'); assert.deepEqual(signals, []);
  identity = '';
  await writeFile(join(root, 'worker.json'), JSON.stringify({ ...held, started: '' }));
  await assert.rejects(units.stop('worker'), /Cannot verify/); assert.deepEqual(signals, []);
  await assert.rejects(units.stop('../outside'), /Invalid unit name/);
});

test('a supervised failed worker restarts independently and stop during backoff fences further attempts', async t => {
  const root = await place(t), dir = join(root, 'units');
  const units = createUnits({ dir, logs: join(root, 'logs') }), run = unitCommands(units);
  t.after(() => units.stop('worker'));
  // No app timer performs the restart: the detached supervisor does it.
  const program = `const fs = require('node:fs'); const n = Number(fs.existsSync('attempts') ? fs.readFileSync('attempts', 'utf8') : 0) + 1; fs.writeFileSync('attempts', String(n)); process.exit(1);`;
  await run('systemd-run', ['--unit=worker', `--working-directory=${root}`, '--property=Restart=on-failure', '--property=RestartSec=0.2s', '--property=RuntimeMaxSec=30', '--', process.execPath, '-e', program]);
  assert.ok(await until(async () => Number(await readFile(join(root, 'attempts'), 'utf8').catch(() => 0)) >= 2));
  assert.ok(await until(async () => (await run('systemctl', ['show', '--property=ActiveState', '--value', 'worker'])).stdout === 'activating\n'));
  await units.stop('worker');
  const attempts = await readFile(join(root, 'attempts'), 'utf8');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(await readFile(join(root, 'attempts'), 'utf8'), attempts);
  assert.equal((await run('systemctl', ['show', '--property=ActiveState', '--value', 'worker'])).stdout, 'inactive\n');
});

test('only systemctl and systemd-run are answered', async () => {
  const run = unitCommands(createUnits({ dir: join(tmpdir(), 'units-none') }));
  await assert.rejects(run('journalctl', ['--user']), error => error.code === 'ENOENT');
  await assert.rejects(run('systemctl', ['--user', 'daemon-reload']), /not understood/);
});
