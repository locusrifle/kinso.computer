import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { serve, fixture } from '../../tools/gui-preview.mjs';

for (const theme of ['Black', 'Chalk']) for (const width of [320, 390, 640, 1280]) {
  test(`${theme} ${width}: trailing session actions and full-height readable preview`, async () => {
    const css = theme === 'Chalk' ? ':root { --pi-bg: #fff; --pi-text: #222; --pi-text-bright: #000; }' : '';
    const { server, sockets, port } = await serve(css);
    const calls = [];
    sockets.on('connection', socket => socket.on('message', raw => calls.push(JSON.parse(raw))));
    const browser = await launchChromium({ args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width < 640, isMobile: width < 640 });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/?face=code`);
      await page.locator('#entry-output.gui-transcript').waitFor();
      // A draft keeps fixture-added tabs from invoking the intentional
      // follow-new-session behavior (the read-only server cannot focus them).
      await page.locator('#entry-input').fill('retain this draft');
      for (const count of [1, 3, 6, 0]) {
        const snapshot = fixture();
        snapshot.tabs = Array.from({ length: count }, (_, i) => ({ ...snapshot.tabs[0], id: i === 0 ? 'mirror' : `long-${i}`, sessionId: i === 0 ? 'mirror' : `long-${i}`, focused: i === 0, prompt: `Session ${i}: ${'Read these detailed instructions and compare every relevant part of the project. '.repeat(9)}` }));
        for (const socket of sockets.clients) socket.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
        await page.waitForFunction(n => document.querySelectorAll('.session-rail-item[data-tab-id]').length === n, count);
        const geometry = await page.evaluate(() => {
          const rail = document.querySelector('#session-rail'), actions = rail.querySelector('.session-rail-heading');
          const r = rail.getBoundingClientRect(), a = actions.getBoundingClientRect();
          const plus = actions.querySelector('.session-rail-open'), p = plus.getBoundingClientRect();
          const tab = rail.querySelector('.session-rail-item[data-tab-id] .session-rail-open')?.getBoundingClientRect();
          return { inside: p.left >= r.left && a.right <= r.right + 1, reachable: plus.contains(document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2)), width: p.width, height: p.height, bottom: p.bottom, tab: tab && { height: tab.height, bottom: tab.bottom }, overflow: document.documentElement.scrollWidth > innerWidth, railScroll: rail.scrollWidth > rail.clientWidth + 1 };
        });
        assert.ok(geometry.inside && geometry.reachable && !geometry.overflow && !geometry.railScroll, JSON.stringify(geometry));
        // As wide as a thumb, and as tall as the tabs it sits level with
        // (a thumb's height on a touch screen).
        assert.ok(geometry.width >= 44 && geometry.height >= (width < 640 ? 44 : 38), JSON.stringify(geometry));
        if (geometry.tab) assert.ok(Math.abs(geometry.tab.height - geometry.height) < 0.5 && Math.abs(geometry.tab.bottom - geometry.bottom) < 0.5, JSON.stringify(geometry));
        assert.equal(await page.getByRole('button', { name: 'new session', exact: true }).count(), 1);
        if (count === 6) {
          const historyBefore = calls.filter(c => c.type === 'sessions').length;
          await page.getByRole('button', { name: 'show the agents', exact: true }).click();
          const sheet = await page.evaluate(() => {
            const rail = document.querySelector('#session-rail'), r = rail.getBoundingClientRect(), field = document.querySelector('#entry-input-zone'), composer = field.getBoundingClientRect();
            const asked = rail.querySelector('.session-rail-asked'), a = asked.getBoundingClientRect();
            // The settled transparent band stays fixed; its opaque list scrolls.
            const list = rail.querySelector('.session-rail-list');
            return { height: r.height, bottom: r.bottom, composer: composer.top, shown: field.offsetHeight > 0, wrapped: a.height > parseFloat(getComputedStyle(asked).lineHeight) * 2, scroll: list.scrollHeight > list.clientHeight };
          });
          // A phone's list is the Mac's sidebar as a sheet over the whole
          // screen, a line a session, the field waiting under it.
          if (width < 640) assert.ok(sheet.height === 844 && !sheet.shown && !sheet.wrapped, JSON.stringify(sheet));
          else assert.ok(sheet.height > 600 && sheet.bottom <= sheet.composer + 1 && sheet.wrapped && sheet.scroll, JSON.stringify(sheet));
          const scrolled = await page.evaluate(() => {
            const rail = document.querySelector('#session-rail'), list = rail.querySelector('.session-rail-list');
            const band = rail.querySelector('.session-rail-heading'), before = band.getBoundingClientRect().top;
            list.scrollTop = list.scrollHeight;
            const l = list.getBoundingClientRect(), last = list.querySelector('.session-rail-agents .session-rail-item:last-child').getBoundingClientRect();
            const reachable = selector => {
              const button = band.querySelector(selector), b = button.getBoundingClientRect();
              return button.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2));
            };
            return { moved: list.scrollTop > 0, lastVisible: last.top >= l.top && last.bottom <= l.bottom + 1,
              fixedBand: band.getBoundingClientRect().top === before,
              plus: reachable('.session-rail-new .session-rail-open'), fold: reachable('.session-rail-fold') };
          });
          assert.ok((scrolled.moved || !sheet.scroll) && scrolled.lastVisible && scrolled.fixedBand && scrolled.plus && scrolled.fold, JSON.stringify(scrolled));
          assert.equal(calls.filter(c => c.type === 'sessions').length, historyBefore, 'expansion never fetches history');
          if (width < 640) {
            await page.locator('#session-rail .sidebar-history').click();
            for (let tries = 0; tries < 20 && calls.filter(c => c.type === 'sessions').length === historyBefore; tries++) await page.waitForTimeout(100);
          } else {
            await page.getByRole('button', { name: 'Show history', exact: true }).click();
            await page.locator('.session-rail-past').first().waitFor({ timeout: 2000 });
          }
          assert.equal(calls.filter(c => c.type === 'sessions').length, historyBefore + 1);
          await page.keyboard.press('Escape');
          await page.locator('#session-rail.collapsed').waitFor();
          assert.equal(await page.locator('#entry-input').inputValue(), 'retain this draft');
          await page.getByRole('button', { name: 'show the agents', exact: true }).click();
          await page.getByRole('button', { name: 'collapse the agents', exact: true }).click();
          await page.locator('#session-rail.collapsed').waitFor();
        }
      }
      const focusBefore = calls.filter(c => c.type === 'tab-focus').length;
      await page.getByRole('button', { name: 'new session', exact: true }).click();
      await page.locator('#entry-terminal.choosing').waitFor();
      assert.equal(calls.filter(c => c.type === 'tab-focus').length, focusBefore, 'new-session needs no prior tab selection');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close(); for (const socket of sockets.clients) socket.terminate();
      await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
    }
  });
}
