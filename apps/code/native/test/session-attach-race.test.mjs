import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTabHost } from '../tabs.mjs';

function runtime(session) {
  return {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: session, sessionFile: session, messages: [], cwd: '/tmp' }),
    command: async () => ({}),
    close: async () => {},
  };
}

test('simultaneous history attachments share one runtime creation', async () => {
  let creations = 0;
  const host = await createTabHost({
    createRuntime: async ({ sessionPath } = {}) => {
      creations++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return runtime(sessionPath || 'initial');
    },
  });
  try {
    const open = () => host.command({ type: 'tab-open', path: 'shared-history', agent: 'pi' }, 't1');
    const [a, b, c] = await Promise.all([open(), open(), open()]);
    assert.equal(a.id, b.id);
    assert.equal(a.id, c.id);
    assert.equal(creations, 2, 'initial runtime plus exactly one history writer');
    assert.equal(host.snapshot().tabs.length, 2);
    assert.equal((await open()).id, a.id);
    assert.equal(creations, 2);
  } finally { await host.close(); }
});

test('a failed shared runtime creation can be retried without a ghost tab', async () => {
  let attempts = 0;
  const host = await createTabHost({
    createRuntime: async ({ sessionPath } = {}) => {
      if (sessionPath && ++attempts === 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        throw new Error('temporary load failure');
      }
      return runtime(sessionPath || 'initial');
    },
  });
  try {
    const open = () => host.command({ type: 'tab-open', path: 'retry-history', agent: 'pi' }, 't1');
    const results = await Promise.allSettled([open(), open()]);
    assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
    assert.equal(attempts, 1);
    assert.equal(host.snapshot().tabs.length, 1);
    const retried = await open();
    assert.equal(retried.sessionId, 'retry-history');
    assert.equal(attempts, 2);
    assert.equal(host.snapshot().tabs.length, 2);
  } finally { await host.close(); }
});
