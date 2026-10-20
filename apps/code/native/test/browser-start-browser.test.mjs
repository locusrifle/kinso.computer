import test from 'node:test';
import assert from 'node:assert/strict';
import { browserStripFixture } from './fixtures/browser-strip.mjs';
import { FAKE_DESK } from './fixtures/harness-page.mjs';
import { runBrowser } from '../browser.mjs';

// The start page has no sites pinned: it is only "Where to?", and a website
// is reached by typing its address.
const SITES = ['https://mail.google.com/', 'https://x.com/', 'https://imperfect.computer/', 'https://www.youtube.com/'];

test('browser tool searches with the same Google URL as human chrome', async () => {
  const heard = [];
  await runBrowser({ action: 'open', url: 'goats on mountains', session: 'start-fixture' }, { ask: async request => {
    heard.push(request); return { tab: 7, url: request.url, title: 'Search fixture' };
  } });
  assert.deepEqual(heard, [{ do: 'open', url: 'https://www.google.com/search?q=goats%20on%20mountains', session: 'start-fixture' }]);
});

async function launch(page, native) {
  if (native) await page.keyboard.press('Meta+Shift+B');
  else await page.locator('#entry-output').evaluate(output => {
    const a = document.createElement('a'); a.dataset.page = 'about:blank'; a.href = '#'; output.append(a); a.click(); a.remove();
  });
  await page.locator('.wm-browser .browser-page.front .browser-start').waitFor();
}

for (const width of [1200, 390]) for (const native of [true, false]) {
  test(`offline start ${width}px ${native ? 'native' : 'iframe'}: no pins, same-tab targets, blank guest, + and Ctrl+T`, { timeout: 45000 }, async () => {
    const fixture = await browserStripFixture({ width, native });
    const { page } = fixture;
    const requests = [];
    await page.route('https://**/*', route => {
      requests.push(route.request().url());
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Chosen fixture site</title><p>Chosen</p>' });
    });
    const guest = () => page.locator(`.wm-browser .browser-page.front ${native ? 'webview' : 'iframe'}`);
    try {
      await launch(page, native);
      assert.equal(await page.locator('.wm-browser .browser-start h2').textContent(), 'Where to?');
      assert.equal(await page.locator('.wm-browser .browser-start button').count(), 0, 'no pinned sites');
      assert.equal(await page.locator('.wm-browser .browser-start img').count(), 0, 'no remote assets on the start page');
      assert.deepEqual(requests, [], 'drawing the start page needs no network');
      assert.equal(await guest().getAttribute('src'), 'about:blank');
      if (!native) {
        const blank = page.frames().find(frame => frame.url() === 'about:blank' && frame.parentFrame());
        assert.ok(blank, 'iframe really loads about:blank');
        assert.equal(await blank.evaluate(() => document.body.textContent), '', 'the start page is not injected into the frame');
      }
      const first = await guest().evaluate(node => { window.firstGuest = node; return node.getAttribute('src'); });
      assert.equal(first, 'about:blank');
      for (const [index, url] of SITES.entries()) {
        if (index) await page.locator('.wm-browser .browser-new').click();
        assert.equal(await guest().getAttribute('src'), 'about:blank', 'new tab remains blank until chosen');
        const count = await page.locator('.wm-browser .browser-tab').count();
        await page.locator('.wm-browser .gui-window-address').fill(url);
        await page.locator('.wm-browser .gui-window-address').press('Enter');
        await page.waitForFunction(({ native, url }) => document.querySelector(`.wm-browser .browser-page.front ${native ? 'webview' : 'iframe'}`)?.getAttribute('src') === url, { native, url });
        assert.equal(await page.locator('.wm-browser .browser-tab').count(), count, 'an address navigates the same tab');
        assert.equal(await page.locator('.wm-browser .browser-page.front .browser-start').isVisible(), false);
        if (native && !index) assert.equal(await guest().evaluate(node => node === firstGuest), true, 'same native guest');
      }
      assert.equal(await page.locator('.wm-browser .browser-pin').count(), 0, 'no pins in the strip either');
      await page.locator('.wm-browser .browser-new').click();
      await page.locator('.wm-browser .gui-window-address').focus();
      await page.keyboard.press('Control+t');
      assert.equal(await page.locator('.wm-browser .browser-tab').count(), 6, 'Ctrl+T creates another blank even if already blank');
      await page.locator('.wm-browser .browser-page.front .browser-start').waitFor();
      assert.equal(await guest().getAttribute('src'), 'about:blank');
      await page.locator('.wm-browser .gui-window-address').fill('https://x.com');
      await page.locator('.wm-browser .gui-window-address').press('Enter');
      assert.equal(await guest().getAttribute('src'), 'https://x.com/');
      assert.equal(await page.locator('.wm-browser .browser-tab').count(), 6, 'an address also uses the front tab');
      await page.locator('.wm-browser .gui-window-address').fill('goats on mountains');
      await page.locator('.wm-browser .gui-window-address').press('Enter');
      assert.equal(await guest().getAttribute('src'), 'https://www.google.com/search?q=goats%20on%20mountains');
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });
}

for (const width of [1200, 390]) {
  test(`initial native Ctrl+T ${width}px opens an offline blank start page`, { timeout: 30000 }, async () => {
    const fixture = await browserStripFixture({ width });
    const { page } = fixture;
    try {
      await page.locator('#entry-input').focus(); await page.keyboard.press('Control+t');
      await page.locator('.wm-browser .browser-start').waitFor();
      assert.equal(await page.locator('.wm-browser .browser-tab').count(), 1);
      assert.equal(await page.locator('.wm-browser webview').getAttribute('src'), 'about:blank');
      assert.equal(await page.locator('.wm-browser .browser-start-pin').count(), 0, 'no pinned sites');
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });
}

for (const native of [true, false]) {
  test(`blank ${native ? 'native' : 'iframe'} tab restores start chrome without changing the underlying page`, { timeout: 30000 }, async () => {
    const fixture = await browserStripFixture({ native });
    const { page } = fixture;
    try {
      await launch(page, native);
      await page.locator('.wm-browser .browser-new').click();
      await page.evaluate(() => harness.prepareSurfaceReload());
      await page.reload();
      if (native) await page.evaluate(FAKE_DESK);
      await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
      const views = page.locator(`.wm-browser ${native ? 'webview' : 'iframe'}`);
      await views.nth(1).waitFor({ state: 'attached' });
      assert.deepEqual(await views.evaluateAll(all => all.map(node => node.getAttribute('src'))), ['about:blank', 'about:blank']);
      assert.equal(await page.locator('.wm-browser .browser-start').count(), 2);
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });
}
