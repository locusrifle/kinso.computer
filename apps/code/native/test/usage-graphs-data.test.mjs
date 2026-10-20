import test from 'node:test';
import assert from 'node:assert/strict';
import { graphData, exactValue, graphValue } from '../public/js/usage-graphs-data.js';
import { pageData } from '../public/js/usage-page.js';
import { aggregateUsage } from '../usage-history.mjs';

const categories = ['input', 'output', 'cacheRead', 'cacheWrite'];
const zero = () => Object.fromEntries(categories.map(k => [k, 0]));
const row = (day, extra = {}) => ({ day, provider: 'p', model: 'm', device: 'desktop', harness: 'pi', tokens: { ...zero(), input: 100 }, categoryUSD: { ...zero(), input: .001 }, missing: zero(), estimatedUSD: .001, responses: 1, unratedTokens: 0, unknownCategories: 0, ...extra });
const history = (rows = [], asOf = '2026-10-11T12:00:00Z') => ({ dayAgents: rows, estimate: { asOf }, historyCoverage: { complete: true } });
const sums = (rows, metric) => rows.reduce((sum, r) => sum + graphValue(r, metric), 0);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10 * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);
function equalAggregate(actual, expected) {
  for (const field of ['tokens', 'categoryUSD', 'missing']) for (const k of categories) close(actual[field][k], expected[field][k] || 0);
  for (const field of ['responses', 'estimatedUSD', 'unratedTokens', 'unknownCategories']) close(actual[field], expected[field]);
}

test('week and month are inclusive UTC calendar windows ending on authority day', () => {
  const h = history(['2026-09-11', '2026-09-12', '2026-10-04', '2026-10-05', '2026-10-11', '2026-10-12'].map(d => row(d)));
  const week = graphData(h, { range: 'week' });
  assert.equal(week.since, '2026-10-05'); assert.equal(week.until, '2026-10-11');
  assert.equal(week.dayCount, 7); assert.equal(week.buckets.length, 7); assert.equal(week.total.responses, 2);
  assert.equal(week.buckets[1].total.responses, 0); assert.equal(week.buckets[1].values.pi, 0);
  const month = graphData(h);
  assert.equal(month.since, '2026-09-12'); assert.equal(month.dayCount, 30); assert.equal(month.total.responses, 4);
  assert.equal(graphData(h, { range: 'all' }).until, '2026-10-11', 'future rows cannot extend all-time');
});

test('weekly buckets start Monday UTC and clip the first and last bucket', () => {
  const h = history([row('2026-10-10'), row('2026-10-11'), row('2026-10-12'), row('2026-10-14')], '2026-10-14T01:00:00+01:00');
  const g = graphData(h, { range: 'week', bucket: 'week' });
  assert.deepEqual(g.buckets.map(b => [b.key, b.start, b.end, b.total.responses]), [
    ['2026-10-05', '2026-10-08', '2026-10-11', 2], ['2026-10-12', '2026-10-12', '2026-10-14', 2],
  ]);
  assert.equal(g.dayCount, 7);
  const all = graphData(h, { range: 'all', bucket: 'week' });
  assert.equal(all.buckets[0].start, '2026-10-10'); assert.equal(all.buckets.at(-1).end, '2026-10-14');
  assert.equal(all.dayCount, 5);
});

test('all uses the real retained span, fills gaps, and handles empty/one-day authorities', () => {
  const h = history([row('2024-02-28'), row('2024-03-01')]);
  const g = graphData(h, { range: 'all' });
  assert.equal(g.dayCount, 3); assert.equal(g.buckets[1].key, '2024-02-29'); assert.equal(g.buckets[1].visibleTotal, 0);
  const one = graphData(history([row('2000-01-01')]), { range: 'all', bucket: 'week' });
  assert.equal(one.dayCount, 1); assert.equal(one.buckets.length, 1);
  assert.equal(one.buckets[0].start, '2000-01-01'); assert.equal(one.buckets[0].end, '2000-01-01');
  const empty = graphData(history(), { range: 'all' });
  assert.equal(empty.since, null); assert.equal(empty.until, null); assert.equal(empty.dayCount, 0);
  assert.deepEqual(empty.series, []); assert.deepEqual(empty.buckets, []); assert.equal(empty.total.responses, 0);
  assert.equal(graphData(history(), { range: 'week' }).buckets.length, 7);
  assert.equal(graphData({}).dayCount, 0); assert.equal(graphData({}).complete, false);
  assert.equal(graphData(history([row('2026-02-30'), row('unknown'), row('2026-10-09')]), { range: 'all' }).dayCount, 1);
});

test('harness stacks are sorted by selected metric, labels are explicit, hidden is chart-only', () => {
  const rows = ['pi', 'claude', 'codex', 'workers', 'unexpected'].map((harness, i) => row('2026-10-10', { harness, tokens: { ...zero(), input: (i + 1) * 100 }, estimatedUSD: 5 - i }));
  const h = history(rows);
  const g = graphData(h, { range: 'all', hidden: ['workers', 'unknown'] });
  assert.deepEqual(g.series.map(s => s.key), ['unknown', 'workers', 'codex', 'claude', 'pi']);
  assert.deepEqual(g.series.map(s => s.label), ['Unknown harness', 'Workers / subagents', 'Codex', 'Claude Code', 'Pi']);
  assert.deepEqual(g.harnesses.map(s => s.key), ['pi', 'claude', 'codex', 'workers', 'unknown']);
  assert.equal(g.buckets[0].visibleTotal, 600); assert.equal(g.buckets[0].values.workers, undefined);
  assert.equal(graphValue(g.buckets[0].total), 1500); assert.equal(sums(g.series, 'tokens'), 1500);
  assert.deepEqual(g.total, graphData(h, { range: 'all' }).total);
  assert.deepEqual(g.models, graphData(h, { range: 'all' }).models);
  assert.deepEqual(g.harnesses, graphData(h, { range: 'all' }).harnesses);
  assert.equal(graphData(h, { range: 'all', hidden: g.series.map(s => s.key) }).buckets[0].visibleTotal, 0);
  assert.deepEqual(graphData(h, { range: 'all', metric: 'spend' }).series.map(s => s.key), ['pi', 'claude', 'codex', 'workers', 'unknown']);
});

test('model keys retain providers; labels disambiguate; seven major models plus exact Other', () => {
  const rows = Array.from({ length: 10 }, (_, i) => row('2026-10-10', { model: `model-${i}`, tokens: { ...zero(), input: i === 9 ? 1 : 100 }, estimatedUSD: i === 9 ? .00000001 : .01 }));
  rows.push(row('2026-10-11', { provider: 'q', model: 'model-0', tokens: { ...zero(), input: 100 }, estimatedUSD: .01, missing: { ...zero(), output: 2 }, unknownCategories: 2, unratedTokens: 7 }));
  const h = history(rows), g = graphData(h, { range: 'all', stack: 'model', metric: 'spend' });
  assert.equal(g.series.length, 8); assert.equal(g.models.length, 11);
  assert.equal(g.models.find(m => m.key === 'p/model-0').label, 'model-0 (p)');
  assert.equal(g.models.find(m => m.key === 'q/model-0').label, 'model-0 (q)');
  assert.equal(g.models.find(m => m.key === 'p/model-1').label, 'model-1');
  const other = g.series.find(s => s.key === 'other');
  assert.equal(other.responses, 4); assert.equal(other.tokens.input, 301);
  close(other.estimatedUSD, .03000001); close(sums(g.series, 'spend'), g.total.estimatedUSD);
  for (const field of ['tokens', 'categoryUSD', 'missing']) for (const k of categories) close(g.series.reduce((n, s) => n + s[field][k], 0), g.total[field][k]);
  for (const field of ['responses', 'unratedTokens', 'unknownCategories']) assert.equal(g.series.reduce((n, s) => n + s[field], 0), g.total[field]);
  close(g.buckets.reduce((n, b) => n + b.visibleTotal, 0), g.total.estimatedUSD);
  const hidden = graphData(h, { range: 'all', stack: 'model', metric: 'spend', hidden: ['other'] });
  close(hidden.buckets.reduce((n, b) => n + b.visibleTotal, 0), g.total.estimatedUSD - other.estimatedUSD);
  assert.deepEqual(hidden.models, g.models); assert.deepEqual(hidden.total, g.total);
});

test('tiny models below 1% group even below the cap; exact 1% stays major; zero spend is deterministic', () => {
  const h = history([row('2026-10-10', { model: 'big', estimatedUSD: .989 }), row('2026-10-10', { model: 'boundary', estimatedUSD: .01 }), row('2026-10-10', { model: 'tiny', estimatedUSD: .001 })]);
  const g = graphData(h, { range: 'all', stack: 'model', metric: 'spend' });
  assert.deepEqual(g.series.map(s => s.key), ['p/big', 'p/boundary', 'other']);
  const zeroSpend = graphData(history(Array.from({ length: 9 }, (_, i) => row('2026-10-10', { model: `m${i}`, estimatedUSD: 0 }))), { range: 'all', stack: 'model', metric: 'spend' });
  assert.equal(zeroSpend.series.length, 8); assert.equal(sums(zeroSpend.series, 'tokens'), 900);
});

test('device filtering affects all totals/breakdowns except the unfiltered computer list and window', () => {
  const h = history([row('2026-10-09', { estimatedUSD: 2 }), row('2026-10-10', { device: 'laptop', model: 'other', harness: 'claude', estimatedUSD: 3 }), row('2026-10-11', { device: 'unknown', estimatedUSD: 1 })]);
  const g = graphData(h, { range: 'all', device: 'laptop' });
  assert.deepEqual(g.computers.map(c => [c.key, c.estimatedUSD]), [['laptop', 3], ['desktop', 2], ['unknown', 1]]);
  assert.equal(g.since, '2026-10-09'); assert.equal(g.dayCount, 3); assert.equal(g.total.responses, 1);
  assert.deepEqual(g.models.map(m => m.key), ['p/other']); assert.deepEqual(g.harnesses.map(h => h.key), ['claude']);
  const none = graphData(h, { range: 'all', device: 'missing' });
  assert.equal(none.total.responses, 0); assert.equal(none.buckets.length, 3); assert.deepEqual(none.series, []);
  assert.deepEqual(none.computers, g.computers);
});

test('older authority falls back to dayModels as unknown; empty dayAgents is authoritative', () => {
  const h = { dayModels: [row('2026-10-10')], estimate: { asOf: '2026-10-11T00:00:00Z' }, historyCoverage: { complete: false } };
  const g = graphData(h);
  assert.equal(g.legacy, true); assert.equal(g.complete, false); assert.equal(g.series[0].key, 'unknown');
  assert.equal(g.total.responses, 1); assert.equal(g.models[0].key, 'p/m');
  assert.equal(graphData({ ...h, dayAgents: [] }).total.responses, 0);
  assert.equal(graphData({ ...h, dayAgents: [] }).legacy, false);
});

test('large multiyear history is continuous and pure, no argument-spread extrema', () => {
  const rows = Array.from({ length: 120000 }, (_, i) => row(i % 2 ? '2000-01-01' : '2026-10-11'));
  const h = history(rows);
  const before = JSON.stringify(rows[0]);
  const g = graphData(h, { range: 'all', bucket: 'week' });
  assert.equal(g.dayCount, (Date.parse('2026-10-11') - Date.parse('2000-01-01')) / 86400000 + 1);
  assert.ok(g.buckets.length > 1300); assert.equal(g.total.responses, rows.length);
  assert.equal(sums(g.series, 'tokens'), 12000000); assert.equal(JSON.stringify(rows[0]), before);
  assert.equal(g.buckets[1].visibleTotal, 0);
});

test('graph sums match pageData authoritative costs: tiers, 1h splits, zero and unknown rates', () => {
  const models = [{ provider: 'p', id: 'rated', cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 1.5, tiers: [{ inputTokensAbove: 100, input: 2, output: 4, cacheRead: 0, cacheWrite: 3 }] } }, { provider: 'p', id: 'zero', cost: zero() }];
  const records = ['rated', 'rated', 'zero', 'unknown'].map((model, i) => ({ key: `${i}`, agent: i % 2 ? 'claude' : 'pi', harness: i === 1 ? 'workers' : i % 2 ? 'claude' : 'pi', day: '2026-10-10', at: Date.parse('2026-10-10'), provider: 'p', model, device: i % 2 ? 'laptop' : 'desktop', tokens: { input: 100, output: 10, cacheRead: 1, cacheWrite: 10 }, cacheWrite1h: 5, aggregate: i === 1 }));
  records.push({ ...records[0], key: 'partial', tokens: { ...records[0].tokens, cacheRead: null } });
  const h = aggregateUsage(records, { models, now: Date.parse('2026-10-11T12:00:00Z') });
  h.historyCoverage = { complete: true };
  const p = pageData(h);
  for (const stack of ['harness', 'model']) for (const metric of ['tokens', 'spend']) for (const bucket of ['day', 'week']) {
    const g = graphData(h, { stack, metric, bucket });
    equalAggregate(g.total, p);
    close(sums(g.series, metric), graphValue(p, metric));
    close(g.buckets.reduce((n, b) => n + b.visibleTotal, 0), graphValue(p, metric));
    close(sums(g.models, 'spend'), p.estimatedUSD); close(sums(g.harnesses, 'spend'), p.estimatedUSD);
    assert.ok(g.total.unratedTokens > 0); assert.equal(g.total.missing.cacheRead, 1);
  }
  close(p.estimatedUSD, .000275 + .0001375);
});

test('exactValue preserves full integers and eight-place USD, deterministic formatting', () => {
  assert.equal(exactValue(1234567890, 'tokens'), '1,234,567,890');
  assert.equal(exactValue(.00000001, 'spend'), 'USD 0.00000001');
  assert.equal(exactValue(.00123456, 'spend'), 'USD 0.00123456');
  assert.equal(exactValue(1234.123456789, 'spend'), 'USD 1,234.12345679');
  assert.equal(exactValue(0, 'spend'), 'USD 0'); assert.equal(exactValue(1e21, 'tokens'), '1,000,000,000,000,000,000,000');
});
