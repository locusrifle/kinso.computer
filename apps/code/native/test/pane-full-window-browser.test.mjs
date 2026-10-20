import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { themeCss } from '../../../../system/theme.mjs';
import { harnessFixture, FAKE_DESK } from './fixtures/harness-page.mjs';

const black = themeCss(JSON.parse(await readFile(new URL('./fixtures/themes/black.json', import.meta.url), 'utf8')));
const machines = [{ id: 'laptop', self: true, reachable: true }, { id: 'pc', home: true, reachable: true }];
const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }];
const geometry = p => p.evaluate(() => ({ left: document.querySelector('.canvas-strip').scrollLeft, panes: [...document.querySelectorAll('.canvas-strip > .wm-window')].sort((a, b) => a.style.order - b.style.order).map(n => [n.classList.contains('wm-files') ? 'files' : n.classList.contains('wm-browser') ? 'browser' : n.classList.contains('wm-live') ? 'live' : 'conversation', n.style.cssText]) }));

for (const kind of ['files', 'browser', 'live']) test(`Super+Shift+F fills the whole window with ${kind}, Escape/key restores panes and draft`, async () => {
  const paths = [], commands = [];
  // Super+Shift+F is the scrolling and dwindle layouts' (focus has Super+F alone).
  const f = await harnessFixture({ desk: true, layout: 'scrolling', machines, messages, themeCSS: black, handleRequest: async (req, res, path) => {
    if (!path.endsWith('/files/list')) return false;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: '/home/person', entries: [] }));
    return true;
  }, onBrowserLive(ws, req) {
    paths.push(req.url);
    ws.on('message', raw => {
      const command = JSON.parse(raw); commands.push(command);
      if (command.do === 'watch' || command.do === 'launch') ws.send(JSON.stringify({ tabs: [{ tab: 42, front: true, url: 'https://example.com/' }] }));
    });
  } });
  try {
    const p = f.page;
    p.setDefaultTimeout(5000);
    await p.evaluate(() => { for (const style of document.querySelectorAll('style')) if (style.textContent.includes('height:650px')) style.remove(); });
    await p.waitForTimeout(450);
    await p.locator('#entry-input').fill('unchanged laptop draft');
    const selector = `.wm-${kind}`;
    if (kind === 'browser') await p.keyboard.press('Meta+Shift+B');
    if (kind === 'live') {
      // Agent activity cannot silently open a remote stream on a desktop.
      f.send({ type: 'browse', machine: 'pc' });
      await p.waitForTimeout(100);
      assert.equal(await p.locator('.wm-live').count(), 0);
      await p.getByRole('button', { name: 'Open PC browser (Chromium)', exact: true }).click();
      await p.locator('.wm-live .browser-tab').waitFor();
      assert.deepEqual(paths, ['/peer/pc/browser/live']);
      assert.equal(await p.locator('webview').count(), 0, 'dock never creates a local browser');
      assert.ok(commands.some(c => c.do === 'launch'));
      f.send({ type: 'browse', machine: 'laptop' });
      await p.waitForTimeout(50);
      assert.deepEqual(paths, ['/peer/pc/browser/live']);
    }
    const target = p.locator(kind === 'files' ? '.wm-files .workbench' : `${selector} .gui-window-address`);
    await target.focus();
    await p.waitForTimeout(100);
    const before = await geometry(p);
    await p.keyboard.press('Meta+Shift+F');
    await p.waitForTimeout(450);
    const rect = await p.locator(selector).boundingBox();
    assert.deepEqual(rect, { x: 0, y: 0, width: 1200, height: 900 });
    assert.equal(await p.locator('#entry-input-zone').evaluate(n => getComputedStyle(n).visibility), 'hidden');
    assert.equal(await target.isVisible(), true, 'pane keeps its own heading');
    if (kind === 'browser') {
      const guest = await p.locator('webview').boundingBox();
      assert.equal(guest.y + guest.height, 900, 'native webview bounds reach past the composer to the bottom');
    }
    // A canvas menu owns Escape before full-window restoration.
    await p.evaluate(() => { const menu = document.createElement('div'); menu.id = 'held-menu'; menu.setAttribute('role', 'menu'); document.body.append(menu); });
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('.wm-full-window').count(), 1);
    await p.evaluate(() => document.querySelector('#held-menu').remove());
    if (process.env.PANE_PREVIEW_DIR) {
      await mkdir(process.env.PANE_PREVIEW_DIR, { recursive: true });
      await p.screenshot({ path: `${process.env.PANE_PREVIEW_DIR}/${kind}-full-window.png` });
    }
    if (kind === 'browser') await p.evaluate(() => keyFromWindow('restoreFullWindow'));
    else await p.keyboard.press('Escape');
    await p.waitForTimeout(150);
    assert.deepEqual(await geometry(p), before);
    assert.equal(await target.evaluate(n => n === document.activeElement), true);
    assert.equal(await p.locator('#entry-input').inputValue(), 'unchanged laptop draft');
    await p.keyboard.press('Alt+Shift+F');
    await p.waitForTimeout(80);
    await p.keyboard.press('Alt+Shift+F');
    await p.waitForTimeout(150);
    assert.deepEqual(await geometry(p), before);
    assert.equal(await p.locator('#entry-input').inputValue(), 'unchanged laptop draft');
    // Entering from the older middle-only full mode restores that mode too.
    await p.keyboard.press('Meta+F');
    await p.keyboard.press('Meta+Shift+F');
    await p.waitForTimeout(80);
    await p.keyboard.press('Escape');
    assert.equal(await p.locator(`${selector}.wm-full`).count(), 1);
    assert.equal(await p.locator('.wm-full-window').count(), 0);
    await p.keyboard.press('Meta+F');
    await p.waitForTimeout(150);
    assert.deepEqual(await geometry(p), before);
    if (kind === 'live') {
      await p.locator('#entry-input').focus();
      await p.keyboard.press('Meta+Shift+B');
      assert.equal(await p.locator('webview').count(), 1, 'local shortcut still local with the portal already open');
      assert.equal(await p.locator('.wm-live').count(), 1, 'shared remote pane retained');
      await p.locator('.wm-browser .gui-window-address').fill('example.com');
      await p.locator('.wm-browser .gui-window-address').press('Enter');
      await p.evaluate(() => harness.prepareSurfaceReload());
      await p.reload();
      await p.evaluate(FAKE_DESK);
      await p.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
      await p.locator('.wm-live').waitFor({ state: 'attached' });
      await p.getByRole('button', { name: 'Open PC browser (Chromium)', exact: true }).click();
      await p.locator('.wm-live .browser-tab').waitFor({ state: 'attached' });
      assert.equal(await p.locator('webview').count(), 1, 'local tab and portal independently restored');
      assert.ok(paths.every(path => path === '/peer/pc/browser/live'), 'restored portal still targets home, never laptop');
      assert.equal(await p.locator('#entry-input').inputValue(), 'unchanged laptop draft');
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
