import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, answer, until, context } from './durable-fixture.mjs';

const image = { type: 'image', mimeType: 'image/png', data: 'AAEC/+==' };
const gate = () => Promise.withResolvers();

test('abort returns only the inbox items it actually withdraws after uncertainty inspection', async t => {
  const first = gate(), started = gate(), inspecting = gate(), inspected = gate();
  const { runtime: r, idle } = await fixture(t, {
    respond: async (model, _messages, count, options) => {
      if (count === 1) { started.resolve(); await first.promise; }
      else if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      return answer(model);
    },
  });
  t.after(() => { first.resolve(); inspected.resolve(); });
  await r.command({ type: 'prompt', text: 'first' });
  await started.promise;
  const queued = await r.command({ type: 'prompt', text: 'already consumed', images: [image] });
  assert.equal(queued.queued, true);
  const { harness } = r.session();
  const inspect = harness.inspect.bind(harness);
  harness.inspect = async (...args) => { inspecting.resolve(); await inspected.promise; return inspect(...args); };
  const stopping = r.command({ type: 'abort' });
  await inspecting.promise;
  first.resolve();
  const receipt = await harness.submission(queued.submissionId, context);
  await until(async () => (await receipt.status(context)).status === 'placed');
  const remaining = await r.command({ type: 'prompt', text: 'still waiting', images: [image] });
  inspected.resolve();
  const back = await stopping;
  await idle();
  assert.deepEqual(back.items.map(item => item.id), [remaining.submissionId]);
  assert.deepEqual(back.steering, ['still waiting']);
  assert.deepEqual(back.items[0].images, [image]);
  const placed = await receipt.status(context);
  assert.ok(placed.entry, 'the consumed prompt remains committed and must not return to the composer');
  const withdrawn = await (await harness.submission(remaining.submissionId, context)).status(context);
  assert.equal(withdrawn.status, 'unanswered');
  assert.equal(withdrawn.reason, 'withdrawn');
  assert.equal(withdrawn.entry, undefined);
  assert.deepEqual(r.snapshot().queue.items, []);
});
