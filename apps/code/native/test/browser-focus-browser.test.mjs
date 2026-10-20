import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FAKE_DESK, harnessFixture } from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { LAYOUT_CHOICE } from '../public/js/layout-choice.js';

const messages = [{ role: 'user', content: 'One computer, many forms.' }, { role: 'assistant', content: 'The same sessions, conversation and Files, in a browser too.' }];
const index = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8')).replace(/<script[^>]*src="\/js\/site.js"[^>]*><\/script>/, '');
const machines = [{ id: 'hosted', name: 'Computer', self: true, home: true, reachable: true, capabilities: ['code', 'files'] }];
const box = (page, selector) => page.locator(selector).first().boundingBox();
const request = async (req, res, path) => {
  if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(index); return true; }
  if (path === '/files/list') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: '/home/noah', entries: ['Downloads', 'projects', 'workbench'].map(name => ({ name, path: `/home/noah/${name}`, dir: true, size: 0, mtime: 1 })) }));
    return true;
  }
  return false;
};
for (const [width, height] of [[1280, 700], [1440, 900], [390, 844]]) for (const mode of ['dark', 'light']) {
  test(`browser focus ${width}×${height} ${mode}: shared frame, Files, draft, panel fullscreen`, { timeout: 90000 }, async () => {
    const phone = width === 390;
    const theme = JSON.parse(await readFile(new URL(`../themes/mac-${mode}.json`, import.meta.url), 'utf8'));
    const f = await harnessFixture({ messages, machines, viewport: { width, height }, hasTouch: phone, themeCSS: themeCss(theme), handleRequest: request });
    const p = f.page;
    try {
      await p.locator('.workbench-item').first().waitFor();
      assert.equal(await p.evaluate(() => Boolean(globalThis.imperfectDesk)), false);
      assert.equal(await p.locator('#entry-terminal.focus-layout').count(), phone ? 0 : 1);
      const middle = await box(p, '.entry-screen'), composer = await box(p, '#entry-input-zone');
      assert.ok(composer.x >= middle.x && composer.x + composer.width <= middle.x + middle.width + 1, 'composer stays inside conversation');
      assert.ok(composer.y + composer.height <= height, 'composer reachable');
      if (!phone) {
        const rail = await box(p, '#session-rail'), files = await box(p, '.wm-files');
        assert.ok(rail.width > 200 && middle.x >= rail.width - 1, 'sessions down the left');
        assert.ok(files.x >= middle.x + middle.width - 1 && files.x + files.width <= width, 'Files floats beside the conversation');
        assert.ok(files.height > 400 && files.y >= 0 && files.y + files.height <= height, 'Files fits even in the website Mac window');
      }
      await p.locator('#entry-input').fill('A draft to keep');
      if (process.env.IMPERFECT_TEST_STILLS) {
        await mkdir(process.env.IMPERFECT_TEST_STILLS, { recursive: true });
        await p.screenshot({ path: join(process.env.IMPERFECT_TEST_STILLS, `${width}x${height}-${mode}.png`), caret: 'hide' });
      }
      if (!phone) {
        await p.locator('#session-rail .session-rail-open', { hasText: 'New page' }).click();
        await p.locator('.wm-browser').waitFor();
        assert.equal(await p.locator('webview').count(), 0, 'no native webview required');
        await p.locator('#session-rail .session-rail-open', { hasText: 'Home' }).click();
        assert.equal(await p.locator('.wm-browser.wm-tucked').count(), 1);
        assert.equal(await p.locator('#entry-input').inputValue(), 'A draft to keep');
        await p.locator('.wm-files').click({ position: { x: 25, y: 100 } });
        await p.keyboard.press('Alt+f');
        assert.equal(await p.locator('#entry-terminal.focus-full-panel').count(), 1, 'web-only fullscreen, no shell call');
        await p.keyboard.press('Escape');
        assert.equal(await p.locator('#entry-terminal.focus-full-panel').count(), 0);
      } else {
        await p.locator('#canvas-strip').evaluate(s => s.scrollTo({ left: s.clientWidth, behavior: 'instant' }));
        await p.waitForTimeout(150);
        if (process.env.IMPERFECT_TEST_STILLS) await p.screenshot({ path: join(process.env.IMPERFECT_TEST_STILLS, `${width}x${height}-${mode}-files.png`), caret: 'hide' });
        assert.equal(await p.locator('.workbench-item').count(), 3);
        await p.locator('.wm-files').click({ position: { x: 25, y: 200 } });
        await p.keyboard.press('Alt+Shift+f');
        assert.equal(await p.locator('.wm-full-window').count(), 1, 'phone full-window chord is unchanged');
        await p.keyboard.press('Escape');
        assert.equal(await p.locator('.wm-full-window').count(), 0);
        assert.equal(await p.locator('#entry-input').inputValue(), 'A draft to keep');
      }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}

for (const desk of [false, true]) test(`${desk ? 'native' : 'browser'} old choices and reloads return to focus once; new choices persist`, async () => {
  for (const layout of ['scrolling', 'dwindle']) {
    const f = await harnessFixture({ messages, desk, legacyLayout: layout });
    try {
      const p = f.page;
      assert.equal(await p.locator('#entry-terminal.focus-layout').count(), 1);
      await p.keyboard.press('Alt+l');
      if (layout === 'dwindle') await p.keyboard.press('Alt+l');
      assert.equal(await p.evaluate(key => localStorage.getItem(key), LAYOUT_CHOICE), layout);
      assert.equal(await p.evaluate(() => localStorage.getItem('imperfect.layout-choice')), layout, 'old choice is left alone');
      await p.evaluate(() => harness.prepareSurfaceReload());
      const view = await p.evaluate(() => JSON.parse(sessionStorage.getItem('imperfect.surface-code-view')));
      assert.equal(view.layout, layout);
      assert.equal(view.oneLayout, LAYOUT_CHOICE);
      await p.reload();
      if (desk) await p.evaluate(FAKE_DESK);
      await p.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi(); });
      await p.locator('#entry-output .gui-assistant').waitFor();
      assert.equal(await p.locator('#entry-terminal.focus-layout').count(), 0);
      assert.equal(await p.locator('.wm-dwindle').count(), layout === 'dwindle' ? 1 : 0);
      if (desk) {
        // The current-version reload fallback also works without a stored choice.
        await p.evaluate(key => { harness.prepareSurfaceReload(); localStorage.removeItem(key); }, LAYOUT_CHOICE);
        await p.reload();
        await p.evaluate(FAKE_DESK);
        await p.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi(); });
        await p.locator('#entry-output .gui-assistant').waitFor();
        assert.equal(await p.locator('#entry-terminal.focus-layout').count(), 0);
        assert.equal(await p.locator('.wm-dwindle').count(), layout === 'dwindle' ? 1 : 0);
      }
      await p.keyboard.press('Alt+l');
      if (layout === 'scrolling') await p.keyboard.press('Alt+l');
      assert.equal(await p.locator('#entry-terminal.focus-layout').count(), 1, 'chord still cycles back to focus');
      assert.equal(await p.evaluate(key => localStorage.getItem(key), LAYOUT_CHOICE), 'focus');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

test('a cross-origin iframe at the website window size gets the same focus layout', async () => {
  const f = await harnessFixture({ messages, machines, handleRequest: request });
  try {
    const p = f.page, src = p.url();
    await p.route('https://website.invalid/', route => route.fulfill({ contentType: 'text/html', body: `<iframe src="${src}" style="width:1280px;height:700px;border:0"></iframe>` }));
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.goto('https://website.invalid/');
    const frame = p.frames().find(frame => frame !== p.mainFrame());
    await frame.waitForLoadState();
    await frame.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi(); });
    await frame.locator('.workbench-item').first().waitFor();
    assert.equal(await frame.locator('#entry-terminal.focus-layout').count(), 1);
    assert.deepEqual(await frame.evaluate(() => [innerWidth, innerHeight]), [1280, 700]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
