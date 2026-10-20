import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, answer, context } from '../durable-fixture.mjs';
const dir = process.argv[2], mode = process.argv[3];
const effect = { name: mode, description: 'Synthetic crash fixture only', parameters: { type: 'object', properties: {} }, replay: mode === 'safe' ? 'safe' : 'unsafe', async execute() { process.send({ type: 'effect' }); await new Promise(() => {}); } };
const { runtime } = await fixture({ after() {} }, { dir, respond: async (model, _transcript, count, options) => {
  if (mode === 'queue') { process.send({ type: 'generation' }); await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); }
  return answer(model, [{ type: 'toolCall', id: 'effect-1', name: mode, arguments: {} }], 'toolUse');
}, serviceOptions: { durableExtensions: [{ name: 'fixture', tools: [effect] }] } });
const first = await runtime.command({ type: 'prompt', requestId: 'first', text: 'first' });
const second = await runtime.command({ type: 'prompt', requestId: 'second', text: 'second' });
process.send({ type: 'accepted', path: runtime.snapshot().sessionFile, first, second });
setInterval(() => {}, 1000);
