import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, answer, context } from './durable-fixture.mjs';
import { SessionInfo } from '../durable-session.mjs';
import { loadDurableArchive, readDurableArchive, snapshotDurableArchive } from '../durable-archive.mjs';
import { readUsageHistory, usageRecord } from '../usage-history.mjs';

const options = f => ({ home: f.dir, agentDir: join(f.dir, 'agent'), sessionDir: join(f.dir, 'sessions'), owner: 'synthetic', cacheFile: join(f.dir, 'usage.json') });
const at = Date.parse('2026-10-01T00:00:00Z');

test('actual response models and provider response IDs survive different entry IDs and native/Durable mirrors', async t => {
  const f = await fixture(t, { respond: model => ({ ...answer(model), responseModel: 'physical-answer', responseId: 'synthetic-response-id' }) });
  for (let i = 0; i < 2; i++) { await f.runtime.command({ type: 'prompt', text: `synthetic ${i}` }); await f.idle(); }
  const path = f.runtime.snapshot().sessionFile;
  await snapshotDurableArchive(path, join(f.dir, 'sessions/copy.sqlite'));
  const h = await readUsageHistory(options(f));
  assert.equal(h.responses, 1, 'a repeated provider response is not a second billed response');
  assert.equal(h.models[0].key, 'openai-codex/physical-answer');
  assert.equal(h.undatedResponses, 0, 'ledger subtraction uses recorded model, not its physical alias');
  assert.equal(h.historyCoverage.complete, true);
});

test('missing Durable usage categories remain unknown/incomplete, including cached reads; harness notes are not human input', async t => {
  const f = await fixture(t);
  const conversation = f.runtime.session().conversation;
  await conversation.commit(async tx => {
    await tx.appendEntry(conversation.id, { kind: 'pi.user', model: [{ role: 'user', content: 'Synthetic input', timestamp: at }] });
    await tx.appendEntry(conversation.id, { kind: 'pi.assistant', model: [{ role: 'assistant', provider: 'fixture', model: 'unknown-usage', content: [], stopReason: 'error', timestamp: at + 1 }] });
    await tx.appendEntry(conversation.id, { kind: 'imperfect.worker-completion', model: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic worker completion, not Noah' }], timestamp: at + 2 }] });
    await tx.appendEntry(conversation.id, { kind: 'pi.reset', head: 'self', model: [{ role: 'user', content: 'Synthetic handoff, not Noah', timestamp: at + 3 }] });
  }, context);
  for (let i = 0; i < 2; i++) {
    const h = await readUsageHistory(options(f));
    assert.equal(h.responses, 1); assert.equal(h.unknownCategories, 4); assert.equal(h.historyCoverage.complete, false); assert.equal(h.estimate.partial, true);
  }
  const { durableArchiveRows } = await import('../durable-archive.mjs');
  const { readPi } = await import('../../../../system/memory.mjs');
  const rows = durableArchiveRows(readDurableArchive(f.runtime.snapshot().sessionFile));
  const memory = await readPi(rows.map(JSON.stringify).join('\n'), undefined, { archive: true });
  assert.deepEqual(memory.entries.map(e => e.text), ['Synthetic input']);
  assert.equal(memory.events.filter(e => e.who === 'note').length, 2);
});

test('legacy auxiliary usage/compaction entries preserve all token categories without inventing model attribution', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-operation-synthetic-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 1 };
  const rows = [{ type: 'usage', id: 'warm', kind: 'arbitrary-operation', provider: 'fixture', model: 'physical', timestamp: at, usage },
    { type: 'compaction', id: 'compact', timestamp: at, usage }, { type: 'branch_summary', id: 'branch', timestamp: at, usage }];
  assert.equal(usageRecord(rows[0], { agent: 'pi' }).model, 'physical');
  const file = join(dir, 'operations.jsonl'); await writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
  const opts = { home: dir, agentDir: join(dir, 'empty'), sessionDir: dir, cacheFile: join(dir, 'usage.json') };
  for (let i = 0; i < 2; i++) {
    const h = await readUsageHistory(opts);
    assert.equal(h.responses, 3); assert.deepEqual(h.tokens, { input: 30, output: 6, cacheRead: 9, cacheWrite: 12 });
    assert.equal(h.models.find(m => m.key === 'unknown/unknown').responses, 2);
    assert.equal(h.malformedRecords, 2); assert.equal(h.historyCoverage.complete, false);
  }
});

test('online backup is transaction-consistent during concurrent commits and retains opaque raw data', async t => {
  const f = await fixture(t), conversation = f.runtime.session().conversation;
  const opaque = { image: 'synthetic-base64-bytes', thinkingSignature: 'opaque-provider-signature', textSignature: 'opaque-text-signature' };
  const write = async n => conversation.commit(async tx => {
    (await tx.doc(SessionInfo, conversation.id)).archiveCounter = n;
    await tx.appendEntry(conversation.id, { kind: 'imperfect.archive-test', data: { n, opaque } });
  }, context);
  await write(1);
  const destination = join(f.dir, 'concurrent.sqlite');
  const writers = (async () => { for (let n = 2; n <= 30; n++) { await write(n); await new Promise(resolve => setImmediate(resolve)); } })();
  await Promise.all([snapshotDurableArchive(f.runtime.snapshot().sessionFile, destination), writers]);
  const archive = await loadDurableArchive(destination);
  const entries = archive.entries.filter(e => e.kind === 'imperfect.archive-test');
  assert.equal(entries.length, archive.info.archiveCounter, 'metadata and entries come from one committed snapshot');
  assert.deepEqual(entries.at(-1).data.opaque, opaque);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  const db = new DatabaseSync(destination, { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); } finally { db.close(); }
});

test('unsupported SQLite archives fail without migration, a writer, or overwriting any destination', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-schema-synthetic-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'foreign.sqlite'), target = join(dir, 'snapshot.sqlite');
  const db = new DatabaseSync(path); db.exec('CREATE TABLE durable_schema (singleton INTEGER, version INTEGER); INSERT INTO durable_schema VALUES (1, 99)'); db.close();
  const original = await readFile(path);
  assert.throws(() => readDurableArchive(path), /Unsupported/);
  await assert.rejects(snapshotDurableArchive(path, target), /Unsupported/);
  await assert.rejects(stat(target), { code: 'ENOENT' });
  await writeFile(target, 'keep my bytes');
  await assert.rejects(snapshotDurableArchive(path, target), { code: 'EEXIST' });
  assert.equal(await readFile(target, 'utf8'), 'keep my bytes'); assert.deepEqual(await readFile(path), original);
});
