import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Subagents, privateJSON, durableSubagents } from '../subagent.mjs';
import { runWorker, subscriptionEnv, subscriptionConfig } from '../subagent-runner.mjs';
import { createRuntime } from '../runtime.mjs';
import { fixture, until, context, answer } from './durable-fixture.mjs';
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'durable-worker-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const manager = (dir, owner = 'parent', extra = {}) => new Subagents({ root: join(dir, 'tasks'), owner, agentDir: dir, launch: async () => {}, ...extra });
const start = (m, cwd, extra = {}) => m.start({ task: 'Inspect assigned files and report', cwd, ...extra });

test('systemd still owns private, bounded, subscription-only workers, never interactive tabs', async t => {
  const dir = await temp(t); let launched;
  const m = manager(dir, 'parent', { launch: async (_cmd, args) => { launched = args; } }), task = start(m, dir);
  await until(() => launched);
  for (const flag of ['--user', '--collect', '--property=UMask=0077', '--property=RuntimeMaxSec=7200', '--property=Restart=on-failure']) assert.ok(launched.includes(flag));
  assert.equal(task.status, 'pending'); assert.equal(task.model.provider, 'openai-codex');
  assert.throws(() => start(m, dir, { model: 'another' }), /Sol only/); assert.throws(() => start(m, dir, { thinking: 'max' }), /thinking/);
  assert.equal(manager(dir, 'other').list().length, 0); await assert.rejects(manager(dir, 'other').cancel(task.id), /ENOENT/);
  for (let n = 0; n < 3; n++) start(m, dir); assert.throws(() => start(m, dir), /four/);
});

test('cancel-before-start claims the worker, and terminal or legacy results remain readable', async t => {
  const dir = await temp(t), calls = [], m = manager(dir, 'parent', { control: async (...args) => { calls.push(args); } }), task = start(m, dir);
  await m.cancel(task.id); let called = false;
  assert.equal(await runWorker(task.path, { makeModels: async () => { called = true; } }), null); assert.equal(called, false); assert.equal(m.result(task.id).status, 'cancelled');
  assert.deepEqual(calls, [['systemctl', ['--user', 'stop', task.unit]]]);
  privateJSON(task.resultPath, { engine: 'claude', status: 'done', output: 'old worker report' }); m.save({ ...task, engine: 'claude', status: 'done' });
  assert.equal(m.result(task.id).engine, 'claude'); assert.equal(m.result(task.id).output, 'old worker report');
});

test('failed launch and lost units never claim unknown model usage was zero', async t => {
  const dir = await temp(t), m = manager(dir, 'parent', { launch: async () => { throw new Error('refused'); } }), task = start(m, dir);
  await until(() => m.read(task.id).status === 'failed'); assert.equal(m.result(task.id).usageReliable, true);
  const lost = start(manager(dir, 'lost'), dir), owner = manager(dir, 'lost', { control: async () => 'inactive' });
  await writeFile(join(lost.path, 'claim'), 'runner'); owner.save({ ...lost, status: 'running', startedAt: new Date(Date.now() - 20000).toISOString() });
  await owner.reconcile(); assert.equal(owner.result(lost.id).usage, null); assert.equal(owner.result(lost.id).usageReliable, false);
});

test('worker strips paid routes and refuses non-OAuth or overridden subscription providers before execution', async t => {
  const env = subscriptionEnv({ OPENAI_API_KEY: 'fixture', OPENAI_BASE_URL: 'invalid', ANTHROPIC_API_KEY: 'fixture', PI_SESSION_ID: 'parent', PATH: '/bin', HOME: '/fixture' }, '/agent');
  assert.equal('OPENAI_API_KEY' in env, false); assert.equal('PI_SESSION_ID' in env, false); assert.equal(env.PI_OFFLINE, '1'); assert.equal(env.IMPERFECT_SUBAGENT, '1');
  const dir = await temp(t), m = manager(dir), task = start(m, dir); let ran = false;
  const result = await runWorker(task.path, { redact: String, makeModels: async () => ({ isUsingSubscription: () => false }), makeRuntime: async () => { ran = true; } });
  assert.equal(ran, false); assert.equal(result.status, 'failed'); assert.match(result.error, /never fall back/);
  await writeFile(join(dir, 'models.json'), JSON.stringify({ providers: { 'openai-codex': {} } })); assert.match(subscriptionConfig(dir), /built-in/);
});

test('the systemd runner executes Durable directly and records a bounded authoritative final result', async t => {
  const dir = await temp(t), m = manager(dir), task = start(m, dir);
  const existing = await fixture(t, { dir });
  const result = await runWorker(task.path, { redact: text => text.replaceAll('ok', 'reviewed'), signals: new EventEmitter(), makeModels: async () => existing.models, makeRuntime: async options => {
    assert.equal(options.serviceOptions.worker, true); assert.equal(options.serviceOptions.settingsManager.getDefaultProvider(), 'openai-codex');
    const worker = await createRuntime(options);
    assert.deepEqual((await worker.session().conversation.agent(context)).tools.map(t => t.name).sort(), ['bash', 'edit', 'read', 'write']);
    return worker;
  } });
  assert.equal(result.status, 'done'); assert.equal(result.output, 'reviewed'); assert.equal(result.model.id, 'gpt-6.1-sol'); assert.equal(result.usageReliable, true);
  assert.equal(m.read(task.id).status, 'done'); assert.equal(JSON.parse(await readFile(task.resultPath)).runtime, 'durable-1.2.0');
});

test('worker accounting names the response model, not only the model requested', async t => {
  const dir = await temp(t), m = manager(dir), task = start(m, dir);
  const existing = await fixture(t, { dir, respond: model => ({ ...answer(model), responseModel: 'gpt-6.1-sol-response' }) });
  const result = await runWorker(task.path, { redact: String, signals: new EventEmitter(), makeModels: async () => existing.models });
  assert.equal(result.status, 'done'); assert.equal(result.model.id, 'gpt-6.1-sol-response');
  assert.equal(result.models['gpt-6.1-sol-response'].input, 1); assert.equal(result.models['gpt-6.1-sol'], undefined);
  assert.equal(result.usageReliable, true);
});

test('worker completion has one durable receipt, including reopen and repeated watcher delivery', async t => {
  const { runtime: r, dir, idle } = await fixture(t), owner = r.snapshot().sessionId;
  const integration = durableSubagents({ root: r.session().conversation, harness: r.session().harness, registry: r.session().registry, owner, cwd: dir, agentDir: join(dir, 'agent'), context, launch: async () => {}, coalesceMs: 10 });
  t.after(() => integration.dispose());
  const task = start(integration.manager, dir);
  privateJSON(task.resultPath, { engine: 'pi', status: 'done', output: 'untrusted worker report' }); integration.manager.save({ ...task, status: 'done' });
  await integration.deliver(); await integration.deliver(); await idle();
  let page = await r.session().conversation.entries({ order: 'ascending' }, 100, undefined, context);
  assert.equal(page.items.filter(e => e.kind === 'imperfect.worker-completion').length, 1);
  const path = r.snapshot().sessionFile; integration.dispose(); await r.close();
  const restored = await fixture(t, { dir, sessionPath: path });
  await new Promise(resolve => setTimeout(resolve, 220)); await restored.idle();
  page = await restored.runtime.session().conversation.entries({ order: 'ascending' }, 100, undefined, context);
  assert.equal(page.items.filter(e => e.kind === 'imperfect.worker-completion').length, 1); assert.equal(restored.seen.length, 0);
});

test('a watch the system refuses (a Mac\'s EMFILE) leaves the machine running; the reconcile carries on', async t => {
  const dir = await temp(t);
  const { execFile } = await import('node:child_process');
  const child = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const real = fs.watch;
    fs.watch = (...args) => { const w = real(...args); if (args[1]?.recursive) setImmediate(() => w.emit('error', Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE', syscall: 'watch' }))); return w; };
    syncBuiltinESMExports();
    const { durableSubagents } = await import(${JSON.stringify(new URL('../subagent.mjs', import.meta.url).href)});
    const integration = durableSubagents({ root: { submit: async () => {} }, registry: { install() {} }, owner: 'parent', cwd: ${JSON.stringify(dir)}, agentDir: ${JSON.stringify(dir)}, launch: async () => {} });
    setTimeout(() => { integration.dispose(); console.log('still running'); }, 300);`;
  const out = await new Promise(resolve => execFile(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, IMPERFECT_PREFIX: dir } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /still running/);
});
