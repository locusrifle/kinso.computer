import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { serve } from '../../tools/gui-preview.mjs';

for (const width of [320, 390, 700]) test(`phone ${width}: the agents are a strip across the top, the list a sheet`, async () => {
  const { server, sockets, port } = await serve(':root { --pi-accent: #4f8cff; }');
  const calls = [];
  sockets.on('connection', socket => socket.on('message', raw => calls.push(JSON.parse(raw))));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.locator('#entry-output.gui-transcript').waitFor();
    assert.equal(await page.locator('.session-rail-mobile-tabs, .harness-native-host, .gui-mode-select').count(), 0);
    const rail = page.locator('#session-rail');
    assert.equal(await rail.isVisible(), true);
    const geometry = () => page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect();
      const rail = box('#session-rail'), screen = box('.entry-screen'), terminal = box('#entry-terminal');
      // The conversation's panel runs under the strip (which leaves with it
      // when another window is swiped in); its work starts below it.
      const work = screen.top + parseFloat(getComputedStyle(document.querySelector('.entry-screen')).paddingTop);
      return { width: rail.width, height: rail.height, full: terminal.width, top: rail.top - terminal.top, below: work >= rail.bottom - 1, screen: screen.width, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    // Folded: a strip of marks across the top of the screen, above the work.
    const strip = await geometry();
    assert.ok(strip.top === 0 && Math.abs(strip.width - strip.full) < 1, JSON.stringify(strip));
    assert.ok(strip.height === 52 && strip.below, JSON.stringify(strip));
    assert.ok(Math.abs(strip.screen - strip.full) < 1 && !strip.overflow, JSON.stringify(strip));
    for (const target of await rail.locator('.session-rail-open, .session-rail-fold').all()) {
      const { width, height } = await target.boundingBox();
      assert.ok(width >= 44 && height >= 44, `a thumb lands on ${width}x${height}`);
    }
    // Unfolded: the whole list over the work, Settings and usage at its foot.
    await page.getByRole('button', { name: 'show the agents', exact: true }).tap();
    const sheet = await geometry();
    assert.ok(Math.abs(sheet.width - sheet.full) < 1 && sheet.height > 600 && !sheet.overflow, JSON.stringify(sheet));
    // Open tabs and history share subtitle styling, but are separate groups.
    assert.deepEqual(await rail.locator('.session-rail-agents .session-rail-asked').allTextContents(), [
      'List the project files.', 'Review the changes.',
    ]);
    // History, folded until asked for, as in the Mac's sidebar.
    const past = () => rail.evaluate(node => {
      const rows = [];
      for (let row = node.querySelector('.sidebar-history')?.nextElementSibling; row?.classList.contains('sidebar-row'); row = row.nextElementSibling) rows.push(row.querySelector('.session-rail-asked').textContent);
      return rows;
    });
    assert.deepEqual(await past(), [], 'history starts folded');
    await rail.getByRole('button', { name: 'History' }).tap();
    await page.waitForFunction(() => document.querySelector('#session-rail .sidebar-history')?.nextElementSibling?.classList.contains('sidebar-row'));
    assert.deepEqual(await past(), ['Project files', 'Example task', 'Review changes']);
    assert.equal(await rail.locator('.session-rail-settings').isVisible(), true);
    await page.getByRole('button', { name: 'collapse the agents', exact: true }).tap();
    assert.equal((await geometry()).height, 52);
    assert.equal(await rail.locator('.sidebar-history').count(), 0, 'history stays out of the folded strip');
    // Choosing from the list folds it back to the strip.
    await page.getByRole('button', { name: 'show the agents', exact: true }).tap();
    await rail.locator('.session-rail-item[data-tab-id="other"] .session-rail-open').tap();
    assert.ok(calls.some(c => c.type === 'tab-focus' && c.tabId === 'other'));
    assert.equal((await geometry()).height, 52, 'the list folds once a session is chosen');
    await rail.locator('.session-rail-new .session-rail-open').tap();
    await page.locator('#entry-terminal.choosing').waitFor();
    assert.equal(calls.some(c => c.type === 'tui-render'), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});

test('phone: a session is swiped away like a notification, and the fold sits at the right', async () => {
  const { server, sockets, port } = await serve(':root { --pi-accent: #4f8cff; }');
  const calls = [];
  sockets.on('connection', socket => socket.on('message', raw => calls.push(JSON.parse(raw))));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.locator('#entry-output.gui-transcript').waitFor();
    const rail = page.locator('#session-rail');
    const fold = await rail.locator('.session-rail-fold').boundingBox();
    const plus = await rail.locator('.session-rail-new').boundingBox();
    assert.ok(fold.x > plus.x, 'folded, the fold is at the right end of the strip');
    const drag = async (row, dx, dy) => {
      await row.waitFor({ state: 'visible' });
      const box = await row.boundingBox();
      assert.ok(box, 'the swipe target has been laid out');
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(x + dx * i / 6, y + dy * i / 6);
      await page.mouse.up();
    };
    const closes = () => calls.filter(c => c.type === 'tab-close').map(c => c.tabId);
    // A short swipe springs back and closes nothing, and is not a tap.
    await drag(rail.locator('.session-rail-item[data-tab-id="other"]'), 0, -12);
    await page.waitForTimeout(250);
    assert.deepEqual(closes(), []);
    assert.equal(calls.some(c => c.type === 'tab-focus' && c.tabId === 'other'), false);
    // Up off the strip.
    await drag(rail.locator('.session-rail-item[data-tab-id="other"]'), 0, -60);
    await page.waitForTimeout(250);
    assert.deepEqual(closes(), ['other']);
    // Sideways out of the unfolded list.
    await page.getByRole('button', { name: 'show the agents', exact: true }).tap();
    const row = rail.locator('.session-rail-item[data-tab-id]').first();
    const id = await row.getAttribute('data-tab-id');
    await drag(row, 220, 0);
    await page.waitForTimeout(250);
    assert.deepEqual(closes(), ['other', id]);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
