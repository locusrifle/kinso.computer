import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { invariantRegistry, createDoctor, heartbeat, pulseSummary, atomicJson, createObserver, observeCrashRecording } from '../../../../system/doctor.mjs';
import { createGueyServer } from '../../../../system/server.mjs';
import { createIncidentLedger } from '../../../../system/pulse-ledger.mjs';
import { createPulseRoute } from '../../../../system/pulse-route.mjs';
const now = Date.parse('2026-10-12T06:00:00Z'), iso = new Date(now).toISOString(), ago = ms => new Date(now - ms).toISOString();
const recording = () => ({ timer: { LoadState: 'loaded', ActiveState: 'active' }, service: { LoadState: 'loaded', ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0' }, sample: { when: iso, bootId: 'this-boot' } });
const good = () => ({ now, crashRecording: recording(), doctor: { checked: iso }, follower: { state: 'current', ahead: 0, behind: 0, dirty: false, branch: 'main', checked: iso }, os: { state: 'current', lastRun: iso }, disks: [{ path: '/', used: 30, inodes: 3 }, { path: '/home', used: 40, inodes: 4 }], memory: { used: 40, some: .1, full: 0 }, services: [{ name: 'store', state: 'ok' }], workers: [], bank: { finished: iso, exchanges: 20, oldOpen: 0 }, backup: { exit: 0, lastSuccess: iso }, clock: { synchronised: true }, gate: { lastSuccess: iso, finished: iso, exit: 0 }, reflections: [], boots: [] });
const examples = {
  'doctor-heartbeat': [['crit', { doctor: { checked: ago(180001) } }], ['unknown', { doctor: null }]],
  'follower-drift': [['warn', { follower: { ...good().follower, dirty: true } }], ['crit', { follower: { ...good().follower, ahead: 1 } }], ['unknown', { follower: null }], ['warn', { follower: { ...good().follower, restartPending: true, pendingSince: ago(31 * 60000) } }], ['unknown', { follower: { ...good().follower, checked: ago(6 * 60000) } }]],
  'os-follower': [['warn', { os: { state: 'waiting', reason: 'busy agents', lastRun: iso } }], ['crit', { os: { state: 'failed', lastRun: iso, reason: 'build failed' } }], ['unknown', { os: null }], ['warn', { os: { state: 'current', lastRun: ago(16 * 60000) } }]],
  'disk-pressure': [['warn', { disks: [{ path: '/', used: 80, inodes: 5 }] }], ['crit', { disks: [{ path: '/home', used: 20, inodes: 90 }] }], ['unknown', { disks: [{ path: '/', used: null, inodes: null }] }], ['crit', { disks: [{ path: '/', used: 92, inodes: 5 }] }], ['crit', { disks: [{ path: '/', used: 92, inodes: null }] }], ['unknown', { disks: [{ path: '/', used: 30, inodes: null }] }]],
  'memory-pressure': [['warn', { memory: { used: 86, some: 0, full: 0 } }], ['crit', { memory: { used: 40, some: 20, full: 10 } }], ['unknown', { memory: null }]],
  services: [['crit', { services: [{ name: 'store', state: 'crit', reason: 'loopback unavailable' }] }], ['unknown', { services: [{ name: 'tunnel', state: 'unknown', reason: 'unit unreadable' }] }]],
  workers: [['warn', { workers: [{ name: 'done', finished: ago(11 * 60000), exit: 0 }] }], ['crit', { workers: [{ name: 'failed', finished: iso, exit: 1 }] }], ['unknown', { workers: null }], ['ok', { workers: [{ name: 'acked', finished: iso, exit: 1, acknowledged: iso }] }]],
  'memory-bank': [['warn', { bank: { ...good().bank, finished: ago(11 * 60000) } }], ['crit', { bank: { ...good().bank, finished: ago(31 * 60000) } }], ['unknown', { bank: null }], ['warn', { bank: { ...good().bank, oldOpen: 1 } }], ['warn', { bank: { ...good().bank, upgradeRefused: true } }], ['ok', { bank: { ...good().bank, exchanges: 0 } }]],
  backups: [['warn', { backup: { exit: 0, lastSuccess: ago(25 * 3600000) } }], ['crit', { backup: { exit: 1, lastSuccess: iso } }], ['unknown', { backup: null }], ['crit', { backup: { exit: 0, lastSuccess: ago(49 * 3600000) } }]],
  clock: [['warn', { clock: { synchronised: false } }], ['crit', { clock: { synchronised: true, offsetMs: 6000 } }], ['unknown', { clock: null }]],
  'test-gate': [['warn', { gate: { exit: 0, lastSuccess: ago(8 * 86400000) } }], ['crit', { gate: { exit: 1, lastSuccess: iso } }], ['unknown', { gate: null }], ['crit', { gate: { exit: 1, lastSuccess: null } }]],
  reflections: [['warn', { reflections: [{ name: 'Files', live: false, checked: iso }] }], ['unknown', { reflections: null }]],
  'crash-recording': [
    ['crit', { crashRecording: { ...recording(), timer: { LoadState: 'not-found', ActiveState: 'inactive' } } }],
    ['crit', { crashRecording: { ...recording(), service: { LoadState: 'not-found' } } }],
    ['crit', { crashRecording: { ...recording(), timer: { LoadState: 'loaded', ActiveState: 'inactive' } } }],
    ['crit', { crashRecording: { ...recording(), service: { ...recording().service, Result: 'exit-code', ExecMainStatus: '1' } } }],
    ['crit', { crashRecording: { ...recording(), service: { ...recording().service, ExecMainStatus: '2' } } }],
    ['warn', { crashRecording: { ...recording(), sample: { when: ago(61000), bootId: 'this-boot' } } }],
    ['crit', { crashRecording: { ...recording(), sample: { when: ago(181000), bootId: 'this-boot' } } }],
    ['unknown', { crashRecording: { ...recording(), sample: null } }],
    ['unknown', { crashRecording: { ...recording(), sample: { when: new Date(now + 31000).toISOString(), bootId: 'this-boot' } } }],
    ['unknown', { crashRecording: null }],
    ['unknown', { crashRecording: { ...recording(), service: null } }],
    ['unknown', { crashRecording: { ...recording(), service: { LoadState: 'loaded', Result: 'success', ExecMainStatus: '0' } } }],
    ['crit', { crashRecording: { ...recording(), timer: { LoadState: 'loaded', ActiveState: 'failed' } } }],
  ],
  'unclean-boots': [['unknown', { crashRecording: { ...recording(), sample: { when: ago(61000), bootId: 'this-boot' } }, boots: [] }], ['unknown', { crashRecording: null, boots: [] }], ['unknown', { crashRecording: { ...recording(), timer: { LoadState: 'not-found' } }, boots: [] }], ['crit', { boots: [{ kind: 'unclean-boot', summary: 'previous boot stopped without a clean shutdown', when: iso, bootId: 'b', previousBootId: 'a' }] }], ['unknown', { boots: null }]],
};
for (const invariant of invariantRegistry()) {
  test(`${invariant.id}: healthy observation and declared metadata`, () => {
    const answer = invariant.check(good()); assert.equal(answer.state, 'ok'); assert.ok(answer.reason); assert.ok(invariant.runbook && invariant.owner && invariant.healing && invariant.severity);
  });
  for (const [state, changes] of examples[invariant.id]) test(`${invariant.id}: ${state} evidence ${JSON.stringify(changes)}`, () => { const answer = invariant.check({ ...good(), ...changes }); assert.equal(answer.state, state); assert.ok(answer.reason); });
}
test('observer uses bounded local probes, fake statfs/PSI/git, and never fetches or probes public services', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-observe-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [], targets = [];
  const observe = createObserver({ stateDir: join(dir, 'data/state'), prefix: dir, root: '/fake/imperfect', authority: true,
    json: async path => path.endsWith('computer-update.json') ? { state: 'paused', reason: 'local commits', checked: iso } : path.endsWith('pulse-pass.json') ? { finished: iso, exchanges: 5 } : null,
    execute: async (file, args) => { calls.push([file, args]); if (file === 'git') return args.includes('rev-list') ? '1\t86' : args.includes('status') ? '' : 'main'; return file === 'timedatectl' ? 'yes' : 'active'; },
    filesystem: async () => ({ blocks: 1000, bavail: 100, files: 200, ffree: 180 }),
    text: async path => path.endsWith('meminfo') ? 'MemTotal: 1000 kB\nMemAvailable: 200 kB\n' : 'some avg10=1 avg60=12.00 avg300=3 total=1\nfull avg10=0 avg60=3.00 avg300=1 total=1\n',
    send: async target => { targets.push(target); const site = target.endsWith('/'); return { ok: !site, status: site ? 404 : 200, json: async () => site ? { error: 'not found' } : { ok: true } }; }, listWorkers: async () => [{ name: 'sol', started: iso }],
  });
  const evidence = await observe(now);
  assert.equal(evidence.disks[0].used, 90); assert.equal(evidence.disks[0].inodes, 10); assert.equal(evidence.memory.some, 12); assert.equal(evidence.memory.full, 3);
  assert.equal(evidence.follower.enabled, false); assert.equal(evidence.follower.ahead, 0, 'authority is not falsely called a diverged follower'); assert.equal(evidence.bank.exchanges, 5);
  assert.equal(evidence.services.length, 4); assert.ok(evidence.services.every(s => s.state === 'ok')); assert.ok(targets.every(target => target.startsWith('http://127.0.0.1:'))); assert.ok(!calls.some(([, args]) => args.includes('fetch'))); assert.equal(evidence.clock.synchronised, true);
});
test('guarded OS closure is not reopened by its unchanged read-only evidence file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-boot-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = invariantRegistry(), ledger = createIncidentLedger({ stateDir: dir, registry });
  const boot = { kind: 'unclean-boot', host: 'PC', when: iso, bootId: 'new', previousBootId: 'old', summary: 'Previous boot ended uncleanly' };
  const doctor = createDoctor({ stateDir: dir, registry, incidents: ledger, observe: async () => ({ ...good(), boots: [boot] }), now: () => now });
  await doctor.tick(); await doctor.tick(); assert.equal((await ledger.list()).length, 1, 'no duplicate generic boot incident');
  const [incident] = await ledger.list(); await ledger.guard(incident.id, { type: 'invariant', id: 'memory-pressure' }); await ledger.close(incident.id);
  const status = await doctor.tick(); assert.equal(status.invariants.find(i => i.id === 'unclean-boots').state, 'ok'); assert.equal((await ledger.list()).length, 1);
  assert.equal(boot.kind, 'unclean-boot'); // The app never changes OS evidence.
});
test('changing pressure measurements retain onset and hourly flaps survive the short transition list', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-onset-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let time = now, state = 'warn', percent = 81;
  const registry = [{ id: 'pressure', title: 'Pressure', check: () => ({ state, reason: `${percent}% used`, evidence: {} }) }];
  const doctor = createDoctor({ stateDir: dir, registry, observe: async () => ({}), now: () => time });
  const first = await doctor.tick(); time += 60000; percent = 82; const second = await doctor.tick(); assert.equal(first.invariants[0].since, second.invariants[0].since); assert.equal(second.invariants[0].transitions.length, 1);
  for (let i = 0; i < 40; i++) { time += 60000; state = i % 2 ? 'warn' : 'ok'; await doctor.tick(); }
  const last = doctor.snapshot().invariants[0]; assert.equal(last.transitions.length, 32); assert.equal(Object.values(last.flaps).reduce((a, b) => a + b, 0), 40);
});
test('a hung check times out without blocking the event loop or later checks', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-timeout-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const doctor = createDoctor({ stateDir: dir, registry: [{ id: 'hung', title: 'Hung', check: () => new Promise(() => {}) }, { id: 'alive', title: 'Alive', check: () => ({ state: 'ok', reason: 'alive' }) }], observe: async () => ({}) });
  const pending = doctor.tick(); assert.equal(doctor.tick(), pending, 'single flight');
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(doctor.snapshot(), null);
  const status = await pending; assert.deepEqual(status.invariants.map(i => i.state), ['unknown', 'ok']);
});
test('a corrupt ledger is unknown, not an empty healthy incident history', async () => {
  const route = createPulseRoute({ stateDir: '/unused', snapshot: () => ({ checked: iso, invariants: [] }), now: () => now, incidents: { list: async () => { throw new Error('corrupt'); } }, workers: { list: async () => [] } });
  const view = await route.view(); assert.equal(view.summary.state, 'unknown'); assert.equal(view.incidents, null); assert.match(view.dataErrors[0], /unreadable/);
});
test('installed recording probes system units and one local current-boot receipt, not source or peer state', async () => {
  const calls = [];
  const receipt = { __REALTIME_TIMESTAMP: String(now * 1000), _BOOT_ID: 'this-boot', PULSE_BOOT_ID: 'this-boot' };
  const execute = async (file, args) => {
    calls.push([file, args]);
    if (file === 'journalctl') return JSON.stringify(receipt);
    const unit = args.at(-1).endsWith('.timer') ? recording().timer : recording().service;
    return Object.entries(unit).map(([key, value]) => `${key}=${value}`).join('\n');
  };
  const observed = await observeCrashRecording(execute);
  assert.deepEqual(observed, recording()); assert.equal(calls.length, 3);
  assert.ok(calls.every(([, args]) => !args.includes('--user')));
  const journal = calls.find(([file]) => file === 'journalctl')[1];
  assert.ok(journal.includes('--boot=0')); assert.equal(journal[journal.indexOf('-n') + 1], '1');
  assert.ok(journal.includes('SYSLOG_IDENTIFIER=imperfect-pulse'));
  const invariant = invariantRegistry().find(i => i.id === 'crash-recording');
  const checked = invariant.check({ ...good(), crashRecording: observed, remote: { state: 'asleep' }, watchdogRuntime: 60 });
  assert.equal(checked.state, 'ok'); assert.match(checked.evidence.scope, /hardware watchdog operation are not verified/);
  receipt._BOOT_ID = 'different-boot';
  assert.equal((await observeCrashRecording(execute)).sample, null);
  receipt._BOOT_ID = 'this-boot'; receipt.__REALTIME_TIMESTAMP = 'invalid';
  assert.equal((await observeCrashRecording(execute)).sample, null);
});
test('unavailable installed probes and unreadable local samples never invent crash coverage', async () => {
  const unavailable = await observeCrashRecording(async () => { throw new Error('unavailable'); });
  assert.deepEqual(unavailable, { timer: null, service: null, sample: null });
  const check = invariantRegistry().find(i => i.id === 'crash-recording').check;
  assert.equal(check({ ...good(), crashRecording: unavailable }).state, 'unknown');
  for (const output of ['', 'not json', '{}', '[]']) {
    const observed = await observeCrashRecording(async (file, args) => file === 'journalctl' ? output : args.at(-1).endsWith('.timer') ? 'LoadState=loaded\nActiveState=active' : 'LoadState=loaded\nActiveState=inactive\nResult=success\nExecMainStatus=0');
    assert.equal(check({ ...good(), crashRecording: observed }).state, 'unknown');
  }
  const missing = await observeCrashRecording(async () => 'LoadState=not-found\nActiveState=inactive');
  assert.equal(check({ ...good(), crashRecording: missing, sourceConfig: { sampler: true } }).state, 'crit');
});
test('atomic status publication round trips', async t => { const dir = await mkdtemp(join(tmpdir(), 'pulse-json-')); t.after(() => rm(dir, { recursive: true, force: true })); await atomicJson(join(dir, 'status.json'), { checked: iso }); assert.equal(JSON.parse(await readFile(join(dir, 'status.json'))).checked, iso); });
