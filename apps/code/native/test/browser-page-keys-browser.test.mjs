import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture, readBody } from './fixtures/harness-page.mjs';
import { browserStripFixture, messages } from './fixtures/browser-strip.mjs';

for (const width of [1200, 390]) test(`native ${width}px: an address typed at the start page gives page keys; agent metadata/front never takes composer keys`, { timeout: 30000 }, async () => {
  const f = await browserStripFixture({ native: true, width }), { page } = f;
  try {
    await f.open(1); await f.reveal();
    await page.locator('.wm-browser .browser-new').click();
    // The start page has no pinned sites: a website is reached by its address.
    await page.locator('.wm-browser .gui-window-address').fill('https://x.com');
    await page.locator('.wm-browser .gui-window-address').press('Enter');
    assert.equal(await page.locator('.browser-page.front webview').getAttribute('src'), 'https://x.com/');
    assert.equal(await page.locator('.browser-page.front webview').evaluate(view => view === document.activeElement), true);
    await page.locator('#entry-input').focus();
    await page.evaluate(() => {
      const view = document.querySelector('.browser-page.front webview');
      view.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://x.com/read' }));
      tabFromWindow({ id: view.getWebContentsId(), do: 'front' });
    });
    assert.equal(await page.locator('#entry-input').evaluate(el => document.activeElement === el), true);
    await page.locator('.browser-page.front webview').focus();
    await page.evaluate(() => keyFromWindow('previous'));
    assert.equal(await page.locator('.wm-files.wm-focused').count(), 1);
    await page.locator('.wm-files').evaluate(files => {
      const frame = document.createElement('iframe'); frame.src = 'about:blank'; frame.id = 'workbench-key-proof'; files.append(frame); frame.focus();
    });
    const count = await page.locator('.wm-browser .browser-page').count();
    await page.evaluate(() => keyFromWindow('closeTab'));
    assert.equal(await page.locator('.wm-browser .browser-page').count(), count, 'forwarded Workbench-frame CtrlW cannot close an unrelated browser tab');
    assert.equal(await page.locator('#workbench-key-proof').evaluate(el => document.activeElement === el), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('native global CtrlT reveals an offscreen scoped Browser and queues exactly one owner new after proof', { timeout: 30000 }, async () => {
  let next = 41, active = 41, connected = 0;
  const tabs = [{ tab: 41, title: 'Remote seed', url: 'http://localhost:5173/' }], heard = [];
  // Page keys in the scrolling layout (a desk starts in focus).
  const f = await harnessFixture({ desk: true, layout: 'scrolling', messages,
    handleRequest: async (req, res, path) => {
      if (path !== '/shown/view') return false;
      await readBody(req); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ stream: true, tab: 41, url: 'http://localhost:5173/' })); return true;
    },
    onBrowserLive: ws => {
      connected++;
      let pin;
      const paint = () => ws.send(JSON.stringify({ scope: 'browser', watching: pin, tabs: tabs.map(tab => ({ ...tab, front: tab.tab === active })) }));
      ws.on('close', () => connected--);
      ws.on('message', raw => {
        const said = JSON.parse(raw); heard.push(said);
        if (said.do === 'watch') { pin = said.tab; paint(); }
        if (said.do === 'new') { const fresh = { tab: ++next, url: 'about:blank', title: '' }; tabs.push(fresh); active = pin = fresh.tab; paint(); }
      });
    },
  });
  const { page } = f;
  try {
    await page.locator('#entry-output').evaluate(output => {
      const a = document.createElement('a'); a.dataset.page = 'http://localhost:5173/'; output.append(a); a.click(); a.remove();
    });
    await page.locator('.wm-browser .browser-tab[data-tab="41"]').waitFor();
    // Move from the Browser's focus, not an already focused composer. The
    // desktop WM deliberately restores manual scroll to its chosen viewport.
    await page.locator('.wm-browser .gui-window-address').focus();
    await page.evaluate(() => { keyFromWindow('previous'); keyFromWindow('previous'); });
    await page.locator('#entry-input').focus();
    await page.waitForFunction(() => {
      const r = document.querySelector('.wm-browser').getBoundingClientRect();
      return r.left >= innerWidth || r.right <= 0;
    }, null, { timeout: 6000 });
    for (const end = Date.now() + 6000; connected !== 0;) {
      if (Date.now() > end) throw new Error('Remote Browser did not disconnect offscreen');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(tabs.length, 1);
    await page.locator('#entry-input').focus(); await page.keyboard.press('Control+t');
    await page.locator('.wm-browser .browser-tab.front[data-tab="42"]').waitFor();
    assert.equal(tabs.length, 2); assert.equal(heard.filter(one => one.do === 'new').length, 1);
    const address = page.locator('.wm-browser .gui-window-address');
    assert.equal(await address.inputValue(), ''); assert.equal(await address.evaluate(el => document.activeElement === el), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
