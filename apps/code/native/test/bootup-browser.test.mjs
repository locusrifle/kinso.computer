import test from 'node:test';
import assert from 'node:assert/strict';
import { serveDirectory } from '../../../../tools/serve.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { BURST } from '../../../../website/bootup.mjs';
import { SHINE, WORD, FIELD_IN, wordmarkAt } from '../../../../website/wordmark.mjs';
import { goatTimes } from '../../../../website/intro/goat.mjs';
const ROOT = new URL('../../../../', import.meta.url).pathname;
const VIEW = { width: 1024, height: 640 };
const frame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const launch = () => launchChromium({ headless: true, args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'] });

// (The site's side of these checks drew the optional world page, website/world.html, which is gone: the launch page
// has its own browser suite, locker/test/launch-browser.mjs. What is left is the lock's side, held to the shared
// modules themselves.)
test('the lock keeps the burst and wordmark clock over wallpaper, then shows the macOS lock', async () => {
  const server = await serveDirectory(ROOT), browser = await launch();
  try {
    const lock = await browser.newPage({ viewport: VIEW });
    await lock.addInitScript(() => { window.__lockClock = 100; window.__lockWall = 1760083230; });
    await lock.goto(server.origin + '/desktop/lock/index.html?world=dragon&epoch=1760083200');
    await lock.waitForFunction(() => window.__lockSaid?.includes('ready'));
    await lock.evaluate(() => window.lock.nudge(100));
    for (let i = 0; i < 120; i++) { if (await lock.evaluate(() => window.__lock().phase === 'bubble')) break;
      await lock.evaluate(() => { window.__lockClock += 1 / 30; window.__lockWall += 1 / 30; }); await frame(lock); }
    const lock0 = await lock.evaluate(() => window.__lockClock);
    const at = async tau => { await lock.evaluate(({ t, tau }) => { window.__lockClock = t + tau; window.__lockWall = 1760083230 + t - 100 + tau; }, { t: lock0, tau }); await frame(lock); };
    for (const tau of [.4, .8, 1.7, 3.8, 5.25, BURST - 1 / 60, BURST + 1e-8]) {
      await at(tau);
      const b = await lock.evaluate(() => window.__lock().bubble);
      for (const k of ['R', 'wob', 'wt', 'rim', 'glow', 'glowScale', 'kick']) assert.ok(Number.isFinite(b[k]), `${tau} ${k}: ${b[k]}`);
      // the word is already there, whole, on the wallpaper the bubble is a portal onto
      if (tau < BURST) { const w = await lock.evaluate(() => window.__lock().wordmark); assert.ok(w && w.on && w.formed === 1 && w.opacity === 1, JSON.stringify(w)); }
    }
    assert.ok(Math.abs((await lock.evaluate(() => window.__lock())).pop - BURST) < 1 / 60);
    // the wordmark, there from the contact, shone on Noah's marks, held and faded: wordmark.mjs's own state, drawn
    const inked = () => { const c = document.getElementById('wordmark'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++; return n / (c.width * c.height); };
    const centre = () => { const r = document.getElementById('wordmark').getBoundingClientRect(); return [r.left + r.width / 2 - innerWidth / 2 - 0.02658 * r.width, r.top + r.height / 2 - innerHeight / 2]; };
    const field = () => +window.__lock().box || 0;
    for (const tau of [BURST + 1 / 60, BURST + 0.15, SHINE.start, (SHINE.start + SHINE.end) / 2, SHINE.end - 0.01, WORD.out - 0.05, WORD.out + 0.3, WORD.gone - 0.02, WORD.gone + 0.2, WORD.gone + FIELD_IN + 0.05, goatTimes().gone + 0.05]) {
      await at(tau);
      const x = wordmarkAt(tau);
      const y = await lock.evaluate(() => window.__lock().wordmark);
      for (const k of ['on', 'opacity', 'formed', 'blur', 'scale']) assert.ok(Math.abs(x[k] - y[k]) < 1e-6, `${tau} ${k}: ${x[k]} != ${y[k]}`);
      assert.deepEqual(!!x.shine, !!y.shine, `${tau}`); if (x.shine) assert.ok(Math.abs(x.shine.at - y.shine.at) < 1e-6);
      if (tau >= SHINE.start && tau < SHINE.end) assert.ok(y.shine && y.shine.at >= 0 && y.shine.at < 1, `${tau}: the light is on the letters`);
      // the field: none while the word shows, coming in once it has gone
      const f = await lock.evaluate(field);
      if (tau < WORD.gone) { assert.equal(f, 0, `${tau}: no field while the word shows`); assert.ok(y.opacity > 0); }
      else {
        assert.equal(y.opacity, 0, `${tau}: the word has gone`);
        assert.equal(f, 1, `${tau}: the macOS lock follows the word`);
      }
      if (tau >= WORD.whole && tau < WORD.out) {
        assert.ok(await lock.evaluate(inked) > 0.05, 'the lettering is drawn');
        assert.ok(Math.hypot(...await lock.evaluate(centre)) < 0.6, 'at the very centre');
      }
    }
    assert.equal(await lock.evaluate(field), 1);
  } finally { await browser.close(); await new Promise(r => server.server.close(r)); }
});
