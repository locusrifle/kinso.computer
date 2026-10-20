// Desktop UsagePage, UsageShareBar and UsageModelDialog adapted from T3 Code
// 43f8a8de17a7ac1baa7a3cf36d681856de2d8add. Copyright (c) 2026 T3 Tools Inc.
// MIT notice: apps/code/licenses/T3-Code-MIT.txt. Native metadata adapter below.
export const CATEGORIES = [['input', 'Uncached input'], ['cacheRead', 'Cached input'], ['cacheWrite', 'Cache write'], ['output', 'Output']];
export const tokens = row => CATEGORIES.reduce((sum, [k]) => sum + (row?.tokens?.[k] || 0), 0);
// usageFormat's three-significant-figure token counts and honest tiny shares.
export function compact(n) {
  const value = Number(n || 0), abs = Math.abs(value);
  for (const [size, suffix] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (abs < size) continue;
    const scaled = value / size, digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
    return `${scaled.toFixed(digits).replace(/\.0+$/, '')}${suffix}`;
  }
  return Math.round(value).toLocaleString();
}
export const percent = share => share > 0 && share < .001 ? '<0.1%' : `${(share * 100).toFixed(1)}%`;
export const money = n => `USD ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < .01 ? 4 : 2 })}`;
export const partial = r => Boolean(r?.unratedTokens || r?.unknownCategories);
export const price = r => tokens(r) > (r?.unratedTokens || 0) || (r?.responses === 0 && !partial(r)) ? `${money(r.estimatedUSD)}${partial(r) ? ' subtotal' : ''}` : 'Unpriced';
export const providerLabel = p => ({ openai: 'OpenAI / ChatGPT', 'openai-codex': 'ChatGPT', anthropic: 'Claude', unknown: 'Unknown provider' })[p] || p;
const color = i => `color-mix(in srgb, var(--label) ${Math.max(35, 100 - i * 22)}%, var(--surface))`;
const providerColor = p => color(p === 'anthropic' ? 1 : p.startsWith('openai') ? 0 : 2);
const blank = () => ({ tokens: {}, categoryUSD: {}, missing: {}, estimatedUSD: 0, responses: 0, unratedTokens: 0, unknownCategories: 0 });
function add(to, row) {
  for (const [k] of CATEGORIES) for (const field of ['tokens', 'categoryUSD', 'missing']) to[field][k] = (to[field][k] || 0) + (row[field]?.[k] || 0);
  for (const k of ['estimatedUSD', 'responses', 'unratedTokens', 'unknownCategories']) to[k] += row[k] || 0;
}
// Only already-deduplicated dated model buckets cross the wire: no messages,
// paths, session IDs or execution-owner guesses. All views use this same window.
export function pageData(history, period = 30, modelKey = null) {
  const until = history.estimate?.asOf?.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until || '') || !Array.isArray(history.dayModels)) return null;
  const since = new Date(Date.parse(`${until}T00:00:00Z`) - (period - 1) * 86400000).toISOString().slice(0, 10);
  const total = blank(), providers = new Map(), models = new Map(), days = new Map(), computers = new Map();
  for (const r of history.dayModels) {
    const key = JSON.stringify([r.provider, r.model]);
    if (r.day < since || r.day > until || (modelKey !== null && key !== modelKey)) continue;
    add(total, r);
    for (const [map, id, extra] of [[providers, r.provider, { provider: r.provider }], [models, key, { provider: r.provider, model: r.model }], [days, r.day, { day: r.day, providers: new Map() }], [computers, r.device || 'unknown', {}]]) {
      if (!map.has(id)) map.set(id, { ...blank(), key: id, ...extra });
      add(map.get(id), r);
    }
    const byProvider = days.get(r.day).providers;
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, blank());
    add(byProvider.get(r.provider), r);
  }
  const periods = Array.from({ length: period }, (_, i) => new Date(Date.parse(`${since}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
  return { ...total, providers: [...providers.values()], models: [...models.values()], computers: [...computers.values()], days, periods, since, until, complete: history.historyCoverage?.complete === true };
}
// Scale from UsageProviderChart.niceScale: round UP to avoid clipping peaks.
export function niceScale(peak, count = 4) {
  if (peak <= 0) return { max: 0, ticks: [0] };
  const raw = peak / count, magnitude = 10 ** Math.floor(Math.log10(raw)), normalized = raw / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}
// UsageProviderChart's shape-preserving cubic interpolation, split at unknown
// periods so partial native scans never invent a bridge across missing data.
export function smoothPath(points) {
  if (!points.length) return '';
  if (points.length === 1) return `M${points[0].x},${points[0].y}`;
  const slopes = points.slice(1).map((p, i) => (p.y - points[i].y) / (p.x - points[i].x));
  const tangents = points.map((_, i) => i === 0 ? slopes[0] : i === points.length - 1 ? slopes.at(-1) : slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
  slopes.forEach((s, i) => {
    if (s === 0) { tangents[i] = tangents[i + 1] = 0; return; }
    const a = tangents[i] / s, b = tangents[i + 1] / s, magnitude = a * a + b * b;
    if (magnitude > 9) { const scale = 3 / Math.sqrt(magnitude); tangents[i] = scale * a * s; tangents[i + 1] = scale * b * s; }
  });
  return points.slice(1).reduce((path, to, i) => {
    const from = points[i], dx = to.x - from.x;
    return `${path} C${from.x + dx / 3},${from.y + tangents[i] * dx / 3} ${to.x - dx / 3},${to.y - tangents[i + 1] * dx / 3} ${to.x},${to.y}`;
  }, `M${points[0].x},${points[0].y}`);
}
export function mountHistoryPage(history, preferences, { el }) {
  const root = el('div', 'usage-page');
  const value = (r, metric = preferences.metric) => metric === 'tokens' ? tokens(r) : r?.estimatedUSD || 0;
  let selected = null, dialog = null, opener = null;
  const dialogInert = new Map();
  function btn(text, action, cls = '') { const n = el('button', cls, text); n.type = 'button'; n.onclick = action; return n; }
  function heading(text) { return el('h2', 'usage-section-title', text); }
  function stat(label, text) { const n = el('div', 'usage-metric'); n.append(el('span', 'usage-line', label), el('strong', '', text)); return n; }
  function shareBar(data, metric) {
    const section = el('section', 'usage-share'); section.append(heading(metric === 'tokens' ? 'Tokens by type' : 'Hypothetical API-equivalent cost by type'));
    const segments = CATEGORIES.map(([key, label], i) => ({ label, value: (metric === 'tokens' ? data.tokens : data.categoryUSD)[key] || 0, color: `color-mix(in oklab, var(--label) ${[60, 30, 72, 100][i]}%, var(--surface))` })).filter(s => s.value > 0);
    const sum = segments.reduce((n, s) => n + s.value, 0), bar = el('div', 'usage-share-bar'), legend = el('div', 'usage-share-legend');
    bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', segments.map(s => `${s.label}: ${metric === 'tokens' ? compact(s.value) : money(s.value)}`).join(', ') || 'No known values');
    for (const s of segments) {
      const fill = el('span'); fill.style.flex = `${s.value} 1 0`; fill.style.background = s.color;
      fill.title = `${s.label} · ${metric === 'tokens' ? compact(s.value) : money(s.value)} · ${percent(s.value / sum)}`; bar.append(fill);
      const item = el('span', '', `${s.label} ${metric === 'tokens' ? compact(s.value) : money(s.value)}`), dot = el('i'); dot.style.background = s.color; item.prepend(dot); legend.append(item);
    }
    section.append(bar, legend); return section;
  }
  function chart(data, metric = preferences.metric) {
    const section = el('section', 'usage-provider-chart');
    section.append(heading(metric === 'tokens' ? 'Daily processed tokens (UTC)' : 'Daily hypothetical API-equivalent cost (UTC)'));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 960 260'); svg.setAttribute('preserveAspectRatio', 'none'); svg.classList.add('usage-chart');
    svg.setAttribute('role', 'slider'); svg.tabIndex = 0; svg.setAttribute('aria-label', 'Daily provider usage'); svg.setAttribute('aria-valuemin', '0'); svg.setAttribute('aria-valuemax', String(data.periods.length - 1));
    const sv = (tag, attrs) => { const n = document.createElementNS(svg.namespaceURI, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
    const rows = data.providers.toSorted((a, b) => value(b, metric) - value(a, metric));
    const rowFor = (day, p) => data.days.get(day)?.providers.get(p);
    const known = r => r ? (metric === 'tokens' || tokens(r) > r.unratedTokens ? value(r, metric) : null) : data.complete ? 0 : null;
    const peak = Math.max(0, ...data.periods.flatMap(day => rows.map(p => known(rowFor(day, p.provider)) || 0)));
    const scale = niceScale(peak), y = n => scale.max ? 260 - n / scale.max * 252 : 260;
    const plot = el('div', 'usage-chart-plot'), axis = el('div', 'usage-chart-axis');
    for (const tick of scale.ticks) { const label = el('span', '', tick === 0 ? '0' : metric === 'tokens' ? compact(tick) : money(tick)); label.style.top = `${y(tick) / 260 * 100}%`; axis.append(label); }
    for (const tick of scale.ticks) svg.append(sv('line', { x1: 0, x2: 960, y1: y(tick), y2: y(tick), class: 'usage-chart-grid' }));
    const strokes = [], dots = [];
    rows.forEach(p => {
      const ink = providerColor(p.provider), groups = []; let points = [];
      data.periods.forEach((day, index) => {
        const v = known(rowFor(day, p.provider));
        if (v === null) { if (points.length) groups.push(points); points = []; return; }
        const x = index * 960 / Math.max(1, data.periods.length - 1); points.push({ x, y: y(v) });
        if (rowFor(day, p.provider)) dots.push(sv('circle', { cx: x, cy: y(v), r: 3, fill: ink }));
      });
      if (points.length) groups.push(points);
      for (const points of groups) {
        const d = smoothPath(points);
        if (points.length > 1) svg.append(sv('path', { d: `${d} L${points.at(-1).x},260 L${points[0].x},260 Z`, fill: ink, 'fill-opacity': .12 }));
        strokes.push(sv('path', { d, fill: 'none', stroke: ink, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', ...(metric === 'cost' && partial(p) ? { 'stroke-dasharray': '4 4' } : {}) }));
      }
    });
    svg.append(...strokes, ...dots);
    const cursor = sv('line', { x1: 960, x2: 960, y1: 0, y2: 260, class: 'usage-chart-cursor' }); svg.append(cursor);
    const readout = el('p', 'usage-chart-readout'); let index = data.periods.length - 1;
    function inspect(next) {
      index = Math.max(0, Math.min(data.periods.length - 1, next)); const day = data.periods[index];
      const text = `${day} · ${rows.map(p => { const r = rowFor(day, p.provider), v = known(r); return `${providerLabel(p.provider)} ${v === null ? 'unavailable' : metric === 'tokens' ? `${compact(v)}${r?.unknownCategories ? ' + unknown' : ''}` : `${money(v)}${partial(r) ? ' subtotal' : ''}`}`; }).join(' · ') || 'No recorded activity'}`;
      readout.textContent = text; svg.setAttribute('aria-valuenow', String(index)); svg.setAttribute('aria-valuetext', text);
      cursor.setAttribute('x1', index * 960 / Math.max(1, data.periods.length - 1)); cursor.setAttribute('x2', cursor.getAttribute('x1'));
    }
    svg.onpointermove = svg.onpointerdown = e => { const b = svg.getBoundingClientRect(); inspect(Math.round((e.clientX - b.left) / b.width * (data.periods.length - 1))); };
    svg.onkeydown = e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); inspect(e.key === 'Home' ? 0 : e.key === 'End' ? data.periods.length - 1 : index + (e.key === 'ArrowRight' ? 1 : -1)); } };
    const dates = el('div', 'usage-chart-dates'); dates.append(el('span', '', data.since), el('span', '', data.until));
    plot.append(axis, svg); section.append(plot, dates, readout); inspect(index); return section;
  }
  function closeModel(returnFocus = true) {
    dialog?.remove(); dialog = null; selected = null;
    for (const [node, inert] of dialogInert) node.inert = inert;
    dialogInert.clear();
    if (returnFocus) opener?.focus({ preventScroll: true });
  }
  function openModel(model, trigger) {
    selected = model.key; opener = trigger;
    const data = pageData(history, preferences.period, selected);
    dialog = el('section', 'usage-model-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', model.model);
    const close = btn('Close model', closeModel, 'usage-model-close');
    dialog.append(close, el('h2', '', model.model), el('p', 'usage-line', providerLabel(model.provider)));
    const stats = el('div', 'usage-totals'); stats.append(stat('Hypothetical API-equivalent cost', price(data)), stat('Processed tokens', compact(tokens(data))));
    const input = (data.tokens.input || 0) + (data.tokens.cacheRead || 0) + (data.tokens.cacheWrite || 0);
    if (input && !data.missing.input && !data.missing.cacheRead && !data.missing.cacheWrite) stats.append(stat('Cache hit', `${((data.tokens.cacheRead || 0) / input * 100).toFixed(1)}%`));
    if (tokens(data) && !partial(data)) stats.append(stat('API equivalent per 1M tokens', money(data.estimatedUSD / tokens(data) * 1e6)));
    dialog.append(stats, chart(data, price(data) === 'Unpriced' ? 'tokens' : preferences.metric), shareBar(data, 'tokens'));
    if (data.estimatedUSD > 0) dialog.append(shareBar(data, 'cost'));
    dialog.append(el('p', 'usage-line', `${compact(data.unratedTokens)} unpriced tokens · ${data.unknownCategories} unavailable token categories. Current catalog rates, not historical prices or subscription charges.`));
    for (const node of [root.querySelector('.usage-page-main'), ...root.closest('.usage-box').querySelectorAll('.usage-header, .usage-toolbar')]) { dialogInert.set(node, node.inert); node.inert = true; }
    root.append(dialog); close.focus({ preventScroll: true });
    dialog.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModel(); }
      if (e.key === 'Tab') { const nodes = [...dialog.querySelectorAll('button, [tabindex="0"]')]; const first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    };
  }
  function render() {
    root.replaceChildren(); dialog = null; selected = null;
    const data = pageData(history, preferences.period), main = el('div', 'usage-page-main'); root.append(main);
    if (!data) { main.append(el('p', 'usage-line', 'Dated model usage unavailable on this computer · refresh after updating it.')); return; }
    // Where each response ran: the answering computer's histories, and on the
    // PC memory's copies of every other computer's.
    const ran = data.computers.toSorted((a, b) => value(b) - value(a)).map(c => `${c.key === 'unknown' ? 'unknown computer' : c.key} ${preferences.metric === 'tokens' ? compact(tokens(c)) : price(c)}`);
    main.append(el('p', 'usage-line usage-scope', `Read on ${history.owner || 'selected computer'} · ${data.since} – ${data.until} UTC${ran.length ? ` · ${ran.join(' · ')}` : ''}`));
    main.append(el('p', 'usage-line usage-quality', `${partial(data) ? `Partial estimate: ${compact(data.unratedTokens)} unpriced tokens; ${data.unknownCategories} unknown token categories. ` : ''}${!data.complete ? 'Incomplete scan: chart gaps are unavailable, not zero.' : 'Chart zeroes apply only to retained records.'}`));
    const overview = el('section', 'usage-overview'), summary = el('div', 'usage-provider-summary');
    summary.append(el('strong', 'usage-headline', !data.responses && !data.complete ? 'Unavailable' : preferences.metric === 'tokens' ? `${compact(tokens(data))}${data.unknownCategories ? ' + unknown' : ''}` : price(data).replace(' subtotal', '')), el('p', 'usage-line', `${data.responses.toLocaleString()} recorded responses${preferences.metric === 'cost' ? ` · hypothetical API equivalent${partial(data) ? ' subtotal' : ''} (not billed)` : ' · processed tokens'}`));
    for (const p of data.providers) {
      const row = el('div', 'usage-provider-row'), title = el('div'); const dot = el('i'); dot.style.background = providerColor(p.provider);
      title.append(dot, el('span', '', providerLabel(p.provider)), el('strong', '', preferences.metric === 'tokens' ? compact(tokens(p)) : price(p)));
      row.append(title, el('span', 'usage-line', `${preferences.metric === 'cost' && price(p) === 'Unpriced' ? 'Unknown share' : percent(value(data) ? value(p) / value(data) : 0)} of ${preferences.metric === 'tokens' ? 'known tokens' : 'priced API-equivalent subtotal'} · ${preferences.metric === 'cost' ? `${compact(tokens(p))} tokens` : `${price(p)} hypothetical API equivalent`}`)); summary.append(row);
    }
    overview.append(summary, chart(data)); main.append(overview);
    const totalsSection = el('section'); totalsSection.append(heading('Totals')); const totals = el('div', 'usage-totals');
    totals.append(stat('Processed tokens', compact(tokens(data))));
    for (const [k, label] of CATEGORIES) totals.append(stat(label, `${compact(data.tokens[k])}${data.missing[k] ? ' + unknown' : ''}`));
    totalsSection.append(totals); main.append(totalsSection);
    if (tokens(data)) main.append(shareBar(data, preferences.metric));
    const breakdown = el('section', 'usage-breakdown'), header = el('div', 'usage-breakdown-header'); header.append(heading('Breakdown'));
    const toggles = el('div', 'usage-toggle'); toggles.setAttribute('role', 'group'); toggles.setAttribute('aria-label', 'Usage breakdown');
    for (const [key, label] of [['model', 'Model'], ['day', 'Day']]) { const b = btn(label, () => { preferences.breakdown = key; render(); root.querySelector(`[data-breakdown="${key}"]`).focus({ preventScroll: true }); }); b.dataset.breakdown = key; b.setAttribute('aria-pressed', String(preferences.breakdown === key)); toggles.append(b); }
    header.append(toggles); breakdown.append(header);
    const table = el('table', 'usage-table'), thead = el('thead'), tr = el('tr'), tbody = el('tbody');
    const byModel = preferences.breakdown !== 'day';
    const labels = byModel ? ['Model', 'Hypothetical API equivalent', 'Share', 'Tokens'] : ['Day (UTC)', ...data.providers.map(p => providerLabel(p.provider)), 'Hypothetical API equivalent', 'Tokens'];
    for (const label of labels) { const th = el('th', label === 'Share' ? 'usage-share-column' : '', label); th.scope = 'col'; tr.append(th); } thead.append(tr); table.append(thead, tbody);
    if (byModel) {
      const models = data.models.toSorted((a, b) => value(b) - value(a)), peak = Math.max(0, ...models.map(m => value(m)));
      models.forEach((m, i) => {
        const row = el('tr'), name = el('td'), trigger = btn(m.model, () => openModel(m, trigger));
        name.append(trigger, el('span', 'usage-model-provider usage-line', providerLabel(m.provider)));
        const bar = el('div', 'usage-model-share'), fill = el('span'); fill.style.width = `${peak ? value(m) / peak * 100 : 0}%`; bar.append(fill); name.append(bar);
        row.append(name, el('td', '', price(m)), el('td', 'usage-share-column', value(data) && !(preferences.metric === 'cost' && price(m) === 'Unpriced') ? percent(value(m) / value(data)) : '—'), el('td', '', `${compact(tokens(m))}${m.unknownCategories ? ' + unknown' : ''}`)); tbody.append(row);
      });
    } else {
      for (const day of [...data.periods].reverse()) {
        const d = data.days.get(day), row = el('tr'); row.append(el('td', '', day));
        for (const p of data.providers) { const r = d?.providers.get(p.provider); row.append(el('td', '', r ? preferences.metric === 'tokens' ? compact(tokens(r)) : price(r) : data.complete ? preferences.metric === 'tokens' ? '0' : money(0) : 'Unavailable')); }
        row.append(el('td', '', d ? price(d) : data.complete ? money(0) : 'Unavailable'), el('td', '', d ? compact(tokens(d)) : data.complete ? '0' : 'Unavailable')); tbody.append(row);
      }
    }
    if (!data.responses) breakdown.append(el('p', 'usage-line', 'No recorded activity in this window.'));
    breakdown.append(table); main.append(breakdown);
    main.append(el('p', 'usage-line usage-limitations', '7 / 30 / 90 UTC calendar days include today. Past 24h is unavailable: this adapter exposes daily records, not hourly usage. Session counts and speed premiums are not recorded per window. Unknown providers remain unknown. A response counts for the computer whose history holds it, or the one a copy or import names.'));
    main.append(el('p', 'usage-line', history.historyCoverage?.scope || 'Retained native Pi/Claude histories include child agents, not your full lifetime. Missing histories and unrecorded usage are unavailable.'));
    main.append(el('p', 'usage-line', `${history.unreadableFiles || 0} unreadable files · ${history.malformedRecords || 0} malformed records · ${history.excludedDates || 0} invalid/future dates omitted.`));
    main.append(el('p', 'usage-line', history.estimate?.basis || 'Current catalog rates; hypothetical API equivalent, not subscription charges.'));
  }
  root.dismissModel = () => { if (!dialog) return false; closeModel(); return true; };
  root.dispose = () => { if (dialog) closeModel(false); };
  render(); return root;
}
