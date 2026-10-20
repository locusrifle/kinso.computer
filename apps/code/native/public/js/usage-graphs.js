import { graphData, exactValue } from './usage-graphs-data.js';
import { compact, money, tokens, niceScale } from './usage-page.js';

// Graphs consume the same priced, deduplicated aggregates as Cost. No reads or
// rate calculations happen here; switching views is entirely local.
export function mountGraphs(history, preferences, { el }) {
  const root = el('div', 'usage-graphs usage-page-main');
  const options = preferences.graphs ||= { range: 'month', bucket: 'day', metric: 'spend', stack: 'harness', device: 'all', hidden: [] };
  let detail = null, chart = null;
  const button = (text, action, cls = '') => { const b = el('button', cls, text); b.type = 'button'; b.onclick = action; return b; };
  const heading = text => el('h2', 'usage-section-title', text);
  const format = (n, metric = options.metric) => metric === 'tokens' ? compact(n) : money(n);
  const ink = i => `color-mix(in srgb, var(--label) ${[100, 68, 42, 82, 55, 30, 91, 20][i % 8]}%, var(--surface))`;
  function controls(label, field, values) {
    const group = el('div', 'usage-toggle'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', label);
    for (const [key, text] of values) {
      const b = button(text, () => { options[field] = key; if (field === 'stack' || field === 'metric') options.hidden = []; render(); root.querySelector(`[data-graph-control="${field}:${key}"]`)?.focus({ preventScroll: true }); });
      b.dataset.graphControl = `${field}:${key}`; b.setAttribute('aria-pressed', String(options[field] === key)); group.append(b);
    }
    group.onkeydown = e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); const buttons = [...group.children], i = buttons.indexOf(document.activeElement);
      buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].focus();
    };
    return group;
  }
  function dataTable(caption, labels, rows, cls = '') {
    const wrap = el('div', `usage-graph-table-wrap ${cls}`), table = el('table', 'usage-table');
    table.append(el('caption', 'usage-line', caption)); const head = el('thead'), tr = el('tr'), body = el('tbody');
    for (const text of labels) { const th = el('th', '', text); th.scope = 'col'; tr.append(th); } head.append(tr);
    for (const values of rows) { const row = el('tr'); values.forEach((text, i) => { const cell = el(i ? 'td' : 'th', '', text); if (!i) cell.scope = 'row'; row.append(cell); }); body.append(row); }
    table.append(head, body); wrap.append(table); return wrap;
  }
  function breakdown(title, rows) {
    const section = el('section', 'usage-graph-breakdown'); section.append(heading(title));
    const peak = rows[0]?.estimatedUSD || 0, bars = el('div', 'usage-graph-bars'); bars.setAttribute('role', 'img'); bars.setAttribute('aria-label', `${title}; exact values in the data table below`);
    rows.forEach(row => {
      const item = el('div', 'usage-graph-bar-row'), label = el('div'); label.append(el('span', '', row.label), el('span', '', money(row.estimatedUSD)));
      const track = el('div', 'usage-graph-bar-track'), fill = el('span'); fill.style.width = `${peak ? row.estimatedUSD / peak * 100 : 0}%`; track.append(fill); item.append(label, track); bars.append(item);
    });
    section.append(bars);
    const table = el('details', 'usage-graph-data'); table.append(el('summary', '', `${title} data table`), dataTable(`${title} · API-equivalent USD, not billed`, ['Series', 'Estimated USD', 'Tokens', 'Unrated tokens'], rows.map(r => [r.label, exactValue(r.estimatedUSD, 'spend'), exactValue(tokens(r), 'tokens'), exactValue(r.unratedTokens, 'tokens')])));
    section.append(table); return section;
  }
  function dismiss() { if (!detail) return false; detail.remove(); detail = null; chart?.focus({ preventScroll: true }); return true; }
  function inspectBucket(bucket) {
    detail?.remove();
    const filtered = { ...history, estimate: { ...history.estimate, asOf: `${bucket.end}T23:59:59Z` } };
    for (const field of ['dayAgents', 'dayModels']) if (Array.isArray(history[field])) filtered[field] = history[field].filter(r => r.day >= bucket.start && r.day <= bucket.end);
    const data = graphData(filtered, { ...options, range: 'all', hidden: [] });
    detail = el('section', 'usage-graph-detail'); detail.setAttribute('aria-label', 'Selected UTC period breakdown');
    const title = heading(`${bucket.start}${bucket.end !== bucket.start ? ` – ${bucket.end}` : ''} UTC`); title.tabIndex = -1;
    detail.append(button('Close breakdown', dismiss), title, el('p', 'usage-line', `${money(data.total.estimatedUSD)} API-equivalent · ${exactValue(tokens(data.total), 'tokens')} tokens · ${exactValue(data.total.unratedTokens, 'tokens')} unrated tokens`));
    detail.append(breakdown('Models in this period', data.models), breakdown('Harnesses in this period', data.harnesses));
    root.querySelector('.usage-time-section').after(detail); title.focus({ preventScroll: true }); detail.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  function timeChart(data) {
    const section = el('section', 'usage-time-section'); section.append(heading('Usage over time'));
    const legend = el('div', 'usage-graph-legend'); legend.setAttribute('role', 'group'); legend.setAttribute('aria-label', 'Visible graph series');
    data.series.forEach((s, i) => {
      const b = button(s.label, () => { options.hidden = options.hidden.includes(s.key) ? options.hidden.filter(k => k !== s.key) : [...options.hidden, s.key]; render(); [...root.querySelectorAll('.usage-graph-legend button')].find(n => n.dataset.series === s.key)?.focus({ preventScroll: true }); });
      b.dataset.series = s.key; b.setAttribute('aria-pressed', String(!options.hidden.includes(s.key))); const swatch = el('i'); swatch.style.background = ink(i); b.prepend(swatch); legend.append(b);
    });
    section.append(legend);
    if (!data.total.responses) { section.append(el('p', 'usage-line usage-graph-empty', 'No recorded activity in this range.')); return section; }
    const plot = el('div', 'usage-graph-plot'), axis = el('div', 'usage-chart-axis');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); chart = svg;
    svg.classList.add('usage-stacked-chart'); svg.setAttribute('viewBox', '0 0 960 240'); svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'slider'); svg.tabIndex = 0; svg.setAttribute('aria-label', `Usage over time, ${options.metric === 'tokens' ? 'tokens' : 'API-equivalent USD'}. Left and right choose a UTC period; Enter opens its breakdown.`);
    svg.setAttribute('aria-valuemin', '0'); svg.setAttribute('aria-valuemax', String(data.buckets.length - 1));
    const sv = (tag, attrs) => { const n = document.createElementNS(svg.namespaceURI, tag); for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, value); return n; };
    const peak = data.buckets.reduce((max, b) => Math.max(max, b.visibleTotal), 0), scale = niceScale(peak), y = n => scale.max ? 240 - n / scale.max * 230 : 240;
    for (const tick of scale.ticks) {
      svg.append(sv('line', { x1: 0, x2: 960, y1: y(tick), y2: y(tick), class: 'usage-chart-grid' }));
      const label = el('span', '', format(tick)); label.style.top = `${y(tick) / 240 * 100}%`; axis.append(label);
    }
    const step = 960 / data.buckets.length;
    data.buckets.forEach((b, index) => {
      let base = 0;
      data.series.forEach((s, i) => {
        const value = b.values[s.key] || 0; if (!value || options.hidden.includes(s.key)) return;
        svg.append(sv('rect', { x: index * step + step * .12, y: y(base + value), width: step * .76, height: y(base) - y(base + value), fill: ink(i), 'data-series': s.key })); base += value;
      });
    });
    const cursor = sv('rect', { y: 0, width: step, height: 240, class: 'usage-graph-cursor', fill: 'none', stroke: 'var(--label)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }); svg.append(cursor);
    const readout = el('p', 'usage-graph-tooltip'); readout.setAttribute('role', 'status'); readout.setAttribute('aria-live', 'polite');
    let index = data.buckets.length - 1;
    function inspect(next) {
      index = Math.max(0, Math.min(data.buckets.length - 1, next)); const b = data.buckets[index]; cursor.setAttribute('x', index * step);
      const text = `${b.start}${b.start === b.end ? '' : ` – ${b.end}`} UTC · ${data.series.filter(s => !options.hidden.includes(s.key)).map(s => `${s.label}: ${exactValue(b.values[s.key] || 0, options.metric)}`).join(' · ') || 'All series hidden'} · Visible total: ${exactValue(b.visibleTotal, options.metric)}`;
      readout.textContent = text; svg.setAttribute('aria-valuenow', String(index)); svg.setAttribute('aria-valuetext', text);
    }
    const point = e => { const rect = svg.getBoundingClientRect(); return Math.floor((e.clientX - rect.left) / rect.width * data.buckets.length); };
    svg.onpointermove = e => inspect(point(e)); svg.onfocus = () => inspect(index);
    svg.onclick = e => { inspect(point(e)); inspectBucket(data.buckets[index]); };
    svg.onkeydown = e => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(e.key)) {
        e.preventDefault(); if (e.key === 'Enter' || e.key === ' ') inspectBucket(data.buckets[index]);
        else inspect(e.key === 'Home' ? 0 : e.key === 'End' ? data.buckets.length - 1 : index + (e.key === 'ArrowRight' ? 1 : -1));
      }
    };
    plot.append(axis, svg); const dates = el('div', 'usage-chart-dates'); dates.append(el('span', '', data.since), el('span', '', `${data.until} · UTC`));
    section.append(plot, dates, readout, el('p', 'usage-line usage-graph-help', `${options.bucket === 'week' ? 'Weeks start Monday; edge weeks are clipped. ' : ''}Hover or focus for exact values. Click a column or press Enter for its breakdown.${data.buckets.length > 120 && options.bucket === 'day' ? ' Many days: switch to Week for wider columns.' : ''}`));
    const table = el('details', 'usage-graph-data'); table.append(el('summary', '', 'Usage over time data table'));
    table.ontoggle = () => {
      if (!table.open || table.querySelector('table')) return;
      const visible = data.series.filter(s => !options.hidden.includes(s.key));
      table.append(dataTable(`Usage over time · ${options.metric === 'tokens' ? 'processed tokens' : 'estimated API-equivalent USD'} · visible series`, ['UTC period', ...visible.map(s => s.label), 'Visible total'], data.buckets.map(b => [`${b.start}${b.start === b.end ? '' : ` – ${b.end}`}`, ...visible.map(s => exactValue(b.values[s.key] || 0, options.metric)), exactValue(b.visibleTotal, options.metric)]), 'usage-time-table'));
    };
    section.append(table); inspect(index); return section;
  }
  function render() {
    detail = chart = null; root.replaceChildren();
    const toolbar = el('div', 'usage-graph-controls');
    toolbar.append(controls('Graph range', 'range', [['week', 'Week'], ['month', 'Month'], ['all', 'All']]), controls('Graph bucket', 'bucket', [['day', 'Day'], ['week', 'Week']]), controls('Graph metric', 'metric', [['tokens', 'Tokens'], ['spend', 'API-equivalent USD']]), controls('Graph stack', 'stack', [['harness', 'Harness'], ['model', 'Model']]));
    root.append(toolbar);
    if (!history || (!Array.isArray(history.dayAgents) && !Array.isArray(history.dayModels))) { root.append(el('p', 'usage-line', 'Dated usage unavailable · refresh after updating the usage computer.')); return; }
    const data = graphData(history, options);
    const computers = el('label', 'usage-graph-computers', 'Computers '), select = el('select'); select.setAttribute('aria-label', 'Filter graph by computer');
    const choices = [{ key: 'all', label: 'All computers' }, ...data.computers];
    if (options.device !== 'all' && !data.computers.some(c => c.key === options.device)) choices.push({ key: options.device, label: `${options.device} · no recorded activity in this range` });
    for (const c of choices) { const option = el('option', '', c.label); option.value = c.key; select.append(option); }
    select.value = options.device; select.onchange = () => { options.device = select.value; render(); root.querySelector('select')?.focus({ preventScroll: true }); }; computers.append(select); root.append(computers);
    root.append(el('p', 'usage-line usage-graph-scope', `Read on ${history.owner || 'usage computer'} · ${data.since ? `${data.since} – ${data.until} UTC` : 'No retained UTC dates'} · ${data.dayCount} calendar days`));
    const summary = el('section', 'usage-graph-estimate'); summary.append(heading('Estimated API spend'), el('strong', 'usage-headline', money(data.total.estimatedUSD)));
    summary.append(el('p', 'usage-line', 'API-equivalent at published API rates, not billed. Most use is through Claude / ChatGPT subscriptions. Current catalog rates, not historical prices.'));
    const stats = el('div', 'usage-totals');
    for (const [label, value] of [['Per-day average', money(data.total.estimatedUSD / Math.max(1, data.dayCount))], ['Projected 30-day month', money(data.total.estimatedUSD / Math.max(1, data.dayCount) * 30)], ['Processed tokens', compact(tokens(data.total))], ['Unrated tokens', exactValue(data.total.unratedTokens, 'tokens')]]) { const stat = el('div', 'usage-metric'); stat.append(el('span', 'usage-line', label), el('strong', '', value)); stats.append(stat); }
    summary.append(stats, el('p', 'usage-line', 'Projection is this range’s daily average × 30, not a bill or forecast of future activity. Legend toggles affect only the time chart, not these totals.'));
    const cached = data.total.tokens.cacheRead || 0, cachedUSD = data.total.categoryUSD.cacheRead || 0;
    summary.append(el('p', 'usage-line usage-cache-effect', `Cache reads: ${exactValue(cached, 'tokens')} tokens (${tokens(data.total) ? (cached / tokens(data.total) * 100).toFixed(1) : '0.0'}% of processed tokens) · ${exactValue(cachedUSD, 'spend')} API-equivalent (${data.total.estimatedUSD ? (cachedUSD / data.total.estimatedUSD * 100).toFixed(1) : '0.0'}% of priced spend).${data.total.missing.cacheRead ? ' Cache-read coverage is partial.' : ''} This is cache-read cost, not an inferred saving.`));
    root.append(summary, el('p', 'usage-line usage-graph-quality', `${!data.complete ? 'Incomplete retained history: absent days have no recorded usage, not proven zero activity. ' : 'Only retained records are counted. '}${data.total.unratedTokens ? 'Spend is a priced subtotal; unrated tokens are excluded. ' : ''}${data.total.unknownCategories ? `${data.total.unknownCategories} token categories unavailable. ` : ''}${data.legacy ? 'Older aggregate: harness attribution unavailable. ' : ''}Workers are separate only where recorded explicitly.`), timeChart(data));
    const breakdowns = el('div', 'usage-graph-breakdowns'); breakdowns.append(breakdown('API-equivalent by model', data.models), breakdown('API-equivalent by harness', data.harnesses)); root.append(breakdowns);
  }
  root.dismissModel = dismiss; root.dispose = () => { detail = chart = null; };
  render(); return root;
}
