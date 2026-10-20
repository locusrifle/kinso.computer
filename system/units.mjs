// The small systemd command surface imperfect uses, backed on a Mac by a
// detached supervisor. The supervisor, not the app, owns restarts and deadlines.
// Units are process groups, not cgroups: children that deliberately detach escape.
import { execFile, spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = /^[A-Za-z0-9][\w.@-]{0,200}$/;
const unitName = name => String(name ?? '').replace(/\.service$/, '');
const refused = (message, code = 1) => Object.assign(new Error(message), { code });
const runner = fileURLToPath(new URL('./units-runner.mjs', import.meta.url));

// Empty means unknown, never permission to signal an unverified PID.
export const processStart = pid => new Promise(resolve => {
  execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 3000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (error, stdout) => resolve(error ? '' : String(stdout).trim()));
});

export function parseRun(args) {
  const out = { name: '', cwd: '', env: {}, umask: null, maxSeconds: 0, quiet: false, restart: 'no', restartSeconds: 0, command: [] };
  const end = args.indexOf('--');
  if (end < 0 || end === args.length - 1) throw refused('systemd-run: no command');
  for (const arg of args.slice(0, end)) {
    let match;
    if (arg === '--user' || arg === '--collect' || arg === '--quiet') continue;
    if ((match = /^--unit=(.+)$/.exec(arg))) out.name = unitName(match[1]);
    else if ((match = /^--working-directory=(.+)$/.exec(arg))) out.cwd = match[1];
    else if ((match = /^--setenv=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(arg))) out.env[match[1]] = match[2];
    else if ((match = /^--property=UMask=([0-7]{3,4})$/.exec(arg))) out.umask = parseInt(match[1], 8);
    else if ((match = /^--property=RuntimeMaxSec=(\d+)(?:s)?$/.exec(arg))) out.maxSeconds = Number(match[1]);
    else if ((match = /^--property=Restart=(no|on-failure)$/.exec(arg))) out.restart = match[1];
    else if ((match = /^--property=RestartSec=(\d+(?:\.\d+)?)(?:s)?$/.exec(arg))) out.restartSeconds = Number(match[1]);
    else if ((match = /^--property=Standard(Output|Error)=null$/.exec(arg))) out.quiet = true;
    else throw refused(`systemd-run: ${arg} is not understood here`);
  }
  if (!NAME.test(out.name)) throw refused('systemd-run: a unit needs a name');
  if (!Number.isFinite(out.maxSeconds * 1000) || !Number.isFinite(out.restartSeconds * 1000)) throw refused('systemd-run: invalid duration');
  out.command = args.slice(end + 1);
  return out;
}

export function createUnits({ dir = join(process.env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'units'),
  logs = join(process.env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'logs'),
  started = processStart, spawnImpl = spawn, kill = process.kill.bind(process), now = Date.now, stopWaitMs = 10_000 } = {}) {
  const file = name => {
    if (!NAME.test(name)) throw refused('Invalid unit name');
    return join(dir, `${name}.json`);
  };
  const record = async name => {
    try { return JSON.parse(await readFile(file(name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw refused(`Cannot read unit ${name}: ${error.message}`); }
  };
  const forget = async (name, held) => {
    if ((await record(name))?.token !== held?.token) return;
    await rm(file(name), { force: true });
    if (held?.token) await rm(`${file(name)}.${held.token}.stop`, { force: true });
  };
  const alive = pid => { try { kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  const same = async held => {
    if (!held?.pid || !alive(held.pid)) return false;
    const identity = await started(held.pid);
    if (!held.started || !identity) throw refused('Cannot verify unit process identity');
    return identity === held.started;
  };
  async function live(name) {
    const held = await record(name);
    return await same(held) ? held : null;
  }
  async function stop(name) {
    const held = await record(name);
    // Persistent intent also fences a supervisor waiting between attempts.
    if (held?.token) await writeFile(`${file(name)}.${held.token}.stop`, '', { mode: 0o600 });
    const signal = async sig => {
      if (!await same(held)) return;
      try { kill(-held.pid, sig); } catch { /* Gone; never fall back to a possibly reused PID. */ }
    };
    await signal('SIGTERM');
    for (const until = now() + stopWaitMs; await same(held) && now() < until;) await new Promise(resolve => setTimeout(resolve, 100));
    await signal('SIGKILL'); // Recheck identity after waiting, too.
    // Do not remove the fence/record while an old supervisor could still write
    // over a replacement registration. A failed stop remains observable.
    for (const until = Date.now() + 1000; await same(held) && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 20));
    if (await same(held)) throw refused('Could not verify that the unit stopped');
    await forget(name, held);
  }
  async function state(name) {
    const held = await live(name);
    if (!held) return (await record(name))?.state === 'failed' ? 'failed' : 'inactive';
    if (held.deadline && now() >= held.deadline) { await stop(name); return 'inactive'; }
    return held.state || 'active'; // Legacy direct-process units remain observable/stoppable.
  }
  const active = async name => ['active', 'activating'].includes(await state(name));
  async function start(options) {
    const { name, quiet, maxSeconds } = options;
    if (await active(name)) throw refused(`Unit ${name}.service already exists`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Serialize registration, including callers in another imperfect process.
    const lock = `${file(name)}.starting`;
    let registration;
    try { registration = await open(lock, 'wx', 0o600); }
    catch { throw refused(`Unit ${name}.service is being started`); }
    let handle, child, held;
    try {
      if (await active(name)) throw refused(`Unit ${name}.service already exists`);
      let output = 'ignore';
      if (!quiet) {
        await mkdir(logs, { recursive: true, mode: 0o700 });
        handle = await open(join(logs, `${name}.log`), 'a', 0o600);
        output = handle.fd;
      }
      child = spawnImpl(process.execPath, [runner], { detached: true, stdio: ['ignore', output, output, 'ipc'] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const identity = await started(child.pid);
      if (!identity) throw new Error('Could not verify supervisor identity');
      held = { pid: child.pid, started: identity, token: randomUUID(), state: 'activating', command: options.command, cwd: options.cwd || homedir(), at: new Date(now()).toISOString(), ...(maxSeconds ? { deadline: now() + maxSeconds * 1000 } : {}) };
      const temp = `${file(name)}.${held.token}.tmp`;
      await writeFile(temp, JSON.stringify(held), { mode: 0o600 });
      await rename(temp, file(name));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Supervisor did not register')), 5000);
        const finish = error => { clearTimeout(timer); child.removeListener('message', ready); child.removeListener('error', finish); child.removeListener('exit', gone); error ? reject(error) : resolve(); };
        const ready = message => { if (message === 'ready') finish(); };
        const gone = () => finish(new Error('Supervisor exited before registration'));
        child.on('message', ready); child.once('error', finish); child.once('exit', gone);
        child.send({ ...options, cwd: held.cwd, deadline: held.deadline, file: file(name), token: held.token, stopWaitMs }, error => { if (error) finish(error); });
      });
    } catch (error) {
      if (held && (await record(name))?.token === held.token) await stop(name);
      throw refused(`Failed to start ${name}.service: ${error.message}`);
    } finally {
      child?.unref();
      if (child?.connected) child.disconnect();
      await handle?.close(); await registration.close(); await rm(lock, { force: true });
    }
  }
  async function running(prefix = '') {
    const names = (await readdir(dir).catch(() => [])).filter(entry => entry.endsWith('.json')).map(entry => entry.slice(0, -5)).filter(name => name.startsWith(prefix));
    const out = [];
    for (const name of names) if (await active(name)) out.push(name);
    return out;
  }
  return { start, stop, active, state, running, record };
}

export function unitCommands(units = createUnits()) {
  return async function run(command, args = []) {
    args = [...args];
    if (command === 'systemd-run') { await units.start(parseRun(args)); return { stdout: '', stderr: '' }; }
    if (command !== 'systemctl') throw refused(`${command} is not on this computer`, 'ENOENT');
    const rest = args.filter(arg => arg !== '--user' && arg !== '--quiet' && arg !== '--no-pager');
    const [verb, ...more] = rest;
    if (verb === 'show') {
      const names = more.filter(arg => !arg.startsWith('-'));
      if (!more.includes('--property=ActiveState') || !more.includes('--value') || names.length !== 1 || more.some(arg => arg.startsWith('-') && !['--property=ActiveState', '--value'].includes(arg))) throw refused('systemctl show: only --property=ActiveState --value is supported');
      const state = await units.state(unitName(names[0]));
      return { stdout: `${state}\n`, stderr: '' };
    }
    if (verb === 'is-active') {
      if (await units.active(unitName(more[0]))) return { stdout: 'active\n', stderr: '' };
      throw Object.assign(refused('inactive', 3), { stdout: 'inactive\n', stderr: '' });
    }
    if (verb === 'stop') { await units.stop(unitName(more[0])); return { stdout: '', stderr: '' }; }
    if (verb === 'list-units') {
      const pattern = more.find(arg => !arg.startsWith('-')) ?? '';
      const names = await units.running(pattern.replace(/\*$/, ''));
      return { stdout: names.map(name => `${name}.service loaded active running ${name}\n`).join(''), stderr: '' };
    }
    throw refused(`systemctl ${verb} is not understood here`);
  };
}
export const ownUnits = (platform = process.platform) => platform === 'darwin';
