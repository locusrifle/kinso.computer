import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageDrain, tabSubscription, DRAIN_WINDOW_MS, DRAIN_READ_MS } from '../public/js/usage-drain.js';

const reading = (used, extra = {}) => [{ agent: 'pi', signedIn: true, windows: [{ name: 'week', used, resetsAt: 1000000 }], ...extra }];
test('only working subscription harnesses/providers drain; API models, idle and offline tabs do not', () => {
  for (const [tab, subscription] of [
    [{ agent: 'claude' }, 'claude'], [{ agent: 'codex' }, 'pi'],
    [{ agent: 'pi', provider: 'claude-agent', model: 'Opus' }, 'claude'],
    [{ agent: 'pi', provider: 'openai-codex', model: 'GPT' }, 'pi'],
    [{ agent: 'pi', model: { provider: 'openai-codex' } }, 'pi'],
    [{ agent: 'pi', provider: 'anthropic' }, null], [{ agent: 'pi', provider: 'openai' }, null],
    [{ agent: 'pi', model: 'claude-opus' }, null], [{ agent: 'other', provider: 'openai-codex' }, null],
  ]) {
    assert.equal(tabSubscription({ ...tab, status: 'working' }), subscription);
    for (const status of ['idle', 'done', 'blocked', 'unknown', undefined]) assert.equal(tabSubscription({ ...tab, status }), null);
    assert.equal(tabSubscription({ ...tab, status: 'working', offline: true }), null);
  }
});
test('a fresh per-window drop drains for 90 seconds, even below the rounded display precision', () => {
  const drain = createUsageDrain();
  drain.observe(reading(20), 1000);
  assert.equal(drain.isDraining('pi', 'week', [], 1000), false, 'first reading is not a drop');
  drain.observe(reading(20.1), 2000);
  assert.equal(drain.isDraining('pi', 'week', [], 2000), true);
  assert.equal(drain.isDraining('pi', '5 hours', [], 2000), false);
  assert.equal(drain.isDraining('claude', 'week', [], 2000), false);
  drain.observe(reading(20.1), 32000);
  assert.equal(drain.isDraining('pi', 'week', [], 2000 + DRAIN_WINDOW_MS - 1), true);
  assert.equal(drain.isDraining('pi', 'week', [], 2000 + DRAIN_WINDOW_MS), false, 'cached/steady readings never extend the window');
  drain.observe(reading(21), 93000);
  assert.equal(drain.isDraining('pi', 'week', [], 94000), true);
  assert.equal(DRAIN_READ_MS, 30000);
});
test('live tabs drain every window on the subscription immediately, then stop at idle', () => {
  const drain = createUsageDrain(), tabs = [{ status: 'working', agent: 'claude', owner: 'another-computer' }];
  assert.equal(drain.isDraining('claude', 'week', tabs, 1000), true);
  assert.equal(drain.isDraining('claude', '5 hours', tabs, 1000), true);
  assert.equal(drain.isDraining('pi', 'week', tabs, 1000), false);
  assert.equal(drain.isDraining('claude', 'week', [{ ...tabs[0], status: 'idle' }], 1000), false);
  assert.equal(drain.isDraining('claude', 'week', [], 1000), false);
});
test('resets, missing/invalid answers, sign-out, errors and changed accounts cannot fabricate spending', () => {
  for (const invalid of [null, [], reading(30, { signedIn: false }), reading(30, { error: 'offline' }), reading(30, { limitsUnavailable: true }), reading(30, { accountId: 'new-account' }), reading(30, { windows: [{ name: 'week', used: 30, resetsAt: 2000000 }] }), ...[null, '30', NaN, Infinity].map(used => reading(used))]) {
    const drain = createUsageDrain(); drain.observe(reading(20), 1000); drain.observe(invalid, 2000);
    assert.equal(drain.isDraining('pi', 'week', [], 2000), false);
  }
  const drain = createUsageDrain(); drain.observe(reading(20), 1000); drain.observe(reading(30), 2000);
  drain.observe(reading(0), 3000);
  assert.equal(drain.isDraining('pi', 'week', [], 3000), false, 'refill clears the old drop');
});
