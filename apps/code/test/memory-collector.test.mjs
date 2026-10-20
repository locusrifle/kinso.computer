process.env.TZ = 'UTC';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { gather, here, memorySourceEnvironment, readCodex } from '../../../system/memory.mjs';
import { loadDurableArchive, snapshotDurableArchive } from '../native/durable-archive.mjs';

const NOW = Date.parse('2026-09-30T04:00:00Z'), TIME = '2026-09-30T01:00:00Z';
const repo = resolve(import.meta.dirname, '../../..');
const codex = () => readFile(join(import.meta.dirname, 'fixtures/memory-collector/codex.jsonl'), 'utf8');
const encode = rows => rows.map(JSON.stringify).join('\n') + '\n';
const pi = (id, text) => encode([{ type: 'session', version: 3, id, cwd: '/Users/synthetic/imperfect', timestamp: TIME },
  { type: 'message', id: 'u', timestamp: TIME, message: { role: 'user', content: text } },
  { type: 'message', id: 'a', timestamp: TIME, message: { role: 'assistant', content: [{ type: 'text', text: 'Preserved.' }], stopReason: 'stop' } }]);

async function world(t) {
  const home = await mkdtemp(join(tmpdir(), 'memory-collector-synthetic-'));
  const prefix = join(home, '.imperfect'), dir = join(prefix, 'memory'), bin = join(home, 'bin');
  const dbs = [];
  t.after(async () => { for (const db of dbs) db.close(); await rm(home, { recursive: true, force: true }); });
  await mkdir(bin, { recursive: true });
  await symlink(repo, join(home, 'imperfect'));
  // Simulate BSD find's rejection of GNU-only flags without a Mac or SSH.
  const find = execFileSync('sh', ['-c', 'command -v find'], { encoding: 'utf8' }).trim();
  await writeFile(join(bin, 'find'), `#!/bin/sh\nfor arg; do\n  if [ "$arg" = -printf ]; then exit 64; fi\ndone\nexec '${find.replaceAll("'", "'\\''")}' "$@"\n`);
  await chmod(join(bin, 'find'), 0o700);
  const commands = [], errors = [];
  const shell = here({ ...process.env, HOME: home, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` });
  const run = async (command, into) => { commands.push(command); return command.startsWith('git ') ? '' : shell(command, into); };
  const collect = (options = {}) => gather({ prefix, dir, home, from: [{ name: 'mac', run }], now: NOW, log: e => errors.push(e), ...options });
  const save = async (relative, text) => {
    const path = join(home, relative); await mkdir(dirname(path), { recursive: true }); await writeFile(path, text, { mode: 0o600 });
    await utimes(path, new Date(NOW - 3600_000), new Date(NOW - 3600_000)); return path;
  };
  return { home, prefix, dir, commands, errors, collect, run, save, dbs };
}

test('source SSH commands find the installed Node without a login shell and fail visibly if unavailable', async t => {
  const home = await mkdtemp(join(tmpdir(), 'memory-source-node-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = join(home, '.local/bin'); await mkdir(bin, { recursive: true });
  await symlink(process.execPath, join(bin, 'node'));
  const source = here({ HOME: home, PATH: '/bin' });
  assert.equal(String(await source(`${memorySourceEnvironment}node -p 'process.versions.node'`)).trim(), process.versions.node);
  await rm(join(bin, 'node'));
  await writeFile(join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await assert.rejects(source(`${memorySourceEnvironment}echo must-not-run`), /History collection requires Node/);
});

test('Codex rollout: one narrative, tools retained, injected context and duplicate UI events omitted', async () => {
  const text = await codex();
  const s = await readCodex(text);
  assert.equal(s.id, 'synthetic-codex-mac'); assert.equal(s.cwd, '/Users/synthetic/imperfect');
  assert.deepEqual(s.models, ['synthetic-model']);
  assert.deepEqual(s.entries.map(e => [e.who, e.text]), [['noah', 'Keep the Mac work in ~/workbench/mac-piece'], ['agent', 'The Mac work is preserved.']]);
  assert.equal(s.events.filter(e => e.who === 'tool').length, 1);
  assert.match(s.events.find(e => e.who === 'tool').result, /Synthetic working tree is clean/);
  assert.doesNotMatch(JSON.stringify(s.events), /Injected|token_count/);
  const bytes = Buffer.from(text);
  assert.deepEqual(await readCodex(Readable.from(Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.subarray(i * 7, i * 7 + 7)))), s);
  assert.equal((await readCodex(text.replace('"source":"cli"', '"source":{"subagent":"fixture"}'))).entries.length, 0);
});

test('Codex event-only/app-server rollouts are readable without copying injected response context', async () => {
  const text = encode([
    { type: 'session_meta', payload: { id: 'event-only', source: 'vscode' } },
    { type: 'response_item', timestamp: TIME, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context/>' }] } },
    { type: 'event_msg', timestamp: TIME, payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Actual request' }] } } },
    { type: 'event_msg', timestamp: TIME, payload: { type: 'agent_message', message: 'Actual answer' } },
  ]);
  assert.deepEqual((await readCodex(text)).entries.map(e => e.text), ['Actual request', 'Actual answer']);
  const mixed = await codex() + encode([
    { type: 'event_msg', timestamp: '2026-09-30T01:10:00Z', payload: { type: 'user_message', message: 'A later event-only request' } },
    { type: 'event_msg', timestamp: '2026-09-30T01:11:00Z', payload: { type: 'agent_message', message: 'A later event-only answer' } },
  ]);
  assert.deepEqual((await readCodex(mixed)).entries.map(e => e.text), ['Keep the Mac work in ~/workbench/mac-piece', 'The Mac work is preserved.', 'A later event-only request', 'A later event-only answer']);
});

test('portable collection includes Codex archives and runtime archives, dedupes prefixes, each exchange once', async t => {
  const w = await world(t), text = await codex();
  await w.save('.codex/sessions/2026/09/30/rollout.jsonl', text);
  await w.save(".codex/archived_sessions/rollout's copy.jsonl", text);
  const original = pi('synthetic-pi', 'Preserve the selected Mac history');
  await w.save('.imperfect/data/state/sessions/same.jsonl', original);
  const archive = await w.save('.imperfect/data/state/sessions-from-the-other-runtime/same.jsonl', original);
  await w.save('.pi/agent/sessions-from-the-other-runtime/old.jsonl', original.split('\n').slice(0, 2).join('\n') + '\n');
  await w.save('.imperfect/data/agent/sessions/new.jsonl', pi('agent-dir-pi', 'A different Pi history in the agent directory'));
  await w.save('.claude/projects/project/subagents/worker.jsonl', 'must not collect');
  const result = await w.collect();
  assert.deepEqual([result.taken, result.sessions, result.exchanges], [6, 3, 3], w.errors.join('\n'));
  const done = JSON.parse(await readFile(join(w.dir, '.done.json')));
  assert.equal(Object.keys(done).length, 6);
  const raws = Object.values(done).map(e => e.raw); assert.equal(new Set(raws).size, 6, 'same basename never overwrites different evidence');
  assert.equal(gunzipSync(await readFile(join(w.dir, done[`mac:${archive}`].raw))).toString(), original);
  assert.ok(w.commands.some(c => c.startsWith('find ') && c.includes('-exec node')));
  assert.ok(!w.commands.some(c => c.includes('-printf')));
  const recent = await readFile(join(w.dir, 'recent.md'), 'utf8');
  assert.equal(recent.match(/Preserve the selected Mac history/g)?.length, 1);
  assert.match(recent, /· mac · pi [^\n]* · ~\/imperfect/);
  assert.equal((await w.collect()).taken, 0);
  await rm(join(w.home, '.codex'), { recursive: true });
  assert.equal((await w.collect()).sessions, 3, 'archived copies alone');
  assert.equal(await readFile(join(w.dir, 'recent.md'), 'utf8'), recent);
  assert.deepEqual(w.errors, []);
});

test('same UUID with divergent original evidence is not silently discarded', async t => {
  const w = await world(t);
  await w.save('.imperfect/data/state/sessions/same.jsonl', pi('same-id', 'First independent history'));
  await w.save('.imperfect/data/state/sessions-from-the-other-runtime/same.jsonl', pi('same-id', 'Second independent history'));
  assert.equal((await w.collect()).sessions, 2);
  assert.deepEqual(w.errors, []);
});

test('Mac runtime-archive SQLite stays hot: source-side online backup includes WAL, mirrors count once', async t => {
  const w = await world(t);
  const source = join(w.home, '.imperfect/data/state/sessions-from-the-other-runtime/hot.sqlite');
  await mkdir(dirname(source), { recursive: true });
  const db = new DatabaseSync(source); w.dbs.push(db);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE durable_schema (singleton INTEGER, version INTEGER);
    INSERT INTO durable_schema VALUES (1, 1);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT, scope_kind TEXT, owner_id INTEGER, retired_at INTEGER);
    CREATE TABLE document_revisions (document_id INTEGER, seq INTEGER, kind TEXT, content TEXT);
    CREATE TABLE entries (id INTEGER PRIMARY KEY, conversation_id INTEGER, record TEXT);`);
  db.prepare('INSERT INTO documents VALUES (1, ?, ?, 1, NULL)').run(JSON.stringify('imperfect.session'), 'conversation');
  db.prepare('INSERT INTO document_revisions VALUES (1, 1, ?, ?)').run('base', JSON.stringify({ id: 'hot-mac', cwd: '/Users/synthetic/imperfect', created: Date.parse(TIME) }));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const main = await readFile(source);
  const insert = text => {
    const n = db.prepare('SELECT count(*) AS n FROM entries').get().n;
    const record = { id: n + 1, kind: 'pi.user', timestamp: Date.parse(TIME), model: [{ role: 'user', content: text, timestamp: Date.parse(TIME) }] };
    db.prepare('INSERT INTO entries VALUES (?, 1, ?)').run(n + 1, JSON.stringify(record));
  };
  insert('Committed only in the hot Mac WAL');
  const wal = await readFile(`${source}-wal`);
  const result = await w.collect();
  assert.deepEqual([result.taken, result.sessions], [1, 1], w.errors.join('\n'));
  const done = JSON.parse(await readFile(join(w.dir, '.done.json'))), raw = join(w.dir, done[`mac:${source}`].raw);
  assert.equal((await loadDurableArchive(raw)).entries.length, 1);
  assert.equal((await stat(raw)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(source), main); assert.deepEqual(await readFile(`${source}-wal`), wal);
  assert.match(await readFile(join(w.dir, 'recent.md'), 'utf8'), /Committed only in the hot Mac WAL/);
  insert('A later WAL-only commit');
  assert.equal((await w.collect()).taken, 1);
  assert.equal((await loadDurableArchive(raw)).entries.length, 2);
  assert.deepEqual(await readFile(source), main);
  await snapshotDurableArchive(source, join(dirname(source), 'mirror.sqlite'));
  assert.equal((await w.collect()).sessions, 1);
  assert.ok(w.commands.some(c => c.includes('durable-archive.mjs') && c.includes(' snapshot ')));
  assert.ok(!w.commands.some(c => c.startsWith('gzip ') && c.includes('.sqlite')));
  const previous = await readFile(raw);
  db.exec('UPDATE durable_schema SET version = 999');
  await w.collect();
  assert.deepEqual(await readFile(raw), previous, 'failed backup never replaces the last good archive');
  assert.ok(w.errors.some(e => e.includes(source) && e.includes('tried again next pass')));
  assert.equal((await readdir(dirname(raw))).filter(name => name.endsWith('.part')).length, 0);
});
