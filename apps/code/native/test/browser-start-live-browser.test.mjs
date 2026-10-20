import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture, PNG, FAKE_DESK } from './fixtures/harness-page.mjs';
import { messages } from './fixtures/browser-strip.mjs';

// The start page has no sites pinned: it is only "Where to?", and a website
// is reached by typing its address.
const SITES = ['https://mail.google.com/', 'https://x.com/', 'https://imperfect.computer/', 'https://www.youtube.com/'];

for (const width of [1200, 390]) {
  test(`streamed start ${width}px: chrome-only blank, no pins, no remote input, same-tab navigate, keys and Google`, { timeout: 45000 }, async () => {
    const heard = [], sockets = new Set();
    let next = 41;
    // This is the agent's real document state, independent of client chrome.
    let tabs = [{ tab: 40, url: 'about:blank', title: '', front: true }];
    const paint = () => { for (const ws of sockets) if (ws.readyState === 1) ws.send(JSON.stringify({ tabs })); };
    const frame = ws => ws.send(JSON.stringify({ frame: PNG.toString('base64'), width: 1, height: 1, tab: tabs.find(one => one.front)?.tab }));
    // The scrolling layout's strip and start page (a desk starts in focus).
    const fixture = await harnessFixture({ desk: width === 1200, layout: 'scrolling', viewport: { width, height: 900 }, hasTouch: width === 390, messages,
      machines: [{ id: 'pc', home: true, reachable: true }],
      onBrowserLive(ws) {
        sockets.add(ws); ws.on('close', () => sockets.delete(ws));
        ws.on('message', raw => {
          const said = JSON.parse(raw); heard.push(said);
          if (said.do === 'navigate') tabs = tabs.map(one => one.tab === said.tab ? { ...one, url: said.url } : one);
          if (said.do === 'new') tabs = [...tabs.map(one => ({ ...one, front: false })), { tab: next++, url: 'about:blank', front: true }];
          if (said.do === 'close') { tabs = tabs.filter(one => one.tab !== said.tab); if (tabs.length) tabs.at(-1).front = true; }
          if (['watch', 'launch', 'navigate', 'new', 'close'].includes(said.do)) { paint(); frame(ws); }
        });
      },
    });
    const { page } = fixture;
    page.setDefaultTimeout(6000);
    const overlay = page.locator('.wm-live .browser-start');
    const address = page.locator('.wm-live .gui-window-address');
    try {
      await page.getByRole('button', { name: 'Open PC browser (Chromium)', exact: true }).click();
      await overlay.waitFor();
      if (width === 390) await page.waitForFunction(() => {
        const strip = document.querySelector('.canvas-strip'), pane = document.querySelector('.wm-live').getBoundingClientRect();
        return Math.abs(pane.x) < 1 && Math.abs(strip.scrollLeft - Math.round(strip.scrollLeft / strip.clientWidth) * strip.clientWidth) < 1;
      });
      assert.equal(tabs[0].url, 'about:blank', 'opening chrome does not navigate the agent');
      assert.equal(await overlay.locator('h2').textContent(), 'Where to?');
      assert.equal(await overlay.getByRole('button').count(), 0, 'no pinned sites');
      assert.equal(await overlay.locator('img').count(), 0, 'no favicon requests');
      assert.equal(await page.locator('.wm-live .browser-live-type').count(), 0, 'no separate remote typing form');
      await overlay.dispatchEvent('pointerdown', { isPrimary: true, clientX: 50, clientY: 150 });
      await overlay.dispatchEvent('pointermove', { isPrimary: true, clientX: 50, clientY: 100 });
      await overlay.dispatchEvent('pointerup', { isPrimary: true, clientX: 50, clientY: 100 });
      await overlay.dispatchEvent('wheel', { deltaY: 120, clientX: 50, clientY: 150 });
      await page.waitForTimeout(100);
      assert.equal(heard.some(one => ['tap', 'scroll', 'type', 'navigate'].includes(one.do)), false, 'overlay input never reaches the blank browser');
      for (const url of SITES) {
        const id = tabs.find(one => one.front).tab;
        const count = tabs.length;
        await address.fill(url); await address.press('Enter');
        await page.waitForFunction(() => document.querySelector('.wm-live .browser-start')?.hidden).catch(async error => {
          console.log('Start navigation diagnostics:', JSON.stringify({ width, url, tabs, heard: heard.filter(said => !said.ack).slice(-8), chrome: await page.locator('.wm-live').evaluate(node => ({ note: node.querySelector('.browser-live-note')?.textContent, address: node.querySelector('.gui-window-address')?.value, start: node.querySelector('.browser-start')?.hidden })) }));
          throw error;
        });
        assert.deepEqual(heard.filter(one => one.do === 'navigate').at(-1), { do: 'navigate', tab: id, url });
        assert.equal(tabs.length, count);
        assert.equal(tabs.find(one => one.tab === id).url, url);
        assert.equal(heard.some(one => ['tap', 'scroll', 'type'].includes(one.do)), false, 'an address typed at the start page is not sent as a remote tap');
        await page.locator('.wm-live .browser-new').click();
        await overlay.waitFor();
        assert.equal(tabs.find(one => one.front).url, 'about:blank');
      }
      assert.equal(await page.locator('.wm-live .browser-pin').count(), 0, 'no pins in the strip either');
      const count = tabs.length;
      await address.focus(); await page.keyboard.press('Control+t');
      await page.waitForFunction(count => document.querySelectorAll('.wm-live .browser-tab').length === count + 1, count);
      assert.equal(tabs.length, count + 1, 'address Ctrl+T sends new, never local iframe');
      await address.focus(); await page.keyboard.press('Control+w');
      await page.waitForFunction(count => document.querySelectorAll('.wm-live .browser-tab').length === count, count);
      assert.equal(tabs.length, count, 'address Ctrl+W closes front');
      assert.equal(await page.locator('.wm-browser').count(), 0);
      if (width === 1200) {
        await page.evaluate(() => keyFromWindow('newTab'));
        await page.waitForFunction(count => document.querySelectorAll('.wm-live .browser-tab').length === count + 1, count);
        await page.evaluate(() => keyFromWindow('closeTab'));
        await page.waitForFunction(count => document.querySelectorAll('.wm-live .browser-tab').length === count, count);
        assert.equal(await page.locator('.wm-browser').count(), 0, 'forwarded guest keys delegate to the focused portal');
      }
      const id = tabs.find(one => one.front).tab;
      await address.fill('https://x.com'); await address.press('Enter');
      await page.waitForFunction(() => document.querySelector('.wm-live .browser-start')?.hidden);
      assert.deepEqual(heard.filter(one => one.do === 'navigate').at(-1), { do: 'navigate', tab: id, url: 'https://x.com/' });
      await address.fill('goats on mountains'); await address.press('Enter');
      await page.waitForFunction(() => document.querySelector('.wm-live .browser-tab.front')?.title.includes('www.google.com/search'));
      assert.deepEqual(heard.filter(one => one.do === 'navigate').at(-1), { do: 'navigate', tab: id, url: 'https://www.google.com/search?q=goats%20on%20mountains' });
      await address.fill('localhost:5173'); await address.press('Enter');
      await page.waitForFunction(() => document.querySelector('.wm-live .browser-tab.front')?.title.includes('localhost:5173'));
      assert.deepEqual(heard.filter(one => one.do === 'navigate').at(-1), { do: 'navigate', tab: id, url: 'http://localhost:5173/' }, 'uses shared address parser');
      const background = tabs.find(one => !one.front).tab;
      await address.focus();
      tabs = tabs.map(one => one.tab === background ? { ...one, loading: true } : one); paint();
      await page.waitForFunction(id => document.querySelector(`.wm-live .browser-tab[data-tab="${id}"]`)?.classList.contains('loading'), background);
      tabs = tabs.map(one => one.tab === background ? { ...one, loading: false } : one); paint();
      await page.waitForFunction(id => document.querySelector(`.wm-live .browser-tab[data-tab="${id}"]`)?.classList.contains('unread'), background);
      assert.equal(await address.evaluate(node => node === document.activeElement), true, 'quiet backend loading/unread updates do not steal keys');
      tabs = tabs.map(one => ({ ...one, front: one.tab === background })); paint();
      await page.waitForFunction(id => !document.querySelector(`.wm-live .browser-tab[data-tab="${id}"]`)?.classList.contains('unread'), background);
      tabs = tabs.map(one => one.front ? { ...one, url: 'about:blank' } : one); paint();
      await overlay.waitFor();
      const navigations = heard.filter(one => one.do === 'navigate').length;
      await page.evaluate(() => harness.prepareSurfaceReload()); await page.reload();
      if (width === 1200) await page.evaluate(FAKE_DESK);
      await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
      await page.locator('.wm-live').waitFor({ state: 'attached' });
      // Restore is quiet and does not watch an off-screen portal. Reveal it
      // through the human command before expecting blank-tab chrome.
      await page.getByRole('button', { name: 'Open PC browser (Chromium)', exact: true }).click();
      await overlay.waitFor();
      assert.equal(tabs.find(one => one.front).url, 'about:blank', 'restoring portal blank does not change the agent document');
      assert.equal(heard.filter(one => one.do === 'navigate').length, navigations);
      assert.equal(await page.locator('.wm-live .browser-live-type').count(), 0);
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });
}

test('fixed streamed blank preview has neither start chrome nor strip/pins', { timeout: 30000 }, async () => {
  const heard = [];
  const fixture = await harnessFixture({ messages, onBrowserLive(ws) {
    ws.on('message', raw => {
      const said = JSON.parse(raw); heard.push(said);
      if (said.do === 'watch') ws.send(JSON.stringify({ watching: 90, tabs: [{ tab: 90, url: 'about:blank', front: false }], frame: PNG.toString('base64'), width: 1, height: 1, tab: 90 }));
    });
  } });
  try {
    await fixture.page.evaluate(async () => {
      const { mountLive } = await import('/js/live.js');
      const live = window.fixedLive = mountLive({ tab: 90 });
      const el = document.createElement('div'); el.id = 'fixed-preview';
      el.style.cssText = 'position:fixed;inset:80px 20px 80px 260px;display:flex;flex-direction:column;z-index:100';
      el.append(live.bar, live.body); document.body.append(el);
      live.newTab(); live.closeFront();
    });
    await fixture.page.locator('#fixed-preview .browser-live-frame').waitFor();
    await fixture.page.waitForFunction(() => document.querySelector('#fixed-preview .browser-live-frame').hasAttribute('src'));
    assert.equal(await fixture.page.locator('#fixed-preview .browser-start,#fixed-preview .browser-tab-strip,#fixed-preview .browser-pin').count(), 0);
    assert.equal(await fixture.page.locator('#fixed-preview .gui-window-address').isVisible(), false);
    assert.equal(heard.some(one => ['navigate', 'new', 'close'].includes(one.do)), false);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
