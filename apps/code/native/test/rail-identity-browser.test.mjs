import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { serve } from '../../tools/gui-preview.mjs';

test('the agents are a strip of tabs across the top, and the panels are in the input bar with every other control', async () => {
  const { server, sockets, port } = await serve(':root { --pi-accent: #4f8cff; }');
  const calls = [];
  sockets.on('connection', socket => socket.on('message', raw => calls.push(JSON.parse(raw).type)));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    // This is the optional scrolling layout's strip, not the default focus sidebar.
    await page.addInitScript(() => localStorage.setItem('imperfect.layout-choice.v2', 'scrolling'));
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.waitForSelector('#session-rail.collapsed .session-rail-open');
    assert.equal(await page.getByLabel('Rendering mode').count(), 0);
    assert.equal(await page.getByLabel('Past inputs').count(), 0);
    assert.equal(await page.locator('.gui-rail-resize, .entry-status-usage').count(), 0, 'no sidebar handle, no corner');
    assert.equal(await page.locator('.session-actions > .session-more').count(), 0, 'nothing folds the dock');
    // The strip spans the conversation's top; the composer spans both panels.
    await page.waitForFunction(() => !document.querySelector('.wm-moving'));
    const layout = await page.evaluate(() => {
      const rail = document.querySelector('#session-rail').getBoundingClientRect(), screen = document.querySelector('.entry-screen').getBoundingClientRect(), terminal = document.querySelector('#entry-terminal').getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(document.querySelector('.entry-screen')).paddingTop);
      return { width: rail.width, middle: screen.width - 2, terminal: terminal.width, composer: document.querySelector('#entry-input-zone').getBoundingClientRect().width, above: rail.bottom <= screen.top + pad + 2, top: rail.top - terminal.top };
    });
    assert.ok(Math.abs(layout.width - layout.middle) < 1 && layout.above && layout.top < 2, JSON.stringify(layout));
    assert.equal(layout.composer, layout.terminal, 'the session header belongs to its middle; its composer spans the shared frame');
    // A tab is its mark and what it was asked; the model is in the unfolded list.
    const tab = await page.locator('.session-rail-item[data-tab-id]').first().evaluate(row => ({ mark: Boolean(row.querySelector('.session-rail-number')), model: getComputedStyle(row.querySelector('.session-rail-model')).display, height: row.getBoundingClientRect().height }));
    assert.ok(tab.mark && tab.model === 'none' && tab.height < 60, JSON.stringify(tab));
    await page.getByRole('button', { name: 'show the agents' }).click();
    await page.waitForSelector('#session-rail:not(.collapsed) .session-rail-model');
    assert.equal(await page.locator('#session-rail .session-rail-model').first().textContent(), 'gpt-6');
    assert.equal(calls.filter(type => type === 'sessions').length, 0, 'expanding agents never loads history');
    assert.equal(await page.locator('.session-rail-past').count(), 0);
    await page.getByRole('button', { name: 'Show history', exact: true }).click();
    await page.waitForSelector('.session-rail-past');
    assert.equal(calls.filter(type => type === 'sessions').length, 1);
    await page.getByRole('button', { name: 'Collapse history', exact: true }).click();
    assert.equal(await page.locator('.session-rail-past').count(), 0);
    await page.getByRole('button', { name: 'collapse the agents' }).click();
    await page.waitForSelector('#session-rail.collapsed');
    assert.equal(await page.getByText('Settle', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Search archive…').count(), 0);
    // Every control in the input bar, the dock open: usage, browser, the mic
    // and +, then the arrow; no Workbench button (Workbench is always open)
    // and no shortcuts.
    const bar = await page.locator('.session-actions').evaluate(dock => [...dock.children].filter(node => getComputedStyle(node).display !== 'none' && !node.hidden).map(node => node.className));
    assert.deepEqual(bar, ['entry-voice entry-usage', 'entry-browser', 'entry-voice', 'entry-plus', 'entry-send'], JSON.stringify(bar));
    const mic = page.locator('.session-actions .entry-voice:not(.entry-usage)');
    const below = await mic.evaluate(button => document.querySelector('#entry-terminal').getBoundingClientRect().bottom - button.getBoundingClientRect().bottom);
    assert.ok(below < 50, String(below));
  } finally {
    await browser.close();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
