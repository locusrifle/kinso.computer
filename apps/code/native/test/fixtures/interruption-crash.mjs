import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hook, ToolTask } from '@earendil-works/pi-durable';
import { fixture, answer, until, context } from '../durable-fixture.mjs';
import { SessionInfo } from '../../durable-session.mjs';

const [dir, mode] = process.argv.slice(2);
const legacy = mode.startsWith('legacy'), shell = ['readonly', 'bash-write'].includes(mode);
const tool = { name: 'send', description: 'Local synthetic external effect', replay: 'unsafe', parameters: { type: 'object', properties: {} }, async execute() {
  await appendFile(join(dir, 'effects.txt'), 'sent\n');
  if (mode === 'persisted') return { output: [{ type: 'text', text: 'original receipt' }] };
  process.send({ type: 'ready' });
  await new Promise(() => {});
} };
const { runtime: r } = await fixture({ after() {} }, { dir, serviceOptions: { durableExtensions: [{ name: 'synthetic', tools: [tool], hooks: legacy ? [hook(ToolTask, {
  // Same persisted phase/memo shape as the removed beforeTool approval wait.
  beforeTool: async (call, api, ctx) => {
    if (mode === 'legacy-answered') await api.memo('effect-approval', true, ctx);
    process.send({ type: 'ready' });
    await new Promise(() => {});
  },
})] : [] }] }, respond: async (model, _request, n) => {
  if (mode === 'persisted' && n > 1) { process.send({ type: 'ready' }); await new Promise(() => {}); }
  const name = shell ? 'bash' : 'send';
  return answer(model, [{ type: 'toolCall', id: 'original-call', name, arguments: name === 'bash' ? { command: `${mode === 'bash-write' ? 'printf once >> effects.txt; ' : ''}printf readonly-output; sleep 2` } : {} }], 'toolUse');
} });
if (legacy) await r.session().conversation.commit(async tx => { (await tx.doc(SessionInfo, 1)).requireEffectApproval = true; }, context);
const ack = await r.command({ type: 'prompt', requestId: 'original-request', text: 'Perform the requested action once' });
process.send({ type: 'accepted', path: r.snapshot().sessionFile, ack });
if (shell) {
  const view = await r.session().conversation.viewState(context);
  // Kill only after actual shell output has committed, not just its intent.
  await until(() => view.value.docs['pi.live']?.tools?.some(slot => slot.output?.includes('readonly-output')));
  view.dispose();
  process.send({ type: 'ready' });
}
setInterval(() => {}, 1000);
