// Explicit parent-operated cutover guard. This never restarts/reloads a service,
// edits original histories or enables a second execution path.
import { mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function activationCheck({ prefix, agentDir }) {
  if (!prefix || !agentDir) throw new Error('Use explicit --prefix and --agent-dir paths');
  const blockers = [], roots = new Set();
  for (const root of [join(prefix, 'subagents'), join(agentDir, 'subagents')]) {
    const canonical = await realpath(root).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (!canonical || roots.has(canonical)) continue;
    roots.add(canonical);
    for (const owner of await readdir(root, { withFileTypes: true })) {
      if (!owner.isDirectory()) continue;
      const ownerDir = join(root, owner.name);
      let ids;
      try { ids = await readdir(ownerDir); }
      catch { blockers.push({ state: 'unreadable', file: ownerDir }); continue; }
      for (const id of ids) {
        if (!/^[a-f0-9]{32}$/.test(id)) continue;
        const file = join(ownerDir, id, 'state.json');
        try {
          const task = JSON.parse(await readFile(file, 'utf8'));
          if (!['done', 'failed', 'cancelled'].includes(task.status)) blockers.push({ id, state: task.status || 'unknown', file });
        } catch { blockers.push({ id, state: 'unreadable', file }); }
      }
    }
  }
  return { ready: blockers.length === 0, blockers, note: 'Read-only metadata gate. Wait for or reconcile each independent worker before dependency replacement; never relaunch its old prompt. Install and verify the persistent rollback guard separately.' };
}

export async function armRollbackGuard({ repo, prefix, unitDir, node = process.execPath }) {
  if (![repo, prefix, unitDir, node].every(p => typeof p === 'string' && p.startsWith('/') && !/[\n\r%"\\$]/.test(p))) throw new Error('Guard paths must be explicit absolute paths without systemd metacharacters');
  const dir = join(prefix, 'pi-durable'), guard = join(dir, 'rollback-guard.mjs');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Copied OUTSIDE the checkout, so git revert cannot remove its protection.
  const code = `import { readFileSync } from 'node:fs';
const repo = ${JSON.stringify(repo)};
let supported = false;
try {
  const source = readFileSync(repo + '/apps/code/native/runtime.mjs', 'utf8');
  const pkg = JSON.parse(readFileSync(repo + '/package.json', 'utf8'));
  supported = source.includes("export const PI_HISTORY_FORMAT = 'durable-sqlite-v1'") && Boolean(pkg.dependencies?.['@earendil-works/pi-durable']);
} catch {}
if (!supported) {
  console.error('Pi Durable rollback refused: original JSONL does not contain SQLite continuation. Keep the databases and WAL. Export/reconcile histories from the candidate before deliberately removing this persistent guard. A code revert is not a history rollback.');
  process.exitCode = 1;
}
`;
  await writeFile(guard, code, { mode: 0o600 });
  const dropin = join(unitDir, 'imperfect-code.service.d');
  await mkdir(dropin, { recursive: true, mode: 0o700 });
  await writeFile(join(dropin, 'pi-durable.conf'), `[Service]\nExecStartPre="${node.replaceAll('"', '\\"')}" "${guard.replaceAll('"', '\\"')}"\n`, { mode: 0o600 });
  return { guard, dropin: join(dropin, 'pi-durable.conf'), next: 'Parent must daemon-reload and verify this ExecStartPre before activation. No service was reloaded or restarted.' };
}

export async function exportHistory({ history, out }) {
  if (!history || !out || resolve(history) === resolve(out)) throw new Error('Specify a distinct new export path');
  const { DatabaseSync, backup } = await import('node:sqlite');
  const { readDurableArchive } = await import('../apps/code/native/durable-archive.mjs');
  // SQLite's backup includes WAL consistently AND preserves tasks/documents/
  // admissions, not just messages. Read the reconciliation view from that exact
  // snapshot. No Harness, writer, scheduler or model is opened.
  const snapshot = `${out}.sqlite`;
  const reserved = await open(snapshot, 'wx', 0o600); await reserved.close();
  const db = new DatabaseSync(history, { readOnly: true });
  try { await backup(db, snapshot); } finally { db.close(); }
  const archive = await readDurableArchive(snapshot);
  const file = await open(out, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ format: 'imperfect-durable-reconciliation-v1', snapshot, warning: 'Not a classic Pi resume file. Reconcile active context, uncertain actions and pending admissions explicitly before rollback.', ...archive })); await file.sync(); }
  finally { await file.close(); }
  return { out, snapshot, format: 'imperfect-durable-reconciliation-v1' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, ...args] = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !args[i + 1]) throw new Error('Use explicit --name value arguments');
    options[args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = args[i + 1];
  }
  const result = action === 'guard' ? await armRollbackGuard(options) : action === 'export' ? await exportHistory(options) : action === 'check' ? await activationCheck(options) : null;
  if (!result) throw new Error('Use check --prefix PATH --agent-dir PATH; guard --repo PATH --prefix PATH --unit-dir PATH; or export --history FILE --out NEW_FILE');
  console.log(JSON.stringify(result));
  if (action === 'check' && !result.ready) process.exitCode = 1;
}
