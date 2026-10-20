// One nonrecursive directory watch, shared by its visible windows. Notifications
// invalidate a listing; periodic child stats also catch lost inotify events and
// changes to symlink targets. No recursive walks or unbounded Promise.all.
import { watch as watchDirectory } from 'node:fs';
import { opendir, stat, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const failure = (status, message) => Object.assign(new Error(message), { status });
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

// Across all directories, at most sixteen child stat operations at once.
function limiter(max) {
  let active = 0;
  const waiting = [];
  return async run => {
    if (active >= max) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await run(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}

export function createFileFeed({
  watch = watchDirectory, childStat = stat, childLstat = lstat,
  maxDirectories = 128, maxStreams = 512, maxWindowStreams = 32,
  debounceMs = 150, pollMs = 900, safetyMs = 10_000,
  heartbeatMs = 5000, validMs = 1000, stalledMs = 15_000,
} = {}) {
  const directories = new Map(), windows = new Map(), listings = new Map();
  const limitedStat = limiter(16), limitedScan = limiter(4);
  let streamCount = 0, stopped = false, sequence = 0;

  function scan(full, collect = false) {
    if (stopped) return Promise.reject(failure(503, 'files are closing'));
    const had = listings.get(full);
    if (had) return !collect || had.collect ? had.promise : had.promise.then(() => scan(full, true));
    if (listings.size >= maxDirectories) return Promise.reject(failure(429, 'too many directory scans'));
    const entry = { collect };
    entry.promise = readDirectory(full, collect).finally(() => listings.delete(full));
    listings.set(full, entry);
    return entry.promise;
  }
  async function readDirectory(full, collect) {
    return limitedScan(async () => {
      if (stopped) throw failure(503, 'files are closing');
      const scanSequence = ++sequence;
      const info = await stat(full);
      const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      const signature = Buffer.alloc(32), entries = collect ? [] : null;
      let count = 0;
      const directory = await opendir(full);
      async function entry(name) {
        const at = join(full, name);
        const info = await limitedStat(() => childStat(at).catch(() => childLstat(at).catch(() => null)));
        const value = { name, path: at, dir: Boolean(info?.isDirectory()), size: info?.size ?? 0, mtime: info?.mtimeMs ?? 0 };
        const hash = createHash('sha256').update(JSON.stringify([name, info?.mode ?? 0, value.dir, value.size, value.mtime, info?.ctimeMs ?? 0])).digest();
        // Order-independent set signature: opendir order may change after a
        // rename. Names are unique, and each name participates in its digest.
        for (let i = 0; i < signature.length; i++) signature[i] ^= hash[i];
        count++;
        entries?.push(value);
      }
      // The handle is automatically closed by async iteration, even on error.
      let batch = [];
      for await (const item of directory) {
        if (stopped || (!collect && !directories.has(full))) throw failure(503, 'directory stream closed');
        batch.push(entry(item.name));
        if (batch.length === 16) { await Promise.all(batch); batch = []; }
      }
      await Promise.all(batch);
      const etag = `"${createHash('sha256').update(signature).update(String(count)).digest('hex')}"`;
      if (!collect) return { etag, scanSequence, identity };
      entries.sort((a, b) => b.mtime - a.mtime || Number(b.dir) - Number(a.dir)
        || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { etag, scanSequence, identity, value: { path: full, up: full === '/' ? null : dirname(full), entries } };
    });
  }

  function notify(state, name) {
    for (const client of state.clients) if (client.ready) client.send(name, {
      path: state.path, version: state.version,
      ...(name === 'ready' || name === 'heartbeat' ? { mode: state.mode } : {}),
    });
  }
  function invalidate(state) {
    if (state.closed) return;
    state.revision++;
    state.invalidated = ++sequence;
    state.version = `${state.id}:${state.revision}`;
    state.dirty = true;
    // One timer, not a queue; a continuous writer cannot postpone it forever.
    if (!state.debounce) state.debounce = setTimeout(() => {
      state.debounce = null;
      notify(state, 'changed');
    }, debounceMs).unref();
  }
  function accept(state, result, revision) {
    if (state.closed) return;
    // fs.watch follows an inode, not a pathname. A replacement between
    // scans may never have been missing: stop claiming watch-backed live.
    if (state.identity && state.identity !== result.identity) { fallback(state); invalidate(state); }
    state.identity = result.identity;
    const stale = revision !== state.revision || result.scanSequence < state.invalidated;
    if (!stale && (state.failed || (state.etag && result.etag !== state.etag && (!state.dirty || state.mode === 'poll')))) invalidate(state);
    state.etag = result.etag;
    state.checked = Date.now();
    state.dirty = stale;
    state.failed = false;
  }
  function revalidate(state) {
    if (state.closed) return Promise.resolve();
    // Overlapping timer scans share one run. The next interval rechecks;
    // even a scan slower than the interval cannot starve a foreground GET.
    if (state.pending) return state.pending;
    state.pending = (async () => {
      const revision = state.revision;
      try { accept(state, await scan(state.path), revision); }
      catch {
        if (!state.failed) invalidate(state);
        state.failed = true;
        state.dirty = true;
        fallback(state);
      }
    })().finally(() => { state.pending = null; });
    return state.pending;
  }
  function fallback(state) {
    if (state.closed || state.mode === 'poll') return;
    state.mode = 'poll';
    state.watcher?.close();
    state.watcher = null;
    clearInterval(state.safety);
    state.safety = setInterval(() => { void revalidate(state); }, pollMs).unref();
    state.dirty = true;
    notify(state, 'ready');
  }
  function make(full) {
    const id = randomUUID();
    const state = { path: full, id, version: `${id}:0`, revision: 0, invalidated: ++sequence, mode: 'watch', clients: new Set(), dirty: true, checked: 0 };
    directories.set(full, state);
    state.safety = setInterval(() => { void revalidate(state); }, safetyMs).unref();
    try {
      state.watcher = watch(full, { recursive: false, persistent: false }, () => invalidate(state));
      state.watcher.on('error', () => { fallback(state); void revalidate(state); });
      state.watcher.on('close', () => { if (!state.closed) fallback(state); });
    } catch { fallback(state); }
    return state;
  }
  function dispose(state) {
    state.closed = true;
    directories.delete(state.path);
    clearTimeout(state.debounce);
    clearInterval(state.safety);
    state.watcher?.close();
  }

  async function events(req, res, full, window) {
    if (res.destroyed) return;
    if (!UUID.test(window || '')) throw failure(400, 'a stable window UUID is required');
    if (stopped) throw failure(503, 'files are closing');
    let held = windows.get(window);
    const existing = directories.get(full);
    if (streamCount >= maxStreams || (held?.streams ?? 0) >= maxWindowStreams
      || (!held?.paths.has(full) && (held?.paths.size ?? 0) >= 16)
      || (!existing && directories.size >= maxDirectories)) throw failure(429, 'too many directory streams');
    const state = existing ?? make(full);
    if (!held) { held = { paths: new Map(), streams: 0 }; windows.set(window, held); }
    held.paths.set(full, (held.paths.get(full) ?? 0) + 1);
    held.streams++;
    streamCount++;
    let ended = false, heartbeat, stall;
    // A slow socket holds at most one of each small event. If it never drains,
    // terminate it rather than accumulating data or pinning a watcher forever.
    const queued = new Map();
    const client = { ready: false, send(name, data) {
      if (ended || res.destroyed) return;
      if (res.writableNeedDrain) { queued.set(name, data); return; }
      if (!res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`) && !stall) {
        stall = setTimeout(() => res.destroy(), stalledMs).unref();
      }
    }, end: () => res.destroy() };
    state.clients.add(client);
    const release = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      clearTimeout(stall);
      queued.clear();
      state.clients.delete(client);
      held.streams--;
      const count = held.paths.get(full) - 1;
      if (count) held.paths.set(full, count); else held.paths.delete(full);
      if (!held.streams) windows.delete(window);
      streamCount--;
      if (!state.clients.size) dispose(state);
    };
    res.once('close', release);
    res.once('error', () => { release(); res.destroy(); });
    res.on('drain', () => {
      clearTimeout(stall); stall = null;
      for (const [name, data] of queued) { queued.delete(name); client.send(name, data); if (res.writableNeedDrain) break; }
    });
    try {
      // Validate before sending SSE headers so nonexistent/unreadable folders
      // still get an ordinary HTTP error. Watch is installed before this scan.
      await state.pending;
      const revision = state.revision;
      const result = await scan(full);
      accept(state, result, revision);
      if (ended || stopped || res.destroyed) { release(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      res.flushHeaders?.();
      client.ready = true;
      client.send('ready', { path: full, mode: state.mode, version: state.version });
      heartbeat = setInterval(() => client.send('heartbeat', { path: full, version: state.version, mode: state.mode }), heartbeatMs).unref();
    } catch (error) { release(); if (res.headersSent) res.destroy(); throw error; }
  }

  return {
    events,
    async list(full, ifNoneMatch) {
      const state = directories.get(full);
      const matches = etag => String(ifNoneMatch || '').split(',').some(tag => tag.trim().replace(/^W\//, '') === etag || tag.trim() === '*');
      const fresh = () => state?.mode === 'watch' && !state.closed && !state.dirty && !state.pending && state.etag
        && Date.now() - state.checked < validMs && matches(state.etag);
      if (fresh()) return { etag: state.etag, unchanged: true };
      await state?.pending;
      // Share the safety scan too: an unchanged folder needs no second walk
      // or allocation of file objects just because its timers coincided.
      if (fresh()) return { etag: state.etag, unchanged: true };
      const revision = state?.revision;
      const result = await scan(full, true);
      if (state) accept(state, result, revision);
      return { ...result, unchanged: matches(result.etag) };
    },
    close() {
      stopped = true;
      for (const state of directories.values()) {
        for (const client of [...state.clients]) client.end();
        if (!state.closed) dispose(state);
      }
    },
  };
}
