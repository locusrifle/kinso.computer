// imperfect's machine on a Mac, kept running: what systemd's
// imperfect-code.service is on Linux (install.sh). imperfect.app starts this
// (desktop/electron/mac.mjs), detached, so it outlives the window; it starts
// system/start.mjs and starts it again three seconds after it stops (an
// update taken, a restart asked for, a crash), backing off to a minute while
// it keeps falling over at once. Stopped (SIGTERM, SIGINT), it asks the
// machine to stop the way systemd does, and waits however long that takes:
// the machine lets every agent's turn finish first.
//
// One keeper at a time: ~/.imperfect/keeper.json says which is running (its
// pid, and when that process began), and a second one leaves at once. What
// the machine says goes to ~/.imperfect/logs/imperfect.log, the last 10 MB
// of it, the 10 MB before that in imperfect.log.1.
//
//   node desktop/mac/keeper.mjs            keep it running
//   node desktop/mac/keeper.mjs stop       stop the keeper and the machine
//   node desktop/mac/keeper.mjs status     running or not, and its pids
import { spawn, execFile } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const prefix = process.env.IMPERFECT_PREFIX || join(homedir(), '.imperfect');
const root = fileURLToPath(new URL('../..', import.meta.url));
const record = join(prefix, 'keeper.json');
const logs = join(prefix, 'logs');
const log = join(logs, 'imperfect.log');
const LOG_MOST = 10 * 1024 * 1024;
// What is kept: the machine (a test names a stand-in).
const machine = process.env.IMPERFECT_KEEPER_SCRIPT || join(root, 'system/start.mjs');

const startedAt = pid => new Promise(resolve => execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 3000, env: { ...process.env, LC_ALL: 'C' } }, (error, out) => resolve(error ? '' : String(out).trim())));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function running() {
  try {
    const held = JSON.parse(readFileSync(record, 'utf8'));
    if (held.pid && alive(held.pid) && (!held.started || await startedAt(held.pid) === held.started)) return held;
  } catch { /* none */ }
  return null;
}
const say = text => process.stdout.write(`${text}\n`);

const asked = process.argv[2] ?? 'keep';
if (asked === 'status') {
  const held = await running();
  say(held ? `keeping imperfect: keeper ${held.pid}, machine ${held.machine ?? 'starting'}` : 'not running');
  process.exit(held ? 0 : 3);
}
if (asked === 'stop') {
  const held = await running();
  if (!held) { say('not running'); process.exit(0); }
  process.kill(held.pid, 'SIGTERM');
  say('stopping once no agent is working');
  while (alive(held.pid)) await new Promise(resolve => setTimeout(resolve, 250));
  say('stopped');
  process.exit(0);
}
if (asked !== 'keep') { say('usage: node desktop/mac/keeper.mjs [keep|stop|status]'); process.exit(2); }

mkdirSync(logs, { recursive: true, mode: 0o700 });
if (await running()) process.exit(0);
const me = { pid: process.pid, started: await startedAt(process.pid), root, at: new Date().toISOString() };
const keep = more => writeFileSync(record, JSON.stringify({ ...me, ...more }), { mode: 0o600 });
keep({});
// Two started at once: the one whose word stands keeps; the other goes.
await new Promise(resolve => setTimeout(resolve, 200));
if ((await running())?.pid !== process.pid) process.exit(0);

function output() {
  try { if (statSync(log).size > LOG_MOST) renameSync(log, `${log}.1`); } catch { /* new */ }
  return openSync(log, 'a', 0o600);
}
const stamp = text => { const fd = output(); try { writeFileSync(fd, `${new Date().toISOString()} keeper: ${text}\n`); } finally { closeSync(fd); } };

let child = null, stopping = false, quickFalls = 0;
function start() {
  const fd = output();
  const began = Date.now();
  child = spawn(process.execPath, [machine], { cwd: root, env: process.env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  keep({ machine: child.pid });
  stamp(`machine ${child.pid} started`);
  child.on('exit', (code, signal) => {
    child = null;
    keep({});
    stamp(`machine stopped (${signal ?? code})`);
    if (stopping) { rmSync(record, { force: true }); process.exit(0); }
    quickFalls = Date.now() - began < 15_000 ? quickFalls + 1 : 0;
    setTimeout(start, Math.min(60_000, 3000 * 2 ** Math.max(0, quickFalls - 1)));
  });
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    if (signal === 'SIGHUP') return;
    if (stopping) return;
    stopping = true;
    stamp(`asked to stop (${signal})`);
    if (child) child.kill('SIGTERM');
    else { rmSync(record, { force: true }); process.exit(0); }
  });
}
start();
