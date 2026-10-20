import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launchChromium } from '../../tools/test-browser.mjs';
import { macosLaunch } from './fixtures/macos-launch.mjs';
import { visibleCursor } from './fixtures/visible-cursor.mjs';
import { BURST } from '../../website/bootup.mjs';

for (const width of [1920, 390]) test(`imperfect ${width}: its original silver lettering and visible cursor through the opener`, { timeout: 120000 }, async () => {
  const evidence = process.env.KINSO_STILLS && join(resolve(process.env.KINSO_STILLS), `imperfect-${width}`);
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  let f;
  try {
    f = await macosLaunch(browser, { viewport: { width, height: width === 390 ? 844 : 1080 } });
    if (evidence) await mkdir(evidence, { recursive: true });
    const shot = async name => {
      await visibleCursor(f.page, name);
      if (evidence) await f.page.screenshot({ path: join(evidence, `${name}.png`), caret: 'hide' });
    };
    const clock = async t => f.page.evaluate(async t => {
      window.__introClock = t;
      await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
    }, t);
    await shot('01-opener');
    await f.page.keyboard.press('ArrowDown');
    for (let i = 1; i < 80 && (await f.state()).intro.phase === 'scene'; i++) await clock(100 + i * .2);
    const contact = (await f.state()).intro.soundAt;
    await clock(contact); await shot('02-touch');
    await clock(contact + 5.7); await shot('03-silver-lettering');
    await clock(contact + 6.25); await shot('04-shine');
    await clock(contact + 7.5); await shot('05-held-lettering');
    assert.equal(await f.page.locator('body').getAttribute('data-company'), null);
    const silver = await f.page.locator('#wordmark').evaluate(el => {
      const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
      let pixels = 0, colour = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 240) {
        pixels++; if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) colour++;
      }
      return { pixels, colour };
    });
    assert.ok(silver.pixels > 1000); assert.equal(silver.colour, 0, 'imperfect stays silver');
    await clock(contact + 9); await f.step(.5); await shot('06-original-lock');
    assert.equal(await f.page.locator('.macos-name').textContent(), 'imperfect');
    assert.equal(await f.page.locator('.macos-avatar').count(), 1);
    assert.deepEqual(f.errors, []);
  } finally { await f?.close(); await browser.close(); }
});

for (const mode of ['reduced', 'png-fallback', 'svg-fallback', 'stand-in']) test(`Kinso logo: ${mode} remains whole, unlit and usable`, { timeout: 120000 }, async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  let f;
  try {
    f = await macosLaunch(browser, { viewport: { width: 390, height: 844 }, reduced: mode === 'reduced' });
    if (mode === 'svg-fallback') await f.context.route('**/kinso/logo-draw.svg*', route => route.abort());
    else if (mode !== 'reduced') await f.context.route('**/kinso/logo-draw.json*', route => route.abort());
    if (mode === 'stand-in') await f.context.route('**/kinso/a/aa106999c9d67289.png', route => route.abort());
    await f.page.goto(`${f.origin}/?for=kinso`);
    await f.page.waitForFunction(() => window.__launch?.().phase === 'intro');
    await f.page.keyboard.press('ArrowDown'); await f.step(3);
    const contact = (await f.state()).intro.soundAt;
    const clock = async t => f.page.evaluate(async t => {
      window.__introClock = t; await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
    }, t);
    await clock(contact + BURST + .01);
    const first = await f.page.locator('#wordmark').evaluate(el => ({ draw: el.dataset.draw, pixels: el.toDataURL() }));
    if (mode === 'reduced' && first.draw !== 'fallback') assert.equal(first.draw, '1', 'Reduce Motion shows complete paths immediately');
    if (mode !== 'reduced') assert.equal(first.draw, 'fallback');
    await clock(contact + 7.5);
    assert.equal(await f.page.locator('#wordmark').evaluate(el => el.toDataURL()), first.pixels, 'fallback has no light sweep');
    assert.equal((await f.state()).intro.wordmark.shine, null);
    await clock(contact + 9); await f.step(.7);
    assert.equal(await f.page.locator('.macos-avatar, .macos-name').count(), 0);
    assert.equal(await f.page.locator('#password').isVisible(), true);
    if (process.env.KINSO_STILLS) {
      const dir = join(resolve(process.env.KINSO_STILLS), mode); await mkdir(dir, { recursive: true });
      await f.page.screenshot({ path: join(dir, 'lock.png') });
    }
    assert.deepEqual(f.errors, []); assert.deepEqual(f.refusals, []);
  } finally { await f?.close(); await browser.close(); }
});
