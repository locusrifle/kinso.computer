// Synthetic, aggregate-only browser data. No live history or account metadata.
import { aggregateUsage } from '../../usage-history.mjs';

export const machines = [
  { id: 'laptop', name: 'Laptop', self: true, reachable: true },
  { id: 'pc', name: 'PC', home: true, reachable: true },
];
export const NOW = Date.parse('2026-10-11T23:59:59Z');
export const FIRST = '2026-09-07';
export const LAST = '2026-10-11';
export const models = [
  { provider: 'anthropic', id: 'claude-sonnet-4-5', cost: { input: 3, output: 15, cacheRead: .3, cacheWrite: 3.75 } },
  { provider: 'anthropic', id: 'claude-opus-4-1', cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { provider: 'openai', id: 'gpt-5-codex', cost: { input: 1.25, output: 10, cacheRead: .125, cacheWrite: 1.25 } },
];
const schedules = [
  ['pi', 'pc', 'anthropic', 'claude-sonnet-4-5', 1],
  ['claude', 'pc', 'anthropic', 'claude-opus-4-1', 2],
  ['codex', 'pc', 'openai', 'gpt-5-codex', 3],
  ['workers', 'pc', 'anthropic', 'claude-sonnet-4-5', 4],
  ['pi', 'laptop', 'openai', 'gpt-5-codex', 2],
  ['claude', 'laptop', 'anthropic', 'claude-sonnet-4-5', 3],
  ['codex', 'laptop', 'openai', 'gpt-5-codex', 4],
  ['workers', 'laptop', 'anthropic', 'claude-opus-4-1', 1],
];
export const records = Array.from({ length: 35 }, (_, i) => {
  const day = new Date(Date.parse(`${FIRST}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
  return schedules.map(([harness, device, provider, model, weight], j) => ({
    key: JSON.stringify(['synthetic', day, device, harness]),
    agent: harness === 'workers' ? 'pi' : harness, harness, device, day,
    at: Date.parse(`${day}T${String(j + 10).padStart(2, '0')}:30:00Z`), provider, model,
    tokens: { input: (i % 7 + 1) * weight * 18000, output: (i % 5 + 1) * weight * 3500, cacheRead: (i % 4 + 2) * weight * 42000, cacheWrite: weight * 6000 },
    cacheWrite1h: null, ...(harness === 'workers' ? { aggregate: true } : {}),
  }));
}).flat();
export function historyFor(rows = records, owner = 'pc') {
  return { ...aggregateUsage(rows, { models, owner, now: NOW }), historyCoverage: { complete: true } };
}
export const pcHistory = historyFor();
export const laptopHistory = historyFor(records.filter(r => r.device === 'laptop'), 'laptop');
export const emptyHistory = historyFor([]);
export const oneDayHistory = historyFor(records.filter(r => r.day === LAST));
export const limits = [{ agent: 'pi', signedIn: false }, { agent: 'claude', signedIn: false }];

// Independent test oracle: do not use graphData to verify its own chart output.
export function expected({ since = '2026-09-12', until = LAST, device = 'all', stack = 'harness', metric = 'spend', hidden = [] } = {}) {
  const rows = records.filter(r => r.day >= since && r.day <= until && (device === 'all' || r.device === device));
  const series = new Map(); let spend = 0, processed = 0;
  for (const row of rows) {
    const rates = models.find(m => m.provider === row.provider && m.id === row.model).cost;
    const usd = Object.entries(row.tokens).reduce((n, [k, value]) => n + value * rates[k] / 1e6, 0);
    const count = Object.values(row.tokens).reduce((a, b) => a + b, 0);
    spend += usd; processed += count;
    const key = stack === 'model' ? `${row.provider}/${row.model}` : row.harness;
    series.set(key, (series.get(key) || 0) + (metric === 'tokens' ? count : usd));
  }
  return { spend, processed, series, visible: [...series].reduce((n, [key, value]) => n + (hidden.includes(key) ? 0 : value), 0) };
}
export const exact = (n, metric = 'spend') => `${metric === 'tokens' ? '' : 'USD '}${n.toLocaleString('en-US', { maximumFractionDigits: metric === 'tokens' ? 0 : 8 })}`;
export const usd = n => `USD ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const harnessLabel = key => ({ pi: 'Pi', claude: 'Claude Code', codex: 'Codex', workers: 'Workers / subagents' })[key];
export function tooltip(day, options = {}) {
  const totals = expected({ ...options, since: day, until: day });
  const range = expected(options);
  const order = [...range.series].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'));
  const visible = order.filter(([key]) => !options.hidden?.includes(key));
  return `${day} UTC · ${visible.map(([key]) => `${options.stack === 'model' ? key.split('/')[1] : harnessLabel(key)}: ${exact(totals.series.get(key) || 0, options.metric)}`).join(' · ') || 'All series hidden'} · Visible total: ${exact(totals.visible, options.metric)}`;
}
