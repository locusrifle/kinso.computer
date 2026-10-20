import test from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_DESK, harnessFixture } from './fixtures/harness-page.mjs';
import { readFile } from 'node:fs/promises';
import { themeCss } from '../../../../system/theme.mjs';
const themeCSS = themeCss(JSON.parse(await readFile(new URL('./fixtures/themes/black.json', import.meta.url), 'utf8')));

async function reload(page) {
  await page.reload();
  await page.evaluate(FAKE_DESK);
  await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
}

const messages = [{ role: 'user', content: 'Browser beside the conversation' }, { role: 'assistant', content: [{ type: 'text', text: 'The browser opens on the right, in the next place along.' }] }];
const order = page => page.evaluate(() => [...document.querySelectorAll('.canvas-strip > .wm-window')].sort((a, b) => a.style.order - b.style.order).map(el => el.classList.contains('entry-screen') ? 'conversation' : el.classList.contains('wm-files') ? 'files' : el.classList.contains('wm-live') ? 'live' : 'browser'));
const rect = (page, selector) => page.locator(selector).evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; });

test('new desktop browsers open on the right, quiet ones leave the view alone, and two chrome rows fit the shared band', async () => {
  // Placement in the scrolling layout's strip (a desk starts in focus).
  const fixture = await harnessFixture({ desk: true, layout: 'scrolling', themeCSS, messages, viewport: { width: 1536, height: 900 } });
  const { page } = fixture;
  try {
    await page.locator('.wm-files').waitFor();
    await page.waitForTimeout(500);
    await page.locator('#entry-input').focus();
    const before = await rect(page, '.entry-screen');
    await page.evaluate(() => browseFromWindow({ url: 'https://example.com/', behind: true }));
    await page.waitForFunction(() => !document.querySelector('.wm-moving'));
    assert.deepEqual(await order(page), ['conversation', 'files', 'browser']);
    assert.deepEqual(await rect(page, '.entry-screen'), before, 'quiet opening does not displace the visible session');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'entry-input');
    await page.evaluate(() => keyFromWindow('browser'));
    const max = await page.locator('.canvas-strip').evaluate(n => n.scrollWidth - n.clientWidth);
    assert.ok(max > 0);
    assert.equal(await page.evaluate(() => document.querySelector('.canvas-strip').scrollLeft), max, 'explicit launch reveals the browser on the right');
    const bar = await rect(page, '.wm-browser .gui-window-bar');
    const files = await rect(page, '.workbench-bar');
    const address = await rect(page, '.gui-window-address');
    assert.equal(bar.height, files.height);
    assert.ok(Math.abs(address.bottom - (bar.bottom - 1)) <= 1, 'URL sits directly on the divider');
    const strip = await rect(page, '.wm-browser .browser-tab-strip');
    const controls = await rect(page, '.wm-browser .browser-controls');
    assert.equal(bar.height, 72, 'shared band remains 72px');
    assert.equal(strip.y - bar.y, 24, 'desktop clock/glance space stays reserved');
    assert.equal(strip.height, 24);
    assert.equal(strip.bottom, controls.y, 'tab row sits above address/navigation');
    assert.equal(controls.height, 23, 'remaining band ends on the 1px divider');
    assert.equal(address.height, controls.height);
    assert.equal(address.y, controls.y);
    const layout = await order(page);
    fixture.push({ ...fixture.tab, sessionId: 'thread-b', tabs: [{ id: 'tab-b', sessionId: 'thread-b', focused: true, agent: 'pi', name: 'B' }] });
    await page.waitForTimeout(150);
    assert.deepEqual(await order(page), layout, 'session switch does not recreate/reorder the browser');
    await page.evaluate(() => harness.prepareSurfaceReload());
    await reload(page);
    await page.locator('.wm-browser').waitFor();
    assert.deepEqual(await order(page), layout, 'saved placement returns on reload');
    await page.evaluate(() => keyFromWindow('along'));
    const rotated = await order(page);
    await page.evaluate(() => harness.prepareSurfaceReload());
    await reload(page);
    await page.locator('.wm-browser').waitFor();
    assert.deepEqual(await order(page), rotated, 'a manually rotated layout is recovered rather than reset');
    // The tiling chosen with MOD+L comes back too.
    await page.evaluate(() => keyFromWindow('layout'));
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 1);
    await page.evaluate(() => harness.prepareSurfaceReload());
    await reload(page);
    await page.locator('.wm-browser').waitFor();
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 1, 'dwindle returns on reload');
    assert.deepEqual(await order(page), rotated);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('saved placements are retained, a left browser saved by the old default included, and fresh ones open on the right on desk and phone', async () => {
  for (const hasTouch of [false, true]) {
    const fixture = await harnessFixture({ desk: true, messages, hasTouch, viewport: { width: hasTouch ? 390 : 1536, height: 900 } });
    const { page } = fixture;
    try {
      if (!hasTouch) {
        await page.evaluate(() => harness.prepareSurfaceReload());
        await page.evaluate(() => {
          const key = Object.keys(sessionStorage).find(key => sessionStorage.getItem(key)?.includes('"windows"'));
          if (!key) throw new Error('missing saved view');
          const view = JSON.parse(sessionStorage.getItem(key));
          view.order = ['browser', 'conversation', 'files'];
          view.windows = [{ kind: 'files', at: '/fixture' }, { kind: 'browser', at: ['https://example.com/'] }];
          sessionStorage.setItem(key, JSON.stringify(view));
        });
        await reload(page);
        await page.locator('.wm-browser').waitFor();
      } else {
        await page.evaluate(() => browseFromWindow({ url: 'https://example.com/', behind: true }));
      }
      assert.deepEqual(await order(page), hasTouch ? ['conversation', 'files', 'browser'] : ['browser', 'conversation', 'files'], 'the saved order, as it was');
      if (!hasTouch) {
        await page.evaluate(() => tabFromWindow({ id: 101, do: 'close' }));
        await page.locator('.wm-browser').waitFor({ state: 'detached' });
        await page.evaluate(() => browseFromWindow({ url: 'https://new.example/', behind: true }));
        assert.deepEqual(await order(page), ['conversation', 'files', 'browser'], 'a fresh browser after closing the restored one opens on the right');
      }
      assert.deepEqual(fixture.errors, []);
    } finally { await fixture.close(); }
  }
});
