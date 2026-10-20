// Run in systemd-run --user --collect -p Nice=10. A failed run cannot erase
// the last successful gate, and every completion leaves a small Pulse receipt.
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { paths, resolvePrefix } from '../system/machine.mjs';
import { smallJson } from '../system/doctor.mjs';
import { atomicWrite, withLedgerLock } from '../system/pulse-ledger.mjs';
export async function testGate({ stateDir = paths(resolvePrefix()).state, cwd = resolve(import.meta.dirname, '..'), command = ['npm', 'test'], launch = spawn, now = () => new Date().toISOString() } = {}) {
  const path = join(stateDir, 'test-gate.json');
  const started = now();
  let commit = null;
  try { commit = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 3000 }).trim(); } catch {}
  const exit = await new Promise(resolveExit => {
    const child = launch(command[0], command.slice(1), { cwd, stdio: 'inherit', env: process.env });
    child.once('error', () => resolveExit(127));
    child.once('exit', code => resolveExit(Number.isInteger(code) ? code : 128));
  });
  const finished = now();
  await withLedgerLock(`${path}.lock`, async () => {
    const previous = await smallJson(path).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
    const lastSuccess = [previous.lastSuccess, ...(exit === 0 ? [finished] : [])].filter(Boolean).sort().at(-1) ?? null;
    const receipt = { started, finished, exit, commit, lastSuccess, scope: 'full' };
    await atomicWrite(path, `${JSON.stringify(previous.finished && previous.finished > finished ? { ...previous, lastSuccess } : receipt)}\n`);
  });
  return exit;
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2), at = args.indexOf('--state-dir');
  const stateDir = at >= 0 ? resolve(args[at + 1]) : undefined;
  if (at >= 0) args.splice(at, 2);
  const divider = args.indexOf('--'), command = divider >= 0 ? args.slice(divider + 1) : ['npm', 'test'];
  process.exitCode = await testGate({ stateDir, command });
}
