import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { serve, fixture } from '../../tools/gui-preview.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { testTheme } from './fixtures/theme.mjs';

for (const theme of ['Black', 'Chalk']) for (const width of [320, 390, 1280]) {
  test(`${theme} ${width}: tab marks remain whole, with only the caption ellipsized`, async () => {
    const css = themeCss(await testTheme(theme === 'Chalk' ? 'light-chalk' : 'black', '/tmp/session-tab-text-theme'));
    const { server, sockets, port } = await serve(css);
    const browser = await launchChromium({ args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 640, hasTouch: width < 640 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`http://127.0.0.1:${port}/?face=code`);
      await page.locator('#entry-output.gui-transcript').waitFor();
      await page.locator('#entry-input').fill('keep this draft');
      await page.evaluate(() => document.fonts.ready);
      for (const index of [0, 1, 7, 12]) {
        const snapshot = fixture();
        snapshot.tabs = Array.from({ length: 20 }, (_, i) => ({ ...snapshot.tabs[0], id: i ? `text-${i}` : 'mirror', sessionId: i ? `text-${i}` : 'mirror', focused: i === index, prompt: 'image 1: ' + 'a very long independently clipped caption '.repeat(10) }));
        for (const socket of sockets.clients) socket.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
        // I already exists in the original two-tab fixture. Wait for this
        // snapshot, not just that mark, before inspecting its selected row.
        await page.waitForFunction(i => {
          const rows = document.querySelectorAll('.session-rail-agents .session-rail-item');
          const row = document.querySelector('.session-rail-agents .session-rail-item.active');
          return rows.length === 20 && row?.dataset.tabId === (i ? `text-${i}` : 'mirror') &&
            (innerWidth < 640 || row.querySelector('.session-rail-number')?.textContent === ['I', 'II', 'VIII', 'XIII'][[0, 1, 7, 12].indexOf(i)]);
        }, index, { timeout: 60000 });
        if (width < 640) {
          // A phone's strip: each session its agent's mark, whole; the one in
          // front a pill with what it was asked, cut short with an ellipsis.
          const seen = await page.evaluate(() => {
            const row = document.querySelector('.session-rail-agents .session-rail-item.active');
            row.scrollIntoView({ inline: 'nearest' });
            const mark = row.querySelector('.session-rail-logo').getBoundingClientRect(), b = row.querySelector('button').getBoundingClientRect();
            const caption = row.querySelector('.session-rail-asked'), asked = getComputedStyle(caption);
            const others = [...document.querySelectorAll('.session-rail-agents .session-rail-item:not(.active) .session-rail-asked')].map(node => getComputedStyle(node).display);
            return { whole: mark.left >= b.left && mark.right <= b.right && mark.width > 0, number: Boolean(row.querySelector('.session-rail-number')),
              caption: { overflow: asked.overflowX, ellipsis: asked.textOverflow, truncated: caption.scrollWidth > caption.clientWidth, narrow: caption.getBoundingClientRect().width <= innerWidth * 0.42 + 1 }, others: [...new Set(others)] };
          });
          assert.ok(seen.whole && !seen.number, JSON.stringify(seen));
          assert.deepEqual(seen.caption, { overflow: 'hidden', ellipsis: 'ellipsis', truncated: true, narrow: true });
          assert.deepEqual(seen.others, ['none']);
          continue;
        }
        // Resolve and measure in one page task: a locator handle can be
        // detached by a rail repaint between resolution and its evaluation.
        const seen = await page.evaluate(() => {
          const row = document.querySelector('.session-rail-agents .session-rail-item.active');
          const rail = row.closest('#session-rail'), agents = row.parentElement;
          agents.scrollLeft = 0;
          agents.scrollLeft = row.getBoundingClientRect().left - agents.getBoundingClientRect().left;
          const number = row.querySelector('.session-rail-number'), identity = number.parentElement, caption = row.querySelector('.session-rail-asked'), button = row.querySelector('button');
          const range = document.createRange(); range.selectNodeContents(number);
          const ink = range.getBoundingClientRect(), n = number.getBoundingClientRect(), b = button.getBoundingClientRect(), r = rail.getBoundingClientRect();
          const clippedBy = [];
          for (let node = number; node && node !== rail.parentElement; node = node.parentElement) {
            const c = getComputedStyle(node), rect = node.getBoundingClientRect();
            if (c.overflowX !== 'visible' && (ink.left < rect.left - .5 || ink.right > rect.right + .5)) clippedBy.push(node.className);
          }
          const clean = [number, identity, number.closest('.session-rail-line'), caption].every(node => {
            const c = getComputedStyle(node);
            return c.backgroundColor === 'rgba(0, 0, 0, 0)' && c.backgroundImage === 'none' && c.boxShadow === 'none' && c.textShadow === 'none';
          });
          const c = getComputedStyle(button), asked = getComputedStyle(caption);
          return { numeral: number.textContent, clippedBy, clean, contained: ink.left >= n.left - .5 && ink.right <= n.right + .5 && ink.left > b.left && ink.right < b.right && ink.left >= r.left, identityFits: identity.clientWidth >= number.offsetWidth, shrink: getComputedStyle(number).flexShrink, left: b.left - r.left, borders: [c.borderTopWidth, c.borderLeftWidth, c.borderRightWidth, c.borderBottomWidth], caption: { display: asked.display, overflow: asked.overflowX, ellipsis: asked.textOverflow, truncated: caption.scrollWidth > caption.clientWidth } };
        });
        assert.deepEqual(seen.clippedBy, [], JSON.stringify(seen));
        assert.ok(seen.clean && seen.contained && seen.identityFits, JSON.stringify(seen));
        assert.equal(seen.shrink, '0');
        assert.ok(Math.abs(seen.left) < 1, 'selected tab may sit flush left without clipping its numeral');
        assert.deepEqual(seen.borders, ['1px', '1px', '1px', '0px']);
        assert.equal(seen.caption.overflow, 'hidden'); assert.equal(seen.caption.ellipsis, 'ellipsis'); assert.ok(seen.caption.truncated);
        if (process.env.TAB_TEXT_SHOTS) {
          await mkdir(process.env.TAB_TEXT_SHOTS, { recursive: true });
          await page.locator('#session-rail').screenshot({ path: `${process.env.TAB_TEXT_SHOTS}/${theme}-${width}-${seen.numeral}.png` });
        }
      }
    } finally {
      await browser.close(); for (const socket of sockets.clients) socket.terminate();
      await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
    }
  });
}
