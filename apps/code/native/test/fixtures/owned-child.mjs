// Test-owned detached children only; never signal a person's browser/service.
import { spawn } from 'node:child_process';

const wait = async (promise, timeout) => {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => {
      timer = setTimeout(() => resolve(false), timeout);
    })]);
  } finally { clearTimeout(timer); }
};

export function spawnOwnedChild(command, args, options) {
  const child = spawn(command, args, { ...options, detached: true });
  // Register at spawn, not teardown: a signal exit has a null exitCode, and
  // a descendant can keep stdio open after the parent's exit event.
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const closed = new Promise(resolve => child.once('close', resolve));
  const reaped = Promise.all([exited, closed]);
  const kill = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    // A desktop launcher may move Electron outside its original group.
    if (child.exitCode == null && child.signalCode == null) child.kill(signal);
  };
  return { child, async stop(timeout = 3000) {
    try {
      kill('SIGTERM');
      if (!await wait(reaped, timeout)) {
        kill('SIGKILL');
        if (!await wait(reaped, timeout)) throw new Error(`Fixture child ${child.pid} did not close after SIGKILL`);
      }
    } finally { kill('SIGKILL'); }
  } };
}
