import { DatabaseSync, backup } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { chmod, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { apply } from '@earendil-works/chord/delta';
import { transcript } from './durable-session.mjs';

const schema = db => {
  if (db.prepare('SELECT version FROM durable_schema WHERE singleton = 1').get()?.version !== 1) throw new Error('Unsupported Durable archive schema');
};

// Archive-only access to the pinned Durable 1.2 SQLite schema. Never starts a
// Harness, migrates a database or competes with its live owner. WAL is included.
export function readDurableArchive(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    schema(db);
    const document = kind => {
      const found = db.prepare('SELECT id FROM documents WHERE kind = ? AND scope_kind = ? AND owner_id = 1 AND retired_at IS NULL').get(JSON.stringify(kind), 'conversation');
      let value;
      if (found) for (const row of db.prepare('SELECT kind, content FROM document_revisions WHERE document_id = ? ORDER BY seq').all(found.id)) {
        value = row.kind === 'base' ? JSON.parse(row.content) : apply(value, JSON.parse(row.content));
      }
      return value;
    };
    const info = document('imperfect.session');
    if (!info?.id) throw new Error('Durable archive is not initialized; refusing a fresh conversation');
    const entries = db.prepare('SELECT record FROM entries WHERE conversation_id = 1 ORDER BY id').all().map(row => JSON.parse(row.record));
    const usage = document('pi.usage'), identity = document('pi.provider')?.sessionId;
    db.exec('COMMIT');
    return { info, entries, usage, identity: identity || info.id, messages: transcript(entries) };
  } finally { db.close(); }
}

// Both DB and WAL identity matter: commits can leave the main file unchanged,
// and checkpoints can replace/truncate a WAL without changing its length.
export async function durableArchiveStamp(path) {
  return JSON.stringify(await Promise.all([path, `${path}-wal`].map(async file => {
    try {
      const s = await stat(file, { bigint: true });
      return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  })));
}

// SQLite's online backup, NOT a copy of the live main file. The committed WAL
// state and all raw entries/documents survive in a standalone private snapshot.
export async function snapshotDurableArchive(source, destination) {
  const file = await open(destination, 'wx', 0o600); await file.close();
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    schema(db);
    await backup(db, destination);
    readDurableArchive(destination); // validate the completed snapshot, not just its source
    await chmod(destination, 0o600);
  } catch (error) { await rm(destination, { force: true }); throw error; }
  finally { db?.close(); }
}

export async function loadDurableArchive(path, { compressed = path.endsWith('.gz') } = {}) {
  if (!compressed) return readDurableArchive(path);
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-archive-'));
  const file = join(dir, 'snapshot.sqlite');
  try {
    const handle = await open(file, 'wx', 0o600);
    await pipeline(createReadStream(path), createGunzip(), handle.createWriteStream());
    return { ...readDurableArchive(file), byteLength: (await stat(file)).size };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// A reconstructible native-shaped projection for archive consumers, not a new
// transcript store. Legacy raw records keep their IDs/record offsets (including
// failed/omitted attempts); imported model-context copies are never responses.
// Memory selects a lineage, retaining pre-compaction experience. Accounting
// selects ALL branches. Neither applies context edits to the original evidence.
export function durableArchiveRows(archive, { activeBranch = false } = {}) {
  const legacy = archive.entries.find(e => e.kind === 'imperfect.legacy');
  const original = legacy?.data.source.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) || [];
  let selected = null;
  if (activeBranch && legacy) {
    const byId = new Map(legacy.data.entries.map(e => [e.id, e]));
    selected = new Set();
    let entry = legacy.data.entries.at(-1);
    while (entry) { if (selected.has(entry.id)) throw new Error('Cyclic legacy archive'); selected.add(entry.id); entry = byId.get(entry.parentId); }
  }
  const rows = [{ type: 'session', id: archive.info.id, cwd: archive.info.cwd, timestamp: new Date(archive.info.created).toISOString(), sourceRecordIndex: 1 }];
  original.slice(1).forEach((row, i) => {
    // Use migrated IDs/parents to select old v1 histories too, but never rewrite
    // the stored original bytes or their response identity for accounting.
    if (!selected || selected.has(legacy.data.entries[i]?.id)) rows.push({ ...row, sourceRecordIndex: i + 2 });
  });
  let index = original.length || 1;
  for (const entry of archive.entries) {
    if (['imperfect.legacy', 'imperfect.imported-context', 'pi.system', 'pi.compaction'].includes(entry.kind)) continue;
    for (const [i, message] of (entry.model || []).entries()) {
      if (message.role === 'system') continue;
      rows.push({ type: 'message', id: `durable:${archive.identity}:${entry.id}:${i}`, timestamp: new Date(message.timestamp ?? entry.timestamp).toISOString(), message, archiveKind: entry.kind, sourceRecordIndex: ++index });
    }
  }
  return rows;
}

// Memory invokes the same collector on the source computer, streaming only a
// completed snapshot. No shell pipeline can hide a failed SQLite backup.
const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  if (process.argv[2] !== 'snapshot' || !process.argv[3]) throw new Error('Expected snapshot <archive>');
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-backup-'));
  try {
    const path = join(dir, 'snapshot.sqlite');
    await snapshotDurableArchive(process.argv[3], path);
    await pipeline(createReadStream(path), createGzip(), process.stdout);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
