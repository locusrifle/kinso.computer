import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { importManifestPath } from '../../../../system/memory-imports.mjs';
import { usageRecord, aggregateUsage, readUsageHistory } from '../usage-history.mjs';

const pi = (id = 'p1', model = 'rated') => ({ type: 'message', id, timestamp: '2026-10-01T23:59:00Z', message: { role: 'assistant', provider: 'provider', model, content: 'private text', usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 10 } } });
const claude = (output = 20) => ({ type: 'assistant', uuid: `block-${output}`, timestamp: '2026-10-02T01:00:00Z', message: { role: 'assistant', id: 'response-a', model: 'claude-opus', usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } } });
const models = [{ provider: 'provider', id: 'rated', cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 } }, { provider: 'anthropic', id: 'claude-opus', cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6 } }];
const r = (row, agent = 'pi', device = 'unknown') => usageRecord(row, { agent, device });

test('mixed native responses, assistant blocks, mirrored copies and cumulative Claude results count once', () => {
  const records = [r(pi()), r(pi()), r(claude(2), 'claude'), r(claude(20), 'claude', 'laptop'), r(claude(), 'claude'), r({ type: 'result', usage: { output_tokens: 5000 }, total_cost_usd: 12 }, 'claude')];
  const h = aggregateUsage(records, { models, owner: 'desktop', now: Date.parse('2026-10-09T12:00:00Z') });
  assert.equal(h.responses, 2);
  assert.deepEqual(h.tokens, { input: 200, output: 40, cacheRead: 80, cacheWrite: 20 });
  assert.equal(h.days.length, 2); assert.equal(h.models.length, 2);
  assert.deepEqual(h.devices.map(d => d.key), ['laptop', 'unknown']);
  assert.deepEqual(h.models.map(m => m.key), ['anthropic/claude-opus', 'provider/rated'], 'Claude Code logs no provider; a claude-* model is Anthropic\'s');
  assert.ok(Math.abs(h.estimatedUSD - 0.001239) < 1e-10);
  assert.equal(h.estimate.partial, false);
  assert.doesNotMatch(JSON.stringify(h), /private text|total_cost_usd|response-a/);
});

test('the last eight days are also counted hour by hour, so a window can count its own today', () => {
  const at = (id, timestamp) => r({ ...pi(id), timestamp });
  const h = aggregateUsage([at('a', '2026-10-09T10:05:00Z'), at('b', '2026-10-09T10:55:00Z'), at('c', '2026-10-09T11:30:00Z'), at('old', '2026-10-01T10:00:00Z')], { models, now: Date.parse('2026-10-09T12:00:00Z') });
  assert.deepEqual(h.hours.map(hour => [new Date(hour.at).toISOString(), hour.tokens, hour.responses]), [
    ['2026-10-09T10:00:00.000Z', 340, 2],
    ['2026-10-09T11:00:00.000Z', 170, 1],
  ]);
  assert.ok(Math.abs(h.hours[0].estimatedUSD - 2 * 0.000159) < 1e-12);
  assert.equal(h.responses, 4, 'older responses still count everywhere else');
});

test('session-local Pi entry IDs do not merge distinct dated responses, but mirrors still deduplicate', () => {
  const later = { ...pi(), timestamp: '2026-10-03T12:00:00Z' };
  const h = aggregateUsage([r(pi()), r(later), r(pi())], { models });
  assert.equal(h.responses, 2); assert.deepEqual(h.days.map(d => d.key), ['2026-10-01', '2026-10-03']);
});

test('restored Pi model metadata enriches scrubbed mirrors without doubling usage', () => {
  for (const order of [[pi('restored', '[redacted]'), pi('restored')], [pi('restored'), pi('restored', '[redacted]')]]) {
    const h = aggregateUsage(order.map(row => r(row)), { models });
    assert.equal(h.responses, 1); assert.equal(h.models[0].key, 'provider/rated'); assert.equal(h.unratedTokens, 0);
  }
});

test('a copy kept for another computer names where the response ran, whichever is read first', () => {
  for (const order of [['desktop', 'laptop'], ['laptop', 'desktop']]) {
    const h = aggregateUsage(order.map(device => r(pi('copied'), 'pi', device)), { models, owner: 'desktop' });
    assert.deepEqual(h.devices.map(d => [d.key, d.responses]), [['laptop', 1]]);
    assert.deepEqual(h.dayModels.map(d => d.device), ['laptop']);
  }
});

test('dated snapshots and context suffixes find the catalog rate of their model', () => {
  const h = aggregateUsage([r(pi('dated', 'rated-20251001')), r(pi('wide', 'rated[1m]'))], { models });
  assert.equal(h.unratedTokens, 0); assert.equal(h.models.length, 2);
});

test('unknown model, partial rates and unknown category never invent prices', () => {
  const partial = pi('partial'); delete partial.message.usage.cacheWrite;
  const h = aggregateUsage([r(partial), r(pi('missing', 'new-model')), r(pi('retry', 'new-model'))], { models: [{ provider: 'provider', id: 'rated', cost: { input: 1 } }] });
  assert.equal(h.responses, 3); assert.equal(h.unknownCategories, 1); assert.equal(h.missing.cacheWrite, 1);
  assert.equal(h.estimatedUSD, 0.0001); assert.equal(h.unratedTokens, 400);
  assert.equal(h.estimate.currency, 'USD'); assert.equal(h.estimate.partial, true);
});

test('catalog request-wide tiers and recorded one-hour cache writes follow installed Pi pricing basis', () => {
  const row = pi('tier'); row.message.usage.cacheWrite1h = 5;
  const catalog = [{ ...models[0], cost: { ...models[0].cost, tiers: [{ inputTokensAbove: 149, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 3 }] } }];
  const h = aggregateUsage([r(row)], { models: catalog });
  assert.ok(Math.abs(h.estimatedUSD - 0.000323) < 1e-10);
  const missing = pi('tier-missing'); delete missing.message.usage.cacheRead;
  const partial = aggregateUsage([r(missing)], { models: catalog });
  assert.equal(partial.estimatedUSD, 0); assert.equal(partial.unratedTokens, 130); assert.equal(partial.estimate.partial, true);
});

test('zero catalog placeholders and virtual prices are unavailable, not free', () => {
  for (const m of [{ provider: 'provider', id: 'rated', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, { ...models[0], api: 'pi-virtual' }]) {
    const h = aggregateUsage([r(pi())], { models: [m] });
    assert.equal(h.unratedTokens, 170); assert.equal(h.estimate.partial, true);
  }
});

test('no records, zero usage, synthetic assistant copies and unknown dates', () => {
  const zero = pi(); zero.message.usage = { input: 0, output: 0 };
  assert.equal(r(zero), null); assert.equal(r({ ...pi(), type: 'custom_message' }), null);
  const undated = pi(); delete undated.timestamp;
  assert.equal(aggregateUsage([r(undated)]).days.length, 0);
  assert.equal(aggregateUsage([r(undated)]).excludedDates, 1);
  assert.equal(aggregateUsage([]).responses, 0); assert.deepEqual(aggregateUsage([]).models, []);
  assert.equal(aggregateUsage([r(claude(), 'claude'), r({ ...claude(), isSidechain: true }, 'claude')]).responses, 1, 'a copied parent response in a child history is not another call');
});

test('read-only native scanning deduplicates roots and mirrors, includes unique child responses and reports incomplete lines', async t => {
  const home = await mkdtemp(join(tmpdir(), 'usage-native-')); t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, '.pi/agent'), sessionDir = join(agentDir, 'sessions');
  await mkdir(sessionDir, { recursive: true });
  const project = join(home, '.claude/projects/project'); await mkdir(join(project, 'subagents'), { recursive: true });
  await writeFile(join(sessionDir, 'a.jsonl'), `${JSON.stringify(pi())}\n${JSON.stringify(pi())}\n{`);
  await writeFile(join(project, 'a.jsonl'), `${JSON.stringify(claude(2))}\n${JSON.stringify(claude())}\n${JSON.stringify({ type: 'result', usage: { input_tokens: 500 } })}\n`);
  const child = { ...claude(), isSidechain: true, message: { ...claude().message, id: 'child-response' } };
  await writeFile(join(project, 'subagents', 'child.jsonl'), `${JSON.stringify(claude())}\n${JSON.stringify(child)}\n`);
  const h = await readUsageHistory({ home, agentDir, sessionDir, models, owner: 'selected-owner' });
  assert.equal(h.filesRead, 3); assert.equal(h.responses, 3); assert.equal(h.malformedRecords, 1); assert.equal(h.owner, 'selected-owner');
  assert.deepEqual(h.devices.map(d => d.key), ['selected-owner'], 'a computer\'s own histories ran on it');
  assert.doesNotMatch(JSON.stringify(h), /private text|\.jsonl|project/);
});

test('validated imported prefix belongs to original execution computer, appended responses to this one', async t => {
  const home = await mkdtemp(join(tmpdir(), 'usage-import-')); t.after(() => rm(home, { recursive: true, force: true }));
  const sessionDir = join(home, '.imperfect/data/state/sessions'), memoryDir = join(home, '.imperfect/memory');
  await mkdir(sessionDir, { recursive: true }); await mkdir(join(memoryDir, 'imports'), { recursive: true });
  const header = { type: 'session', id: 'import-session', timestamp: '2026-10-01T00:00:00Z' };
  const path = join(sessionDir, 'import.jsonl'), old = `${JSON.stringify(header)}\r\n${JSON.stringify(pi('imported'))}\r\n\r\n`, fresh = `${JSON.stringify(pi('appended'))}\n`;
  await writeFile(path, old + fresh);
  const hash = createHash('sha256').update(old).digest('hex');
  const manifest = { version: 1, path, machine: 'laptop', originalPath: '/home/original/.pi/agent/sessions/import.jsonl', recordCount: 2, byteCutoff: Buffer.byteLength(old), originalHash: hash, importedHash: hash, importedAt: '2026-10-02T00:00:00Z' };
  await writeFile(importManifestPath(memoryDir, path), JSON.stringify(manifest), { mode: 0o600 });
  const options = { home, sessionDir, agentDir: join(home, 'empty'), memoryDir, owner: 'desktop' };
  const h = await readUsageHistory(options);
  assert.deepEqual(h.devices.map(d => [d.key, d.responses]), [['desktop', 1], ['laptop', 1]]);
  const local = await readUsageHistory({ ...options, thisComputerOnly: true });
  assert.equal(local.responses, 1, 'local scope excludes the validated laptop import prefix');
  assert.deepEqual(local.devices.map(d => d.key), ['desktop']);
  await writeFile(join(sessionDir, 'mirror.jsonl'), old);
  const mirrored = await readUsageHistory(options);
  assert.equal(mirrored.responses, 2, 'import and copied native responses count once');
  assert.deepEqual(mirrored.devices.map(d => [d.key, d.responses]), [['desktop', 1], ['laptop', 1]]);
  await writeFile(importManifestPath(memoryDir, path), '{}');
  const unknown = await readUsageHistory(options);
  assert.equal(unknown.responses, 1, 'invalid provenance cannot silently re-count imported responses; only the ordinary mirror remains');
  assert.deepEqual(unknown.devices.map(d => d.key), ['desktop']);
  assert.equal(unknown.unreadableFiles, 1); assert.equal(unknown.historyCoverage.complete, false);
});
