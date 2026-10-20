import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { openUsage, usageArtifacts } from './fixtures/usage-controls.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import {
  machines, pcHistory, laptopHistory, emptyHistory, oneDayHistory, limits,
  FIRST, LAST, expected, exact, usd, tooltip, historyFor, records,
} from './fixtures/usage-graphs.mjs';

// Top-level node:test tests intentionally use default sequential execution.
// Never parallelize this file: each fixture owns one real Chromium until t.after.
const SHOTS = usageArtifacts('usage-graphs');
const themes = await Promise.all(['black', 'light-chalk'].map(async name =>
  themeCss(JSON.parse(await readFile(new URL(`./fixtures/themes/${name}.json`, import.meta.url), 'utf8')))));
const initial = { site: true, machines, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Synthetic laptop conversation; PC is the usage authority.' }] }] };
const graphControl = (graphs, label, name) => graphs.getByRole('group', { name: label, exact: true }).getByRole('button', { name, exact: true });
const metricControl = (pane, name) => pane.getByRole('group', { name: 'Usage metric', exact: true }).getByRole('button', { name, exact: true });
async function prefer(page, metric = 'graphs') {
  await page.evaluate(metric => localStorage.setItem('imperfect:usage-page:v1', JSON.stringify({ metric, period: 30 })), metric);
}
async function fixture(t, width, theme = 0) {
  const f = await harnessFixture({ ...initial, themeCSS: themes[theme], hasTouch: width < 500, viewport: { width, height: 900 } });
  t.after(() => f.close());
  f.calls = [];
  f.answer = (c, owner) => {
    f.calls.push({ ...c, owner: owner || 'laptop' });
    if (c.type === 'usage-history') return owner === 'pc' ? pcHistory : laptopHistory;
    if (c.type === 'usage') return limits;
  };
  return f;
}
const historyCalls = f => f.calls.filter(c => c.type === 'usage-history');
async function noOverflow(page) {
  const dimensions = await page.evaluate(() => {
    const nodes = [document.documentElement, document.body, document.querySelector('.usage-box'), document.querySelector('.usage-content'), document.querySelector('.usage-graphs')].filter(Boolean);
    return nodes.map(n => ({ name: n.className || n.tagName, scroll: n.scrollWidth, client: n.clientWidth }));
  });
  for (const n of dimensions) assert.ok(n.scroll <= n.client + 1, `horizontal page overflow: ${JSON.stringify(n)}`);
}
async function assertTables(graphs) {
  const time = graphs.locator('.usage-time-section');
  await time.getByText('Usage over time data table', { exact: true }).click();
  const table = time.getByRole('table');
  // details/toggle populates lazily on a later task, not during click dispatch.
  await table.locator('tbody tr').first().waitFor();
  assert.equal(await table.getByRole('row').count(), 31);
  assert.equal(await table.locator('tbody tr').first().locator('th').innerText(), '2026-09-12');
  assert.equal(await table.locator('tbody tr').last().locator('td').last().innerText(), exact(expected({ since: LAST }).visible));
  assert.equal(await table.locator('th[scope="col"]').count(), 6);
  await time.getByText('Usage over time data table', { exact: true }).click();
  for (const name of ['API-equivalent by model', 'API-equivalent by harness']) {
    const section = graphs.locator('.usage-graph-breakdown').filter({ has: graphs.page().getByRole('heading', { name, exact: true }) });
    assert.equal(await section.getByRole('img').count(), 1);
    await section.getByText(`${name} data table`, { exact: true }).click();
    assert.equal(await section.getByRole('table').count(), 1);
    assert.equal(await section.locator('tbody tr').count(), name.endsWith('model') ? 3 : 4);
    assert.match(await section.getByRole('table').innerText(), /Estimated USD.*Tokens.*Unrated tokens/s);
    await section.getByText(`${name} data table`, { exact: true }).click();
  }
}
async function screenshotStates(page, graphs, prefix) {
  await mkdir(SHOTS, { recursive: true });
  await graphs.locator('.usage-graph-estimate').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/${prefix}-summary.png` });
  for (const [metric, name] of [['spend', 'API-equivalent USD'], ['tokens', 'Tokens']]) {
    await graphControl(graphs, 'Graph metric', name).click();
    for (const [stack, label] of [['harness', 'Harness'], ['model', 'Model']]) {
      await graphControl(graphs, 'Graph stack', label).click();
      await graphs.locator('.usage-stacked-chart').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/${prefix}-${metric}-${stack}.png` });
    }
  }
  await graphControl(graphs, 'Graph metric', 'API-equivalent USD').click();
  await graphControl(graphs, 'Graph stack', 'Harness').click();
}

for (const width of [1200, 390, 320]) for (const theme of [0, 1]) test(`Graphs on laptop reads PC: controls, exact values, detail, tables and layout (${width}px ${theme ? 'Chalk' : 'Black'})`, async t => {
  const f = await fixture(t, width, theme), { page } = f;
  const input = page.locator('#entry-input'), pane = page.locator('.usage-box'), graphs = pane.locator('.usage-graphs');
  await prefer(page); await input.fill('unfinished graph draft');
  await openUsage(page); await graphs.locator('.usage-headline').waitFor();
  assert.equal(historyCalls(f).length, 1);
  assert.equal(historyCalls(f)[0].owner, 'pc', 'Graphs explicitly requests the PC authority, not laptop self');
  assert.equal(await pane.locator('.usage-owner-scope').innerText(), 'PC · all computers');
  assert.match(await graphs.locator('.usage-graph-scope').innerText(), /Read on pc · 2026-09-12 – 2026-10-11 UTC · 30 calendar days/);
  const headline = await graphs.locator('.usage-headline').innerText();
  assert.equal(headline, usd(expected().spend), 'PC headline includes both computers');
  assert.notEqual(headline, usd(expected({ device: 'laptop' }).spend));
  assert.match(await graphs.innerText(), /not billed.*subscriptions.*not historical prices/s);
  assert.match(await graphs.innerText(), /Projection.*not a bill.*Cache reads:.*not an inferred saving/s);
  assert.equal(await pane.getByRole('group', { name: 'Usage period', exact: true }).isVisible(), false);
  assert.equal(f.calls.some(c => c.type === 'usage'), false, 'Graphs does not read subscription limits');
  assert.equal(f.commands.some(c => ['tab-focus', 'session-attach', 'tab-new'].includes(c.type)), false);
  assert.equal(await pane.evaluate(n => getComputedStyle(n).backgroundColor), theme ? 'rgb(240, 240, 240)' : 'rgb(0, 0, 0)');
  assert.equal(await graphs.locator('.usage-graph-legend button').count(), 4);
  assert.ok(await graphs.locator('rect[data-series="workers"]').count() > 0, 'explicit aggregate workers are their own stack');
  await assertTables(graphs); await noOverflow(page);

  const chart = graphs.getByRole('slider');
  await chart.focus(); await page.keyboard.press('End');
  assert.equal(await chart.getAttribute('aria-valuetext'), tooltip(LAST));
  assert.equal(await graphs.getByRole('status').innerText(), tooltip(LAST));
  await page.keyboard.press('Home');
  assert.equal(await chart.getAttribute('aria-valuetext'), tooltip('2026-09-12'));
  await page.keyboard.press('ArrowRight');
  assert.equal(await chart.getAttribute('aria-valuetext'), tooltip('2026-09-13'));
  await chart.scrollIntoViewIfNeeded();
  const bounds = await chart.boundingBox();
  await page.mouse.move(bounds.x + bounds.width * 4.5 / 30, bounds.y + bounds.height / 2);
  assert.equal(await graphs.getByRole('status').innerText(), tooltip('2026-09-16'), 'pointer reports exact series and visible total');
  await page.mouse.click(bounds.x + bounds.width * 4.5 / 30, bounds.y + bounds.height / 2);
  const detail = graphs.getByRole('region', { name: 'Selected UTC period breakdown' });
  await detail.waitFor(); assert.match(await detail.innerText(), /2026-09-16 UTC.*Models in this period.*Harnesses in this period/s);
  assert.match(await detail.innerText(), new RegExp(usd(expected({ since: '2026-09-16', until: '2026-09-16' }).spend).replace('.', '\\.')));
  await page.keyboard.press('Escape'); assert.equal(await detail.count(), 0); assert.equal(await pane.count(), 1);
  assert.equal(await chart.evaluate(n => n === document.activeElement), true);
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await detail.waitFor();
  assert.match(await detail.innerText(), /2026-10-11 UTC/);
  assert.equal(await detail.locator('details').count(), 2, 'each detail chart has a data-table alternative');
  await page.keyboard.press('Escape'); assert.equal(await detail.count(), 0);

  const legend = graphs.getByRole('group', { name: 'Visible graph series', exact: true });
  await legend.getByRole('button', { name: 'Pi', exact: true }).click();
  assert.equal(await legend.getByRole('button', { name: 'Pi', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(await graphs.locator('rect[data-series="pi"]').count(), 0);
  assert.equal(await graphs.locator('.usage-headline').innerText(), headline, 'legend never changes the headline');
  assert.equal(await graphs.getByRole('status').innerText(), tooltip(LAST, { hidden: ['pi'] }));
  assert.ok(expected({ since: LAST, hidden: ['pi'] }).visible < expected({ since: LAST }).visible);
  await legend.getByRole('button', { name: 'Pi', exact: true }).click();

  await graphControl(graphs, 'Graph range', 'Week').click();
  assert.match(await graphs.locator('.usage-graph-scope').innerText(), /2026-10-05 – 2026-10-11 UTC · 7 calendar days/);
  assert.equal(await graphs.locator('.usage-headline').innerText(), usd(expected({ since: '2026-10-05' }).spend));
  await graphControl(graphs, 'Graph bucket', 'Week').click();
  assert.equal(await chart.getAttribute('aria-valuemax'), '0');
  assert.match(await graphs.getByRole('status').innerText(), /^2026-10-05 – 2026-10-11 UTC/);
  assert.match(await graphs.innerText(), /Weeks start Monday; edge weeks are clipped/);
  await chart.focus(); await page.keyboard.press('Enter'); await detail.waitFor();
  assert.match(await detail.innerText(), /2026-10-05 – 2026-10-11 UTC/); await page.keyboard.press('Escape');
  await graphControl(graphs, 'Graph range', 'Month').click();
  assert.equal(await chart.getAttribute('aria-valuemax'), '4', 'month has five Monday-aligned, clipped buckets');
  await chart.focus(); await page.keyboard.press('Home');
  assert.match(await chart.getAttribute('aria-valuetext'), /^2026-09-12 – 2026-09-13 UTC/);
  await graphControl(graphs, 'Graph range', 'All').click();
  assert.match(await graphs.locator('.usage-graph-scope').innerText(), /2026-09-07 – 2026-10-11 UTC · 35 calendar days/);
  assert.equal(await graphs.locator('.usage-headline').innerText(), usd(expected({ since: FIRST }).spend));
  await graphControl(graphs, 'Graph bucket', 'Day').click();
  assert.equal(await chart.getAttribute('aria-valuemax'), '34');
  await graphControl(graphs, 'Graph range', 'Month').click();

  await graphControl(graphs, 'Graph metric', 'Tokens').click();
  assert.match(await chart.getAttribute('aria-label'), /tokens/);
  assert.equal(await graphs.getByRole('status').innerText(), tooltip(LAST, { metric: 'tokens' }));
  assert.equal(await graphs.locator('.usage-headline').innerText(), headline, 'token chart retains the API spend summary');
  await graphControl(graphs, 'Graph stack', 'Model').click();
  assert.equal(await legend.getByRole('button').count(), 3);
  assert.equal(await graphs.getByRole('status').innerText(), tooltip(LAST, { metric: 'tokens', stack: 'model' }));
  await graphControl(graphs, 'Graph metric', 'API-equivalent USD').click();
  assert.equal(await graphs.getByRole('status').innerText(), tooltip(LAST, { stack: 'model' }));
  await graphControl(graphs, 'Graph stack', 'Harness').click();
  const computers = graphs.getByRole('combobox', { name: 'Filter graph by computer' });
  assert.deepEqual((await computers.locator('option').allTextContents()).sort(), ['All computers', 'laptop', 'pc'].sort());
  await computers.selectOption('laptop');
  assert.equal(await graphs.locator('.usage-headline').innerText(), usd(expected({ device: 'laptop' }).spend));
  assert.equal(await graphs.getByRole('status').innerText(), tooltip(LAST, { device: 'laptop' }));
  assert.equal(await pane.locator('.usage-owner-scope').innerText(), 'PC · all computers', 'graph filter is local; authority remains PC');
  await computers.selectOption('pc');
  assert.equal(await graphs.locator('.usage-headline').innerText(), usd(expected({ device: 'pc' }).spend));
  await computers.selectOption('all');
  assert.equal(historyCalls(f).length, 1, 'ranges, buckets, metrics, stacks and computer filter reuse one aggregate read');
  await noOverflow(page);
  await screenshotStates(page, graphs, `${theme ? 'chalk' : 'black'}-${width}`);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  await graphControl(graphs, 'Graph bucket', 'Week').click();
  assert.equal(await graphs.evaluate(n => [...n.querySelectorAll('*')].every(el => {
    const s = getComputedStyle(el); return s.animationName === 'none' && s.transitionDuration.split(',').every(v => parseFloat(v) === 0) && s.scrollBehavior === 'auto';
  })), true, 'Graphs disables animation, transitions and smooth scrolling under reduced motion');
  await noOverflow(page);
  await metricControl(pane, 'Cost').click(); await pane.locator('.usage-headline').waitFor();
  assert.equal(await pane.locator('.usage-headline').innerText(), headline);
  await metricControl(pane, 'Graphs').click(); await graphs.waitFor();
  assert.equal(historyCalls(f).length, 1, 'Cost/Graphs switch reuses the same lazy history');
  assert.equal(await input.inputValue(), 'unfinished graph draft');
  await pane.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  assert.equal(await pane.count(), 0); assert.equal(await input.inputValue(), 'unfinished graph draft');
  assert.deepEqual(f.errors, []);
});

test('selected computer remains explicit when range or authority has no activity for it', async t => {
  const f = await fixture(t, 390), { page } = f;
  const archive = historyFor([...records, { ...records[0], key: 'archive-record', device: 'archive' }]);
  f.answer = (c, owner) => c.type === 'usage-history' ? owner === 'pc' ? archive : laptopHistory : undefined;
  await prefer(page); await openUsage(page);
  const pane = page.locator('.usage-box'), graphs = pane.locator('.usage-graphs');
  await graphs.locator('.usage-headline').waitFor();
  await graphControl(graphs, 'Graph range', 'All').click();
  const computer = graphs.getByRole('combobox', { name: 'Filter graph by computer' });
  await computer.selectOption('archive');
  assert.notEqual(await graphs.locator('.usage-headline').innerText(), 'USD 0.00');
  await graphControl(graphs, 'Graph range', 'Week').click();
  assert.equal(await computer.inputValue(), 'archive');
  assert.match(await computer.locator('option:checked').innerText(), /archive · no recorded activity/);
  assert.equal(await graphs.locator('.usage-headline').innerText(), 'USD 0.00');
  await pane.getByRole('button', { name: 'This computer only', exact: true }).click();
  await pane.locator('.usage-owner-scope').getByText('Laptop · this computer only', { exact: true }).waitFor();
  assert.equal(await computer.inputValue(), 'archive');
  assert.match(await computer.locator('option:checked').innerText(), /archive · no recorded activity/);
  await computer.selectOption('all');
  assert.notEqual(await graphs.locator('.usage-headline').innerText(), 'USD 0.00');
  assert.deepEqual(f.errors, []);
});

test('Limits stays lazy; Cost/Graphs switches preserve an unfinished dialog answer without rescans', async t => {
  const f = await fixture(t, 390), { page } = f;
  const pane = page.locator('.usage-box'); await prefer(page, 'limits');
  const state = { ...f.tab, ui: { dialogs: [{ id: 'graph-question', method: 'input', title: 'Question stays' }] } };
  f.push(state); const answer = page.locator('#entry-dialog textarea'); await answer.waitFor(); await answer.fill('unfinished answer');
  await openUsage(page); await pane.getByText('Not signed in to ChatGPT here · sign in from Settings (Pi) or with codex login', { exact: true }).waitFor();
  assert.equal(historyCalls(f).length, 1, 'Limits reads Today once; metric switches below must reuse it');
  assert.equal(f.calls.filter(c => c.type === 'usage').length, 1);
  await metricControl(pane, 'Graphs').click(); await pane.locator('.usage-graphs').waitFor();
  for (const metric of ['Cost', 'Graphs', 'Cost', 'Graphs']) {
    await metricControl(pane, metric).click(); await pane.locator('.usage-headline').waitFor();
  }
  f.push({ ...state, stats: { contextUsage: { percent: 42 } } });
  assert.equal(await answer.inputValue(), 'unfinished answer');
  assert.equal(historyCalls(f).length, 1); assert.equal(historyCalls(f)[0].owner, 'pc');
  await pane.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  assert.equal(await answer.inputValue(), 'unfinished answer');
  assert.equal(f.calls.some(c => c.type === 'dialog'), false); assert.deepEqual(f.errors, []);
});

for (const theme of [0, 1]) test(`empty and one-day Graphs remain useful at 320px (${theme ? 'Chalk' : 'Black'})`, async t => {
  const f = await fixture(t, 320, theme), { page } = f;
  let history = emptyHistory;
  f.answer = (c, owner) => { f.calls.push({ ...c, owner }); return c.type === 'usage-history' ? history : c.type === 'usage' ? limits : undefined; };
  await prefer(page); await openUsage(page);
  const pane = page.locator('.usage-box'), graphs = pane.locator('.usage-graphs');
  await graphs.getByText('No recorded activity in this range.', { exact: true }).waitFor();
  assert.equal(await graphs.locator('.usage-headline').innerText(), 'USD 0.00');
  assert.equal(await graphs.getByRole('slider').count(), 0); await noOverflow(page);
  history = oneDayHistory;
  await pane.getByRole('button', { name: 'Refresh usage', exact: true }).click(); await graphs.getByRole('slider').waitFor();
  await graphControl(graphs, 'Graph range', 'All').click();
  assert.match(await graphs.locator('.usage-graph-scope').innerText(), /2026-10-11 – 2026-10-11 UTC · 1 calendar days/);
  assert.equal(await graphs.locator('.usage-headline').innerText(), usd(expected({ since: LAST }).spend));
  const chart = graphs.getByRole('slider');
  assert.equal(await chart.getAttribute('aria-valuemax'), '0');
  await chart.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  assert.equal(await chart.getAttribute('aria-valuenow'), '0');
  assert.equal(await chart.getAttribute('aria-valuetext'), tooltip(LAST, { since: LAST }));
  await page.keyboard.press('Enter'); const detail = graphs.locator('.usage-graph-detail'); await detail.waitFor();
  await page.keyboard.press('Escape'); assert.equal(await detail.count(), 0); assert.equal(await pane.count(), 1);
  await graphs.getByText('Usage over time data table', { exact: true }).click();
  await graphs.locator('.usage-time-table tbody tr').first().waitFor();
  assert.equal(await graphs.locator('.usage-time-table tbody tr').count(), 1);
  await noOverflow(page);
  await page.keyboard.press('Escape'); assert.equal(await pane.count(), 0);
  assert.deepEqual(f.errors, []);
});
