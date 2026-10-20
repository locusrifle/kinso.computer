import test from 'node:test';
import assert from 'node:assert/strict';
import { usageRecord, aggregateUsage } from '../usage-history.mjs';
import { pageData, partial } from '../public/js/usage-page.js';

const now = Date.parse('2026-10-09T12:00:00Z');
const models = [{ provider: 'fixture', id: 'rated', cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 } }];
const response = (id, timestamp, model = 'rated') => usageRecord({ type: 'message', id, timestamp, message: { role: 'assistant', provider: 'fixture', model, usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } } }, { agent: 'pi' });

test('all records and 30 UTC calendar days use identical dedup and independent rate coverage', () => {
  const rows = [response('old', '2026-09-09T23:59:59Z', 'unknown'), response('boundary', '2026-09-10T00:00:00Z'), response('utc', '2026-09-10T00:15:00+01:00'), response('today', '2026-10-09T11:59:00Z')];
  const h = aggregateUsage([...rows, rows[1]], { models, now }), last30 = pageData(h, 30);
  assert.equal(h.responses, 4); assert.equal(last30.responses, 2);
  assert.equal(last30.since, '2026-09-10'); assert.equal(last30.until, '2026-10-09');
  assert.equal(h.estimate.partial, true); assert.equal(partial(last30), false);
  assert.equal(last30.estimatedUSD, 0.0002);
  assert.equal(h.days.reduce((n, d) => n + d.estimatedUSD, 0), h.estimatedUSD);
  assert.equal(h.days.reduce((n, d) => n + d.tokens.input, 0), h.tokens.input);
});

test('invalid/future timestamps cannot invent daily costs; empty and unpriced periods differ', () => {
  const h = aggregateUsage([response('bad', 'not-a-date'), response('future', '2026-10-09T12:00:01Z'), response('tomorrow', '2026-10-10T00:00:00Z'), response('old', '2026-09-01T00:00:00Z', 'unknown')], { models, now });
  assert.equal(h.excludedDates, 3); assert.equal(h.responses, 1); assert.equal(h.unratedTokens, 100);
  const last30 = pageData(h, 30);
  assert.equal(last30.responses, 0); assert.equal(partial(last30), false); assert.equal(last30.estimatedUSD, 0);
  assert.equal(h.days[0].unratedTokens, 100);
  const invalid = aggregateUsage([response('calendar', '2026-02-30T00:00:00Z')], { models, now });
  assert.equal(invalid.responses, 0); assert.equal(invalid.excludedDates, 1);
});
