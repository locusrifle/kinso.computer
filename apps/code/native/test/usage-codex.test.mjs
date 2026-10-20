import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { codexUsageReader } from '../usage-codex.mjs';
import { aggregateUsage } from '../usage-history.mjs';
const event = (input, cached, output, last) => ({ type: 'event_msg', timestamp: '2026-10-01T00:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output }, ...(last ? { last_token_usage: last } : {}) } } });
function reader(id) { const r = codexUsageReader('laptop'); r({ type: 'session_meta', payload: { id } }); r({ type: 'turn_context', payload: { model: 'gpt-fixture' } }); return r; }
test('Codex cumulative repeats, mirrors, independent sessions and reasoning subsets', () => {
 const r = reader('one'), copy = reader('one'), other = reader('two');
 const e = event(100, 80, 10, { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, reasoning_output_tokens: 8 });
 const a = r(e); assert.deepEqual(a.tokens, { input: 20, output: 10, cacheRead: 80, cacheWrite: 0 }); assert.equal(r(e), null);
 const b = r(event(150, 100, 15)); assert.deepEqual(b.tokens, { input: 30, output: 5, cacheRead: 20, cacheWrite: 0 });
 const h = aggregateUsage([a, b, copy(e), other(e)], { now: Date.parse('2026-10-02'), models: [] });
 assert.equal(h.responses, 3); assert.equal(h.tokens.output, 25);
});
test('native Codex fixture retains only two response counter increments', async () => {
 const r = codexUsageReader('fixture');
 const text = await readFile(new URL('./fixtures/codex-usage.jsonl', import.meta.url), 'utf8');
 const records = text.trim().split('\n').map(line => r(JSON.parse(line))).filter(Boolean);
 assert.equal(records.length, 2); assert.equal(records.reduce((n, x) => n + x.tokens.input, 0), 50);
 assert.equal(records.reduce((n, x) => n + x.tokens.output, 0), 15);
});
test('invalid cumulative cache and calendar dates reject usage even with valid last counters', () => {
 let rejected = 0;
 const r = codexUsageReader('laptop', () => { rejected++; });
 r({ type: 'session_meta', payload: { id: 'invalid' } });
 const last = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 1 };
 for (const cached of [-1, 11, Infinity, NaN, '2', null]) assert.equal(r(event(10, cached, 1, last)), null);
 for (const timestamp of ['2026-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2026-13-01T00:00:00Z', 'bad']) {
  assert.equal(r({ ...event(10, 2, 1, last), timestamp }), null);
 }
 assert.equal(rejected, 10);
 assert.ok(r({ ...event(10, 2, 1, last), timestamp: '2024-02-29T23:00:00-02:00' }));
 assert.equal(rejected, 10);
});

test('counter resets with explicit last counters stay valid; zero/repeats are not incomplete', () => {
 let rejected = 0;
 const r = codexUsageReader('laptop', () => { rejected++; });
 r({ type: 'session_meta', payload: { id: 'reset' } });
 assert.ok(r(event(100, 80, 10)));
 const reset = event(10, 2, 1, { input_tokens: 10, cached_input_tokens: 2, output_tokens: 1 });
 assert.ok(r(reset)); assert.equal(r(reset), null);
 assert.equal(r(event(10, 2, 2, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 })), null);
 assert.equal(rejected, 0);
});

test('no session identity, invalid counters and auxiliary counts are not usage', () => {
 const r = codexUsageReader('laptop'); assert.equal(r(event(10, 0, 1)), null);
 const s = reader('s'); assert.equal(s(event(10, 11, 1)), null); assert.equal(s({ type: 'event_msg', payload: { type: 'token_count', info: null } }), null);
});
