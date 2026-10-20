import { createReadStream } from 'node:fs';
import { readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { codexUsageReader } from './usage-codex.mjs';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { importedBytes, readMemoryImport, validateMemoryImport } from '../../../system/memory-imports.mjs';
import { Readable } from 'node:stream';
import { durableArchiveRows, durableArchiveStamp, loadDurableArchive } from './durable-archive.mjs';

export const CATEGORIES = ['input', 'output', 'cacheRead', 'cacheWrite'];
const count = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
const empty = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
// Detach identifiers from large JSONL lines (which can contain image data).
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 ? Buffer.from(value).toString('utf8') : null;
// Claude Code logs no provider; a claude-* model is Anthropic's, whatever carried it.
const vendor = (agent, provider, model) => provider || (agent === 'claude' && model.startsWith('claude-') ? 'anthropic' : 'unknown');

// A recorded timestamp's UTC day. Date.parse normalizes impossible dates such
// as February 30; do not price them as real history.
function dayOf(at) {
  const date = new Date(typeof at === 'number' || (typeof at === 'string' && at.trim()) ? at : NaN);
  const calendar = typeof at === 'string' ? at.match(/^(\d{4}-\d{2}-\d{2})(?:[Tt ]|$)/)?.[1] : null;
  const calendarDate = calendar ? new Date(`${calendar}T00:00:00Z`) : null;
  const validCalendar = !calendar || (Number.isFinite(calendarDate.getTime()) && calendarDate.toISOString().slice(0, 10) === calendar);
  return { at: date.getTime(), day: validCalendar && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'unknown' };
}

// Native response/operation metadata. Claude result/modelUsage counters are
// cumulative and overlap these responses; they must never be added. Legacy Pi
// compactions without model identity keep their tokens, not an invented model.
export function usageRecord(row, { agent, device = 'unknown', model: known = null, includeUnknown = false }) {
  const operation = agent === 'pi' && ['usage', 'compaction', 'branch_summary'].includes(row.type) && row.usage;
  const m = operation ? { role: 'assistant', model: row.model || 'unknown', provider: row.provider, usage: row.usage, timestamp: row.timestamp } : row.message;
  if (!m || m.role !== 'assistant' || (!operation && (agent === 'pi' ? row.type !== 'message' : row.type !== 'assistant')) || (!m.usage && !includeUnknown)) return null;
  const model = known || identifier(m.responseModel) || identifier(typeof m.model === 'string' ? m.model : m.model?.id);
  if (!model || model.startsWith('<')) return null;
  const u = m.usage || {};
  const tokens = agent === 'pi' ? Object.fromEntries(CATEGORIES.map(k => [k, count(u[k])])) : {
    input: count(u.input_tokens), output: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens),
  };
  if (!includeUnknown && !Object.values(tokens).some(n => n > 0)) return null;
  const at = m.timestamp ?? row.timestamp;
  const provider = vendor(agent, identifier(m.provider || row.provider), model);
  // Pi entry IDs are only session-local: their recorded response timestamp
  // disambiguates unrelated sessions, while native mirrors keep both. Claude
  // response IDs are global and survive copied parent context/content blocks.
  // Responses keep their ID/timestamp even where a copy's model ID was
  // scrubbed, so dated Pi mirrors and Claude copies exclude model metadata
  // from identity. Undated Pi records retain it to reduce local-ID collisions.
  const id = agent === 'claude' ? m.id : operation && row.id ? `operation:${row.id}` : row.id;
  const identity = id ? (agent === 'pi' ? [id, at ?? 'unknown', ...(at == null ? [provider, model] : [])] : [id]) : [at, tokens, provider, model];
  const key = agent === 'pi' && identifier(m.responseId) ? JSON.stringify(['pi-response', provider, m.responseId]) : JSON.stringify([agent, ...identity]);
  return { key, agent, harness: agent === 'claude' && row.isSidechain === true ? 'workers' : agent, device, ...dayOf(at), provider, model, tokens,
    unattributed: Boolean(operation && (!row.provider || !row.model)),
    cacheWrite1h: count(agent === 'pi' ? u.cacheWrite1h : u.cache_creation?.ephemeral_1h_input_tokens) };
}

const bucket = extra => ({ tokens: empty(), categoryUSD: empty(), missing: empty(), responses: 0, estimatedUSD: 0, unratedTokens: 0, unknownCategories: 0, ...extra });

export function aggregateUsage(records, { models = [], owner = 'unknown', now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  let excludedDates = 0, undatedResponses = 0;
  const unique = new Map();
  for (const record of records) {
    if (!record) continue;
    if (!record.undated && (!/^\d{4}-\d{2}-\d{2}$/.test(record.day) || record.at > now || record.day > today)) { excludedDates++; continue; }
    const previous = unique.get(record.key);
    if (!previous) unique.set(record.key, { ...record, tokens: { ...record.tokens } });
    else {
      // A parent response copied into a child history is still the parent's
      // call. Native evidence wins over a sidechain copy, in either read order.
      if ((record.harness || record.agent) !== 'workers') previous.harness = record.harness || record.agent;
      // Claude can write multiple content blocks/updates for one API response.
      for (const k of CATEGORIES) if (record.tokens[k] != null) previous.tokens[k] = Math.max(previous.tokens[k] ?? 0, record.tokens[k]);
      // A copy kept for another computer names where the response ran.
      if (previous.device === 'unknown' || (previous.device === owner && record.device !== 'unknown')) previous.device = record.device;
      if (record.cacheWrite1h != null) previous.cacheWrite1h = Math.max(previous.cacheWrite1h ?? 0, record.cacheWrite1h);
      if ((previous.model.includes('[redacted]') && !record.model.includes('[redacted]')) || (previous.inferred && !record.inferred && !record.model.includes('[redacted]'))) Object.assign(previous, { provider: record.provider, model: record.model, inferred: record.inferred });
    }
  }
  const rates = new Map(models.filter(m => m.api !== 'pi-virtual').map(m => [`${m.provider}/${m.id}`, m.cost]));
  // Logs can carry a context suffix ("[1m]") or a dated snapshot the catalog lists without its date.
  const rateFor = source => rates.get(source) ?? rates.get(source.replace(/\[[^\]]*\]$/, '')) ?? rates.get(source.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, ''));
  const total = bucket();
  const buckets = { days: new Map(), models: new Map(), devices: new Map(), dayModels: new Map(), dayAgents: new Map() };
  // The last eight days hour by hour, so a window counts "today" from its
  // own midnight (days above are UTC days).
  const HOUR = 3_600_000, recentFrom = now - 8 * 24 * HOUR;
  const hours = new Map();
  for (const record of unique.values()) {
    if (record.undated) undatedResponses++;
    const rateSource = `${record.provider}/${record.model}`;
    const catalogRate = rateFor(rateSource);
    let rate = catalogRate && CATEGORIES.some(c => count(catalogRate[c]) > 0) ? catalogRate : null;
    // Tiers apply per request; a worker's summed total is priced at base rates.
    if (rate?.tiers?.length && !record.aggregate) {
      if (['input', 'cacheRead', 'cacheWrite'].some(k => record.tokens[k] == null)) rate = null;
      else {
        const input = record.tokens.input + record.tokens.cacheRead + record.tokens.cacheWrite;
        const tier = [...rate.tiers].filter(t => input > t.inputTokensAbove).sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0];
        if (tier) rate = tier;
      }
    }
    const cost = bucket({ responses: 1 });
    for (const k of CATEGORIES) {
      const n = record.tokens[k];
      if (n == null) { cost.unknownCategories++; cost.missing[k]++; continue; }
      cost.tokens[k] = n;
      // Catalog all-zero prices are often placeholders for subscription models,
      // not documented free API rates. Conservatively leave them unavailable.
      if (rate && count(rate[k]) != null) {
        if (k === 'cacheWrite' && record.cacheWrite1h > 0) {
          if (record.cacheWrite1h > n || count(rate.input) == null) cost.unratedTokens += n;
          else cost.categoryUSD[k] += ((n - record.cacheWrite1h) * rate.cacheWrite + record.cacheWrite1h * rate.input * 2) / 1e6;
        } else cost.categoryUSD[k] += n * rate[k] / 1e6;
      } else cost.unratedTokens += n;
    }
    cost.estimatedUSD = CATEGORIES.reduce((sum, k) => sum + cost.categoryUSD[k], 0);
    const targets = [total];
    const harness = record.harness || record.agent || 'unknown';
    for (const [group, key] of [['days', record.day], ['models', rateSource], ['devices', record.device], ['dayModels', JSON.stringify([record.day, record.provider, record.model, record.device])], ['dayAgents', JSON.stringify([record.day, record.provider, record.model, record.device, harness])]]) {
      if (!buckets[group].has(key)) buckets[group].set(key, bucket({ key, ...(['dayModels', 'dayAgents'].includes(group) ? { day: record.day, provider: record.provider, model: record.model, device: record.device } : {}), ...(group === 'dayAgents' ? { harness } : {}), ...(group === 'models' ? { rates: catalogRate ?? null, rateSource } : {}), ...(group === 'devices' ? { latest: null } : {}) }));
      targets.push(buckets[group].get(key));
    }
    for (const target of targets) {
      for (const k of CATEGORIES) { target.tokens[k] += cost.tokens[k]; target.categoryUSD[k] += cost.categoryUSD[k]; target.missing[k] += cost.missing[k]; }
      for (const k of ['responses', 'estimatedUSD', 'unratedTokens', 'unknownCategories']) target[k] += cost[k];
    }
    const device = buckets.devices.get(record.device);
    if (!(device.latest >= record.at)) device.latest = record.at;
    if (Number.isFinite(record.at) && record.at >= recentFrom) {
      const at = Math.floor(record.at / HOUR) * HOUR;
      const hour = hours.get(at) ?? { at, tokens: 0, estimatedUSD: 0, responses: 0 };
      hour.tokens += CATEGORIES.reduce((sum, k) => sum + (cost.tokens[k] ?? 0), 0);
      hour.estimatedUSD += cost.estimatedUSD; hour.responses += 1;
      hours.set(at, hour);
    }
  }
  return { owner, ...total, excludedDates, undatedResponses, ...Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, [...v.values()].sort((a, b) => a.key.localeCompare(b.key))])),
    hours: [...hours.values()].sort((a, b) => a.at - b.at),
    estimate: { currency: 'USD', source: 'Installed Pi modelRuntime catalog cost metadata', asOf: new Date(now).toISOString(), basis: 'USD per million tokens; current catalog rates, not historical prices; per-request input tiers (delegated workers\' totals at base rates); default cache-write rate unless a 1h split is recorded (installed Pi calculator: 2× input for 1h writes); hypothetical API equivalent, not subscription charges', partial: total.unratedTokens > 0 || total.unknownCategories > 0 || undatedResponses > 0 } };
}

async function names(dir) {
  try { return (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort(); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return []; throw e; }
}
async function* tree(root, suffix, depth = 0) {
  if (!root || depth > 8) return;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return; throw e; }
  for (const e of entries) {
    if (e.isDirectory()) yield* tree(join(root, e.name), suffix, depth + 1);
    else if (e.isFile() && e.name.endsWith(suffix)) yield join(root, e.name);
  }
}

// Every history this computer keeps: its own native Pi/Claude logs and, where
// memory lives (the PC), memory's gzipped copy of every computer's logs.
async function sources({ sessionDir, agentDir, home, claudeDir, memoryDir, owner }) {
  const found = [];
  let problems = 0;
  const add = async (agent, device, paths) => {
    try { for await (const path of paths) found.push({ path, agent, device, worker: path.includes('/subagents/'), native: device === owner && !path.endsWith('.gz') }); } catch { problems++; }
  };
  for (const root of [sessionDir, join(agentDir, 'sessions'), join(home, '.pi/agent/sessions')]) {
    for (const suffix of ['.jsonl', '.sqlite']) await add('pi', owner, tree(root, suffix));
  }
  // Durable workers have stable per-response identities; their result totals
  // must not be added again, even after a crash or a memory mirror.
  await add('pi', owner, tree(join(agentDir, 'subagents'), '.sqlite'));
  await add('claude', owner, tree(join(claudeDir, 'projects'), '.jsonl'));
  for (const dir of ['sessions', 'archived_sessions']) await add('codex', owner, tree(join(home, '.codex', dir), '.jsonl'));
  if (memoryDir) {
    let computers = [];
    try { computers = await names(join(memoryDir, 'raw')); } catch { problems++; }
    for (const computer of computers) {
      const raw = join(memoryDir, 'raw', computer);
      for (const agent of ['pi', 'claude', 'codex']) await add(agent, computer, tree(join(raw, agent), '.jsonl.gz'));
      await add('pi', computer, tree(join(raw, 'pi'), '.sqlite.gz'));
      // Child and worker logs memory keeps beside the human ones.
      let manifest = null;
      try { manifest = JSON.parse(await readFile(join(raw, 'archives', 'manifest.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') problems++; }
      for (const file of Array.isArray(manifest?.files) ? manifest.files : []) {
        const agent = file?.harness === 'claude' ? 'claude' : file?.harness === 'codex' ? 'codex' : String(file?.harness).startsWith('pi') ? 'pi' : null;
        if (agent && typeof file.path === 'string' && (file.path.endsWith('.jsonl.gz') || (agent === 'pi' && file.path.endsWith('.sqlite.gz'))) && !file.path.split(/[\\/]/).includes('..')) found.push({ path: join(raw, 'archives', file.path), agent, device: computer, worker: file.harness === 'pi-worker' || file.path.includes('/subagents/'), native: false });
      }
    }
  }
  return { found, problems };
}

// JSONL records end only at LF; readline would also split inside strings at
// U+2028/U+2029, which JSON leaves unescaped.
async function* lines(stream) {
  let pending = [];
  for await (const chunk of stream) {
    let start = 0, end;
    while ((end = chunk.indexOf('\n', start)) !== -1) { pending.push(chunk.slice(start, end)); yield pending.join(''); pending = []; start = end + 1; }
    if (start < chunk.length) pending.push(chunk.slice(start));
  }
  if (pending.length) yield pending.join('');
}

// One file's responses. Lines without usage are never parsed; a line that is
// not a whole JSON object is malformed (a truncated write, usually).
async function scan(path, agent, deviceAt) {
  const input = createReadStream(path), stream = path.endsWith('.gz') ? input.pipe(createGunzip()) : input;
  stream.setEncoding('utf8');
  const records = [], redacted = [], named = new Set(), counters = new Map();
  let index = 0, malformed = 0;
  const codex = codexUsageReader(deviceAt(1), () => { malformed++; });
  try {
    for await (const line of lines(stream)) {
      const text = line.trim();
      if (!text) continue;
      ++index;
      if (text[0] !== '{' || text.at(-1) !== '}') { malformed++; continue; }
      if (agent === 'codex') {
        try { const record = codex(JSON.parse(text)); if (record) records.push(record); } catch { malformed++; }
        continue;
      }
      const usage = text.includes('"usage"'), costs = agent === 'claude' && text.includes('"modelUsage"');
      if (!usage && !costs) continue;
      let row;
      try { row = JSON.parse(text); } catch { malformed++; continue; }
      if (costs && row.modelUsage && typeof row.modelUsage === 'object') {
        for (const [model, u] of Object.entries(row.modelUsage)) counters.set(model, Math.max(counters.get(model) ?? 0, count(u?.outputTokens) ?? 0));
      }
      const record = usage ? usageRecord(row, { agent, device: deviceAt(index) }) : null;
      if (!record) continue;
      if (record.unattributed) malformed++;
      if (record.model.includes('[redacted]')) redacted.push({ row, device: record.device, model: record.model });
      else { named.add(record.model); records.push(record); }
    }
  } finally { input.destroy(); stream.destroy(); }
  // A memory import scrubbed some model IDs as if they were secrets. Claude
  // Code's own per-session counters still name the model: take it only when one
  // unnamed model accounts for nearly all of the session's output.
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const { row, device, model } of redacted) {
    const pattern = new RegExp('^' + model.split('[redacted]').map(escape).join('.+') + '$');
    const candidates = [...counters].filter(([id]) => !named.has(id) && !id.includes('[redacted]') && pattern.test(id));
    const sum = candidates.reduce((n, [, out]) => n + out, 0), best = candidates.sort((a, b) => b[1] - a[1])[0];
    const recovered = best && sum > 0 && best[1] >= 0.95 * sum ? best[0] : model;
    records.push({ ...usageRecord(row, { agent, device, model: recovered }), inferred: recovered !== model });
  }
  return { records: records.map(pack), malformed };
}

// Durable 1.2 keeps compaction usage only in the cumulative pi.usage doc.
// Subtract committed responses, preserving the residual by actual model/cache
// category. Its request count/dates/tier are unknowable: keep it undated, at
// base rates, and explicitly incomplete, never zero or a fabricated response.
async function scanDurable(path, deviceAt, provenance, worker) {
  const archive = await loadDurableArchive(path);
  const legacy = archive.entries.find(e => e.kind === 'imperfect.legacy');
  if (provenance) {
    if (!legacy) throw new Error('memory import: Durable archive has no original');
    for await (const _ of importedBytes(Readable.from([Buffer.from(legacy.data.source)]), provenance)) { /* validate immutable prefix */ }
  }
  const records = [], measured = new Map();
  let malformed = 0;
  for (const row of durableArchiveRows(archive)) {
    const durable = row.id?.startsWith(`durable:${archive.identity}:`);
    const record = usageRecord(row, { agent: 'pi', device: deviceAt(row.sourceRecordIndex), includeUnknown: durable });
    if (!record) continue;
    if (record.unattributed) malformed++;
    if (worker) record.harness = 'workers';
    records.push(record);
    if (durable) {
      // The pinned Durable ledger indexes message.model, not responseModel.
      const key = `${row.message.provider}/${row.message.model}`;
      const previous = measured.get(key) || empty();
      for (const c of CATEGORIES) previous[c] = previous[c] == null || record.tokens[c] == null ? null : previous[c] + record.tokens[c];
      previous.cacheWrite1h = (previous.cacheWrite1h || 0) + (record.cacheWrite1h || 0);
      measured.set(key, previous);
    }
  }
  for (const [key, usage] of Object.entries(archive.usage?.models || {})) {
    const before = measured.get(key) || empty(), tokens = {};
    for (const c of CATEGORIES) {
      const n = count(usage[c]);
      tokens[c] = n == null || before[c] == null ? null : n - before[c];
      if (tokens[c] < 0) { tokens[c] = null; malformed++; }
    }
    if (Object.values(tokens).some(n => n == null)) malformed++;
    if (!Object.values(tokens).some(n => n > 0)) continue;
    const slash = key.indexOf('/');
    if (slash < 1) { malformed++; continue; }
    const oneHour = count(usage.cacheWrite1h);
    const cacheWrite1h = oneHour == null ? null : oneHour - (before.cacheWrite1h || 0);
    if (cacheWrite1h < 0) malformed++;
    records.push({ key: JSON.stringify(['pi-durable-residual', archive.identity, key]), agent: 'pi', harness: worker ? 'workers' : 'pi', device: deviceAt(Infinity), day: 'unknown', at: null, provider: key.slice(0, slash), model: key.slice(slash + 1), tokens, cacheWrite1h: cacheWrite1h >= 0 ? cacheWrite1h : null, undated: true, aggregate: true });
    malformed++;
  }
  return { records: records.map(pack), malformed };
}

const pack = r => [r.key, r.agent, r.device, r.day, r.at, r.provider, r.model, r.tokens.input, r.tokens.output, r.tokens.cacheRead, r.tokens.cacheWrite, r.cacheWrite1h, Boolean(r.inferred), r.harness || r.agent, Boolean(r.aggregate), Boolean(r.undated)];
const unpack = ([key, agent, device, day, at, provider, model, input, output, cacheRead, cacheWrite, cacheWrite1h, inferred, harness, aggregate, undated]) => ({ key, agent, harness, device, day, at, provider, model, tokens: { input, output, cacheRead, cacheWrite }, cacheWrite1h, inferred, aggregate, undated });

// Delegated worker usage comes from the runner's sum, not its private session:
// current Pi and Claude workers per model that answered, old Pi as a whole.
async function workerRecords(agentDir, device) {
  const records = [];
  let unreliable = 0;
  const root = join(agentDir, 'subagents');
  for (const parent of await names(root).catch(() => [])) for (const id of await names(join(root, parent)).catch(() => [])) {
    // Durable responses are scanned above. Do not add a parallel aggregate
    // authority, including when result.json is absent or usageReliable is false.
    let durable = false;
    try { for await (const _ of tree(join(root, parent, id, 'session'), '.sqlite')) { durable = true; break; } }
    catch { unreliable++; continue; }
    if (durable) continue;
    let state, result;
    try { [state, result] = await Promise.all(['state.json', 'result.json'].map(async f => JSON.parse(await readFile(join(root, parent, id, f), 'utf8')))); } catch { continue; }
    if (state?.runtime?.startsWith('durable-') || result?.runtime?.startsWith('durable-') || state?.sessionPath?.endsWith('.sqlite')) {
      // A removed/private archive may still be mirrored elsewhere. Its runner
      // total has no response IDs, so adding it would count those calls twice.
      unreliable++; continue;
    }
    if (state?.engine === 'claude' || (state?.engine === 'pi' && result?.models)) {
      // Unknown (a crash, a runner that died, a broken count) is incomplete coverage, never zero.
      if (result?.usageReliable !== true) { unreliable++; continue; }
      const models = Object.entries(result.models ?? {}).filter(([, u]) => CATEGORIES.some(k => count(u?.[k]) > 0));
      for (const [name, u] of models) {
        const model = identifier(name);
        const agent = state.engine;
        if (model) records.push({ key: JSON.stringify([`${agent}-worker`, id, model]), agent, harness: 'workers', device, ...dayOf(state.endedAt), provider: agent === 'claude' ? vendor('claude', null, model) : identifier(u.provider) || 'unknown', model, tokens: Object.fromEntries(CATEGORIES.map(k => [k, count(u[k])])), cacheWrite1h: null, aggregate: true });
      }
      continue;
    }
    const u = result?.usage, model = identifier(state?.model?.id);
    const tokens = Object.fromEntries(CATEGORIES.map(k => [k, count(u?.[k])]));
    if (!model || !Object.values(tokens).some(n => n > 0)) continue;
    if (!result.usageReliable) { unreliable++; continue; }
    records.push({ key: JSON.stringify(['pi-worker', id]), agent: 'pi', harness: 'workers', device, ...dayOf(state.endedAt), provider: identifier(state.model.provider) || 'unknown', model, tokens, cacheWrite1h: null, aggregate: true });
  }
  return { records, unreliable };
}

// Files already read, by path, reused while unchanged (size, mtime, import
// manifest). Kept in a private file between reads, so the server holds none of
// it; without one, for this process only.
const memo = new Map();
const CACHE_VERSION = 6;

async function pool(items, limit, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) await work(items[next++]); }));
}

export async function readUsageHistory({ agentDir = getAgentDir(), sessionDir, home = homedir(), claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), memoryDir, thisComputerOnly = false, models = [], owner = hostname().split('.')[0], now = null, cacheFile = null } = {}) {
  let cache = memo;
  if (cacheFile) {
    cache = new Map();
    try {
      const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (saved?.version === CACHE_VERSION) for (const [path, entry] of Object.entries(saved.files ?? {})) cache.set(path, entry);
    } catch { /* no cache yet, or an unreadable one: read everything again */ }
  }
  const archivedProvenance = new Map(), nativeProvenance = new Map();
  let collectionProblems = 0;
  if (memoryDir) {
    try {
      const done = JSON.parse(await readFile(join(memoryDir, '.done.json'), 'utf8'));
      if (!done || typeof done !== 'object' || Array.isArray(done)) throw new Error('Invalid memory collection index');
      for (const [key, entry] of Object.entries(done)) if (entry.provenance) {
        archivedProvenance.set(join(memoryDir, entry.raw), entry.provenance);
        if (key.startsWith(`${owner}:`)) {
          nativeProvenance.set(key.slice(owner.length + 1), entry.provenance);
          nativeProvenance.set(entry.provenance.path, entry.provenance);
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') collectionProblems++; }
  }
  const { found, problems } = await sources({ sessionDir, agentDir, home, claudeDir, memoryDir: thisComputerOnly ? null : memoryDir, owner });
  const canonical = new Set(), files = [];
  for (const source of found) {
    const path = source.native ? await realpath(source.path).catch(() => source.path) : source.path;
    if (canonical.has(path)) continue;
    canonical.add(path); files.push({ ...source, path });
  }
  let unreadableFiles = problems + collectionProblems, malformedRecords = 0, filesRead = 0, changed = false;
  const used = new Map();
  await pool(files, 4, async ({ path, agent, device, native, worker }) => {
    try {
      const info = await stat(path);
      const durable = path.endsWith('.sqlite') || path.endsWith('.sqlite.gz');
      const original = path.endsWith('.jsonl.durable.sqlite') ? path.slice(0, -'.durable.sqlite'.length) : path;
      const provenance = native && memoryDir ? (await readMemoryImport(memoryDir, original) || nativeProvenance.get(path)) : archivedProvenance.get(path);
      const tag = JSON.stringify([provenance, worker, provenance || durable ? [info.ino, info.ctimeMs] : null, durable && !path.endsWith('.gz') ? await durableArchiveStamp(path) : null]);
      let entry = cache.get(path);
      if (!entry || entry.size !== info.size || entry.mtimeMs !== info.mtimeMs || entry.tag !== tag) {
        if (provenance && !durable) await validateMemoryImport(path, provenance);
        // A validated import's prefix ran on the computer it came from.
        const deviceAt = index => provenance && index <= provenance.recordCount ? provenance.machine : device;
        entry = { size: info.size, mtimeMs: info.mtimeMs, tag, ...await (durable ? scanDurable(path, deviceAt, provenance, worker) : scan(path, agent, deviceAt)) };
        cache.set(path, entry); changed = true;
      }
      used.set(path, entry); filesRead++; malformedRecords += entry.malformed;
    } catch { unreadableFiles++; }
  });
  if (cacheFile && (changed || cache.size !== used.size)) {
    const temporary = `${cacheFile}.${process.pid}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(used) }), { mode: 0o600 }); await rename(temporary, cacheFile); } catch { /* the next read scans again */ }
  }
  const workers = await workerRecords(agentDir, owner);
  const records = [...[...used.values()].flatMap(entry => entry.records.map(unpack)), ...workers.records];
  // Responses written while reading are not "future" ones.
  const aggregate = aggregateUsage(thisComputerOnly ? records.filter(r => r.device === owner) : records, { models, owner, now: now ?? Date.now() });
  malformedRecords += workers.unreliable;
  const computers = aggregate.devices.map(d => d.key).filter(k => k !== 'unknown');
  return { ...aggregate, filesRead, unreadableFiles, malformedRecords,
    historyCoverage: { complete: unreadableFiles === 0 && malformedRecords === 0 && aggregate.excludedDates === 0 && aggregate.unknownCategories === 0,
      scope: `Pi, Claude and Codex responses (child agents and delegated workers included) from ${owner}'s own histories${!thisComputerOnly && memoryDir && computers.some(c => c !== owner) ? ` and memory's copies of every computer's (${computers.join(', ')})` : ''}, each counted once.${aggregate.undatedResponses ? ' Durable ledger-only usage has unknown request counts/dates, is included undated at base rates, and makes coverage incomplete.' : ''} Other harnesses and sessions saved nowhere are not included.` } };
}
