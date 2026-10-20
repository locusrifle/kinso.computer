#!/usr/bin/env node
// Independent systemd ExecStopPost; never rely on a child's finally/trap.
import { constants as osConstants } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkerLedger, atomicWrite, withLedgerLock } from '../system/pulse-ledger.mjs';

export function completionFromSystemd(env = process.env, wrapperExit = null) {
  const result = env.SERVICE_RESULT || 'unknown';
  const code = env.EXIT_CODE;
  const status = env.EXIT_STATUS;
  if (code === 'killed' || code === 'dumped') {
    const signal = String(status || 'unknown');
    const number = /^\d+$/.test(signal) ? Number(signal) : osConstants.signals[signal.startsWith('SIG') ? signal : `SIG${signal}`];
    return { exit: Math.min(255, 128 + (number || 0)), signal, result };
  }
  if (result !== 'success' && result !== 'unknown') {
    const exit = code === 'exited' && /^\d+$/.test(status || '') && Number(status) > 0 ? Number(status) : 1;
    return { exit: Math.min(255, exit), result };
  }
  if (code === 'exited' && /^\d+$/.test(status || '')) return { exit: Math.min(255, Number(status)), result };
  if (Number.isInteger(wrapperExit) && wrapperExit >= 0 && wrapperExit <= 255) return { exit: wrapperExit, result };
  return { exit: result === 'success' ? 0 : 1, result };
}

export async function completeWorker(configPath, env = process.env) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const ledger = createWorkerLedger(config);
  const old = await ledger.get(config.name);
  // An old unit must not overwrite a reused name's exit file or test gate.
  if (old.runId !== config.runId) return old;
  const raw = await readFile(join(config.taskDir, 'exit'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const wrapperExit = /^\d+\s*$/.test(raw) ? Number(raw.trim()) : null;
  const completion = completionFromSystemd(env, wrapperExit);
  const record = await ledger.finish(config.name, { ...completion, runId: config.runId });
  if (record.runId !== config.runId) return record;
  await atomicWrite(join(config.taskDir, 'exit'), `${record.exit}\n`);
  if (config.kind === 'test') {
    const path = join(config.stateDir, 'test-gate.json');
    await withLedgerLock(`${path}.lock`, async () => {
      const previous = await readFile(path, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return {}; throw error; });
      const lastSuccess = [previous.lastSuccess, ...(record.exit === 0 ? [record.finished] : [])].filter(Boolean).sort().at(-1) || null;
      const receipt = { name: record.name, unit: record.unit, runId: record.runId, exit: record.exit, finished: record.finished, ok: record.exit === 0, lastSuccess };
      const gate = previous.finished && previous.finished > record.finished ? { ...previous, lastSuccess } : receipt;
      await atomicWrite(path, `${JSON.stringify(gate)}\n`);
      if (record.exit === 0 && lastSuccess === record.finished) await atomicWrite(join(config.stateDir, 'test-gate-success.json'), `${JSON.stringify(receipt)}\n`);
    });
  }
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  completeWorker(process.argv[2]).catch(error => { console.error(`worker completion: ${error.message}`); process.exitCode = 1; });
}
