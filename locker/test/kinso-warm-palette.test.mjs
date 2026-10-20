// Palette only: use the real lock and renderer, never installed state or inboxes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchChromium } from '../../tools/test-browser.mjs';
import { kinsoLaunch } from './fixtures/kinso-launch.mjs';

const evidence = process.env.KINSO_STILLS;
const native = new URL('../../apps/code/native/public/js/sharks.js', import.meta.url);
const site = new URL('../../website/for-kinso/sharks.mjs', import.meta.url);
test('light renderer copies stay byte-identical; dark ground and light grid are retained', async () => {
  const source = await readFile(native, 'utf8');
  assert.equal(source, await readFile(site, 'utf8'));
  assert.match(source, /light: \{\s+ground: '#fcfcfb',\s+grid: 'rgba\(40,40,30,0\.055\)'/);
  assert.match(source, /dark: \{\s+ground: '#0b0c0f',\s+grid: 'rgba\(255,255,255,0\.032\)'/);
});

for (const width of [1920, 390]) test(`pale-grid Kinso lock ${width}: opaque canvas, quiet still and unlocked wallpaper policy`, { timeout: 90000 }, async () => {
  const f = await kinsoLaunch();
  let browser, context;
  try {
    if (evidence) await mkdir(evidence, { recursive: true });
    browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
    context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1080 } });
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      return [f.origin, f.product.origin].includes(u.origin) || ['blob:', 'data:'].includes(u.protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage(), faults = [];
    page.on('pageerror', e => faults.push(e.message));
    const shot = async name => { if (evidence) await page.screenshot({ path: join(evidence, `${width}-${name}.png`), caret: 'hide' }); };
    const ground = async () => page.locator('.kinso-sharks').evaluate(c => {
      const ctx = c.getContext('2d'), counts = new Map();
      for (let y = 3; y < c.height; y += 17) for (let x = 3; x < c.width; x += 17) {
        const px = [...ctx.getImageData(x, y, 1, 1).data].join(','); counts.set(px, (counts.get(px) || 0) + 1);
      }
      return [...counts].sort((a, b) => b[1] - a[1]);
    });
    await page.goto(f.url);
    await page.waitForFunction(() => window.__launch?.().phase === 'intro');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => window.__launch().phase === 'ready', null, { timeout: 20000 });
    await page.waitForTimeout(2800);
    const colors = await ground();
    assert.equal(colors[0][0], '252,252,251,255', 'canvas itself retains the chosen pale opaque ground');
    assert.ok(colors.length > 2, 'grid/sea remain visible');
    assert.equal(await page.locator('#sky').evaluate(n => getComputedStyle(n).backgroundColor), 'rgb(252, 252, 251)');
    assert.equal(await page.locator('#sky .macos-wallpaper').evaluate(n => getComputedStyle(n).display), 'none');
    assert.equal(await page.locator('.macos-name').textContent(), 'Kinso');
    assert.equal(await page.locator('#password').isVisible(), true);
    await shot('pale-grid-lock');
    await page.locator('#password').fill('kinso'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#lockScreen').hidden && !document.querySelector('#macScreen').hidden && Number(getComputedStyle(document.querySelector('#macScreen')).opacity) === 1);
    assert.notEqual(await page.locator('.launch-wallpaper').evaluate(n => getComputedStyle(n).display), 'none', 'unlocked Mac wallpaper is not replaced');
    await shot('unlocked-wallpaper');
    await context.clearCookies(); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(f.url);
    await page.waitForFunction(() => window.__launch?.().phase === 'intro');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => window.__launch().phase === 'ready', null, { timeout: 20000 });
    await page.waitForTimeout(500);
    assert.equal((await ground())[0][0], '252,252,251,255', 'reduced-motion still paints the same pale ground');
    assert.equal(await page.evaluate(() => window.__launch().kinso.sharks.swimming), false);
    await shot('pale-grid-lock-still');
    assert.deepEqual(faults, []);
  } finally { await context?.close(); await browser?.close(); await f.close(); }
});
