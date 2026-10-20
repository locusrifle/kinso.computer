import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../../../../tools/test-browser.mjs';

test('the native macOS lock uses the shared font fallback and count-only circular password dots', async () => {
  const evidence = process.env.LOCK_FONT_EVIDENCE;
  if (evidence) await mkdir(evidence, { recursive: true });
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--allow-file-access-from-files', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { window.__lockClock = 100; window.__lockWall = 1760083230; });
    const path = fileURLToPath(new URL('../../../../desktop/lock/index.html', import.meta.url));
    await page.goto(`file://${path}?world=dragon&bg=000000&ink=ffffff&epoch=1760083200.123`);
    await page.waitForFunction(() => (window.__lockSaid || []).includes('ready') || window.__lockError, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__lockError ?? null), null);
    const look = await page.evaluate(async () => {
      // The keeper passes only a count, never the password; show a synthetic count for glyph evidence.
      window.lock.key(5);
      for (let i = 0; i < 120 && window.__lock().phase !== 'box'; i++) {
        window.__lockClock += 0.25; window.__lockWall += 0.25;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      if (window.__lock().phase !== 'box') throw new Error('native password phase did not arrive');
      await document.fonts.load('400 24px Outfit');
      await document.fonts.ready;
      const style = getComputedStyle(document.querySelector('.macos-name'));
      const dot = getComputedStyle(document.querySelector('#dots i'));
      return { family: style.fontFamily, loaded: document.fonts.check('400 24px Outfit'), count: document.querySelectorAll('#dots i').length,
        dot: { width: dot.width, height: dot.height, radius: dot.borderRadius }, inputs: document.querySelectorAll('input,textarea').length };
    });
    assert.match(look.family, /-apple-system.*BlinkMacSystemFont.*Outfit.*system-ui/);
    assert.equal(look.loaded, true); assert.equal(look.count, 5); assert.equal(look.inputs, 0);
    assert.deepEqual(look.dot, { width: '5px', height: '5px', radius: '50%' });
    if (evidence) {
      await writeFile(`${evidence}/font.json`, JSON.stringify({ look }, null, 2));
      await page.screenshot({ path: `${evidence}/native-lock-outfit.png` });
    }
  } finally { await browser.close(); }
});
