// Isolated production harness screenshots. No live service/profile is used.
// Usage: node tools/screenshot-browser-tabs.mjs [output directory]
import assert from 'node:assert/strict';
import { launchChromium } from './test-browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { browserStripFixture, stripGeometry } from '../apps/code/native/test/fixtures/browser-strip.mjs';

const output = resolve(process.argv[2] || '../screenshots');
await mkdir(output, { recursive: true });
const manifest = [];
// One browser for the whole matrix: contexts are isolated, no launch storm.
const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
try {
for (const theme of ['light-chalk', 'black']) for (const width of [1200, 390]) {
  for (const state of ['one', 'three', 'twelve', 'agent-driven', 'start']) {
    // Most pictures contain real iframe documents. Agent state is sent via
    // the normal desk event into FAKE_DESK, not hand-painted CSS classes.
    const native = ['agent-driven', 'start'].includes(state);
    const fixture = await browserStripFixture({ width, native, theme, browser });
    const { page } = fixture;
    try {
      const count = ['one', 'start'].includes(state) ? 1 : state === 'twelve' ? 12 : 3;
      if (state === 'start') {
        await page.keyboard.press('Meta+Shift+B');
        await page.locator('.wm-browser .browser-start').waitFor();
        assert.equal(await page.locator('.wm-browser webview').getAttribute('src'), 'about:blank');
      } else for (let index = 1; index <= count; index++) await fixture.open(index, native && index > 1);
      if (native && state !== 'start') {
        // Only guest content is illustrative: the shell/strip/controls and
        // theme are production. Real native evidence is the Electron check.
        await page.locator('.wm-browser webview').first().evaluate(view => {
          view.style.background = 'var(--pi-bg)';
          view.innerHTML = '<div style="padding:32px;font:18px system-ui;color:var(--pi-text)"><h1 style="font-weight:400">Field notes</h1><p>A small useful computer.</p></div>';
        });
      } else if (!native) await fixture.tabs().first().click();
      await fixture.reveal();
      if (width === 1200) {
        // Human full-pane command: show the desktop browser at its actual
        // 1200px width, not a clipped 640px overflow column beside Files.
        await page.locator('.wm-browser .gui-window-bar').focus();
        await page.keyboard.press('Alt+f');
        await page.locator('.wm-browser.wm-full').waitFor();
      }
      if (state === 'agent-driven') {
        await page.evaluate(() => tabFromWindow({ id: 102, do: 'driving' }));
        await page.locator('.wm-browser webview').nth(1).evaluate(view => view.dispatchEvent(new Event('did-start-loading')));
        await page.locator('.wm-browser webview').nth(2).evaluate(view => view.dispatchEvent(new Event('did-stop-loading')));
      }
      await page.evaluate(() => document.fonts.ready);
      const geometry = await stripGeometry(page);
      assert.equal(geometry.bar.height, 72);
      assert.equal(new Set(geometry.items.map(item => Math.round(item.y))).size, 1);
      if (count === 12) assert.ok(geometry.overflow);
      const name = `${theme === 'light-chalk' ? 'chalk' : 'black'}-${width === 1200 ? 'desktop1200' : 'phone390'}-${state}.png`;
      await page.screenshot({ path: join(output, name), animations: 'disabled' });
      assert.deepEqual(fixture.errors, []);
      manifest.push({ file: name, theme, viewport: { width, height: 900 }, state, tabs: count, guests: state === 'start' ? 'FAKE_DESK about:blank; production chrome-only start overlay' : native ? 'FAKE_DESK, illustrative guest content; desk events drive states' : 'real iframe documents', geometry });
      console.log(name);
    } finally { await fixture.close(); }
  }
}
} finally { await browser.close(); }
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Captured ${manifest.length} screenshots in ${output}`);
