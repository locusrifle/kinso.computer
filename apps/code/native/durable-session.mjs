import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { processLock } from '@earendil-works/chord/node';
import { dirname, join } from 'node:path';
import { buildSessionContext, migrateSessionEntries, convertToLlm, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent';
import { defineDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { bootId, ownerRecord, ownerHolds, parseOwner } from './owner.mjs';

export const context = (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT;
export const SessionInfo = defineDoc({ kind: 'imperfect.session', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ id: randomUUID(), cwd: '', name: '', created: Date.now(), review: [] }) });
export const cleanJSON = value => JSON.parse(JSON.stringify(value));

// Do NOT open a legacy file with SessionManager: open migrates it in place.
// Keep the entire original tree in one immutable archive entry, and import only
// the selected leaf's projected context for the model. Originals stay byte-identical.
export async function legacySession(path) {
  const bytes = await readFile(path);
  // Reject invalid UTF-8 rather than archiving replacement characters as the
  // alleged original. Valid JSONL (including CRLF/whitespace) stays verbatim.
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const rows = source.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const header = rows[0];
  if (header?.type !== 'session' || typeof header.id !== 'string' || !header.id || typeof header.cwd !== 'string' || !header.cwd || (header.version !== undefined && ![1, 2, 3].includes(header.version))) throw new Error('Unsupported Pi history; original preserved, refusing a fresh conversation');
  migrateSessionEntries(rows);
  const entries = rows.slice(1), ids = new Set();
  const supported = new Set(['message', 'thinking_level_change', 'model_change', 'usage', 'compaction', 'branch_summary', 'custom', 'custom_message', 'context_edit', 'label', 'session_info']);
  for (const entry of entries) {
    if (!supported.has(entry.type) || typeof entry.id !== 'string' || ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId))) throw new Error('Unsupported or ambiguous Pi history tree; original preserved, refusing a fresh conversation');
    ids.add(entry.id);
  }
  const projected = buildSessionContext(entries);
  return { source, header, entries, projected, messages: convertToLlm(projected.messages), hash: createHash('sha256').update(bytes).digest('hex') };
}

// One live writer per database, including two tabs in the same process.
// Never unlink someone else's lock just because its PID belongs to an old boot.
export async function openSessionFile({ cwd, agentDir, sessionDir, sessionPath }) {
  let legacy, saved;
  if (sessionPath) {
    const file = await stat(sessionPath).catch(() => null);
    if (!file?.isFile() || !file.size) throw new Error(`Pi session ${sessionPath} was not found or is empty; refusing to start a new one`);
    if (file.nlink > 1) throw new Error('Hard-linked Pi histories cannot safely share SQLite WAL ownership; use one canonical file');
    sessionPath = await realpath(sessionPath);
    if (!sessionPath.endsWith('.sqlite')) legacy = await legacySession(sessionPath);
    else saved = (await import('./durable-archive.mjs')).readDurableArchive(sessionPath).info;
  }
  const dir = sessionDir || join(agentDir, 'sessions', `--${cwd.replaceAll('/', '-')}--`);
  const target = sessionPath ? legacy ? `${sessionPath}.durable.sqlite` : sessionPath : join(dir, `${new Date().toISOString().replaceAll(':', '-')}_${randomUUID()}.sqlite`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const path = await realpath(target).catch(error => { if (error.code !== 'ENOENT') throw error; return realpath(dirname(target)).then(dir => join(dir, target.slice(dirname(target).length + 1))); });
  // Serialize stale-file takeover too. Checking a PID then unlinking a file is
  // not a compare-and-swap: two contenders could unlink the winner's new lock.
  let unlock;
  try { unlock = await processLock(`imperfect-pi:${path}`); }
  catch { throw new Error('Pi history already has a writer; refusing to open it twice'); }
  const lockPath = `${path}.owner`, record = { ...await ownerRecord(), token: randomUUID() };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  let lock;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { lock = await open(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const text = await readFile(lockPath, 'utf8');
        const held = parseOwner(text);
        if (!held || await ownerHolds(held, { boot: await bootId(), alive })) throw new Error('Pi history already has a writer (or an unverifiable lock); refusing to open it twice');
        if (await readFile(lockPath, 'utf8') !== text) throw new Error('Pi history ownership changed; retry opening it');
        await unlink(lockPath);
      }
    }
    if (!lock) throw new Error('Could not acquire Pi history ownership');
    await lock.writeFile(JSON.stringify(record)); await lock.close();
  } catch (error) {
    if (lock) { await lock.close().catch(() => {}); await unlink(lockPath).catch(() => {}); }
    await unlock(); throw error;
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      if (await readFile(lockPath, 'utf8').catch(() => '') === JSON.stringify(record)) await unlink(lockPath);
    } finally { await unlock(); }
  };
  try {
    if (legacy && (await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))?.size) {
      // Verify a prior import before opening a writer. A changed Classic
      // branch (or an unrelated/corrupt sidecar) must never be silently adopted.
      const imported = (await import('./durable-archive.mjs')).readDurableArchive(path).info.imported;
      if (imported?.sourceId !== legacy.header.id || imported?.sha256 !== legacy.hash) throw new Error('Original Pi history changed since import; refusing to silently ignore its newer branch. Both histories are preserved.');
    }
    // Precreate privately. The containing directory is private while WAL is live.
    const file = await open(path, 'a', 0o600); await file.close();
    const storage = await openNodeSqliteStorage(path);
    return { path, legacy, storage, release, cwd: saved?.cwd || legacy?.header.cwd || cwd };
  } catch (error) { await release(); throw error; }
}

export async function initializeSession(tx, id, { cwd, legacy }) {
  const info = await tx.doc(SessionInfo, id);
  info.cwd = legacy?.header.cwd || cwd;
  if (!legacy) return;
  info.id = legacy.header.id;
  info.name = legacy.entries.findLast(entry => entry.type === 'session_info')?.name || '';
  info.imported = { sourceId: legacy.header.id, sha256: legacy.hash };
  await tx.appendEntry(id, { kind: 'imperfect.legacy', data: { source: legacy.source, entries: legacy.entries } });
  await tx.appendEntry(id, { kind: 'imperfect.notice', data: { text: 'Imported Pi history into Durable. The original JSONL is unchanged; terminal Pi will not see this continuation.' } });
  for (const message of legacy.messages) await tx.appendEntry(id, { kind: 'imperfect.imported-context', model: [cleanJSON(message)] });
  // Seed reviewed notifications as settled admissions, not a second completion
  // ledger. Only a final successful answer proves a review ended; tool calls
  // and failed/partial answers after a notification do not.
  const answered = legacy.entries.findLastIndex(e => e.type === 'message' && e.message?.role === 'assistant' && ['stop', 'length'].includes(e.message.stopReason));
  const reviewed = new Set(legacy.entries.slice(0, Math.max(0, answered)).filter(e => e.type === 'custom_message' && ['subagent-completion', 'subagent-review-recovery'].includes(e.customType) && e.details?.owner === legacy.header.id).flatMap(e => [...(e.details.ids || []), ...(e.details.recoveryIds || [])]));
  for (const task of reviewed) if (/^[a-f0-9]{32}$/.test(task)) await tx.createSubmission({ conversationId: id, type: 'input', requestId: `worker:${legacy.header.id}:${task}`, status: 'unanswered', reason: 'legacy-reviewed' });
  // No legacy tool is scheduled. Unmatched calls require review before a new
  // request: the old process may have performed them without writing a result.
  const results = new Set(legacy.messages.filter(m => m.role === 'toolResult').map(m => m.toolCallId));
  info.review = legacy.messages.flatMap(m => m.role === 'assistant' ? m.content.filter(b => b.type === 'toolCall' && !results.has(b.id)).map(b => ({ name: b.name, arguments: b.arguments, reason: 'Legacy tool call has no recorded result' })) : []);
}

// The model projection applies compaction and context edits; the person's
// transcript must instead keep the unedited messages on the selected branch.
function legacyTranscript(entries) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const branch = [];
  for (let entry = entries.at(-1); entry; entry = byId.get(entry.parentId)) branch.push(entry);
  return branch.reverse().flatMap(sessionEntryToContextMessages).filter(message => message.role !== 'system');
}

export function transcript(entries, { live } = {}) {
  const lastAttempt = new Map();
  for (const entry of entries) {
    if (entry.kind === 'pi.assistant' && entry.byTaskId !== undefined) lastAttempt.set(entry.byTaskId, entry.id);
  }
  function displayMessage(message, entry) {
    const failed = message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason);
    const superseded = entry.byTaskId !== undefined && lastAttempt.get(entry.byTaskId) !== entry.id;
    const continuing = entry.byTaskId !== undefined && live?.run?.taskId === entry.byTaskId;
    if (!failed || (!superseded && !continuing)) return message;
    // Retain content and response accounting, but paint only terminal errors.
    // Neither the committed attempt nor later model context is rewritten.
    const { errorMessage, ...display } = message;
    return display;
  }
  return entries.flatMap(entry => {
    if (entry.kind === 'imperfect.legacy') return legacyTranscript(entry.data.entries);
    if (entry.kind === 'imperfect.worker-completion') return [{ role: 'custom', customType: 'subagent-completion', display: true, content: entry.model?.[0]?.content || [], details: entry.data }];
    if (entry.kind === 'imperfect.notice') return [{ role: 'assistant', content: [], errorMessage: entry.data.text, timestamp: entry.timestamp }];
    if (entry.kind === 'imperfect.imported-context' || entry.kind === 'pi.system') return [];
    if (entry.kind === 'pi.compaction') return [{ role: 'compactionSummary', summary: entry.model?.[0]?.content?.[0]?.text || '', timestamp: entry.timestamp }];
    return entry.model?.filter(m => m.role !== 'system').map(message => displayMessage(message, entry)) ?? [];
  });
}
