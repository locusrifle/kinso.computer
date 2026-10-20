import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { browserStripFixture } from './fixtures/browser-strip.mjs';

const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Keep the page beside the conversation.' }] }];

test('same-origin iframe follows links, reloads and restores its current address', { timeout: 30000 }, async () => {
  let secondLoads = 0;
  const fixture = await harnessFixture({ messages, handleRequest: async (req, res, path) => {
    if (!['/navigation/one', '/navigation/two'].includes(path)) return false;
    res.setHeader('Content-Type', 'text/html');
    res.end(path.endsWith('/one') ? '<title>First page</title><a href="/navigation/two">Next page</a>' : `<title>Second page</title><h1>Second page ${++secondLoads}</h1>`);
    return true;
  } });
  const { page } = fixture;
  try {
    const origin = new URL(page.url()).origin;
    await page.locator('#entry-output').evaluate(output => {
      const link = document.createElement('a'); link.dataset.page = `${location.origin}/navigation/one`; link.href = '#'; output.append(link); link.click(); link.remove();
    });
    const frame = () => page.frameLocator('.wm-browser .browser-page.front iframe');
    await frame().getByRole('link', { name: 'Next page' }).click();
    await frame().getByRole('heading', { name: 'Second page 1' }).waitFor();
    const address = page.locator('.wm-browser .gui-window-address');
    await page.waitForFunction(url => document.querySelector('.wm-browser .gui-window-address').value === url, `${origin}/navigation/two`);
    assert.equal(await page.locator('.browser-tab-title').textContent(), 'Second page');
    await page.locator('#entry-input').focus();
    await page.keyboard.press('Alt+ArrowRight');
    await page.keyboard.press('Alt+ArrowRight');
    await page.locator('.wm-browser .browser-controls [aria-label="Reload"]').click();
    await frame().getByRole('heading', { name: 'Second page 2' }).waitFor();
    assert.equal(await address.inputValue(), `${origin}/navigation/two`);
    await page.evaluate(() => harness.prepareSurfaceReload());
    await page.reload();
    await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
    await frame().getByRole('heading', { name: 'Second page 3' }).waitFor();
    assert.equal(await address.inputValue(), `${origin}/navigation/two`);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('native address navigation gives the page keys; close from the address follows the surviving tab', { timeout: 30000 }, async () => {
  const fixture = await browserStripFixture({ native: true });
  const { page } = fixture;
  try {
    await fixture.open(1); await fixture.reveal();
    const address = page.locator('.wm-browser .gui-window-address');
    await address.fill('example.net/read'); await address.press('Enter');
    assert.equal(await page.locator('.wm-browser webview').getAttribute('src'), 'https://example.net/read');
    assert.equal(await page.locator('.wm-browser webview').evaluate(view => view === document.activeElement), true);
    assert.equal(await address.inputValue(), 'https://example.net/read');
    await page.locator('.wm-browser .browser-new').click();
    assert.equal(await address.inputValue(), '');
    await address.press('Control+w');
    assert.equal(await page.locator('.wm-browser webview').count(), 1);
    assert.equal(await address.inputValue(), 'https://example.net/read');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
