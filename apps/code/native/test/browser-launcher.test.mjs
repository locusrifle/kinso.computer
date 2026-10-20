import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

for (const theme of ['Black', 'Chalk']) for (const width of [320, 390, 1200]) test(`browser launcher reuses the current tab and preserves drafts at ${width}px in ${theme}`, async () => {
  // The dock's browser button is the scrolling layout's (in focus the panel's switch opens the browser).
  const f = await harnessFixture({ desk: true, layout: 'scrolling', machines: [{ id: 'pc', self: true, home: true, reachable: true }], themeCSS: theme === 'Chalk' ? ':root{--theme-bg:#fff;--theme-accent:#444;--theme-text:#111;--pi-bg:#fff;--pi-text:#111}' : '', viewport: { width, height: 900 }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }] });
  try {
    const p = f.page;
    await p.locator('#entry-input').fill('keep this draft');
    const button = p.getByRole('button', { name: 'Open PC browser (Chromium)', exact: true });
    await p.keyboard.press('Alt+Shift+B');
    assert.equal(await p.locator('webview').count(), 1);
    assert.equal(await p.locator('.gui-window-address').evaluate(n => n === document.activeElement), true);
    await p.locator('.gui-window-address').fill('https://example.com');
    await p.locator('.gui-window-address').press('Enter');
    await p.keyboard.press('Alt+Shift+B');
    await p.evaluate(() => keyFromWindow('browser'));
    assert.equal(await p.locator('webview').count(), 1);
    assert.equal(await p.locator('webview').getAttribute('src'), 'https://example.com/');
    assert.equal(await p.locator('#entry-input').inputValue(), 'keep this draft');
    assert.equal(f.tab.sessionId, 'thread-a');
    await p.waitForFunction(() => document.querySelector('.code-face').getAnimations().every(a => a.playState === 'finished'));
    const box = await button.boundingBox();
    assert.equal(box.width, 34); assert.equal(box.height, 34);
    assert.ok(box.x >= 0 && box.x + box.width <= width);
    await p.evaluate(() => { const menu = document.createElement('div'); menu.id = 'held-menu'; menu.setAttribute('role', 'menu'); keyFromWindow('previous'); keyFromWindow('previous'); document.body.append(menu); });
    await p.keyboard.press('Alt+Shift+B');
    await p.evaluate(() => keyFromWindow('browser'));
    assert.equal(await p.locator('.canvas-strip').evaluate(n => n.scrollLeft), 0, 'menus hold launch shortcuts');
    await p.evaluate(() => document.querySelector('#held-menu').remove());
    await p.locator('#entry-input').focus();
    await p.keyboard.press('Control+t');
    assert.equal(await p.locator('webview').count(), 2);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
