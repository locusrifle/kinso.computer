// Pure projections of the authority's already-priced, deduplicated UTC rows.
// Never reprice aggregated requests: tiers and 1h cache writes are lost there.
import { CATEGORIES, tokens } from './usage-page.js';

const DAY = 86400000;
const HARNESSES = { pi: 'Pi', claude: 'Claude Code', codex: 'Codex', workers: 'Workers / subagents', unknown: 'Unknown harness' };
const fields = ['estimatedUSD', 'responses', 'unratedTokens', 'unknownCategories'];
const blank = () => ({ tokens: Object.fromEntries(CATEGORIES.map(([k]) => [k, 0])), categoryUSD: Object.fromEntries(CATEGORIES.map(([k]) => [k, 0])), missing: Object.fromEntries(CATEGORIES.map(([k]) => [k, 0])), estimatedUSD: 0, responses: 0, unratedTokens: 0, unknownCategories: 0 });
function add(to, row) {
  for (const [k] of CATEGORIES) for (const field of ['tokens', 'categoryUSD', 'missing']) to[field][k] += row[field]?.[k] || 0;
  for (const field of fields) to[field] += row[field] || 0;
  return to;
}
const day = time => new Date(time).toISOString().slice(0, 10);
function timeOf(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && day(time) === value ? time : null;
}
const monday = time => time - ((new Date(time).getUTCDay() + 6) % 7) * DAY;
const harnessOf = row => Object.hasOwn(HARNESSES, row.harness) ? row.harness : 'unknown';
const modelOf = row => `${row.provider || 'unknown'}/${row.model || 'unknown'}`;
export const graphValue = (row, metric = 'tokens') => metric === 'tokens' ? tokens(row) : row?.estimatedUSD || 0;
const order = metric => (a, b) => graphValue(b, metric) - graphValue(a, metric) || a.key.localeCompare(b.key, 'en');
function collect(map, key, label, row, extra = {}) {
  if (!map.has(key)) map.set(key, { key, label, ...extra, ...blank() });
  add(map.get(key), row);
}

// Locale-independent precision, including tiny API-equivalent subtotals.
export function exactValue(number, metric = 'tokens') {
  const value = Number.isFinite(number) ? number : 0;
  return `${metric === 'tokens' ? '' : 'USD '}${value.toLocaleString('en-US', { maximumFractionDigits: metric === 'tokens' ? 0 : 8 })}`;
}

export function graphData(history = {}, options = {}) {
  const range = ['week', 'month', 'all'].includes(options.range) ? options.range : 'month';
  const weekly = options.bucket === 'week', metric = options.metric === 'spend' ? 'spend' : 'tokens';
  const stack = options.stack === 'model' ? 'model' : 'harness';
  const device = options.device ?? 'all', hidden = new Set(Array.isArray(options.hidden) ? options.hidden : []);
  const legacy = !Array.isArray(history.dayAgents);
  const source = legacy ? history.dayModels : history.dayAgents;
  const asOf = timeOf(history.estimate?.asOf?.slice(0, 10));
  const dated = [];
  let first = null, last = null;
  for (const row of Array.isArray(source) ? source : []) {
    const time = timeOf(row.day);
    if (time === null || (asOf !== null && time > asOf)) continue;
    dated.push(row);
    if (first === null || time < first) first = time;
    if (last === null || time > last) last = time;
  }
  const end = range === 'all' ? last : asOf ?? last;
  const start = range === 'all' ? first : end === null ? null : end - (range === 'week' ? 6 : 29) * DAY;
  const since = start === null ? null : day(start), until = end === null ? null : day(end);
  const total = blank(), modelMap = new Map(), harnessMap = new Map(), computerMap = new Map();
  const retained = [];
  for (const row of dated) {
    if (since === null || row.day < since || row.day > until) continue;
    const computer = row.device || 'unknown';
    collect(computerMap, computer, computer === 'unknown' ? 'Unknown computer' : computer, row);
    if (device !== 'all' && computer !== device) continue;
    retained.push(row);
    add(total, row);
    const model = row.model || 'unknown', provider = row.provider || 'unknown';
    collect(modelMap, modelOf(row), model, row, { provider, model });
    const harness = legacy ? 'unknown' : harnessOf(row);
    collect(harnessMap, harness, HARNESSES[harness], row);
  }
  // Only repeated model names need a provider qualifier.
  const providers = new Map();
  for (const model of modelMap.values()) {
    if (!providers.has(model.model)) providers.set(model.model, new Set());
    providers.get(model.model).add(model.provider);
  }
  for (const model of modelMap.values()) if (providers.get(model.model).size > 1) model.label = `${model.model} (${model.provider})`;
  const models = [...modelMap.values()].sort(order('spend'));
  const harnesses = [...harnessMap.values()].sort(order('spend'));
  const computers = [...computerMap.values()].sort(order('spend'));
  let series = (stack === 'model' ? [...models] : [...harnesses]).sort(order(metric));
  const seriesForModel = new Map();
  if (stack === 'model') {
    const major = [], other = { key: 'other', label: 'Other models', ...blank() };
    const sum = graphValue(total, metric);
    for (const row of series) {
      if (major.length < 7 && !(sum > 0 && graphValue(row, metric) < sum * .01)) {
        major.push(row); seriesForModel.set(row.key, row.key);
      } else {
        add(other, row); seriesForModel.set(row.key, 'other');
      }
    }
    series = (seriesForModel.size > major.length ? [...major, other] : major).sort(order(metric));
  }
  const buckets = [], byKey = new Map();
  if (start !== null && end !== null) {
    for (let time = weekly ? monday(start) : start; time <= end; time += (weekly ? 7 : 1) * DAY) {
      const key = day(time);
      const row = { key, start: day(Math.max(start, time)), end: day(Math.min(end, time + (weekly ? 6 : 0) * DAY)), total: blank(), values: Object.fromEntries(series.filter(s => !hidden.has(s.key)).map(s => [s.key, 0])), visibleTotal: 0 };
      buckets.push(row); byKey.set(key, row);
    }
  }
  for (const row of retained) {
    const bucket = byKey.get(weekly ? day(monday(timeOf(row.day))) : row.day);
    add(bucket.total, row);
    const key = stack === 'model' ? seriesForModel.get(modelOf(row)) : legacy ? 'unknown' : harnessOf(row);
    if (!hidden.has(key)) {
      const value = graphValue(row, metric);
      bucket.values[key] += value;
      bucket.visibleTotal += value;
    }
  }
  return { since, until, dayCount: start === null || end === null ? 0 : (end - start) / DAY + 1, total, series, buckets, models, harnesses, computers, complete: history.historyCoverage?.complete === true, legacy };
}
