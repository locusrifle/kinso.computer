import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { aggregateUsage, usageRecord, readUsageHistory } from '../usage-history.mjs';

const categories = ['input', 'output', 'cacheRead', 'cacheWrite'];
const now = Date.parse('2026-10-11T12:00:00Z');
const models = [{ provider: 'fixture', id: 'rated', cost: { input: 1, output: 2, cacheRead: .1, cacheWrite: 1.5 } }, { provider: 'anthropic', id: 'claude-rated', cost: { input: 5, output: 25, cacheRead: .5, cacheWrite: 6 } }];
const claude = (id, sidechain) => ({ type: 'assistant', timestamp: '2026-10-10T00:00:00Z', ...(sidechain === undefined ? {} : { isSidechain: sidechain }), message: { role: 'assistant', id, model: 'claude-rated', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } });
const fields = ['responses', 'estimatedUSD', 'unratedTokens', 'unknownCategories'];
const blank = () => ({ tokens: Object.fromEntries(categories.map(k => [k, 0])), categoryUSD: Object.fromEntries(categories.map(k => [k, 0])), missing: Object.fromEntries(categories.map(k => [k, 0])), ...Object.fromEntries(fields.map(k => [k, 0])) });
function sum(rows) {
  const total = blank();
  for (const row of rows) {
    for (const field of ['tokens', 'categoryUSD', 'missing']) for (const k of categories) total[field][k] += row[field][k];
    for (const k of fields) total[k] += row[k];
  }
  return total;
}
function equal(a, b) {
  for (const field of ['tokens', 'categoryUSD', 'missing']) for (const k of categories) assert.ok(Math.abs(a[field][k] - b[field][k]) < 1e-10);
  for (const k of fields) assert.ok(Math.abs(a[k] - b[k]) < 1e-10);
}
function conserved(h) {
  equal(sum(h.dayAgents), sum(h.dayModels)); equal(sum(h.dayAgents), h);
  for (const row of h.dayModels) {
    const agents = h.dayAgents.filter(a => a.day === row.day && a.provider === row.provider && a.model === row.model && a.device === row.device);
    equal(sum(agents), row);
  }
  for (const r of h.dayAgents) assert.deepEqual(JSON.parse(r.key), [r.day, r.provider, r.model, r.device, r.harness]);
}

test('dayAgents partitions the exact existing cost calculation, native harnesses and explicit workers', () => {
  const records = ['pi', 'claude', 'codex', 'pi'].map((agent, i) => ({ key: `${i}`, agent, ...(i === 3 ? { harness: 'workers', aggregate: true } : {}), day: '2026-10-10', at: Date.parse('2026-10-10'), device: 'desktop', provider: 'fixture', model: 'rated', tokens: { input: 100, output: 10, cacheRead: 20, cacheWrite: 5 }, cacheWrite1h: i === 0 ? 2 : null }));
  records.push({ ...records[0], key: 'partial', day: '2026-10-09', device: 'laptop', model: 'unknown', tokens: { ...records[0].tokens, cacheRead: null } });
  const h = aggregateUsage(records, { models, now });
  conserved(h);
  assert.deepEqual(h.dayAgents.map(r => r.harness).sort(), ['claude', 'codex', 'pi', 'pi', 'workers']);
  const workers = h.dayAgents.filter(r => r.harness === 'workers');
  equal(sum(workers), aggregateUsage([records[3]], { models, now }));
  assert.equal(records[3].agent, 'pi', 'classification does not overwrite engine metadata');
  assert.equal(h.dayModels.length, 2, 'harness does not split the existing dayModels');
});

test('explicit Claude sidechains count as workers, but a copied parent response stays native in either order', () => {
  const parent = usageRecord(claude('parent'), { agent: 'claude' });
  const copy = usageRecord(claude('parent', true), { agent: 'claude' });
  const child = usageRecord(claude('child', true), { agent: 'claude' });
  assert.equal(child.agent, 'claude'); assert.equal(child.harness, 'workers');
  for (const records of [[parent, copy, child], [copy, parent, child]]) {
    const h = aggregateUsage(records, { models, now });
    conserved(h); assert.equal(h.responses, 2);
    assert.deepEqual(h.dayAgents.map(r => [r.harness, r.responses]).sort(), [['claude', 1], ['workers', 1]]);
    equal(sum(h.dayAgents.filter(r => r.harness === 'workers')), aggregateUsage([child], { models, now }));
  }
});

test('cached native/archive rows preserve proven harnesses; filenames do not prove workers; runner sums are explicit workers', async t => {
  const home = await mkdtemp(join(tmpdir(), 'usage-agents-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const agentDir = join(home, '.pi/agent'), sessionDir = join(agentDir, 'sessions'), project = join(home, '.claude/projects/p');
  const memoryDir = join(home, 'memory'), archive = join(memoryDir, 'raw/laptop/archives');
  for (const dir of [sessionDir, join(project, 'subagents'), join(archive, 'subagents')]) await mkdir(dir, { recursive: true });
  const lines = rows => rows.map(JSON.stringify).join('\n') + '\n';
  await writeFile(join(project, 'main.jsonl'), lines([claude('parent')]));
  await writeFile(join(project, 'subagents/child.jsonl'), lines([claude('parent', true), claude('child', true), claude('unproven-native')]));
  await writeFile(join(archive, 'subagents/child.jsonl.gz'), gzipSync(lines([claude('child', true), claude('unproven-archive')])));
  await writeFile(join(archive, 'manifest.json'), JSON.stringify({ files: [{ path: 'subagents/child.jsonl.gz', harness: 'claude' }] }));
  await writeFile(join(sessionDir, 'pi.jsonl'), lines([{ type: 'message', id: 'pi', timestamp: '2026-10-10T00:00:00Z', message: { role: 'assistant', model: 'rated', provider: 'fixture', usage: { input: 100, output: 10, cacheRead: 20, cacheWrite: 5 } } }]));
  const worker = async (id, state, result) => {
    const dir = join(agentDir, 'subagents/parent', id); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), JSON.stringify({ endedAt: '2026-10-10T00:00:00Z', ...state }));
    await writeFile(join(dir, 'result.json'), JSON.stringify(result));
  };
  const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
  await worker('old-pi', { model: { id: 'rated', provider: 'fixture' } }, { usageReliable: true, usage });
  await worker('pi', { engine: 'pi' }, { usageReliable: true, models: { rated: { ...usage, provider: 'fixture' } } });
  await worker('claude', { engine: 'claude' }, { usageReliable: true, models: { 'claude-rated': usage } });
  await worker('unreliable', { engine: 'pi' }, { usageReliable: false, models: { rated: usage } });
  const cacheFile = join(home, 'cache.json');
  await writeFile(cacheFile, JSON.stringify({ version: 4, files: {} }));
  const options = { home, agentDir, sessionDir, memoryDir, cacheFile, models, owner: 'desktop', now };
  const first = await readUsageHistory(options), cachedAt = (await stat(cacheFile)).mtimeMs;
  const second = await readUsageHistory(options);
  assert.deepEqual(second, first); assert.equal((await stat(cacheFile)).mtimeMs, cachedAt, 'unchanged packed records reuse the cache');
  assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).version, 6);
  conserved(first); assert.equal(first.responses, 8); assert.equal(first.malformedRecords, 1);
  assert.equal(first.historyCoverage.complete, false);
  assert.equal(sum(first.dayAgents.filter(r => r.harness === 'workers')).responses, 4, 'one native child, three reliable runner model sums');
  assert.equal(sum(first.dayAgents.filter(r => r.harness === 'claude')).responses, 3, 'parent and unproven native/archive logs remain Claude');
  assert.equal(sum(first.dayAgents.filter(r => r.harness === 'pi')).responses, 1);
  assert.equal(first.dayAgents.filter(r => r.harness === 'workers' && r.provider === 'fixture')[0].tokens.input, 2000);
  assert.doesNotMatch(JSON.stringify(first), /parent|child\.jsonl|unproven|old-pi/);
});
