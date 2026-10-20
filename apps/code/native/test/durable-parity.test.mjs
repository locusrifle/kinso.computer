import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent';
import { Subagents, claim } from '../subagent.mjs';
import { runWorker } from '../subagent-runner.mjs';
import { openSessionFile } from '../durable-session.mjs';
import { createTabHost } from '../tabs.mjs';
import { activationCheck, armRollbackGuard, exportHistory } from '../../../../tools/pi-durable-transition.mjs';
import { fixture, answer, until, context } from './durable-fixture.mjs';
const exec = promisify(execFile);
const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'durable-parity-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const settings = more => SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', compaction: { enabled: false }, retry: { enabled: false }, ...more });

for (const name of ['read', 'bash']) test(`${name} completed ordinary failure does not approval-block a read/test loop, without declaring bash replay safe`, async t => {
  const { runtime: r, idle, seen } = await fixture(t, { respond: (model, _request, n) => n === 1 ? answer(model, [{ type: 'toolCall', id: 'failed', name, arguments: name === 'read' ? { path: 'absent.txt' } : { command: 'exit 1' } }], 'toolUse') : answer(model) });
  await r.command({ type: 'prompt', text: 'inspect and run tests' }); await idle();
  assert.equal(seen.length, 2); assert.equal(r.snapshot().ui.dialogs.length, 0);
  assert.equal(r.snapshot().messages.find(m => m.toolName === name).isError, true);
  assert.equal((await r.session().conversation.agent(context)).tools.find(t => t.name === name).replay, name === 'read' ? 'safe' : undefined);
});

test('current GUI resources: AGENTS, SYSTEM/APPEND, configured and package templates, settings, selected tools and diagnostics survive', async t => {
  const dir = await temp(t), agent = join(dir, 'agent'), project = join(dir, '.pi'), pkg = join(agent, 'prompt-package');
  await Promise.all([mkdir(join(agent, 'prompts'), { recursive: true }), mkdir(project), mkdir(join(pkg, 'prompts'), { recursive: true })]);
  await writeFile(join(dir, 'AGENTS.md'), 'Keep the project instruction.');
  await writeFile(join(project, 'SYSTEM.md'), 'Custom system instruction.');
  await writeFile(join(project, 'APPEND_SYSTEM.md'), 'Additional project instruction.');
  await writeFile(join(agent, 'prompts', 'inspect.md'), 'Inspect ${1:-correctness}. $@');
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'prompt-only', pi: { prompts: ['./prompts/*.md'] } }));
  await writeFile(join(pkg, 'prompts', 'package-review.md'), 'Package template $1');
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', packages: ['./prompt-package'], defaultTools: ['read', 'grep', 'find', 'ls'], retry: { enabled: false }, compaction: { enabled: false } }));
  const { runtime: r, idle, seen } = await fixture(t, { dir, serviceOptions: { settingsManager: SettingsManager.create(dir, agent), resourceLoaderOptions: {} } });
  await r.command({ type: 'prompt', text: '/inspect "API compatibility"' }); await idle();
  const request = JSON.stringify(seen[0]);
  for (const text of ['Keep the project instruction.', 'Custom system instruction.', 'Additional project instruction.', 'Inspect API compatibility. API compatibility']) assert.ok(request.includes(text), text);
  assert.deepEqual((await r.session().conversation.agent(context)).tools.filter(t => !['AskUserQuestion', 'subagent'].includes(t.name)).map(t => t.name).sort(), ['find', 'grep', 'ls', 'read']);
  assert.match(JSON.stringify(r.snapshot().startup), /package-review/);
  await r.command({ type: 'prompt', text: '/package-review locks' }); await idle(); assert.match(JSON.stringify(seen.at(-1)), /Package template locks/);
  assert.ok(r.snapshot().startup.sections.some(s => s.name === 'Context'));
});

test('only actually enabled classic extensions refuse startup; excluded files and prompts-only packages do not', async t => {
  const dir = await temp(t), agent = join(dir, 'agent'); await mkdir(join(agent, 'extensions'), { recursive: true });
  const extension = join(agent, 'extensions', 'do-not-execute.js');
  await writeFile(extension, 'throw new Error("CLASSIC EXTENSION EXECUTED"); export default function() {}');
  const options = { dir, serviceOptions: { settingsManager: settings({ extensions: [`-${extension}`] }), resourceLoaderOptions: {} } };
  const permitted = await fixture(t, options); await permitted.runtime.close();
  await assert.rejects(fixture(t, { dir, serviceOptions: { settingsManager: settings(), resourceLoaderOptions: {} } }), /extensions need a Durable port/);
  await assert.rejects(fixture(t, { dir, serviceOptions: { settingsManager: settings(), resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: [extension] } } }), /extensions need a Durable port/);
  await assert.rejects(fixture(t, { dir, serviceOptions: { settingsManager: settings({ packages: ['./missing-package'] }) } }), /no automatic installs/);
  const pkg = join(agent, 'filtered-package'); await mkdir(join(pkg, 'prompts'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'filtered', pi: { extensions: ['./extension.js'], prompts: ['./prompts/*.md'] } }));
  await writeFile(join(pkg, 'extension.js'), 'throw new Error("MUST NOT EXECUTE");'); await writeFile(join(pkg, 'prompts', 'filtered.md'), 'Filtered package prompt');
  const filtered = await fixture(t, { dir, serviceOptions: { settingsManager: settings({ extensions: [`-${extension}`], packages: [{ source: './filtered-package', extensions: [] }] }), resourceLoaderOptions: {} } });
  assert.match(JSON.stringify(filtered.runtime.snapshot().startup), /filtered/);
});

test('blockImages is request-local; recorded attachments and token/cache stats are not dropped', async t => {
  const image = { type: 'image', data: 'AAEC', mimeType: 'image/png' };
  const { runtime: r, idle, seen } = await fixture(t, { serviceOptions: { settingsManager: settings({ images: { blockImages: true } }) }, respond: model => ({ ...answer(model), usage: { input: 3, output: 2, cacheRead: 7, cacheWrite: 0, totalTokens: 12, cost: { total: 1 } } }) });
  await r.command({ type: 'prompt', text: 'attached', images: [image] }); await idle();
  assert.ok(!JSON.stringify(seen[0]).includes('AAEC')); assert.match(JSON.stringify(seen[0]), /Image reading is disabled/);
  assert.deepEqual(r.snapshot().messages[0].content[1], image);
  const stats = r.snapshot().stats; assert.equal(stats.tokens.total, 12); assert.equal(stats.tokens.totalTokens, 12); assert.equal(stats.cost, 1); assert.equal(stats.cacheHitRate, 70); assert.equal(stats.contextUsage.tokens, 12);
});

test('legacy metered attempts and summary usage remain counted; context after compaction stays unknown until a fresh answer', async t => {
  const dir = await temp(t), sm = SessionManager.create(dir, join(dir, 'legacy'));
  const model = { api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6.1-sol' }, message = answer(model);
  const user = sm.appendMessage({ role: 'user', content: 'legacy context', timestamp: 1 });
  sm.appendMessage({ ...message, stopReason: 'error', errorMessage: 'recorded failed attempt' }); sm.appendMessage(message);
  sm.appendUsage('cache_warm', model.provider, model.id, message.usage);
  sm.appendCompaction('legacy summary', user, 4, undefined, false, message.usage);
  const { runtime: r, idle } = await fixture(t, { dir, sessionPath: sm.getSessionFile(), serviceOptions: { settingsManager: settings({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1024 } }) } });
  assert.equal(r.snapshot().stats.tokens.total, 8); assert.equal(r.snapshot().stats.contextUsage.tokens, null);
  await r.command({ type: 'prompt', text: 'continue' }); await idle(); assert.equal(r.snapshot().stats.tokens.total, 10); assert.equal(r.snapshot().stats.contextUsage.tokens, 2);
  const task = await r.session().conversation.compact(undefined, context); await r.session().harness.waitForTask(task, context); await idle(); assert.equal(r.snapshot().stats.tokens.total, 12); assert.equal(r.snapshot().stats.contextUsage.tokens, null);
});

test('already-reviewed legacy completions seed receipts; old-root CLI tasks are observed, never relaunched, and unfinished reviews wake once', async t => {
  const dir = await temp(t), oldRoot = join(dir, 'old-root'), newRoot = join(dir, 'new-root');
  const sm = SessionManager.create(dir, join(dir, 'old-sessions')), owner = sm.getSessionId();
  const old = new Subagents({ root: oldRoot, owner, agentDir: join(dir, 'agent'), launch: async () => {} });
  const reviewed = old.start({ task: 'old reviewed task', cwd: dir }), unreviewed = old.start({ task: 'old interrupted review', cwd: dir }), running = old.start({ task: 'old active CLI', cwd: dir });
  for (const task of [reviewed, unreviewed]) { old.fail(task, 'fixture complete'); old.save({ ...old.read(task.id), runtime: undefined }); }
  old.save({ ...running, runtime: undefined, status: 'running', startedAt: new Date(Date.now() - 20000).toISOString() });
  sm.appendMessage({ role: 'user', content: 'original work', timestamp: 1 });
  sm.appendCustomMessageEntry('subagent-completion', 'review this one', true, { owner, ids: [reviewed.id] });
  sm.appendMessage(answer({ api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6.1-sol' }));
  sm.appendCustomMessageEntry('subagent-completion', 'interrupted review', true, { owner, ids: [unreviewed.id] });
  const source = await readFile(sm.getSessionFile()); let launches = 0, probes = 0;
  const opts = { dir, sessionPath: sm.getSessionFile(), serviceOptions: { subagentOptions: { taskRoot: newRoot, legacyRoots: [oldRoot], launch: async () => { launches++; }, control: async () => { probes++; return 'active'; }, coalesceMs: 5 } } };
  const { runtime: r, idle, seen } = await fixture(t, opts);
  await until(() => seen.length === 1); await idle(); await until(() => probes > 0);
  assert.equal(launches, 0); assert.equal(old.read(running.id).status, 'running');
  assert.deepEqual(r.background(), [`subagent ${running.id}`]);
  const receipt = await r.session().conversation.commit(tx => tx.submissionByRequest(1, `worker:${owner}:${reviewed.id}`), context);
  assert.equal(receipt.reason, 'legacy-reviewed');
  const entries = (await r.session().conversation.entries({}, 100, undefined, context)).items.filter(e => e.kind === 'imperfect.worker-completion');
  assert.deepEqual(entries.map(e => e.data.id), [unreviewed.id]);
  assert.deepEqual(await readFile(sm.getSessionFile()), source);
  for (const task of [running, { ...running, status: 'pending' }]) {
    old.save({ ...task, runtime: undefined }); let requested = false;
    assert.equal(await runWorker(task.path, { makeModels: async () => { requested = true; } }), null); assert.equal(requested, false);
  }
  const history = r.snapshot().sessionFile; await r.close();
  const reopened = await fixture(t, { ...opts, sessionPath: history }); await new Promise(r => setTimeout(r, 50)); await reopened.idle(); assert.equal(reopened.seen.length, 0);
});

test('an unavailable systemd bus and an activating unit are not evidence that an adopted worker died', async t => {
  const dir = await temp(t); let state = 'unknown';
  const m = new Subagents({ root: join(dir, 'tasks'), owner: 'parent', agentDir: join(dir, 'agent'), launch: async () => {}, control: async (_cmd, args) => { if (args.includes('stop') || state === 'unknown') throw new Error('bus unavailable'); return state; } });
  const task = m.start({ task: 'observe original unit', cwd: dir }); m.save({ ...task, runtime: undefined, status: 'running', startedAt: new Date(Date.now() - 20000).toISOString() });
  assert.equal(claim(task.path, 'legacy-runner'), true);
  await m.reconcile(); assert.equal(m.read(task.id).status, 'running');
  await assert.rejects(m.cancel(task.id), /bus unavailable/); assert.equal(m.read(task.id).status, 'running');
  state = 'activating'; await m.reconcile(); assert.equal(m.read(task.id).status, 'running');
  state = 'inactive'; await m.reconcile(); assert.equal(m.read(task.id).status, 'failed');
});

test('Pi handoff keeps held input on disk until admission, and retries a lost acknowledgement using the same receipt', async t => {
  const { runtime: r, dir, idle, seen } = await fixture(t);
  const stateDir = join(dir, 'tabs'), image = { type: 'image', mimeType: 'image/png', data: 'AAEC' };
  const command = r.command; let lost = false;
  r.command = async c => {
    if (c.type !== 'prompt') return command(c);
    assert.equal(JSON.parse(await readFile(join(stateDir, 'open-tabs.json')))[0].held[0].id, 'held');
    const ack = await command(c);
    assert.equal(JSON.parse(await readFile(join(stateDir, 'open-tabs.json')))[0].held[0].id, 'held');
    if (!lost) { lost = true; throw new Error('acknowledgement lost after commit'); }
    return ack;
  };
  const host = await createTabHost({ stateDir, createRuntime: async () => r, listPiSessions: async () => [], checkUpdates: false }); t.after(() => host.close());
  host.requestQuiesce(); await host.command({ type: 'prompt', requestId: 'held', text: 'kept input', images: [image] });
  await host.resumeDelivery(); assert.equal(host.snapshot().queue.items.at(-1).id, 'held');
  await host.resumeDelivery(); await idle();
  assert.equal(seen.length, 1); assert.equal(r.snapshot().messages.filter(m => m.role === 'user').length, 1); assert.equal(host.snapshot().queue.items.length, 0);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'open-tabs.json')))[0].held, undefined);
});

test('original JSONL and not-yet-created sidecar coalesce into one tab during import', async t => {
  const dir = await temp(t), sm = SessionManager.create(dir, join(dir, 'legacy'));
  sm.appendMessage({ role: 'user', content: 'original context', timestamp: 1 }); sm.appendMessage(answer({ api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6.1-sol' }));
  const original = sm.getSessionFile(), sidecar = `${original}.durable.sqlite`; let creates = 0;
  const host = await createTabHost({ stateDir: join(dir, 'tabs'), createRuntime: async options => { creates++; return (await fixture(t, { dir, sessionPath: options.sessionPath })).runtime; }, listPiSessions: async () => [], checkUpdates: false }); t.after(() => host.close());
  const [a, b] = await Promise.all([host.command({ type: 'tab-open', agent: 'pi', path: original }), host.command({ type: 'tab-open', agent: 'pi', path: sidecar })]);
  assert.equal(a.id, b.id); assert.equal(creates, 2); assert.equal(host.snapshot().sessionFile, sidecar);
});

test('worker activation check is read-only and blocks unsettled legacy metadata in either root', async t => {
  const dir = await temp(t), root = join(dir, 'prefix', 'subagents'), agentDir = join(dir, 'agent');
  const old = new Subagents({ root, owner: 'parent', agentDir, launch: async () => {} });
  const task = old.start({ task: 'old task', cwd: dir }); old.save({ ...task, runtime: undefined });
  const before = await readFile(join(task.path, 'state.json'));
  const check = await activationCheck({ prefix: join(dir, 'prefix'), agentDir });
  assert.equal(check.ready, false); assert.equal(check.blockers[0].id, task.id);
  assert.deepEqual(await readFile(join(task.path, 'state.json')), before);
  old.fail(task, 'fixture finished'); assert.equal((await activationCheck({ prefix: join(dir, 'prefix'), agentDir })).ready, true);
});

test('kernel ownership serializes simultaneous stale-file takeover and aliases, and release is idempotent', async t => {
  const dir = await temp(t);
  const module = new URL('../durable-session.mjs', import.meta.url).href;
  // Use identical prechosen new filenames by making sessionPath point to one
  // initialized store; the two contenders both see the same stale .owner.
  const f = await fixture(t, { dir }); const history = f.runtime.snapshot().sessionFile; await f.runtime.close();
  await writeFile(`${history}.owner`, JSON.stringify({ pid: 2147483647, boot: 'old', started: '0' }));
  const contend = `import {openSessionFile} from ${JSON.stringify(module)};try { const f=await openSessionFile({cwd:${JSON.stringify(dir)},agentDir:${JSON.stringify(dir)},sessionPath:${JSON.stringify(history)}});process.send({held:true});process.on('message',async()=>{await f.storage.close();await f.release();await f.release();process.exit(0)}); }catch(e){process.send({error:e.message});process.exit(0)}`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', contend], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }));
  t.after(() => children.forEach(c => c.kill()));
  const results = await Promise.all(children.map(c => new Promise((resolve, reject) => { c.once('message', resolve); c.once('error', reject); })));
  assert.equal(results.filter(r => r.held).length, 1); assert.match(results.find(r => r.error).error, /already has a writer/);
  await symlink(history, join(dir, 'alias.sqlite'));
  await assert.rejects(openSessionFile({ cwd: dir, agentDir: dir, sessionPath: join(dir, 'alias.sqlite') }), /already has a writer/);
  const winner = children[results.findIndex(r => r.held)]; const exited = new Promise(r => winner.once('exit', r)); winner.send('release'); await exited;
  const final = await openSessionFile({ cwd: dir, agentDir: dir, sessionPath: history }); await final.storage.close(); await final.release();
  const hard = join(dir, 'hard.sqlite'); await link(history, hard);
  await assert.rejects(openSessionFile({ cwd: dir, agentDir: dir, sessionPath: hard }), /Hard-linked Pi histories/);
});

test('an out-of-checkout guard refuses stale-runtime rollback; WAL-aware export preserves continuation privately without a model call', async t => {
  const dir = await temp(t), repo = join(dir, 'repo'); await mkdir(join(repo, 'apps/code/native'), { recursive: true });
  await writeFile(join(repo, 'package.json'), JSON.stringify({ dependencies: { '@earendil-works/pi-durable': '1.2.0' } }));
  const runtime = join(repo, 'apps/code/native/runtime.mjs'); await writeFile(runtime, "export const PI_HISTORY_FORMAT = 'durable-sqlite-v1';");
  const { guard, dropin } = await armRollbackGuard({ repo, prefix: join(dir, 'prefix'), unitDir: join(dir, 'units') });
  await exec(process.execPath, [guard]); await writeFile(runtime, '// old AgentSession resumes unchanged JSONL');
  await assert.rejects(exec(process.execPath, [guard]), e => /rollback refused/.test(e.stderr)); assert.match(await readFile(dropin, 'utf8'), /ExecStartPre=/);
  const { runtime: r, idle, seen } = await fixture(t, { dir }); await r.command({ type: 'prompt', requestId: 'exported', text: 'post migration continuation' }); await idle();
  const out = join(dir, 'reconcile.json'), exported = await exportHistory({ history: r.snapshot().sessionFile, out });
  assert.equal(seen.length, 1); assert.match(await readFile(out, 'utf8'), /post migration continuation/); assert.equal((await stat(exported.snapshot)).mode & 0o777, 0o600);
  await assert.rejects(exportHistory({ history: r.snapshot().sessionFile, out }), /EEXIST/);
  const restored = await fixture(t, { dir, sessionPath: exported.snapshot });
  const ack = await restored.runtime.command({ type: 'prompt', requestId: 'exported', text: 'post migration continuation' }); assert.equal(ack.duplicate, true); assert.equal(restored.seen.length, 0);
});
