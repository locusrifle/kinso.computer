import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, answer, until } from './durable-fixture.mjs';
import { aggregateUsage } from '../usage-history.mjs';

test('Codex sign-in is injected into the Durable console and does not interrupt Pi work', async t => {
  let finish, signedIn = false, logins = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  t.after(() => finish());
  const f = await fixture(t, {
    authentication: true,
    codexSignIn: {
      configured: () => signedIn,
      async login() { logins++; signedIn = true; },
      async logout() { signedIn = false; },
    },
    respond: async model => { await pending; return answer(model); },
  });
  const id = f.runtime.snapshot().sessionId;
  await f.runtime.command({ type: 'prompt', text: 'Keep the Pi continuation alive' });
  await until(() => f.runtime.snapshot().streaming);
  const providers = await f.runtime.command({ type: 'auth_providers' });
  assert.equal(providers.find(p => p.id === 'codex').configured, false);
  await f.runtime.command({ type: 'auth_login', provider: 'codex', method: 'oauth' });
  await until(() => !f.runtime.snapshot().auth.busy);
  assert.equal(logins, 1);
  assert.equal(f.runtime.snapshot().auth.status, 'success');
  assert.equal(f.runtime.snapshot().streaming, true);
  assert.equal(f.runtime.snapshot().sessionId, id);
  assert.equal((await f.runtime.command({ type: 'auth_accounts' })).some(a => a.id === 'codex'), true);
  finish(); await f.idle();
  assert.equal(f.runtime.snapshot().messages.at(-1).content[0].text, 'ok');
});

test('hourly usage keeps dated classic/Codex answers and marks undated Durable usage partial', () => {
  const now = Date.parse('2026-10-18T00:30:00Z');
  const record = (key, agent, extra = {}) => ({ key, agent, provider: 'synthetic', model: 'synthetic', device: 'fixture', at: now - 1000, day: '2026-10-18', tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, ...extra });
  const history = aggregateUsage([
    record('classic', 'pi'), record('codex', 'codex'),
    record('ledger', 'pi', { undated: true, at: NaN, day: 'unknown' }),
  ], { now });
  assert.equal(history.responses, 3);
  assert.equal(history.undatedResponses, 1);
  assert.equal(history.estimate.partial, true);
  assert.equal(history.hours.length, 1);
  assert.equal(history.hours[0].responses, 2);
  assert.equal(history.hours[0].tokens, 20);
  assert.deepEqual(history.dayAgents.map(row => row.harness).sort(), ['codex', 'pi', 'pi']);
});
