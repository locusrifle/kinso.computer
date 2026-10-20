import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture, PNG } from './fixtures/harness-page.mjs';
import { messages, stripGeometry } from './fixtures/browser-strip.mjs';

for (const width of [1200, 390]) {
  test(`hosted portal strip ${width}px: streamed list, states, stable focus, front/close/new`, { timeout: 30000 }, async () => {
    const heard = [];
    let remoteTabs = [{ tab: 21, title: 'Human.html', url: 'https://example.test/', front: true }, { tab: 22, title: 'Research', url: 'https://example.test/agent', driving: true, loading: true, unread: true }, { tab: 23, title: '', url: 'about:blank' }];
    const sockets = new Set();
    const paint = () => { for (const ws of sockets) if (ws.readyState === 1) ws.send(JSON.stringify({ tabs: remoteTabs })); };
    const fixture = await harnessFixture({ viewport: { width, height: 900 }, hasTouch: width === 390, messages,
      onBrowserLive(ws) {
        sockets.add(ws); ws.on('close', () => sockets.delete(ws));
        ws.on('message', raw => {
          const said = JSON.parse(raw); heard.push(said);
          if (said.do === 'front') remoteTabs = remoteTabs.map(one => ({ ...one, front: one.tab === said.tab }));
          if (said.do === 'close') {
            const front = remoteTabs.find(one => one.front)?.tab;
            remoteTabs = remoteTabs.filter(one => one.tab !== said.tab);
            if (front === said.tab && remoteTabs.length) remoteTabs[0].front = true;
          }
          if (said.do === 'new') remoteTabs = [...remoteTabs.map(one => ({ ...one, front: false })), { tab: 24, url: 'about:blank', front: true }];
          if (['watch', 'front', 'close', 'new'].includes(said.do)) paint();
          if (said.do === 'watch') ws.send(JSON.stringify({ frame: PNG.toString('base64'), width: 1, height: 1, tab: 21 }));
        });
      },
    });
    const { page } = fixture;
    page.setDefaultTimeout(6000);
    try {
      fixture.send({ type: 'browse', front: false, machine: '' });
      await page.locator('.wm-live').waitFor({ state: 'attached' });
      await page.keyboard.press('Alt+ArrowRight');
      await page.keyboard.press('Alt+ArrowRight');
      await page.locator('.wm-live').scrollIntoViewIfNeeded();
      const tabs = page.locator('.wm-live .browser-tab');
      await tabs.nth(2).waitFor({ state: 'attached' });
      assert.deepEqual(await tabs.locator('.browser-tab-title').allTextContents(), ['Human', 'Research', 'New tab']);
      assert.equal(await tabs.nth(1).evaluate(tab => ['driven', 'loading', 'unread'].every(state => tab.classList.contains(state))), true);
      const initial = await stripGeometry(page, '.wm-live');
      assert.equal(initial.bar.height, 72);
      await tabs.first().focus(); await tabs.first().evaluate(tab => { window.keptLiveTab = tab; });
      remoteTabs = remoteTabs.map(one => ({ ...one, loading: false })); paint();
      await page.waitForFunction(() => !document.querySelectorAll('.wm-live .browser-tab')[1].classList.contains('loading'));
      assert.equal(await tabs.first().evaluate(tab => tab === keptLiveTab && tab === document.activeElement), true);
      await tabs.nth(1).click();
      await page.waitForFunction(() => document.querySelectorAll('.wm-live .browser-tab')[1].classList.contains('front'));
      assert.ok(heard.some(said => said.do === 'front' && said.tab === 22));
      await page.locator('.wm-live .browser-tab-close').nth(1).click();
      await page.waitForFunction(() => document.querySelectorAll('.wm-live .browser-tab').length === 2);
      assert.ok(heard.some(said => said.do === 'close' && said.tab === 22));
      await page.locator('.wm-live .browser-new').click();
      await page.waitForFunction(() => document.querySelectorAll('.wm-live .browser-tab').length === 3);
      assert.ok(heard.some(said => said.do === 'new'));
      assert.equal(await page.locator('.wm-live .browser-tab.front .browser-tab-title').textContent(), 'New tab');
      const many = Array.from({ length: 12 }, (_, i) => ({ tab: 30 + i, title: `Streamed page ${i + 1}`, url: `https://example.test/${i}`, front: i === 0 }));
      remoteTabs = many; paint();
      await tabs.nth(11).waitFor({ state: 'attached' });
      const overflow = await stripGeometry(page, '.wm-live');
      assert.ok(overflow.overflow);
      assert.equal(new Set(overflow.items.map(item => Math.round(item.y))).size, 1);
      assert.equal(overflow.controls.y, initial.controls.y);
      assert.deepEqual(overflow.address, initial.address);
      remoteTabs = [many[0]]; paint();
      await page.waitForFunction(() => document.querySelectorAll('.wm-live .browser-tab').length === 1);
      assert.equal(await page.locator('.wm-live .browser-tab-strip').isVisible(), true, 'one streamed tab keeps its strip');
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  });
}
