import { appendFileSync, mkdirSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CLOSE_AUDIT_LIMIT = 1024 * 1024;
const identifier = value => typeof value === 'string' ? value.slice(0, 256) : null;
const gestures = new Set(['key', 'sidebar-x', 'swipe', 'model-switch-empty', 'tool']);

export function closeAuditRecord(command, tab, connection = {}) {
  const snap = tab?.runtime.snapshot();
  return {
    time: new Date().toISOString(), tabId: identifier(command.tabId),
    sessionId: identifier(snap?.sessionId), agent: tab?.agent ?? null,
    busy: Boolean(snap?.busy || snap?.streaming || snap?.operation || snap?.ui?.dialogs?.length || snap?.queue?.items?.length || tab?.held?.length),
    closeConfirmed: command.closeConfirmed === true,
    gesture: gestures.has(command.gesture) ? command.gesture : 'tool',
    connection: { kind: ['local', 'peer', 'viewer', 'phone'].includes(connection.kind) ? connection.kind : 'local', machine: identifier(connection.machine) },
    accepted: false,
  };
}

export function appendCloseAudit(stateDir, record) {
  if (!stateDir) return;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, 'tab-close.jsonl');
    const line = JSON.stringify(record) + '\n';
    let size = 0;
    try { size = statSync(path).size; } catch { /* first close */ }
    if (size + Buffer.byteLength(line) > CLOSE_AUDIT_LIMIT) {
      // Retain complete recent lines, leaving room for more closes. Bounded
      // reads also recover from an oversized file left by an older version.
      const buffer = Buffer.alloc(Math.min(size, CLOSE_AUDIT_LIMIT / 2));
      const fd = openSync(path, 'r');
      try { readSync(fd, buffer, 0, buffer.length, size - buffer.length); }
      finally { closeSync(fd); }
      const tail = buffer.toString('utf8');
      writeFileSync(path, tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : '', { mode: 0o600 });
    }
    appendFileSync(path, line, { mode: 0o600 });
  } catch {
    // Diagnostics must never change what an explicit close does. No command
    // or error text is logged here: either could carry private conversation.
    console.error('Could not write tab-close audit');
  }
}
