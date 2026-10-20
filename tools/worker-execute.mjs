#!/usr/bin/env node
// Only runs inside the independently owned unit. ExecStopPost records death
// even if this process or its child is SIGKILLed before it can write `exit`.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { readFile, open, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { constants } from 'node:os';
import { pathToFileURL } from 'node:url';
import { atomicWrite } from '../system/pulse-ledger.mjs';

// JSON mode may exit 0 after an error/abort. Inspect authoritative final
// assistant messages and agent_settled without buffering the full transcript.
export function createPiOutcomeReader() {
  let buffer = Buffer.alloc(0), discarding = false, failed = false;
  const line = bytes => {
    let row;
    try { row = JSON.parse(bytes.toString('utf8')); } catch { return; }
    if (row.type === 'message_end' && row.message?.role === 'assistant') failed = ['error', 'aborted'].includes(row.message.stopReason);
    if (row.type === 'agent_settled' && row.aborted) failed = true;
  };
  return {
    push(chunk) {
      let start = 0;
      for (let index = 0; index < chunk.length; index++) {
        if (chunk[index] !== 10) continue;
        if (!discarding) line(Buffer.concat([buffer, chunk.subarray(start, index)]));
        buffer = Buffer.alloc(0); discarding = false; start = index + 1;
      }
      if (!discarding) {
        buffer = Buffer.concat([buffer, chunk.subarray(start)]);
        if (buffer.length > 4 * 1024 * 1024) { buffer = Buffer.alloc(0); discarding = true; }
      }
    },
    failed: () => failed,
  };
}

export async function executeWorker(configPath) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  await mkdir(join(config.taskDir, 'session'), { recursive: true, mode: 0o700 });
  const stdout = await open(join(config.taskDir, 'out.jsonl'), 'a', 0o600);
  const stderr = await open(join(config.taskDir, 'err.log'), 'a', 0o600);
  const env = { ...process.env, ...config.env };
  for (const key of ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL']) delete env[key];
  if (config.kind === 'sol') delete env.OPENAI_API_KEY;
  if (config.kind === 'claude') delete env.ANTHROPIC_API_KEY;
  let exit = 1;
  const outcome = createPiOutcomeReader();
  try {
    let command = config.command;
    if (config.kind === 'sol' || config.kind === 'claude') {
      const prompt = await readFile(join(config.taskDir, 'prompt.md'), 'utf8');
      command = config.kind === 'sol'
        ? ['pi', '--print', '--mode', 'json', '--model', config.model, '--thinking', config.thinking || 'high', '--session-dir', join(config.taskDir, 'session'), '--', prompt]
        : ['claude', '--print', '--output-format', 'stream-json', '--verbose', ...(config.model ? ['--model', config.model] : []), '--', prompt];
    }
    if (!Array.isArray(command) || !command.length || command.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid worker command');
    const child = spawn(command[0], command.slice(1), { cwd: config.worktree || config.taskDir, env, stdio: ['ignore', config.kind === 'sol' ? 'pipe' : stdout.fd, stderr.fd] });
    if (config.kind === 'sol') {
      // Backpressure-aware file piping and parsing; no transcript accumulates.
      const stream = createWriteStream(join(config.taskDir, 'out.jsonl'), { flags: 'a', mode: 0o600 });
      child.stdout.on('data', chunk => outcome.push(chunk));
      const stopped = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done({ code, signal })); });
      const [{ code, signal }] = await Promise.all([stopped, pipeline(child.stdout, stream)]);
      exit = signal ? 128 + (constants.signals[signal] || 0) : code ?? 1;
      if (exit === 0 && outcome.failed()) exit = 1;
    } else {
      exit = await new Promise((done, reject) => { child.once('error', reject); child.once('close', (code, signal) => done(signal ? 128 + (constants.signals[signal] || 0) : code ?? 1)); });
    }
  } catch (error) { await stderr.writeFile(`worker execute: ${error.message}\n`); exit = 1; }
  finally { await stdout.close(); await stderr.close(); }
  exit = Math.min(255, exit);
  await atomicWrite(join(config.taskDir, 'exit'), `${exit}\n`);
  return exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  executeWorker(process.argv[2]).then(exit => { process.exitCode = exit; }, error => { console.error(error.message); process.exitCode = 1; });
}
