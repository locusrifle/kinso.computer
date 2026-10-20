import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createIncidentLedger, createWorkerLedger, invariantIds } from '../../../../system/pulse-ledger.mjs';
import { createWorkerLauncher, buildUnitInvocation, systemdQuote, parseWorkerArgs } from '../../../../tools/worker.mjs';
import { completeWorker, completionFromSystemd } from '../../../../tools/worker-complete.mjs';
import { createPiOutcomeReader } from '../../../../tools/worker-execute.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../../../', import.meta.url));
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pulse-ledger-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state'), memoryDir = join(dir, 'memory'), tasksDir = join(dir, 'tasks');
  const options = { stateDir, memoryDir, tasksDir, ...overrides };
  const prompt = join(dir, 'input.md');
  await writeFile(prompt, 'Do not launch a model. Synthetic fixture only.\n');
  return { dir, stateDir, memoryDir, tasksDir, prompt, options, incidents: createIncidentLedger(options), workers: createWorkerLedger(options) };
}
const sink = () => ({ text: '', write(chunk) { this.text += chunk; return true; } });
const absent = path => assert.rejects(readFile(path), { code: 'ENOENT' });

// These tests create temporary synthetic state only. No systemd units, browser,
// model invocations, installed state, credentials, or interactive sessions.
test('construction/list do not create incident state or seed anything', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.incidents.list(), []);
  await absent(join(f.stateDir, 'incidents.jsonl'));
});

test('incident replay keeps causes, existing guard evidence and idempotent close', async t => {
  const f = await fixture(t);
  const record = await f.incidents.open({ id: 'one', title: 'disk incident', invariant: 'disk-pressure', evidence: { percent: 92 } });
  await f.incidents.cause(record.id, 'Cache grew without a pressure check.');
  await f.incidents.cause(record.id, 'The build cache was the largest contributor.');
  const guarded = await f.incidents.guard(record.id, { type: 'test', path: f.prompt });
  assert.equal(guarded.guards[0].path, f.prompt);
  assert.equal(typeof guarded.guards[0].evidence.size, 'number');
  const closed = await f.incidents.close(record.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closingGuards.length, 1);
  assert.equal(closed.causes.length, 2);
  assert.deepEqual(await createIncidentLedger(f.options).open({ id: 'one', title: 'retry' }), closed);
  assert.deepEqual(await f.incidents.close('one'), closed);
  await assert.rejects(f.incidents.cause('one', 'Too late'), /already closed/);
});

test('close refuses missing guards; paths must be actual regular files', async t => {
  const f = await fixture(t);
  const record = await f.incidents.open('No protection yet');
  await assert.rejects(f.incidents.close(record.id), /no currently validated guard/);
  await assert.rejects(f.incidents.guard(record.id, { type: 'hook', path: join(f.dir, 'missing') }), { code: 'ENOENT' });
  await assert.rejects(f.incidents.guard(record.id, { type: 'test', path: f.dir }), /regular file/);
  await assert.rejects(f.incidents.guard(record.id, { type: 'invariant', id: 'not-real' }), /Unknown invariant/);
  await f.incidents.guard(record.id, { type: 'hook', path: f.prompt });
  await unlink(f.prompt);
  await assert.rejects(f.incidents.close(record.id), /no currently validated guard/);
  assert.equal((await f.incidents.list())[0].guards.length, 1, 'failed validation does not erase evidence');
});

test('invariants validate the current supplied registry, including removal at close', async t => {
  let registry = [{ id: 'workers' }];
  const f = await fixture(t, { registry: () => registry });
  const record = await f.incidents.open('Workers');
  await f.incidents.guard(record.id, { type: 'invariant', id: 'workers' });
  registry = [];
  await assert.rejects(f.incidents.close(record.id), /no currently validated guard/);
  registry = new Map([['workers', {}]]);
  assert.equal((await f.incidents.close(record.id)).status, 'closed');
});

test('no-guard note needs the explicit prefix and a substantive 40-character reason', async t => {
  const f = await fixture(t);
  const record = await f.incidents.open('External outage');
  for (const value of ['No guard is possible because the remote provider owns this service.', 'no guard possible: short', `no guard possible: ${'reason '.repeat(20)}`, `no guard possible: ${'x'.repeat(100)}`]) {
    await assert.rejects(f.incidents.guard(record.id, { type: 'note', text: value }), /meaningful reason/);
  }
  await f.incidents.guard(record.id, { type: 'note', text: 'no guard possible: The remote provider controls the hardware and offers no observable health endpoint for this failure.' });
  assert.equal((await f.incidents.close(record.id)).status, 'closed');
});

test('bounded checkpoints preserve open state and all guard/cause evidence', async t => {
  const f = await fixture(t, { maxBytes: 8192, retainClosed: 0 });
  await f.incidents.open({ id: 'kept', title: 'A'.repeat(600) });
  await f.incidents.guard('kept', { type: 'invariant', id: 'disk-pressure' });
  for (let index = 0; index < 15; index++) await f.incidents.cause('kept', `Evidence revision ${index}: a cache writer filled the mounted disk.`);
  const raw = await readFile(join(f.stateDir, 'incidents.jsonl'), 'utf8');
  assert.ok(Buffer.byteLength(raw) <= 8192);
  assert.ok(raw.includes('"op":"checkpoint"'));
  const [kept] = await createIncidentLedger(f.options).list();
  assert.equal(kept.causes.length, 15);
  assert.equal(kept.guards[0].id, 'disk-pressure');
  await f.incidents.close('kept');
  assert.equal((await f.incidents.list())[0].guards.length, 1, 'closed guard evidence also survives');
});

test('mandatory state at byte capacity refuses writes without losing open incidents', async t => {
  const f = await fixture(t, { maxBytes: 2048 });
  await f.incidents.open({ id: 'kept', title: 'Keep me' });
  const before = await readFile(join(f.stateDir, 'incidents.jsonl'), 'utf8');
  await assert.rejects(f.incidents.open({ id: 'too-big', title: 'Huge evidence', evidence: 'x'.repeat(5000) }), /capacity/);
  assert.equal(await readFile(join(f.stateDir, 'incidents.jsonl'), 'utf8'), before);
  assert.deepEqual((await f.incidents.list()).map(item => item.id), ['kept']);
});

test('corruption fails closed rather than silently overwriting the ledger', async t => {
  const f = await fixture(t);
  await mkdir(f.stateDir);
  for (const malformed of ['{broken}\n', '{"version":9,"op":"put"}\n', '{"version":1,"op":"put","record":{"id":"one"}}']) {
    await writeFile(join(f.stateDir, 'incidents.jsonl'), malformed);
    await assert.rejects(f.incidents.open('Do not erase evidence'), /Corrupt|Unsupported/);
    assert.equal(await readFile(join(f.stateDir, 'incidents.jsonl'), 'utf8'), malformed);
  }
});

test('an externally oversized ledger is refused before an unbounded read', async t => {
  const f = await fixture(t, { maxBytes: 1024 }); await mkdir(f.stateDir);
  await writeFile(join(f.stateDir, 'incidents.jsonl'), 'x'.repeat(2048));
  await assert.rejects(f.incidents.list(), /unbounded read/);
});
test('kernel lock serializes independent CLI writers with no lost entries', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 6 }, (_, index) => exec(process.execPath, [join(root, 'tools/incident.mjs'), 'open', `Concurrent incident ${index}`, '--state-dir', f.stateDir])));
  const rows = await f.incidents.list();
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map(row => row.id)).size, 6);
  const mode = (await stat(join(f.stateDir, 'incidents.jsonl'))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('explicit seeds are repeatable; unmerged or unshipped guards stay pending', async t => {
  const f = await fixture(t);
  const first = await f.incidents.seed();
  const second = await f.incidents.seed();
  assert.deepEqual(first, second);
  assert.equal(second.length, 7);
  const byId = new Map(second.map(item => [item.id, item]));
  for (const suffix of ['pc-freeze', 'stale-files', 'usage-authority', 'browser-storm']) {
    const item = byId.get(`week-2026-10-11-${suffix}`);
    assert.equal(item.status, 'open');
    assert.ok(item.pendingGuards.length);
  }
  for (const suffix of ['laptop-follower', 'unseen-workers', 'disk-pressure']) assert.equal(byId.get(`week-2026-10-11-${suffix}`).status, 'closed');
  assert.deepEqual(invariantIds, ['follower-drift', 'os-follower', 'disk-pressure', 'memory-pressure', 'services', 'workers', 'memory-bank', 'backups', 'clock', 'test-gate', 'reflections', 'unclean-boots', 'doctor-heartbeat']);
});

test('OS boot imports are idempotent and do not trust their declared guard', async t => {
  const f = await fixture(t);
  const boot = { kind: 'unclean-boot', host: 'desktop', when: '2026-10-11T20:31:00Z', bootId: 'new', previousBootId: 'old', summary: 'Unclean restart', evidence: { journal: ['oom'] }, suspects: ['workers'], guard: { type: 'invariant', id: 'unclean-boots' } };
  const path = join(f.dir, 'os.json');
  await writeFile(path, JSON.stringify(boot));
  const first = await f.incidents.importBoot(path);
  assert.deepEqual(await f.incidents.importBoot(boot), first);
  assert.equal(first.guards.length, 0);
  assert.deepEqual(first.evidence, boot);
  await assert.rejects(f.incidents.close(first.id), /no currently validated guard/);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), boot);
  await assert.rejects(f.incidents.importBoot({ kind: 'worker' }), /Invalid OS/);
});

test('incident CLI guard/close enforce the same validation as the API', async t => {
  const f = await fixture(t);
  const run = args => exec(process.execPath, [join(root, 'tools/incident.mjs'), ...args, '--state-dir', f.stateDir]);
  const { stdout } = await run(['open', 'CLI incident']);
  const { id } = JSON.parse(stdout);
  await assert.rejects(run(['close', id]), /no currently validated guard/);
  await run(['guard', id, '--test', f.prompt]);
  assert.equal(JSON.parse((await run(['close', id])).stdout).status, 'closed');
});

test('worker launcher fake runner owns an independent hook and ports the task layout', async t => {
  const f = await fixture(t);
  let invocation;
  const launcher = createWorkerLauncher({ ...f.options, wrapper: null, runner: async (command, args) => { invocation = { command, args }; } });
  const record = await launcher.start('sample', { prompt: f.prompt, worktree: f.dir });
  assert.equal(record.kind, 'sol');
  assert.equal(record.model, 'openai-codex/gpt-6.1-sol');
  assert.equal(record.finished, null);
  assert.equal(invocation.command, 'systemd-run');
  assert.ok(invocation.args.includes('--slice=imperfect-workers.slice'));
  assert.ok(invocation.args.includes('--property=Nice=10'));
  assert.ok(invocation.args.some(arg => arg.startsWith('--property=ExecStopPost=') && arg.includes('worker-complete.mjs')));
  for (const file of ['prompt.md', 'out.jsonl', 'err.log', 'worker.json', 'session']) await stat(join(record.taskDir, file));
  const config = JSON.parse(await readFile(join(record.taskDir, 'worker.json'), 'utf8'));
  assert.ok(config.env.PI_CODING_AGENT_DIR.endsWith('/data/agent'));
  assert.equal((await stat(join(record.taskDir, 'worker.json'))).mode & 0o777, 0o600);
  await assert.rejects(launcher.ack('sample'), /running worker/);
  await assert.rejects(launcher.start('sample', { prompt: f.prompt }), /running or unacknowledged/);
});

test('a separate completion hook raises both formats even without a child exit file', async t => {
  const f = await fixture(t);
  const launcher = createWorkerLauncher({ ...f.options, wrapper: null, runner: async () => {} });
  const record = await launcher.start('crashed', { prompt: f.prompt });
  const configPath = join(record.taskDir, 'worker.json');
  // Fake systemd calls the real independently executable ExecStopPost helper;
  // there is no live unit and the wrapper never got to create its exit file.
  await exec(process.execPath, [join(root, 'tools/worker-complete.mjs'), configPath], { env: { ...process.env, SERVICE_RESULT: 'signal', EXIT_CODE: 'killed', EXIT_STATUS: 'KILL' } });
  const finished = await f.workers.get('crashed');
  assert.equal(finished.exit, 137);
  assert.equal(finished.signal, 'KILL');
  assert.ok(finished.finished);
  const notice = JSON.parse(await readFile(join(f.memoryDir, 'open', 'worker-crashed.json'), 'utf8'));
  assert.match(notice.summary, /worker finished: crashed exit 137/);
  assert.match(await readFile(join(f.memoryDir, 'open', 'worker-crashed.md'), 'utf8'), /^- worker finished: crashed exit 137/);
  assert.equal(await readFile(join(record.taskDir, 'exit'), 'utf8'), '137\n');
  await launcher.ack('crashed');
  for (const ext of ['json', 'md']) await absent(join(f.memoryDir, 'open', `worker-crashed.${ext}`));
  await completeWorker(configPath, { SERVICE_RESULT: 'success', EXIT_CODE: 'exited', EXIT_STATUS: '0' });
  for (const ext of ['json', 'md']) await absent(join(f.memoryDir, 'open', `worker-crashed.${ext}`));
});

test('systemd crash/timeout wins over a stale success exit file', async t => {
  const f = await fixture(t);
  const launcher = createWorkerLauncher({ ...f.options, wrapper: null, runner: async () => {} });
  const record = await launcher.start('timeout', { prompt: f.prompt });
  await writeFile(join(record.taskDir, 'exit'), '0\n');
  const completed = await completeWorker(join(record.taskDir, 'worker.json'), { SERVICE_RESULT: 'timeout', EXIT_CODE: 'exited', EXIT_STATUS: '0' });
  assert.equal(completed.exit, 1);
  assert.equal(completed.result, 'timeout');
  assert.deepEqual(completionFromSystemd({ SERVICE_RESULT: 'signal', EXIT_CODE: 'killed', EXIT_STATUS: '9' }), { exit: 137, signal: '9', result: 'signal' });
});

test('worker list repairs memory notice materialization after interruption', async t => {
  const f = await fixture(t);
  await f.workers.start({ name: 'repair', kind: 'job', taskDir: f.dir, unit: 'repair.service' });
  await f.workers.finish('repair', { exit: 0 });
  await unlink(join(f.memoryDir, 'open', 'worker-repair.md'));
  await f.workers.list();
  assert.match(await readFile(join(f.memoryDir, 'open', 'worker-repair.md'), 'utf8'), /worker finished: repair exit 0/);
});

test('ack permits reuse without erasing old logs; obsolete hooks cannot finish new run', async t => {
  const f = await fixture(t);
  const launcher = createWorkerLauncher({ ...f.options, wrapper: null, runner: async () => {} });
  const first = await launcher.start('repeat', { prompt: f.prompt });
  const oldConfig = join(first.taskDir, 'worker.json');
  await writeFile(join(first.taskDir, 'out.jsonl'), 'Original log\n');
  await completeWorker(oldConfig, { SERVICE_RESULT: 'success', EXIT_CODE: 'exited', EXIT_STATUS: '0' });
  await launcher.ack('repeat');
  const second = await launcher.start('repeat', { prompt: f.prompt });
  assert.notEqual(second.taskDir, first.taskDir);
  assert.equal(await readFile(join(first.taskDir, 'out.jsonl'), 'utf8'), 'Original log\n');
  await completeWorker(oldConfig, { SERVICE_RESULT: 'signal', EXIT_CODE: 'killed', EXIT_STATUS: 'KILL' });
  assert.equal((await launcher.ledger.get('repeat')).finished, null);
  await absent(join(second.taskDir, 'exit'));
});

test('launcher refuses injection names, missing commands, and overwriting existing logs', async t => {
  const f = await fixture(t);
  const launcher = createWorkerLauncher({ ...f.options, wrapper: null, runner: async () => assert.fail('must not dispatch') });
  await assert.rejects(launcher.start('bad;touch-pwned', { prompt: f.prompt }), /name must/);
  await assert.rejects(launcher.start('../escape', { prompt: f.prompt }), /name must/);
  await assert.rejects(launcher.start('no-command', { prompt: f.prompt, kind: 'job' }), /requires -- executable/);
  const taskDir = join(f.tasksDir, 'existing');
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, 'out.jsonl'), 'Retain this\n');
  await assert.rejects(launcher.start('existing', { prompt: f.prompt }), /rather than overwrite logs/);
  assert.equal(await readFile(join(taskDir, 'out.jsonl'), 'utf8'), 'Retain this\n');
  assert.deepEqual(await f.workers.list(), []);
});

test('launch rejection records a failed unacknowledged worker and exposes logs', async t => {
  const f = await fixture(t);
  const launcher = createWorkerLauncher({ ...f.options, wrapper: null, runner: async () => { throw new Error('systemd unavailable'); } });
  await assert.rejects(launcher.start('rejected', { prompt: f.prompt }), /systemd unavailable/);
  const record = await f.workers.get('rejected');
  assert.equal(record.exit, 1);
  assert.equal(record.result, 'launch-failed');
  const output = sink();
  await launcher.logs('rejected', output);
  assert.match(output.text, /systemd unavailable/);
  assert.match(await readFile(join(f.memoryDir, 'open', 'worker-rejected.md'), 'utf8'), /exit 1/);
});

test('imperfect-run synchronous executor stays inside ONE hook-bearing unit, closing the dispatch crash gap', async t => {
  const f = await fixture(t);
  let invocation;
  const launcher = createWorkerLauncher({ ...f.options, wrapper: '/fake/imperfect-run', runner: async (command, args) => { invocation = { command, args }; } });
  const record = await launcher.start('wrapped', { prompt: f.prompt });
  assert.equal(invocation.command, 'systemd-run');
  assert.ok(invocation.args.some(arg => arg.includes('ExecStopPost=')));
  const start = invocation.args.indexOf('--');
  assert.deepEqual(invocation.args.slice(start + 1, start + 7), ['/fake/imperfect-run', 'execute', '--unit', record.unit.replace(/\.service$/, ''), '--', process.execPath]);
  assert.match(record.unit, /^imperfect-worker-wrapped-[a-f0-9]{12}\.service$/);
  assert.equal(invocation.args.filter(arg => arg === 'systemd-run').length, 0, 'no detached child dispatcher');
  await completeWorker(join(record.taskDir, 'worker.json'), { SERVICE_RESULT: 'signal', EXIT_CODE: 'killed', EXIT_STATUS: 'KILL' });
  assert.equal((await f.workers.get('wrapped')).exit, 137);
});

test('systemd hook quoting escapes specifiers and environment, not shell strings', () => {
  const quote = systemdQuote('/tmp/a "$HOME" %n; $(touch pwned)');
  assert.ok(quote.includes('$$HOME'));
  assert.ok(quote.includes('%%n'));
  assert.ok(quote.includes('\\"'));
  const invocation = buildUnitInvocation({ name: 'safe', unit: 'safe.service' }, '/tmp/a;$(false) %n.json');
  assert.equal(invocation.args.at(-1), '/tmp/a;$(false) %%n.json');
  assert.ok(!invocation.args.includes('bash'));
  assert.deepEqual(parseWorkerArgs(['start', 'job', '--kind', 'job', '--prompt', 'p.md', '--', 'node', '-e', 'text']), { positional: ['start', 'job'], options: { kind: 'job', prompt: 'p.md', command: ['node', '-e', 'text'] } });
});

test('test workers publish last result and preserve the last successful gate', async t => {
  const f = await fixture(t);
  const launcher = createWorkerLauncher({ ...f.options, wrapper: null, runner: async () => {} });
  for (const [name, exit] of [['passed', 0], ['failed', 1]]) {
    const record = await launcher.start(name, { prompt: f.prompt, kind: 'test', command: [process.execPath, '--version'] });
    await completeWorker(join(record.taskDir, 'worker.json'), { SERVICE_RESULT: exit ? 'exit-code' : 'success', EXIT_CODE: 'exited', EXIT_STATUS: String(exit) });
  }
  const last = JSON.parse(await readFile(join(f.stateDir, 'test-gate.json'), 'utf8'));
  assert.equal(last.name, 'failed');
  assert.ok(last.lastSuccess);
  assert.equal(JSON.parse(await readFile(join(f.stateDir, 'test-gate-success.json'), 'utf8')).name, 'passed');
});

test('worker checkpoint compaction retains running and unacknowledged records', async t => {
  const f = await fixture(t, { maxBytes: 4096, retainClosed: 1 });
  await f.workers.start({ name: 'running', kind: 'sol', taskDir: f.dir, unit: 'running.service' });
  await f.workers.start({ name: 'unseen', kind: 'job', taskDir: f.dir, unit: 'unseen.service' });
  await f.workers.finish('unseen', { exit: 5 });
  for (let index = 0; index < 12; index++) {
    const name = `acked-${index}`;
    await f.workers.start({ name, kind: 'job', taskDir: f.dir, unit: `${name}.service` });
    await f.workers.finish(name, { exit: 0 });
    await f.workers.ack(name);
    await absent(join(f.memoryDir, 'open', `worker-${name}.md`));
  }
  const records = await createWorkerLedger(f.options).list();
  assert.ok(records.some(record => record.name === 'running' && !record.finished));
  assert.ok(records.some(record => record.name === 'unseen' && record.exit === 5 && !record.acknowledged));
  assert.ok((await stat(join(f.stateDir, 'workers.jsonl'))).size <= 4096);
});

test('Pi JSON errors and aborts are not treated as successful process exits', () => {
  const reader = createPiOutcomeReader();
  const error = JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: 'Unicode\u2028inside one record' }] } }) + '\n';
  reader.push(Buffer.from(error.slice(0, 10)));
  reader.push(Buffer.from(error.slice(10)));
  assert.equal(reader.failed(), true);
  reader.push(Buffer.from(`${JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })}\n`));
  assert.equal(reader.failed(), false, 'successful retry supersedes the transient failure');
  reader.push(Buffer.from('{"type":"agent_settled","aborted":true}\n'));
  assert.equal(reader.failed(), true);
});

test('a Mac takes the ledger lock with lockf(1), keeping the file, or before macOS 15 with perl; Linux with flock(1)', async () => {
  const { lockCommand } = await import('../../../../system/pulse-ledger.mjs');
  assert.deepEqual(lockCommand('/s/x.lock', ['node', '-e', '1'], 'darwin', { lockf: true }), ['/usr/bin/lockf', ['-k', '-t', '30', '/s/x.lock', 'node', '-e', '1']]);
  const [perl, args] = lockCommand('/s/x.lock', ['node', '-e', '1'], 'darwin', { lockf: false });
  assert.equal(perl, '/usr/bin/perl');
  assert.deepEqual(args.slice(-5), ['/s/x.lock', '30', 'node', '-e', '1']);
  assert.deepEqual(lockCommand('/s/x.lock', ['node'], 'linux'), ['flock', ['--exclusive', '--timeout', '30', '/s/x.lock', 'node']]);
  assert.deepEqual(lockCommand('/s/x.lock', ['node'], 'linux', { wait: 0 }), ['flock', ['--exclusive', '--timeout', '0', '/s/x.lock', 'node']]);
});

test('without lockf(1), as before macOS 15, perl holds the lock until its program ends, and a second waits or gives up', { skip: !existsSync('/usr/bin/perl') && 'no /usr/bin/perl here' }, async t => {
  const { lockCommand } = await import('../../../../system/pulse-ledger.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'perl-lock-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'x.lock');
  const hold = wait => {
    const child = spawn(...lockCommand(path, ['bash', '-c', 'echo ready; read -r _ || true'], 'darwin', { lockf: false, wait }), { stdio: ['pipe', 'pipe', 'ignore'] });
    const ended = new Promise(resolve => child.once('close', resolve));
    const held = new Promise(resolve => { child.stdout.once('data', () => resolve(true)); child.once('close', () => resolve(false)); });
    return { child, ended, held };
  };
  const first = hold(0);
  assert.equal(await first.held, true);
  const refused = hold(0);
  assert.equal(await refused.held, false);
  assert.equal(await refused.ended, 75);
  const waiting = hold(5);
  first.child.stdin.end();
  assert.equal(await first.ended, 0);
  assert.equal(await waiting.held, true, 'the lock passes on once its holder ends');
  waiting.child.stdin.end();
  assert.equal(await waiting.ended, 0);
});
