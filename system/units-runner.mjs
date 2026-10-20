// Detached Mac unit supervisor. Its PID stays the process-group leader across
// worker crashes, so stop never has to signal the PID of a departed worker.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function groupEmpty() {
  return new Promise(resolve => {
    const query = execFile('ps', ['-axo', 'pid=,pgid='], { timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(false); // Unknown descendants: never restart over them.
      const members = String(stdout).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      resolve(!members.some(([pid, group]) => group === process.pid && pid !== process.pid && pid !== query.pid));
    });
  });
}

export async function supervise(config, { spawnImpl = spawn, signals = process, signalGroup = sig => process.kill(-process.pid, sig), empty = groupEmpty,
  cancelled = () => existsSync(`${config.file}.${config.token}.stop`), publish = async () => {}, now = Date.now, pause = sleep } = {}) {
  let stopping = false, cleaning = false, expired = false, force, deadlineTimer;
  const stopWaitMs = config.stopWaitMs ?? 10_000;
  const signal = sig => { try { signalGroup(sig); } catch { /* already gone */ } };
  const stop = (broadcast = false) => {
    // Our own cleanup SIGTERM is not a cancellation. A public stop writes its
    // token-scoped fence first, so it cannot be lost even during cleanup.
    if (cleaning && !cancelled() && !expired) return;
    if (stopping) return;
    stopping = true;
    // Public stop already signalled the group. Do not send a second TERM to
    // workers whose one-shot graceful-cancel handler has just been consumed.
    if (broadcast) signal('SIGTERM');
    force = setTimeout(() => signal('SIGKILL'), stopWaitMs);
  };
  const onSignal = () => stop();
  signals.on('SIGTERM', onSignal); signals.on('SIGINT', onSignal);
  const remaining = () => config.deadline ? config.deadline - now() : Infinity;
  // Timers are capped because Node treats overflowing delays as one millisecond.
  const armDeadline = () => {
    if (!config.deadline) return;
    deadlineTimer = setTimeout(() => {
      if (remaining() > 0) armDeadline();
      else { expired = true; stop(true); }
    }, Math.max(0, Math.min(remaining(), 2 ** 31 - 1)));
  };
  armDeadline();
  // A live group leader makes group signals safe even after the worker exited.
  // Do not restart over stubborn descendants: kill the whole unit instead.
  async function cleanGroup() {
    cleaning = true;
    signal('SIGTERM');
    const until = now() + stopWaitMs;
    while (!await empty()) {
      if (now() >= until) { signal('SIGKILL'); return false; }
      await pause(50);
    }
    await pause(0); // Deliver our SIGTERM before leaving cleanup mode.
    cleaning = false;
    return true;
  }
  let final = 'inactive';
  try {
    while (!stopping && !cancelled() && remaining() > 0) {
      const [program, ...args] = config.umask == null ? config.command : ['/bin/sh', '-c', `umask ${config.umask.toString(8).padStart(4, '0')} && exec "$@"`, 'sh', ...config.command];
      const result = await new Promise(resolve => {
        let child;
        try {
          child = spawnImpl(program, args, { cwd: config.cwd, env: { ...process.env, ...config.env }, stdio: ['ignore', 'inherit', 'inherit'] });
        } catch (error) { resolve({ error }); return; }
        child.once('spawn', () => { void publish('active').catch(() => stop(true)); });
        child.once('error', error => resolve({ error }));
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const failed = Boolean(result.error || result.signal || result.code !== 0);
      final = failed || expired ? 'failed' : 'inactive';
      if (!await cleanGroup()) { final = 'failed'; break; }
      if (stopping || cancelled() || remaining() <= 0 || !failed || config.restart !== 'on-failure') break;
      await publish('activating');
      // Poll the durable stop fence as well as listening for signals. The
      // original deadline spans all attempts; it is never reset by a crash.
      const next = now() + (config.restartSeconds ?? 0) * 1000;
      while (!stopping && !cancelled() && remaining() > 0 && now() < next) await pause(Math.min(100, next - now()));
    }
    await publish(expired || remaining() <= 0 ? 'failed' : stopping || cancelled() ? 'inactive' : final);
  } finally {
    clearTimeout(force); clearTimeout(deadlineTimer);
    signals.removeListener('SIGTERM', onSignal); signals.removeListener('SIGINT', onSignal);
  }
}

async function main() {
  // A parent dying before registration must not leave an idle supervisor.
  const timeout = setTimeout(() => process.exit(1), 10_000);
  const config = await new Promise(resolve => process.once('message', resolve));
  clearTimeout(timeout);
  let writes = Promise.resolve();
  const publish = state => writes = writes.then(async () => {
    const held = JSON.parse(await readFile(config.file, 'utf8'));
    if (held.token !== config.token || held.pid !== process.pid) throw new Error('Unit ownership changed');
    const temp = `${config.file}.${config.token}.tmp`;
    await writeFile(temp, JSON.stringify({ ...held, state }), { mode: 0o600 });
    await rename(temp, config.file);
  });
  // Ready means ownership and signal handling have been installed, not that
  // the command succeeded (systemd-run also returns before service completion).
  const running = supervise(config, { publish });
  if (process.connected) process.send('ready');
  await running;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { process.exitCode = 1; });
