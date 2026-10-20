process.env.TZ = 'UTC';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync, gunzipSync } from 'node:zlib';
import { gather, here, readPi, readClaude } from './memory.mjs';
import { importManifestPath, importedBytes, readMemoryImport } from './memory-imports.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const TIME = '2026-09-30T01:00:00Z', NOW = Date.parse('2026-09-30T04:00:00Z');
const encode = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const header = { type: 'session', version: 3, id: 'same-uuid', cwd: '/home/noah/imperfect', timestamp: TIME };
const message = (id, parentId, role, text, timestamp = TIME) => ({ type: 'message', id, parentId, timestamp,
  message: { role, content: [{ type: 'text', text }], model: 'synthetic-model', stopReason: 'stop' } });
const oldRecords = [header, message('u1', null, 'user', 'Historical synthetic request'), message('a1', 'u1', 'assistant', 'Historical synthetic answer')];
const original = encode(oldRecords);
const derivative = encode([{ ...header, cwd: '/home/vaita/imperfect' }, ...oldRecords.slice(1)]);
const next = encode([message('u2', 'a1', 'user', 'New synthetic PC request'), message('a2', 'u2', 'assistant', 'New synthetic PC answer')]);
const chunks = text => Readable.from(Array.from({ length: Math.ceil(Buffer.byteLength(text) / 7) }, (_, i) => Buffer.from(text).subarray(i * 7, (i + 1) * 7)));

async function world(t) {
  const home = await mkdtemp(join(tmpdir(), 'memory-import-synthetic-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const prefix = join(home, '.imperfect'), dir = join(prefix, 'memory');
  const path = join(prefix, 'data/state/sessions/imported.jsonl');
  await mkdir(dirname(path), { recursive: true });
  await mkdir(join(dir, 'imports'), { recursive: true, mode: 0o700 });
  await writeFile(path, derivative, { mode: 0o600 });
  const entry = { version: 1, path, machine: 'laptop', originalPath: '/home/noah/.imperfect/data/state/sessions/original.jsonl',
    recordCount: oldRecords.length, byteCutoff: Buffer.byteLength(derivative), originalHash: sha(original), importedHash: sha(derivative), importedAt: TIME };
  const manifest = importManifestPath(dir, path);
  const save = async value => { await writeFile(manifest, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); };
  await save(entry);
  const errors = [];
  // Enumerate only these synthetic files. Real shell only gzips synthetic paths.
  const shell = here({ ...process.env, HOME: home });
  // Accurate sizes matter to historical-only fast path.
  const localRun = async (command, into) => {
    if (command.startsWith('git ')) return '';
    if (!command.startsWith('find ')) return shell(command, into);
    const files = (await readdir(dirname(path))).filter(name => name.endsWith('.jsonl'));
    return (await Promise.all(files.map(async name => `${(await readFile(join(dirname(path), name))).length}\t0\t${join(dirname(path), name)}`))).join('\n');
  };
  const gatherHere = (options = {}) => gather({ prefix, dir, now: NOW, from: [{ name: 'desktop', local: true, run: localRun }],
    log: text => errors.push(text), ...options });
  const recent = () => readFile(join(dir, 'recent.md'), 'utf8');
  return { home, prefix, dir, path, entry, manifest, save, gatherHere, recent, errors };
}

test('embedded snapshot provenance is structurally validated without a native manifest file', async t => {
  const w = await world(t);
  for (const entry of [{}, { ...w.entry, recordCount: 0 }, { ...w.entry, importedHash: undefined }, { ...w.entry, path: '/tmp/not-a-native-session.jsonl' }]) {
    await assert.rejects(async () => { for await (const _ of importedBytes(chunks(derivative), entry)) {} }, /memory import: invalid manifest fields/);
  }
});

test('unimported readers unchanged; header remap preserves IDs/parents and narrative', async () => {
  const before = await readPi(original), after = await readPi(derivative);
  assert.equal(before.id, after.id);
  assert.equal(after.cwd, '/home/vaita/imperfect');
  assert.deepEqual(before.entries, after.entries);
  assert.deepEqual(before.events, after.events);
  assert.equal(JSON.parse(derivative.split('\n')[2]).parentId, 'u1');
});

test('historical-only import: no PC raw, exchanges or done mutations', async t => {
  const w = await world(t);
  const result = await w.gatherHere();
  assert.deepEqual([result.taken, result.sessions, result.exchanges], [0, 0, 0]);
  assert.doesNotMatch(await w.recent(), /Historical synthetic/);
  await assert.rejects(readFile(join(w.dir, '.done.json')), { code: 'ENOENT' });
  await assert.rejects(readdir(join(w.dir, 'raw')), { code: 'ENOENT' });
  assert.equal(await readFile(w.path, 'utf8'), derivative);
});

test('equal timestamps: appended turns only, archived independently, once, survives native deletion', async t => {
  const w = await world(t);
  await appendFile(w.path, next);
  const result = await w.gatherHere();
  assert.deepEqual([result.taken, result.exchanges], [1, 1]);
  const recent = await w.recent();
  assert.match(recent, /\n## 2026-09-30 01:00 · desktop · pi sameuuid · ~\/imperfect\n\nNoah:\n> New synthetic PC request\n\nAgent, 01:00:\n> New synthetic PC answer\n$/);
  assert.doesNotMatch(recent, /Historical synthetic/);
  const done = JSON.parse(await readFile(join(w.dir, '.done.json'), 'utf8'));
  const kept = done[`desktop:${w.path}`];
  assert.equal(kept.importPath, w.path);
  assert.equal(gunzipSync(await readFile(join(w.dir, kept.raw))).toString(), derivative + next);
  await w.gatherHere();
  assert.equal(await w.recent(), recent, 'once');
  await rm(w.path);
  await w.gatherHere();
  assert.equal(await w.recent(), recent, 'from raw/ once the log is gone');
});

test('multiple blocks in a record, compactions, old parents and an appended reply without new user', async t => {
  const w = await world(t);
  const log = derivative + encode([
    { type: 'compaction', id: 'compact', parentId: 'a1', timestamp: TIME, summary: 'old context', firstKeptEntryId: 'u1' },
    { ...message('reply', 'compact', 'assistant', ''), message: { role: 'assistant', model: 'new-model', content: [
      { type: 'text', text: 'New block one' }, { type: 'text', text: 'New block two' }] } },
  ]);
  await writeFile(w.path, log);
  const parsed = await readPi(importedBytes(chunks(log), w.entry), undefined, { afterRecord: 3 });
  assert.deepEqual(parsed.events.map(event => event.sourceRecordIndex), [5, 5]);
  assert.deepEqual(parsed.entries.map(entry => entry.text), ['New block one\n\nNew block two']);
  assert.deepEqual(parsed.models, ['new-model']);
  const result = await w.gatherHere();
  assert.equal(result.exchanges, 1);
  const recent = await w.recent();
  assert.match(recent, /\nNoah: \(earlier, [^\n]*\)\n\nAgent, 01:00:\n> New block one\n>\n> New block two\n$/, 'reply after historical user is not lost');
  assert.doesNotMatch(recent, /Historical synthetic|old context/);
});

test('Claude synthetic reader retains replay/sidechain filtering across record cutoff', async () => {
  const user = { type: 'user', uuid: 'u', sessionId: 'claude-id', cwd: '/home/vaita/imperfect', timestamp: TIME, message: { content: 'old' } };
  const assistant = { type: 'assistant', uuid: 'a', timestamp: TIME, message: { id: 'm', model: 'new', content: [
    { type: 'text', text: 'new one' }, { type: 'text', text: 'new two' }] } };
  const oldBlock = { ...assistant, uuid: 'old-block', message: { ...assistant.message, content: [{ type: 'text', text: 'Historical block' }] } };
  const parsed = await readClaude(encode([user, oldBlock, user,
    { ...user, uuid: 'child', isSidechain: true }, assistant]), undefined, { afterRecord: 2 });
  assert.deepEqual(parsed.events.map(event => event.sourceRecordIndex), [5, 5]);
  assert.deepEqual(parsed.entries.map(entry => entry.text), ['new one\n\nnew two']);
});

for (const kind of ['malformed', 'unknown', 'count', 'truncation', 'hash', 'boundary', 'badJSON', 'path', 'public', 'missingArchiveManifest']) {
  test(`bad provenance ${kind} fails closed without blocking ordinary logs`, async t => {
    const w = await world(t);
    if (kind === 'missingArchiveManifest') {
      await appendFile(w.path, next);
      await w.gatherHere();
      await rm(w.manifest);
      await rm(w.path); // raw alone must still refuse an absent manifest
    } else if (kind === 'malformed') await w.save('{bad');
    else if (kind === 'unknown') await w.save({ ...w.entry, version: 2 });
    else if (kind === 'count') await w.save({ ...w.entry, recordCount: 1 });
    else if (kind === 'truncation') await writeFile(w.path, derivative.slice(0, -20));
    else if (kind === 'hash') await w.save({ ...w.entry, importedHash: 'f'.repeat(64) });
    else if (kind === 'boundary') await w.save({ ...w.entry, byteCutoff: w.entry.byteCutoff - 1 });
    else if (kind === 'badJSON') { const text = derivative.replace('"session"', 'nonsense'); await writeFile(w.path, text); await w.save({ ...w.entry, byteCutoff: Buffer.byteLength(text), importedHash: sha(text) }); }
    else if (kind === 'path') await w.save({ ...w.entry, path: '/outside.jsonl' });
    else if (kind === 'public') await chmod(w.manifest, 0o644);
    const normal = encode([{ ...header, id: 'normal-id' }, message('n1', null, 'user', 'Ordinary synthetic request'), message('n2', 'n1', 'assistant', 'Ordinary answer')]);
    await writeFile(join(dirname(w.path), 'normal.jsonl'), normal);
    await w.gatherHere();
    const recent = await w.recent();
    assert.match(recent, /Ordinary synthetic request/);
    assert.doesNotMatch(recent, /Historical synthetic|New synthetic PC/);
    assert.ok(w.errors.some(text => text.includes('memory import:')), w.errors.join('\n'));
  });
}

test('canonical laptop raw/done survive import and rebuild after source disappears', async t => {
  const w = await world(t);
  const raw = 'raw/laptop/pi/original.jsonl.gz';
  await mkdir(dirname(join(w.dir, raw)), { recursive: true });
  const compressed = gzipSync(original);
  await writeFile(join(w.dir, raw), compressed);
  const sourceKey = 'laptop:/home/noah/.imperfect/data/state/sessions/original.jsonl';
  const sourceDone = { raw, size: Buffer.byteLength(original), mtime: 0 };
  await writeFile(join(w.dir, '.done.json'), JSON.stringify({ [sourceKey]: sourceDone }));
  await w.gatherHere(); // the original's exchange, from the laptop
  assert.match(await w.recent(), /\n## 2026-09-30 01:00 · laptop · pi sameuuid · ~\/imperfect\n\nNoah:\n> Historical synthetic request\n/);
  await appendFile(w.path, next);
  await w.gatherHere();
  assert.deepEqual(await readFile(join(w.dir, raw)), compressed);
  assert.deepEqual(JSON.parse(await readFile(join(w.dir, '.done.json')))[sourceKey], sourceDone);
  const recent = await w.recent();
  assert.deepEqual(recent.match(/^## .*$/gm).map(line => line.split(' · ')[1]).sort(), ['desktop', 'laptop'], 'at the same minute');
  assert.equal(recent.match(/Historical synthetic request/g).length, 1);
  await rm(w.path);
  await w.gatherHere();
  assert.equal(await w.recent(), recent);
});

for (const timestamp of ['2026-09-30T02:00:00Z', '2026-09-30T00:00:00Z']) test(`a repeated request at ${timestamp} stays PC and cannot mark canonical history a replay`, async t => {
  const w = await world(t);
  const raw = 'raw/laptop/pi/original.jsonl.gz';
  await mkdir(dirname(join(w.dir, raw)), { recursive: true });
  await writeFile(join(w.dir, raw), gzipSync(original));
  await w.gatherHere();
  await appendFile(w.path, encode([message('fresh-user', 'a1', 'user', 'Historical synthetic request', timestamp),
    message('fresh-reply', 'fresh-user', 'assistant', 'Actually new PC answer', timestamp)]));
  const result = await w.gatherHere();
  assert.equal(result.replays, 0);
  assert.match(await w.recent(), /\n## [^\n]* · desktop · pi sameuuid [^\n]*\n\nNoah:\n> Historical synthetic request\n\nAgent, \d\d:\d\d:\n> Actually new PC answer\n/);
});

test('replayed Pi IDs after cutoff are not genuinely new turns', async t => {
  const w = await world(t);
  await appendFile(w.path, encode(oldRecords.slice(1)));
  const result = await w.gatherHere();
  assert.equal(result.exchanges, 0);
  assert.doesNotMatch(await w.recent(), /Historical synthetic/);
});

test('active appended import uses live reader; quiet snapshot then reads only PC records', async t => {
  const w = await world(t);
  await appendFile(w.path, next);
  const local = async command => command.startsWith('find ')
    ? `${(await readFile(w.path)).length}\t${NOW / 1000}\t${w.path}` : '';
  const result = await w.gatherHere({ from: [{ name: 'desktop', local: true, run: local }] });
  assert.deepEqual([result.taken, result.live, result.sessions], [0, 1, 1]);
  const recent = await w.recent();
  assert.match(recent, /New synthetic PC request/);
  assert.doesNotMatch(recent, /Historical synthetic/);
  await w.gatherHere();
  assert.match(await w.recent(), /New synthetic PC request/);
  assert.doesNotMatch(await w.recent(), /Historical synthetic/);
});

test('import archive names cannot replace existing normal PC raw of same basename', async t => {
  const w = await world(t);
  const raw = join(w.dir, 'raw/desktop/pi/imported.jsonl.gz');
  const prior = gzipSync(encode([{ ...header, id: 'unrelated-pc' }]));
  await mkdir(dirname(raw), { recursive: true });
  await writeFile(raw, prior);
  await appendFile(w.path, next);
  await w.gatherHere();
  assert.deepEqual(await readFile(raw), prior);
  const names = await readdir(dirname(raw));
  assert.equal(names.length, 2);
  assert.ok(names.some(name => /^import-[a-f0-9]{64}-imported\.jsonl\.gz$/.test(name)));
});

test('lookup is scoped, rejects private non-native paths and unexpected fields', async t => {
  const w = await world(t);
  assert.equal(await readMemoryImport(w.dir, join(dirname(w.path), 'unimported.jsonl')), null);
  await w.save({ ...w.entry, auth: 'not-a-value' });
  await assert.rejects(readMemoryImport(w.dir, w.path), /invalid manifest/);
  for (const path of ['/home/synthetic/.imperfect/auth.jsonl', '/home/synthetic/.claude/projects/x/subagents/a.jsonl', '/home/synthetic/.pi/agent/sessions/../bad.jsonl']) {
    await writeFile(importManifestPath(w.dir, path), JSON.stringify({ ...w.entry, path }), { mode: 0o600 });
    await assert.rejects(readMemoryImport(w.dir, path), /invalid manifest/);
  }
});
