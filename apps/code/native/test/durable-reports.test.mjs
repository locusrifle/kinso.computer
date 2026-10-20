import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, answer } from './durable-fixture.mjs';

test('a contained observer report does not veto future prompts, requests or tools', async t => {
  const { runtime: r, idle, seen, dir } = await fixture(t, {
    respond: (model, _messages, count) => count === 1
      ? answer(model, [{ type: 'toolCall', id: 'read-after-report', name: 'read', arguments: { path: 'present.txt' } }], 'toolUse')
      : answer(model),
  });
  await writeFile(join(dir, 'present.txt'), 'read after a nonfatal report');
  const stop = r.session().harness.subscribeCommits(() => { throw new Error('one broken observer'); });
  await r.command({ type: 'name', name: 'still healthy' });
  stop();
  assert.match(JSON.stringify(r.snapshot().messages), /one broken observer/);
  await r.command({ type: 'prompt', text: `Read a file in ${dir}, then answer` });
  await idle();
  assert.equal(seen.length, 2, 'the tool and its continuation still execute');
  assert.match(JSON.stringify(r.snapshot().messages.find(m => m.role === 'toolResult')), /read after a nonfatal report/);
  await r.command({ type: 'prompt', text: 'another normal turn' });
  await idle();
  assert.equal(seen.length, 3);
});

test('a fatal Harness failure remains failed rather than being treated as a nonfatal report', async t => {
  const { runtime: r, seen } = await fixture(t);
  const { harness, registry } = r.session();
  const failure = new Error('synthetic registry failure');
  registry.snapshot = () => { throw failure; };
  await r.command({ type: 'prompt', text: 'cannot schedule' }).catch(error => assert.ok(error === failure || error.cause === failure));
  const end = await harness.closed;
  assert.equal(end.reason, 'failed');
  assert.equal(end.error, failure);
  await assert.rejects(r.command({ type: 'prompt', text: 'must reopen first' }), error => error.name === 'SessionFailed' && error.cause === failure);
  assert.equal(seen.length, 0);
});
