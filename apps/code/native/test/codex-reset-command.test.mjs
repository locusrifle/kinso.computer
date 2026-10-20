import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the real routing expression without starting a signed-in runtime.
test('reset commands cannot replace server-owned auth or usage-cache dependencies', async () => {
  const source = await readFile(new URL('../runtime.mjs', import.meta.url), 'utf8');
  const expression = source.match(/case 'codex-reset-consume': return ([^;]+);/)?.[1];
  assert.ok(expression, 'the narrow runtime route exists');
  const route = new Function('codexResets', 'models', 'c', `return ${expression};`);
  const modelRuntime = { fixture: 'server-owned runtime' };
  let received;
  const result = route({ consume: input => { received = input; return { outcome: 'not_applied' }; } },
    modelRuntime, {
      type: 'codex-reset-consume', accountId: 'fixture-account', creditId: 'fixture-credit',
      operationId: 'fixture-confirmation', confirmed: true,
      modelRuntime: { fixture: 'untrusted runtime' }, store: { fixture: 'untrusted cache' },
      fetch: 'untrusted transport', expectedSessionId: 'fixture-session',
    });
  assert.deepEqual(received, {
    accountId: 'fixture-account', creditId: 'fixture-credit', operationId: 'fixture-confirmation',
    confirmed: true, modelRuntime,
  });
  assert.deepEqual(result, { outcome: 'not_applied' });
});
