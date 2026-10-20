// Pulse's durable record. No I/O at import/construction, and no implicit seeds.
// Rows are full-state events; a checkpoint replaces old events without losing
// open incidents, any of their guard evidence, or unacknowledged completions.
import { existsSync } from 'node:fs';
import { open as openFile, readFile, mkdir, rename, unlink, stat, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const invariantIds = ['follower-drift', 'os-follower', 'disk-pressure', 'memory-pressure', 'services', 'workers', 'memory-bank', 'backups', 'clock', 'test-gate', 'reflections', 'unclean-boots', 'doctor-heartbeat'];
export const defaultStateDir = () => join(process.env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'data', 'state');
export const defaultMemoryDir = () => join(process.env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'memory');
const iso = () => new Date().toISOString();
const safeId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('Invalid ledger id/name');
  return value;
};
const text = (value, label, max = 8192) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}`);
  return value.trim();
};
const json = value => JSON.parse(JSON.stringify(value));

export async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await openFile(temporary, 'wx', 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await openFile(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

// Kernel flock, not a stale-PID timeout lock. Closing stdin (including parent
// SIGKILL) releases the child and lock. Never steal a slow live writer's lock.
// A Mac has no flock(1); its lockf(1) takes the same lock (-k: the file stays),
// and before macOS 15, which has no lockf(1) either, perl's flock does. wait:
// the seconds to keep trying (0: once).
const PERL_LOCK = 'open(my $f, ">>", shift) or die "$!\\n"; my $until = time + shift; '
  + 'until (flock($f, LOCK_EX | LOCK_NB)) { exit 75 if time >= $until; select(undef, undef, undef, 0.1) } '
  + 'exit((system { $ARGV[0] } @ARGV) >> 8)';
export const lockCommand = (path, program, platform = process.platform, { wait = 30, lockf = platform === 'darwin' && existsSync('/usr/bin/lockf') } = {}) => (
  platform !== 'darwin' ? ['flock', ['--exclusive', '--timeout', String(wait), path, ...program]]
    : lockf ? ['/usr/bin/lockf', ['-k', '-t', String(wait), path, ...program]]
      : ['/usr/bin/perl', ['-MFcntl=:flock', '-e', PERL_LOCK, path, String(wait), ...program]]);
async function locked(path, action) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockFile = await openFile(path, 'a', 0o600);
  await lockFile.close();
  const holder = spawn(...lockCommand(path, [process.execPath, '--input-type=module', '-e', 'process.stdout.write("locked\\n");process.stdin.resume();']), { stdio: ['pipe', 'pipe', 'pipe'] });
  holder.stdin.on('error', () => {});
  const ended = new Promise(resolveExit => { holder.once('error', error => resolveExit(error)); holder.once('close', code => resolveExit(code)); });
  let diagnostic = '';
  holder.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2048); });
  try {
    await new Promise((ready, reject) => {
      holder.stdout.once('data', ready);
      holder.once('error', reject);
      holder.once('close', code => reject(new Error(`Ledger lock failed (${code}): ${diagnostic}`)));
    });
    return await action();
  } finally { holder.stdin.end(); await ended; }
}

export { locked as withLedgerLock };

function store({ stateDir = defaultStateDir(), maxBytes = 2 * 1024 * 1024, retainClosed = 128 } = {}, name, key, mandatory) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || !Number.isSafeInteger(retainClosed) || retainClosed < 0) throw new Error('Invalid ledger bounds');
  const path = join(resolve(stateDir), `${name}.jsonl`);
  const read = async () => {
    const file = await openFile(path, 'r').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    let raw = '';
    if (file) {
      try {
        if ((await file.stat()).size > maxBytes) throw new Error(`${name} ledger exceeds its ${maxBytes}-byte bound; refusing an unbounded read`);
        raw = await file.readFile('utf8');
      } finally { await file.close(); }
    }
    if (raw && !raw.endsWith('\n')) throw new Error(`Corrupt ${name} ledger: incomplete final row; refusing to overwrite`);
    const records = new Map();
    const rows = raw.split('\n').filter(Boolean).map((line, index) => {
      let row;
      try { row = JSON.parse(line); } catch { throw new Error(`Corrupt ${name} ledger at row ${index + 1}; refusing to overwrite`); }
      if (row.version !== 1 || !['checkpoint', 'put'].includes(row.op)) throw new Error(`Unsupported ${name} ledger row`);
      if (row.op === 'checkpoint') {
        if (!Array.isArray(row.records)) throw new Error(`Invalid ${name} checkpoint`);
        records.clear();
        for (const record of row.records) records.set(safeId(record[key]), record);
      } else {
        if (!row.record || typeof row.record !== 'object') throw new Error(`Invalid ${name} event`);
        records.set(safeId(row.record[key]), row.record);
      }
      return row;
    });
    return { raw, rows, records };
  };
  const transaction = action => locked(`${path}.lock`, async () => {
    const state = await read();
    const changes = [];
    const put = record => { const copy = json(record); state.records.set(safeId(copy[key]), copy); changes.push({ version: 1, op: 'put', at: iso(), record: copy }); };
    const result = await action(state.records, put);
    if (!changes.length) return result;
    let output = state.raw + changes.map(row => `${JSON.stringify(row)}\n`).join('');
    if (Buffer.byteLength(output) > maxBytes || state.rows.length + changes.length > 512) {
      const changed = new Set(changes.map(row => row.record[key]));
      const required = record => mandatory(record) || changed.has(record[key]);
      const kept = [...state.records.values()].filter(required);
      const optional = [...state.records.values()].filter(record => !required(record)).sort((a, b) => String(b.updated || b.finished || b.started).localeCompare(String(a.updated || a.finished || a.started))).slice(0, retainClosed);
      const encode = () => `${JSON.stringify({ version: 1, op: 'checkpoint', at: iso(), records: [...kept, ...optional] })}\n`;
      output = encode();
      while (Buffer.byteLength(output) > maxBytes && optional.length) { optional.pop(); output = encode(); }
      if (Buffer.byteLength(output) > maxBytes) throw new Error(`${name} ledger capacity: required open records/evidence exceed ${maxBytes} bytes; nothing removed`);
    }
    await atomicWrite(path, output);
    return result;
  });
  return { path, read, transaction };
}

async function registryHas(registry, id) {
  const current = typeof registry === 'function' ? await registry() : registry;
  if (current instanceof Map || current instanceof Set) return current.has(id);
  if (Array.isArray(current)) return current.some(item => (typeof item === 'string' ? item : item.id) === id);
  return !!current && Object.hasOwn(current, id);
}

async function validateGuard(guard, registry) {
  if (!guard || typeof guard !== 'object') throw new Error('Invalid guard');
  const type = guard.type;
  if (type === 'test' || type === 'hook') {
    const path = await realpath(resolve(text(guard.path, 'guard path')));
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Guard must reference an existing regular file');
    return { type, path, validated: iso(), evidence: { size: info.size, modified: info.mtime.toISOString() } };
  }
  if (type === 'invariant') {
    const id = safeId(guard.id);
    if (!await registryHas(registry, id)) throw new Error(`Unknown invariant: ${id}`);
    return { type, id, validated: iso() };
  }
  if (type === 'note') {
    const note = text(guard.text, 'guard note');
    const reason = note.replace(/^no guard possible:\s*/i, '').trim();
    const words = reason.toLowerCase().match(/[a-z]{3,}/g) || [];
    if (!/^no guard possible:\s+/i.test(note) || reason.length < 40 || new Set(words).size < 6 || !/[a-z]/i.test(reason)) throw new Error('Note must say "no guard possible: reason" with a meaningful reason of at least 40 characters');
    return { type, text: note, validated: iso() };
  }
  throw new Error('Guard type must be test, invariant, hook, or note');
}

export function createIncidentLedger(options = {}) {
  const registry = options.registry ?? invariantIds;
  // Keep guard evidence and imported identities even after close. At capacity
  // refuse additions rather than silently erase a guard or reopen an old boot.
  const db = store(options, 'incidents', 'id', record => record.status === 'open' || record.guards?.length > 0 || ['seed', 'os'].includes(record.source));
  const get = (records, id) => { const record = records.get(safeId(id)); if (!record) throw new Error(`Unknown incident: ${id}`); return record; };
  const editable = (records, id) => { const record = get(records, id); if (record.status === 'closed') throw new Error('Incident is already closed'); return record; };
  const api = {
    async list({ status } = {}) { return [...(await db.read()).records.values()].filter(record => !status || record.status === status).sort((a, b) => b.opened.localeCompare(a.opened)); },
    async open(input) {
      const data = typeof input === 'string' ? { title: input } : input;
      const id = safeId(data?.id || randomUUID());
      const title = text(data?.title, 'incident title', 1024);
      return db.transaction((records, put) => {
        if (records.has(id)) return records.get(id);
        const now = iso();
        const record = { id, title, status: 'open', opened: data.when || now, updated: now, causes: [], guards: [] };
        for (const field of ['invariant', 'reason', 'evidence', 'source', 'pendingGuards']) if (data[field] !== undefined) record[field] = json(data[field]);
        if (typeof record.opened !== 'string' || !Number.isFinite(Date.parse(record.opened))) throw new Error('Invalid incident timestamp');
        put(record); return record;
      });
    },
    async cause(id, value) {
      const cause = text(value, 'cause');
      return db.transaction((records, put) => { const old = editable(records, id), now = iso(); const record = { ...old, cause, causes: [...old.causes, { text: cause, when: now }], updated: now }; put(record); return record; });
    },
    async guard(id, guard) {
      return db.transaction(async (records, put) => { const old = editable(records, id); const valid = await validateGuard(guard, registry); const record = { ...old, guards: [...old.guards, valid], updated: iso() }; put(record); return record; });
    },
    async close(id) {
      return db.transaction(async (records, put) => {
        const old = get(records, id);
        if (old.status === 'closed') return old;
        const valid = [];
        for (const guard of old.guards) { try { valid.push(await validateGuard(guard, registry)); } catch { /* Keep invalid historical evidence, but it cannot authorize close. */ } }
        if (!valid.length) throw new Error('Refusing to close: no currently validated guard');
        const now = iso(), record = { ...old, status: 'closed', closed: now, updated: now, closingGuards: valid };
        put(record); return record;
      });
    },
    async importBoot(input) {
      const boot = typeof input === 'string' ? JSON.parse(await readFile(input, 'utf8')) : input;
      if (boot?.kind !== 'unclean-boot' || !boot.host || !boot.bootId || !boot.previousBootId || !boot.summary) throw new Error('Invalid OS unclean-boot incident');
      const hash = createHash('sha256').update(`${boot.host}:${boot.previousBootId}`).digest('hex').slice(0, 32);
      return api.open({ id: `boot-${hash}`, title: boot.summary, source: 'os', when: boot.when, invariant: 'unclean-boots', evidence: boot });
    },
    async seed() {
      const seeds = JSON.parse(await readFile(new URL('./pulse-seeds.json', import.meta.url), 'utf8'));
      const root = fileURLToPath(new URL('../', import.meta.url));
      const results = [];
      for (const seed of seeds) {
        let record = await api.open({ ...seed, source: 'seed', pendingGuards: seed.pendingGuards || [] });
        if (record.status === 'open') {
          if (!record.cause && seed.cause) record = await api.cause(record.id, seed.cause);
          for (const proposed of seed.guards || []) {
            const guard = { ...proposed, ...(proposed.path ? { path: resolve(root, proposed.path) } : {}) };
            if (record.guards.some(old => old.type === guard.type && (old.id === guard.id && old.path === guard.path))) continue;
            try { record = await api.guard(record.id, guard); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !error.message.startsWith('Unknown invariant:')) throw error; }
          }
          if (seed.close && record.guards.length && !record.pendingGuards.length) record = await api.close(record.id);
        }
        results.push(record);
      }
      return results;
    },
  };
  return api;
}

export function createWorkerLedger(options = {}) {
  const memoryDir = resolve(options.memoryDir || defaultMemoryDir());
  const db = store(options, 'workers', 'name', record => !record.finished || !record.acknowledged);
  const get = (records, name) => { const record = records.get(safeId(name)); if (!record) throw new Error(`Unknown worker: ${name}`); return record; };
  const notice = async record => {
    const base = join(memoryDir, 'open', `worker-${safeId(record.name)}`);
    if (record.finished && !record.acknowledged) {
      const summary = `worker finished: ${record.name} exit ${record.exit}${record.signal ? ` (${record.signal})` : ''}`;
      const contents = {
        json: `${JSON.stringify({ kind: 'worker', ...record, summary })}\n`,
        md: `- ${summary}; ${record.finished}; logs ${String(record.taskDir).replace(/[\r\n]/g, ' ')}; acknowledge with worker ack ${record.name}.\n`,
      };
      for (const [ext, content] of Object.entries(contents)) {
        const existing = await readFile(`${base}.${ext}`, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (existing !== content) await atomicWrite(`${base}.${ext}`, content);
      }
    } else {
      for (const ext of ['json', 'md']) await unlink(`${base}.${ext}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  };
  // Notice materialization stays under the same lock as ack/finish, preventing
  // a late completion from resurrecting an acknowledged item. Repair after a
  // crash between committing the ledger and writing its derived memory files.
  const mutate = action => locked(`${db.path}.notices.lock`, async () => {
    for (const record of (await db.read()).records.values()) await notice(record);
    const result = await action();
    if (result && !Array.isArray(result)) await notice(result);
    return result;
  });
  return {
    async list() { return mutate(async () => [...(await db.read()).records.values()].sort((a, b) => b.started.localeCompare(a.started))); },
    async get(name) { return get((await db.read()).records, name); },
    async start(input) {
      safeId(input.name);
      if (!['sol', 'claude', 'test', 'job'].includes(input.kind)) throw new Error('Invalid worker kind');
      return mutate(() => db.transaction((records, put) => {
        const old = records.get(input.name);
        if (old && (!old.finished || !old.acknowledged)) throw new Error('Worker name is running or unacknowledged; acknowledge before reuse');
        const record = { ...input, runId: input.runId || randomUUID(), started: input.started || iso(), exit: null, finished: null, acknowledged: null };
        put(record); return record;
      }));
    },
    async finish(name, completion) {
      return mutate(() => db.transaction((records, put) => {
        const old = get(records, name);
        if ((completion.runId && completion.runId !== old.runId) || old.finished) return old;
        if (!Number.isInteger(completion.exit) || completion.exit < 0 || completion.exit > 255) throw new Error('Invalid worker exit');
        const record = { ...old, exit: completion.exit, finished: completion.finished || iso(), ...(completion.signal ? { signal: completion.signal } : {}), ...(completion.result ? { result: completion.result } : {}) };
        put(record); return record;
      }));
    },
    async ack(name) {
      return mutate(() => db.transaction((records, put) => {
        const old = get(records, name);
        if (!old.finished) throw new Error('Cannot acknowledge a running worker');
        if (old.acknowledged) return old;
        const record = { ...old, acknowledged: iso() }; put(record); return record;
      }));
    },
  };
}
