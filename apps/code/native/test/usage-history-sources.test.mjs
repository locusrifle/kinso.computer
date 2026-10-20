import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes, appendFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsageHistory } from '../usage-history.mjs';

const now = Date.parse('2026-10-09T12:00:00Z');
const models = [{ provider: 'fixture', id: 'rated', cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5, tiers: [{ inputTokensAbove: 1000, input: 10, output: 20, cacheRead: 1, cacheWrite: 15 }] } },
  { provider: 'anthropic', id: 'claude-big', cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6 } }];
const pi = (id, extra = '') => JSON.stringify({ type: 'message', id, timestamp: '2026-10-01T00:00:00Z', message: { role: 'assistant', provider: 'fixture', model: 'rated', content: `private${extra}`, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } });
const claude = (id, model = 'claude-big') => JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-10-02T00:00:00Z', message: { role: 'assistant', id, model, usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const counters = usage => JSON.stringify({ type: 'cost-state', sessionId: 's', modelUsage: Object.fromEntries(Object.entries(usage).map(([model, outputTokens]) => [model, { outputTokens }])) });
async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'usage-sources-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { home: dir, agentDir: join(dir, '.pi/agent'), sessionDir: join(dir, '.imperfect/data/state/sessions'), memoryDir: join(dir, '.imperfect/memory'), claude: join(dir, '.claude/projects/p') };
  for (const p of [paths.sessionDir, paths.claude, join(paths.memoryDir, 'raw/laptop/claude'), join(paths.memoryDir, 'raw/laptop/pi'), join(paths.memoryDir, 'raw/desktop/pi'), join(paths.memoryDir, 'raw/laptop/archives/.claude/p/subagents'), join(paths.memoryDir, 'raw/laptop/archives/.codex')]) await mkdir(p, { recursive: true });
  return paths;
}
const options = p => ({ home: p.home, agentDir: p.agentDir, sessionDir: p.sessionDir, memoryDir: p.memoryDir, models, owner: 'desktop', now });
const gz = (path, lines) => writeFile(path, gzipSync(lines.join('\n') + '\n'));

test('rejected Codex usage is incomplete coverage in fresh and cached reads', async t => {
  const p = await home(t), root = join(p.home, '.codex/sessions');
  await mkdir(root, { recursive: true });
  const usage = (cached, timestamp = '2026-10-01T00:00:00Z') => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: cached, output_tokens: 1 }, last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 1 } } } });
  const rows = [{ type: 'session_meta', payload: { id: 'invalid-coverage' } }, usage(-1), usage(2, '2026-02-30T00:00:00Z'), usage(2), usage(2), { type: 'event_msg', payload: { type: 'token_count', info: null } }];
  await writeFile(join(root, 'invalid.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  const opts = { ...options(p), cacheFile: join(p.home, 'cache.json') };
  for (let i = 0; i < 2; i++) {
    const h = await readUsageHistory(opts);
    assert.equal(h.responses, 1); assert.equal(h.malformedRecords, 2);
    assert.equal(h.historyCoverage.complete, false);
  }
});

test('every native root and every computer memory keeps is read whole, each response once, where it ran', async t => {
  const p = await home(t);
  for (let i = 0; i < 30; i++) await writeFile(join(p.sessionDir, `s${i}.jsonl`), `${pi(`here-${i}`)}\n`);
  await writeFile(join(p.claude, 'c.jsonl'), `${claude('shared')}\n${claude('mine')}\n`);
  await gz(join(p.memoryDir, 'raw/desktop/pi/s0.jsonl.gz'), [pi('here-0')]);
  await gz(join(p.memoryDir, 'raw/laptop/claude/c.jsonl.gz'), [claude('shared'), claude('away')]);
  await gz(join(p.memoryDir, 'raw/laptop/pi/l.jsonl.gz'), [pi('away-pi')]);
  await gz(join(p.memoryDir, 'raw/laptop/archives/.claude/p/subagents/a.jsonl.gz'), [claude('child')]);
  await gz(join(p.memoryDir, 'raw/laptop/archives/.codex/r.jsonl.gz'), ['{"type":"event_msg"}']);
  await writeFile(join(p.memoryDir, 'raw/laptop/archives/manifest.json'), JSON.stringify({ files: [{ path: '.claude/p/subagents/a.jsonl.gz', harness: 'claude' }, { path: '.codex/r.jsonl.gz', harness: 'codex' }, { path: '../../escape.jsonl.gz', harness: 'claude' }] }));
  const h = await readUsageHistory(options(p));
  assert.equal(h.responses, 30 + 2 + 3, 'no file, byte or record cap; copies count once');
  assert.deepEqual(h.devices.map(d => [d.key, d.responses]), [['desktop', 31], ['laptop', 4]]);
  assert.equal(h.unreadableFiles, 0); assert.equal(h.malformedRecords, 0); assert.equal(h.historyCoverage.complete, true);
  assert.match(h.historyCoverage.scope, /memory's copies of every computer's \(desktop, laptop\)/);
  assert.doesNotMatch(JSON.stringify(h), /private|\.jsonl|shared|away/);
});

test('a scrubbed model ID is recovered from its session\'s own counters only when one model dominates', async t => {
  const p = await home(t);
  await gz(join(p.memoryDir, 'raw/laptop/claude/one.jsonl.gz'), [claude('a', '[redacted]'), counters({ 'claude-small': 30, 'claude-big': 9000 })]);
  await gz(join(p.memoryDir, 'raw/laptop/claude/two.jsonl.gz'), [claude('b', '[redacted]'), counters({ 'claude-small': 5000, 'claude-big': 5000 })]);
  await gz(join(p.memoryDir, 'raw/laptop/claude/three.jsonl.gz'), [claude('c', '[redacted]')]);
  const h = await readUsageHistory(options(p));
  assert.deepEqual(h.models.map(m => [m.key, m.responses]), [['anthropic/claude-big', 1], ['unknown/[redacted]', 2]]);
  assert.equal(h.unratedTokens, 2200); assert.ok(Math.abs(h.estimatedUSD - 0.0075) < 1e-12);
});

test('exact recovered response model replaces a counters-based inference', async t => {
  const p = await home(t);
  await gz(join(p.memoryDir, 'raw/laptop/claude/old.jsonl.gz'), [claude('correct-me', '[redacted]'), counters({ 'claude-big': 10000 })]);
  await gz(join(p.memoryDir, 'raw/laptop/archives/.claude/p/subagents/exact.jsonl.gz'), [claude('correct-me', 'claude-small')]);
  await writeFile(join(p.memoryDir, 'raw/laptop/archives/manifest.json'), JSON.stringify({ files: [{ path: '.claude/p/subagents/exact.jsonl.gz', harness: 'claude' }] }));
  const h = await readUsageHistory(options(p)); assert.equal(h.responses, 1); assert.equal(h.models[0].key, 'anthropic/claude-small');
});

test('unchanged files come from the private cache; changed, added and removed ones do not', async t => {
  const p = await home(t), cacheFile = join(p.home, 'usage-history.json'), file = join(p.sessionDir, 'a.jsonl');
  const mtime = new Date('2026-10-01T00:00:00Z');
  await writeFile(file, `${pi('one', 'x')}\n`); await utimes(file, mtime, mtime);
  const first = await readUsageHistory({ ...options(p), cacheFile });
  assert.equal(first.responses, 1); assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
  await writeFile(file, `${pi('two', 'y')}\n`); await utimes(file, mtime, mtime);
  assert.equal((await readUsageHistory({ ...options(p), cacheFile })).dayModels[0].tokens.input, 100);
  assert.match(await readFile(cacheFile, 'utf8'), /one/, 'same size and time: read from the cache');
  await appendFile(file, `${pi('three')}\n`);
  assert.equal((await readUsageHistory({ ...options(p), cacheFile })).responses, 2, 'a grown file is read again');
  await writeFile(join(p.sessionDir, 'b.jsonl'), `${pi('four')}\n`);
  assert.equal((await readUsageHistory({ ...options(p), cacheFile })).responses, 3);
  await rm(file);
  assert.equal((await readUsageHistory({ ...options(p), cacheFile })).responses, 1);
  assert.doesNotMatch(await readFile(cacheFile, 'utf8'), /a\.jsonl/);
});

test('delegated Pi workers count once from their summed result, at base rates', async t => {
  const p = await home(t), worker = join(p.agentDir, 'subagents/parent/w1');
  await mkdir(worker, { recursive: true });
  await writeFile(join(worker, 'state.json'), JSON.stringify({ id: 'w1', model: { provider: 'fixture', id: 'rated' }, endedAt: '2026-10-08T00:00:00Z' }));
  await writeFile(join(worker, 'result.json'), JSON.stringify({ status: 'done', usage: { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } }, usageReliable: true, output: 'private report' }));
  await mkdir(join(p.agentDir, 'subagents/parent/running'), { recursive: true });
  await writeFile(join(p.agentDir, 'subagents/parent/running/state.json'), JSON.stringify({ id: 'running', model: { provider: 'fixture', id: 'rated' } }));
  const h = await readUsageHistory(options(p));
  assert.equal(h.responses, 1); assert.deepEqual(h.devices.map(d => d.key), ['desktop']);
  assert.ok(Math.abs(h.estimatedUSD - 0.0052) < 1e-12, 'a sum of requests is not one large request');
  assert.doesNotMatch(JSON.stringify(h), /private report|w1/);
});

test('Sol workers count actual response models, not requested models or private session copies; unknown usage stays incomplete', async t => {
  const p = await home(t), dir = join(p.agentDir, 'subagents/parent/sol');
  await mkdir(join(dir, 'session'), { recursive: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify({ id: 'sol', engine: 'pi', model: { provider: 'openai-codex', id: 'gpt-6.1-sol' }, endedAt: '2026-10-08T00:00:00Z' }));
  await writeFile(join(dir, 'result.json'), JSON.stringify({ engine: 'pi', status: 'done', usageReliable: true, models: { rated: { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, provider: 'fixture' } } }));
  await writeFile(join(dir, 'session/private.jsonl'), pi('private-copy'));
  const unknown = join(p.agentDir, 'subagents/parent/unknown'); await mkdir(unknown);
  await writeFile(join(unknown, 'state.json'), JSON.stringify({ engine: 'pi', model: { provider: 'openai-codex', id: 'gpt-6.1-sol' } }));
  await writeFile(join(unknown, 'result.json'), JSON.stringify({ status: 'failed', models: {}, usage: null, usageReliable: false }));
  const h = await readUsageHistory(options(p));
  assert.equal(h.responses, 1); assert.equal(h.tokens.input, 5000); assert.equal(h.models[0].key, 'fixture/rated');
  assert.equal(h.malformedRecords, 1); assert.equal(h.historyCoverage.complete, false);
});

test('delegated Claude workers count once per model that answered; unreliable usage is incomplete coverage, never a guess', async t => {
  const p = await home(t), worker = (id, result) => [join(p.agentDir, 'subagents/parent', id), result];
  const write = async ([dir, result], id) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'state.json'), JSON.stringify({ id, engine: 'claude', model: null, endedAt: '2026-10-08T00:00:00Z' })); await writeFile(join(dir, 'result.json'), JSON.stringify(result)); };
  await write(worker('c1', { engine: 'claude', status: 'done', usageReliable: true, output: 'private report', models: { 'claude-big': { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, provider: 'firstParty' }, 'claude-unrated': { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 } } }), 'c1');
  await write(worker('c2', { engine: 'claude', status: 'failed', usageReliable: false, models: { 'claude-big': { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 } } }), 'c2');
  await write(worker('c3', { engine: 'claude', status: 'failed', limit: true, usageReliable: true, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, models: {} }), 'c3');
  await write(worker('c4', { engine: 'claude', status: 'failed', usageReliable: false, usage: null, models: {} }), 'c4');
  const h = await readUsageHistory(options(p));
  assert.equal(h.responses, 2); assert.equal(h.tokens.input, 1005); assert.equal(h.malformedRecords, 2, 'partial and unknown usage both count as incomplete'); assert.equal(h.historyCoverage.complete, false);
  assert.ok(Math.abs(h.estimatedUSD - 0.0075) < 1e-12, 'base rates on the summed tokens, not Claude\'s list-price costUSD');
  assert.doesNotMatch(JSON.stringify(h), /private report|c1/);
});

test('Codex native and archive mirrors count once by session and counter, not across independent sessions', async t => {
  const p = await home(t), native = join(p.home, '.codex/sessions');
  await mkdir(native, { recursive: true });
  const log = id => [JSON.stringify({ type: 'session_meta', payload: { id } }), JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-fixture' } }), ...[1, 2].map(() => JSON.stringify({ type: 'event_msg', timestamp: '2026-10-01T00:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } } } }))];
  await writeFile(join(native, 'a.jsonl'), log('one').join('\n') + '\n');
  await gz(join(p.memoryDir, 'raw/laptop/archives/.codex/a.jsonl.gz'), log('one'));
  await gz(join(p.memoryDir, 'raw/laptop/archives/.codex/b.jsonl.gz'), log('two'));
  await writeFile(join(p.memoryDir, 'raw/laptop/archives/manifest.json'), JSON.stringify({ files: ['a', 'b'].map(id => ({ path: `.codex/${id}.jsonl.gz`, harness: 'codex' })) }));
  const h = await readUsageHistory(options(p));
  assert.equal(h.responses, 2); assert.equal(h.tokens.input, 40); assert.equal(h.tokens.output, 20); assert.equal(h.tokens.cacheRead, 160);
  assert.deepEqual(h.devices.map(d => [d.key, d.responses]), [['laptop', 2]]);
});

test('records end only at LF: U+2028 inside a string and CRLF endings keep a record whole', async t => {
  const p = await home(t);
  await writeFile(join(p.sessionDir, 'a.jsonl'), `${pi('sep', ' after ')}\r\n${pi('next')}\r\n`);
  const h = await readUsageHistory(options(p));
  assert.equal(h.responses, 2); assert.equal(h.malformedRecords, 0);
});
