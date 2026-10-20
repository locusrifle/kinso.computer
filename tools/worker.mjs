#!/usr/bin/env node
// Noninteractive, argv-only workers; completion belongs to systemd, not Pi.
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWorkerLedger, atomicWrite, defaultStateDir, defaultMemoryDir } from '../system/pulse-ledger.mjs';
import { completeWorker } from './worker-complete.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const workerName = name => {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(name)) throw new Error('Worker name must be 1–48 letters, digits, underscore or hyphen');
  return name;
};
export async function findExecutable(name, env = process.env) {
  for (const dir of (env.PATH || '').split(':').filter(Boolean)) {
    const path = resolve(dir, name);
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; } catch { /* Try next PATH entry. */ }
  }
  return null;
}

export function runUnit(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-8192); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? done({ stdout, stderr }) : reject(new Error(`Unit launch failed (${signal || code}): ${stderr.trim()}`)));
  });
}

// This is systemd command-line quoting, NOT shell quoting. Prevent both
// environment expansion ($$) and specifier expansion (%%) in ExecStopPost.
export const systemdQuote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;

export function buildUnitInvocation(config, configPath, { node = process.execPath, wrapper = null } = {}) {
  const hook = [node, join(here, 'worker-complete.mjs'), configPath].map(systemdQuote).join(' ');
  const argv = [node, join(here, 'worker-execute.mjs'), configPath].map(value => value.replace(/%/g, '%%'));
  const args = ['--user', '--collect', '--slice=imperfect-workers.slice', `--unit=${config.unit}`, '--property=Nice=10', '--property=Type=exec', '--property=KillMode=control-group', '--property=TimeoutStopSec=30', `--property=ExecStopPost=${hook}`, '--expand-environment=no', '--', ...argv];
  if (wrapper) {
    // Use the OS wrapper's synchronous executor INSIDE our one hook-owning
    // unit. Its public submit command detaches again, leaving a crash gap.
    // The shared raw unit format is also validated by imperfect-run.py.
    args.splice(args.indexOf('--') + 1, 0, wrapper, 'execute', '--unit', config.unit.replace(/\.service$/, ''), '--');
  }
  return { command: 'systemd-run', args };
}

export function createWorkerLauncher(options = {}) {
  const stateDir = resolve(options.stateDir || defaultStateDir());
  const memoryDir = resolve(options.memoryDir || defaultMemoryDir());
  const tasksDir = resolve(options.tasksDir || join(process.env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'tasks'));
  const env = options.env || process.env;
  const ledger = createWorkerLedger({ ...options, stateDir, memoryDir });
  return {
    ledger,
    async start(name, input = {}) {
      workerName(name);
      const kind = input.kind || 'sol';
      if (!['sol', 'claude', 'test', 'job'].includes(kind)) throw new Error('kind must be sol, claude, test, or job');
      if (!input.prompt) throw new Error('--prompt file is required');
      const prompt = await readFile(resolve(input.prompt), 'utf8');
      const worktree = input.worktree ? resolve(input.worktree) : null;
      if (worktree && !(await stat(worktree)).isDirectory()) throw new Error('Worktree must be an existing directory');
      const taskDir = resolve(input.taskDir || join(tasksDir, name));
      // Reusing a name gets a new run directory rather than erasing old logs.
      const runId = randomUUID();
      const old = await ledger.get(name).catch(error => { if (error.message.startsWith('Unknown worker:')) return null; throw error; });
      if (old && (!old.finished || !old.acknowledged)) throw new Error('Worker is running or unacknowledged; acknowledge before reuse');
      const actualDir = old ? join(taskDir, 'runs', runId) : taskDir;
      if (!old) {
        for (const file of ['worker.json', 'out.jsonl', 'err.log', 'exit']) {
          try { await stat(join(actualDir, file)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          throw new Error(`Task directory already contains ${file}; choose a new name or --task-dir rather than overwrite logs`);
        }
      }
      const command = input.command;
      if (['test', 'job'].includes(kind) && (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string' || !arg.length || arg.includes('\0')))) throw new Error('test/job requires -- executable [args...]');
      const model = input.model || (kind === 'sol' ? 'openai-codex/gpt-6.1-sol' : undefined);
      if (model && (typeof model !== 'string' || model.includes('\0'))) throw new Error('Invalid model');
      const thinking = input.thinking || 'high';
      if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('Invalid thinking level');
      const config = { name, runId, kind, unit: `imperfect-worker-${name}-${runId.replaceAll('-', '').slice(0, 12)}.service`, taskDir: actualDir, worktree, stateDir, memoryDir, model, thinking, ...(command ? { command } : {}), env: { HOME: env.HOME || homedir(), PATH: env.PATH || '/usr/bin:/bin', PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR || join(process.env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'data', 'agent') } };
      const wrapper = options.wrapper === undefined ? await findExecutable('imperfect-run', env) : options.wrapper;
      // Record ownership first. A launch failure itself has a raised completion.
      await ledger.start({ name, runId, kind, unit: config.unit, taskDir: actualDir, worktree, model });
      const configPath = join(actualDir, 'worker.json');
      try {
        await mkdir(join(actualDir, 'session'), { recursive: true, mode: 0o700 });
        await atomicWrite(join(actualDir, 'prompt.md'), prompt);
        await atomicWrite(join(actualDir, 'out.jsonl'), '');
        await atomicWrite(join(actualDir, 'err.log'), '');
        await atomicWrite(configPath, `${JSON.stringify(config)}\n`);
        const invocation = buildUnitInvocation(config, configPath, { wrapper, node: options.node || process.execPath });
        await (options.runner || runUnit)(invocation.command, invocation.args, { env });
      } catch (error) {
        await ledger.finish(name, { runId, exit: 1, result: 'launch-failed' });
        // A task-dir permission/disk error must not prevent the state-dir
        // failure record or its independent memory notice from being raised.
        await atomicWrite(join(actualDir, 'err.log'), `worker launch: ${error.message}\n`).catch(() => {});
        await atomicWrite(join(actualDir, 'exit'), '1\n').catch(() => {});
        throw error;
      }
      return ledger.get(name);
    },
    list: () => ledger.list(),
    ack: name => ledger.ack(workerName(name)),
    async logs(name, output = process.stdout) {
      const record = await ledger.get(workerName(name));
      // Stream from disk instead of reading potentially multi-GB JSONL into RAM.
      for (const file of ['out.jsonl', 'err.log']) {
        output.write(`\n== ${join(record.taskDir, file)} ==\n`);
        try {
          for await (const chunk of createReadStream(join(record.taskDir, file))) {
            if (!output.write(chunk)) await new Promise(done => output.once('drain', done));
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return record;
    },
    // Exposed for deterministic fake-unit tests; real units always use the hook.
    complete: completeWorker,
  };
}

export function parseWorkerArgs(args) {
  const positional = [], options = {};
  const allowed = new Set(['prompt', 'model', 'worktree', 'kind', 'state-dir', 'memory-dir', 'task-dir', 'thinking']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { options.command = args.slice(i + 1); break; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!allowed.has(key) || !args[i + 1] || Object.hasOwn(options, key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()))) throw new Error(`Invalid option: ${arg}`);
      options[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = args[++i];
    } else positional.push(arg);
  }
  return { positional, options };
}

export async function workerCli(args = process.argv.slice(2), output = process.stdout) {
  const { positional, options } = parseWorkerArgs(args);
  const [action, name, ...extra] = positional;
  if (extra.length || (!name && action !== 'list')) throw new Error('Usage: worker start <name> --prompt file [--model …] [--worktree …] [--kind …] | list | ack <name> | logs <name>');
  const launcher = createWorkerLauncher(options);
  let result;
  if (action === 'start') result = await launcher.start(name, options);
  else if (action === 'list' && !name) result = await launcher.list();
  else if (action === 'ack') result = await launcher.ack(name);
  else if (action === 'logs') return launcher.logs(name, output);
  else throw new Error('Unknown worker command');
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  workerCli().catch(error => { console.error(`worker: ${error.message}`); process.exitCode = 1; });
}
