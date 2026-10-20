process.env.TZ = 'UTC';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { fixture, answer, context } from '../native/test/durable-fixture.mjs';
import { durableArchiveRows, loadDurableArchive, readDurableArchive, snapshotDurableArchive } from '../native/durable-archive.mjs';
import { readUsageHistory } from '../native/usage-history.mjs';
import { gather, here, sizes } from '../../../system/memory.mjs';
import { importManifestPath } from '../../../system/memory-imports.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const encode = rows => rows.map(JSON.stringify).join('\n') + '\n';
const tokens = { input: 11, output: 3, cacheRead: 7, cacheWrite: 5 };
const settingsManager = () => SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1024 }, retry: { enabled: false } });
const response = model => ({ ...answer(model), provider: 'fixture', model: 'actual', usage: { ...tokens, cacheWrite1h: 2, totalTokens: 26, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
async function world(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'memory-durable-synthetic-'));
  const prefix = join(home, '.imperfect'), dir = join(prefix, 'memory');
  const sessionDir = join(prefix, 'data/state/sessions'), agentDir = join(home, '.pi/agent');
  await mkdir(sessionDir, { recursive: true });
  // Exercise the installed remote command contract without SSH or another host.
  await symlink(repo, join(home, 'imperfect'));
  const oldPath = join(sessionDir, 'legacy.jsonl');
  if (options.legacy) await writeFile(oldPath, options.legacy, { mode: 0o600 });
  const f = await fixture(t, { dir: home, cwd: '/home/noah/imperfect', sessionDir, agentDir, ...(options.legacy ? { sessionPath: oldPath } : {}), respond: response, serviceOptions: { settingsManager: settingsManager() } });
  t.after(() => rm(home, { recursive: true, force: true }));
  if (options.legacy) await f.runtime.session().conversation.configure({ model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' } }, context);
  const commands = [], errors = [], shell = here({ ...process.env, HOME: home, PATH: `${dirname(process.execPath)}:${process.env.PATH}` });
  const run = (command, into) => { commands.push(command); return shell(command, into); };
  const collect = (local = true, extra = {}) => gather({ prefix, dir, home, from: [{ name: local ? 'desktop' : 'laptop', run, local }], now: Date.now(), log: text => errors.push(text), ...extra });
  const usageOptions = { home, agentDir, sessionDir, memoryDir: dir, owner: 'desktop', models: [{ provider: 'fixture', id: 'actual', cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }], cacheFile: join(home, 'usage-cache.json') };
  return { ...f, home, prefix, dir, sessionDir, agentDir, oldPath, collect, commands, errors, usageOptions, path: f.runtime.snapshot().sessionFile };
}
const prompt = async (w, text, requestId = text) => { await w.runtime.command({ type: 'prompt', text, requestId }); await w.idle(); };
const done = async w => Object.values(JSON.parse(await readFile(join(w.dir, '.done.json'), 'utf8')));

test('new Durable admission -> WAL snapshot -> memory/recall views and cached usage, each mirrored response once', async t => {
  const w = await world(t);
  await prompt(w, 'Synthetic durable memory request');
  await prompt(w, 'Synthetic durable memory request'); // the same durable receipt
  const first = await w.collect();
  assert.deepEqual([first.sessions, first.live, first.taken], [1, 1, 1]);
  assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /Synthetic durable memory request/);
  let h = await readUsageHistory(w.usageOptions);
  assert.equal(h.responses, 1); assert.deepEqual(h.tokens, tokens);
  assert.equal(h.models[0].key, 'fixture/actual'); assert.equal(h.historyCoverage.complete, true);
  const main = await readFile(w.path), mainInfo = await stat(w.path);
  assert.ok((await stat(`${w.path}-wal`)).size > 0);
  await prompt(w, 'A second committed WAL-only request');
  assert.equal((await stat(w.path)).mtimeMs, mainInfo.mtimeMs, 'a WAL commit does not touch the main database');
  assert.deepEqual(await readFile(w.path), main);
  h = await readUsageHistory(w.usageOptions);
  assert.equal(h.responses, 2, 'private usage cache invalidates on WAL-only changes');
  assert.deepEqual(h.tokens, Object.fromEntries(Object.entries(tokens).map(([k, n]) => [k, n * 2])));
  const second = await w.collect();
  assert.equal(second.taken, 1, 'memory cache also invalidates on WAL-only changes');
  assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /A second committed WAL-only request/);
  const entry = (await done(w)).find(e => e.raw.endsWith('.sqlite.gz'));
  const raw = join(w.dir, entry.raw);
  const rawBytes = gunzipSync(await readFile(raw));
  assert.equal(rawBytes.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await sizes({ dir: w.dir })).computers.desktop.rawBytes, rawBytes.length, 'sizes counts the completed snapshot, not just the stale main file');
  assert.equal((await stat(raw)).mode & 0o777, 0o600);
  assert.equal((await loadDurableArchive(raw)).entries.filter(e => e.kind === 'pi.assistant').length, 2);
  await copyFile(raw, join(dirname(raw), 'mirror.sqlite.gz'));
  await snapshotDurableArchive(w.path, join(w.sessionDir, 'native-mirror.sqlite'));
  assert.equal((await readUsageHistory(w.usageOptions)).responses, 2);
  assert.equal((await w.collect()).sessions, 1, 'snapshot copies do not count twice');
  assert.deepEqual(await readFile(w.path), main, 'collectors never checkpoint or rewrite the source');
  assert.deepEqual(w.errors, []);
  await w.runtime.close();
  await rm(w.sessionDir, { recursive: true });
  assert.equal((await w.collect(true, { from: [] })).sessions, 1, 'raw snapshots reconstruct memory without native files');
  assert.equal((await readUsageHistory(w.usageOptions)).responses, 2);
  const index = join(w.dir, '.done.json');
  await writeFile(index, '{broken');
  await assert.rejects(w.collect(true, { from: [] }), SyntaxError, 'a corrupt index cannot silently erase import provenance');
  assert.equal(await readFile(index, 'utf8'), '{broken');
  assert.equal((await readUsageHistory(w.usageOptions)).historyCoverage.complete, false);
});

test('remote collection streams a completed SQLite backup even while WAL is hot, with source bytes untouched', async t => {
  const w = await world(t);
  await prompt(w, 'Remote synthetic continuation');
  const main = await readFile(w.path), wal = await readFile(`${w.path}-wal`);
  const result = await w.collect(false);
  assert.deepEqual([result.taken, result.live, result.sessions], [1, 0, 1], w.errors.join('\n'));
  assert.ok(w.commands.some(c => c.includes('durable-archive.mjs') && c.includes(' snapshot ')));
  assert.ok(!w.commands.some(c => c.startsWith('gzip ') && c.includes('.sqlite')));
  assert.deepEqual(await readFile(w.path), main); assert.deepEqual(await readFile(`${w.path}-wal`), wal);
  assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /· laptop · pi /);
  let h = await readUsageHistory(w.usageOptions);
  assert.equal(h.responses, 1); assert.equal(h.devices[0].key, 'laptop');
  assert.equal((await readUsageHistory({ ...w.usageOptions, thisComputerOnly: true })).responses, 1, 'native-only scope excludes remote mirrors, not its local evidence');
  await prompt(w, 'Remote appended work');
  assert.equal((await w.collect(false)).taken, 1);
  h = await readUsageHistory(w.usageOptions); assert.equal(h.responses, 2);
  assert.deepEqual(w.errors, []);
});

const legacy = () => {
  const at = Date.now() - 3600_000;
  const m = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp: new Date(at).toISOString(), message: role === 'assistant' ? { ...response({ api: 'fixture' }), timestamp: at, content: [{ type: 'text', text }] } : { role, content: text, timestamp: at } });
  return encode([{ type: 'session', version: 3, id: 'legacy-session', cwd: '/home/noah/imperfect', timestamp: new Date(at).toISOString() },
    m('u1', null, 'user', 'Historical selected request'), m('a1', 'u1', 'assistant', 'Historical answer'),
    m('discard', 'a1', 'user', 'ABANDONED alternative'), m('failed', 'discard', 'assistant', 'Abandoned billed response'),
    { type: 'compaction', id: 'compact', parentId: 'a1', timestamp: new Date(at).toISOString(), firstKeptEntryId: 'u1', summary: 'Selected checkpoint' },
    { type: 'context_edit', id: 'omit', parentId: 'compact', timestamp: new Date(at).toISOString(), targetId: 'a1', replacement: null }]);
};

test('legacy originals, imported context and sidecars: one active narrative; failed/abandoned/omitted responses still billed once', async t => {
  const original = legacy(), w = await world(t, { legacy: original });
  await prompt(w, 'New SQLite continuation');
  assert.equal(await readFile(w.oldPath, 'utf8'), original);
  const archive = readDurableArchive(w.path);
  assert.equal(archive.entries.find(e => e.kind === 'imperfect.legacy').data.source, original);
  assert.ok(durableArchiveRows(archive).some(r => r.id === 'failed'));
  assert.ok(!durableArchiveRows(archive, { activeBranch: true }).some(r => r.id === 'discard'));
  const result = await w.collect();
  assert.equal(result.sessions, 1);
  const recent = await readFile(join(w.dir, 'recent.md'), 'utf8');
  assert.match(recent, /Historical selected request/); assert.match(recent, /New SQLite continuation/);
  assert.doesNotMatch(recent, /ABANDONED/);
  const h = await readUsageHistory(w.usageOptions);
  assert.equal(h.responses, 3, 'two historical responses (including abandoned/omitted) plus one new response');
  assert.deepEqual(h.tokens, Object.fromEntries(Object.entries(tokens).map(([k, n]) => [k, n * 3])));
  assert.equal(h.historyCoverage.complete, true);
  assert.equal(await readFile(w.oldPath, 'utf8'), original);
  assert.deepEqual(w.errors, []);
});

test('validated memory-import cutoff survives Durable conversion, remote snapshots and original/manifest removal without duplicate exchanges', async t => {
  const original = legacy(), w = await world(t, { legacy: original });
  const recordCount = original.trim().split('\n').length;
  const provenance = { version: 1, path: w.oldPath, machine: 'laptop', originalPath: '/home/noah/.pi/agent/sessions/original.jsonl', recordCount,
    byteCutoff: Buffer.byteLength(original), originalHash: sha(original), importedHash: sha(original), importedAt: new Date().toISOString() };
  const manifest = importManifestPath(w.dir, w.oldPath);
  await mkdir(dirname(manifest), { recursive: true, mode: 0o700 });
  await writeFile(manifest, JSON.stringify(provenance), { mode: 0o600 });
  const raw = join(w.dir, 'raw/laptop/pi/original.jsonl.gz');
  await mkdir(dirname(raw), { recursive: true }); await writeFile(raw, gzipSync(original));
  await prompt(w, 'Only the new desktop continuation');
  const result = await w.collect(); assert.equal(result.sessions, 2);
  const text = await readFile(join(w.dir, 'recent.md'), 'utf8');
  assert.equal(text.match(/^> Historical selected request$/gm)?.length, 1);
  assert.equal(text.match(/^> Only the new desktop continuation$/gm)?.length, 1);
  let h = await readUsageHistory(w.usageOptions);
  assert.equal(h.responses, 3);
  assert.deepEqual(h.devices.map(d => [d.key, d.responses]), [['desktop', 1], ['laptop', 2]]);
  // The remote command reads the source machine's manifest, not ours by accident.
  await w.collect(false);
  assert.ok(w.commands.some(c => c.includes('readMemoryImport')));
  await rm(manifest);
  await prompt(w, 'Further desktop work after the native manifest was removed');
  assert.equal((await w.collect()).sessions, 2, 'the validated archive cutoff cannot be forgotten');
  h = await readUsageHistory(w.usageOptions); assert.equal(h.responses, 4);
  assert.equal((await readUsageHistory({ ...w.usageOptions, thisComputerOnly: true })).responses, 2, 'native-only provenance also survives manifest removal');
  await w.runtime.close(); await rm(w.sessionDir, { recursive: true });
  const rebuilt = await w.collect(true, { from: [] });
  assert.equal(rebuilt.sessions, 2, 'canonical original plus one Durable continuation, not one session per snapshot/mirror');
  h = await readUsageHistory(w.usageOptions); assert.equal(h.responses, 4);
  assert.deepEqual(w.errors, []);
});

test('Durable compaction keeps raw turns and all cache categories; non-response ledger usage is explicitly undated/incomplete in fresh and cached reads', async t => {
  const w = await world(t);
  for (let i = 0; i < 3; i++) await prompt(w, `Raw pre-compaction experience ${i}: ${'context '.repeat(200)}`);
  const task = await w.runtime.session().conversation.compact(undefined, context);
  await w.runtime.session().harness.waitForTask(task, context);
  const a = readDurableArchive(w.path);
  assert.ok(a.entries.some(e => e.kind === 'pi.compaction'));
  assert.equal(a.entries.filter(e => e.kind === 'pi.assistant').length, 3);
  for (let n = 0; n < 2; n++) {
    const h = await readUsageHistory(w.usageOptions);
    assert.deepEqual(h.tokens, Object.fromEntries(Object.entries(tokens).map(([k, n]) => [k, n * 4])));
    assert.equal(h.undatedResponses, 1); assert.equal(h.historyCoverage.complete, false); assert.equal(h.estimate.partial, true);
    assert.equal(h.days.find(d => d.key === 'unknown').tokens.cacheWrite, tokens.cacheWrite);
    assert.ok(Math.abs(h.estimatedUSD - 0.0001018) < 1e-12, 'one-hour cache-write residuals retain their recorded split');
  }
  await w.collect();
  assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /Raw pre-compaction experience 0/);
  assert.equal((await readUsageHistory(w.usageOptions)).tokens.input, tokens.input * 4, 'raw mirrors do not duplicate ledger residuals');
  assert.deepEqual(w.errors, []);
});

test('Durable worker responses replace unreliable/summed runner totals, including mirrored worker archives', async t => {
  const w = await world(t);
  await prompt(w, 'Synthetic worker work');
  const worker = join(w.agentDir, 'subagents/parent/worker');
  await mkdir(join(worker, 'session'), { recursive: true });
  await snapshotDurableArchive(w.path, join(worker, 'session/worker.sqlite'));
  await w.runtime.close(); await rm(w.sessionDir, { recursive: true });
  await writeFile(join(worker, 'state.json'), JSON.stringify({ engine: 'pi', runtime: 'durable-1.2.0', endedAt: new Date().toISOString() }));
  await writeFile(join(worker, 'result.json'), JSON.stringify({ usageReliable: true, models: { actual: { provider: 'fixture', ...tokens } } }));
  const mirrorDir = join(w.dir, 'raw/laptop/archives'); await mkdir(mirrorDir, { recursive: true });
  await writeFile(join(mirrorDir, 'worker.sqlite.gz'), gzipSync(await readFile(join(worker, 'session/worker.sqlite'))));
  await writeFile(join(mirrorDir, 'manifest.json'), JSON.stringify({ files: [{ path: 'worker.sqlite.gz', harness: 'pi-worker' }] }));
  const h = await readUsageHistory(w.usageOptions);
  assert.equal(h.responses, 1); assert.deepEqual(h.tokens, tokens);
  assert.equal(h.dayAgents[0].harness, 'workers'); assert.equal(h.historyCoverage.complete, true);
  await rm(join(worker, 'session/worker.sqlite'));
  const mirroredOnly = await readUsageHistory(w.usageOptions);
  assert.equal(mirroredOnly.responses, 1, 'retained runner totals cannot duplicate an archived worker after native deletion');
  assert.equal(mirroredOnly.historyCoverage.complete, false, 'without the private source, runner coverage cannot be proved');
});

test('bad Durable import provenance fails closed in memory and usage, never silently re-counting its original prefix', async t => {
  const original = legacy(), w = await world(t, { legacy: original });
  await prompt(w, 'New work after imported prefix');
  const manifest = importManifestPath(w.dir, w.oldPath);
  await mkdir(dirname(manifest), { recursive: true, mode: 0o700 });
  await writeFile(manifest, JSON.stringify({ broken: true }), { mode: 0o600 });
  assert.equal((await w.collect()).sessions, 0);
  assert.ok(w.errors.some(e => e.includes('memory import:')));
  const h = await readUsageHistory(w.usageOptions);
  assert.equal(h.responses, 0); assert.equal(h.historyCoverage.complete, false); assert.equal(h.unreadableFiles, 2);
});
