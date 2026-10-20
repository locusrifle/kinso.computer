import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUsage, usageRecord } from '../usage-history.mjs';
import { pageData, tokens, niceScale, price } from '../public/js/usage-page.js';
const now = Date.parse('2026-10-09T12:00:00Z');
const models = [{ provider: 'openai', id: 'rated', cost: { input: 2, output: 8, cacheRead: .2, cacheWrite: 2.5 } }];
const record = (id, day, model = 'rated', usage = { input: 1000000, output: 200000, cacheRead: 100000, cacheWrite: 50000 }) => usageRecord({ type: 'message', id, timestamp: `${day}T12:00:00Z`, message: { role: 'assistant', provider: 'openai', model, usage } }, { agent: 'pi' });
const rows = [record('old', '2026-07-12'), record('90', '2026-07-13'), record('30', '2026-09-10'), record('7', '2026-10-03'), record('today', '2026-10-09'), record('unknown', '2026-10-09', 'unknown', { input: 102 })];
const history = aggregateUsage([...rows, rows[3]], { now, models });
test('one deduplicated priced dated adapter drives UTC periods, provider/model/day shares and drilldowns', () => {
  for (const [period, expected, since] of [[7, 3, '2026-10-03'], [30, 4, '2026-09-10'], [90, 6, '2026-07-12']]) {
    const d = pageData(history, period);
    // 90 includes July 12, exactly 89 UTC midnights before October 9.
    assert.equal(d.responses, expected);
    assert.equal(d.since, since); assert.equal(d.until, '2026-10-09'); assert.equal(d.periods.length, period);
    assert.equal(d.providers.reduce((n, p) => n + tokens(p), 0), tokens(d));
    assert.equal(d.models.reduce((n, p) => n + p.estimatedUSD, 0), d.estimatedUSD);
    assert.equal([...d.days.values()].reduce((n, p) => n + p.estimatedUSD, 0), d.estimatedUSD);
    assert.equal(Object.values(d.categoryUSD).reduce((a, b) => a + b, 0), d.estimatedUSD);
    assert.equal(d.unratedTokens, 102); assert.equal(d.unknownCategories, 3); assert.match(price(d), /subtotal/);
    const m = d.models.find(m => m.model === 'unknown'); assert.equal(price(m), 'Unpriced');
    const selected = pageData(history, period, m.key); assert.equal(selected.responses, 1); assert.equal(tokens(selected), 102);
    assert.equal(selected.days.size, 1); assert.equal(selected.estimatedUSD, 0);
  }
});
test('cost category subtotals preserve exact cache/tier calculation and unknown coverage', () => {
  const h = aggregateUsage([rows[4]], { now, models });
  assert.equal(h.categoryUSD.input, 2); assert.equal(h.categoryUSD.output, 1.6); assert.equal(h.categoryUSD.cacheRead, .02); assert.equal(h.categoryUSD.cacheWrite, .125);
  assert.equal(h.estimatedUSD, 3.745);
  assert.equal(h.dayModels[0].estimatedUSD, h.estimatedUSD);
  assert.equal(pageData({ ...h, historyCoverage: { complete: true } }, 7).complete, true);
  assert.equal(pageData(h, 7).complete, false);
  assert.equal(pageData({ ...h, dayModels: undefined }, 7), null);
  assert.doesNotMatch(JSON.stringify(h.dayModels), /timestamp|sessionId|messages|rated-owner/);
});
test('provider chart scale is rounded up, zero/unknown is not a negative scale', () => {
  for (const peak of [.000001, .1, 1, 11, 103, 99999]) assert.ok(niceScale(peak).max >= peak);
  assert.deepEqual(niceScale(0), { max: 0, ticks: [0] });
});
