#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIncidentLedger } from '../system/pulse-ledger.mjs';

export async function incidentCli(args = process.argv.slice(2), output = process.stdout) {
  const words = [], options = {};
  const flags = new Set(['state-dir', 'memory-dir', 'registry', 'test', 'invariant', 'hook', 'note']);
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === '--') { words.push(...args.slice(i + 1)); break; }
    if (!word.startsWith('--')) { words.push(word); continue; }
    const flag = word.slice(2);
    if (!flags.has(flag) || args[i + 1] === undefined || Object.hasOwn(options, flag)) throw new Error(`Invalid option: ${word}`);
    options[flag] = args[++i];
  }
  const ledger = createIncidentLedger({
    ...(options['state-dir'] ? { stateDir: options['state-dir'] } : {}),
    ...(options['memory-dir'] ? { memoryDir: options['memory-dir'] } : {}),
    ...(options.registry ? { registry: JSON.parse(await readFile(resolve(options.registry), 'utf8')) } : {}),
  });
  const [action, id, ...rest] = words;
  let result;
  if (action === 'open' && id) result = await ledger.open([id, ...rest].join(' '));
  else if (action === 'cause' && id && rest.length) result = await ledger.cause(id, rest.join(' '));
  else if (action === 'guard' && id && !rest.length) {
    const chosen = ['test', 'invariant', 'hook', 'note'].filter(key => Object.hasOwn(options, key));
    if (chosen.length !== 1) throw new Error('Choose exactly one guard: --test file | --invariant id | --hook file | --note "no guard possible: reason"');
    const type = chosen[0], value = options[type];
    result = await ledger.guard(id, { type, ...(type === 'invariant' ? { id: value } : type === 'note' ? { text: value } : { path: resolve(value) }) });
  } else if (action === 'close' && id && !rest.length) result = await ledger.close(id);
  else if (action === 'list' && !id) result = await ledger.list();
  else if (action === 'seed' && !id) result = await ledger.seed();
  else throw new Error('Usage: incident open <title> | cause <id> <text> | guard <id> --test file|--invariant id|--hook file|--note text | close <id> | list | seed');
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  incidentCli().catch(error => { console.error(`incident: ${error.message}`); process.exitCode = 1; });
}
