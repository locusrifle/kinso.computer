import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture, readBody } from './fixtures/harness-page.mjs';

// The browser's bar isolates its contents, so whatever drops from it is trapped
// in the bar's stacking context: the bar must stand above the tab stack, or the
// pages paint over what it opens. The tabs are a strip in the bar now, and what
// drops from it is the Pages list (a streamed page from another computer keeps
// the others reachable there). Both are imperfect's, drawn over the website: a
// click on them chooses the tab and never lands in the page under them.
test('the tabs and the Pages list stand over the website and a click there chooses the tab', async t => {
  // The tabs and the Pages list as the scrolling layout shows them (a desk starts in focus, which hides the strip).
  const f = await harnessFixture({ desk: true, layout: 'scrolling', viewport: { width: 1472, height: 920 }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Tabs' }] }],
    handleRequest: async (req, res, path) => {
      if (path !== '/shown/view') return false;
      await readBody(req); res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ stream: true, tab: 41, url: 'http://localhost:5173/' })); return true;
    },
    onBrowserLive: ws => ws.on('message', raw => {
      const said = JSON.parse(raw);
      if (said.do === 'watch') ws.send(JSON.stringify({ scope: 'browser', watching: said.tab, tabs: [{ tab: 41, title: 'Preview', url: 'http://localhost:5173/', front: true }] }));
    }),
  });
  t.after(() => f.close());
  const p = f.page;
  await p.evaluate(() => {
    browseFromWindow({ url: 'https://one.invalid/', behind: true });
    browseFromWindow({ url: 'https://two.invalid/', behind: true });
    browseFromWindow({ url: 'https://three.invalid/', behind: true });
  });
  await p.evaluate(() => tabFromWindow({ id: 101, do: 'reveal' }));
  await p.waitForFunction(() => {
    const pane = document.querySelector('.wm-browser')?.getBoundingClientRect();
    return pane && pane.left >= -2 && pane.right <= innerWidth + 2 && !document.querySelector('.wm-moving');
  });
  const front = () => p.locator('.wm-browser .browser-page.front webview').getAttribute('src');
  assert.equal(await front(), 'https://one.invalid/');
  const hits = selector => p.locator(selector).evaluateAll(all => all.map(one => {
    const r = one.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { label: one.textContent.trim(), x, y, hit: one.contains(hit) ? 'tab' : hit?.localName ?? null };
  }));

  // The strip: every tab in the bar takes its own click.
  const strip = await hits('.wm-browser .browser-tab .browser-tab-title');
  assert.deepEqual(strip.map(one => one.label), ['one.invalid', 'two.invalid', 'three.invalid']);
  assert.deepEqual(strip.map(one => one.hit), ['tab', 'tab', 'tab']);
  await p.mouse.click(strip[2].x, strip[2].y);
  assert.equal(await front(), 'https://three.invalid/', 'the tab chosen is in front');
  assert.deepEqual(await p.evaluate(() => deskSaid.at(-1)), ['front', 103], 'and the window is told');

  // A streamed page joins the same browser in front; the Pages list drops from
  // the bar over the website under it.
  await p.locator('#entry-output').evaluate(output => {
    const a = document.createElement('a'); a.dataset.page = 'http://localhost:5173/'; output.append(a); a.click(); a.remove();
  });
  const pagesButton = p.locator('.wm-browser .browser-panels');
  await pagesButton.waitFor({ state: 'visible' });
  await pagesButton.click();
  const list = p.locator('.wm-browser .browser-panel-list');
  await list.waitFor({ state: 'visible' });
  const stack = await p.locator('.wm-browser .browser-stack').boundingBox();
  const entries = await hits('.wm-browser .browser-panel-entry > button:first-child');
  assert.deepEqual(entries.map(one => one.label), ['one.invalid', 'two.invalid', 'three.invalid', 'Preview']);
  assert.ok(entries.every(one => one.y > stack.y), 'the list drops over the website');
  assert.deepEqual(entries.map(one => one.hit), ['tab', 'tab', 'tab', 'tab'], 'the list is drawn over the pages, not under them');
  await p.mouse.click(entries[0].x, entries[0].y);
  assert.equal(await front(), 'https://one.invalid/', 'the tab chosen from the list is in front');
  assert.deepEqual(await p.evaluate(() => deskSaid.at(-1)), ['front', 101], 'and the window is told');
  assert.equal(await list.isVisible(), false, 'chosen, the list goes');
  assert.deepEqual(f.errors, []);
});
