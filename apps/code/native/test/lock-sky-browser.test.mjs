import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { testTheme } from './fixtures/theme.mjs';
import { BURST } from '../../../../website/bootup.mjs';
import { WORD } from '../../../../website/wordmark.mjs';
import { goatTimes } from '../../../../website/intro/goat.mjs';
import { bubblePath } from '../../../../website/bubble.mjs';
import { serveDirectory } from '../../../../tools/serve.mjs';

// imperfect OS's lock page (desktop/lock), played in Chromium on stepped clocks, and the sky it leaves behind
// imperfect's window (arrival.js, kept-sky.js). The lock's own WebKit and imperfect's Electron are the OS's to
// prove (its VM test, and the laptop); here the choreography, and that both draw the same frame of stars.
const PAGE = fileURLToPath(new URL('../../../../desktop/lock/index.html', import.meta.url));
const VIEW = { width: 1024, height: 640 };
const EPOCH = 1760083200.123;
const launch = () => launchChromium({ headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });

async function openLock(browser, { theme = ['000000', 'ffffff'], reduced = false } = {}) {
  const page = await browser.newPage({ viewport: VIEW });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(epoch => {
    window.__lockClock = 100; window.__lockWall = epoch + 30; window.__starSubmissions = [];
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function(...args) {
      const program = this.getParameter(this.CURRENT_PROGRAM);
      const twist = program && this.getUniformLocation(program, 'uTwist');
      if (args[0] === this.POINTS && twist) {
        const opacity = this.getUniform(program, this.getUniformLocation(program, 'uOpacity'));
        window.__starSubmissions.push({ opacity, phase: window.__lock?.().phase, tau: window.__lock?.().tau });
        if (window.__omitStars) return;
      }
      return draw.apply(this, args);
    };
  }, EPOCH);
  await page.goto(`file://${PAGE}?world=dragon&bg=${theme[0]}&ink=${theme[1]}&epoch=${EPOCH.toFixed(3)}`);
  await page.waitForFunction(() => (window.__lockSaid || []).includes('ready') || window.__lockError, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__lockError ?? null), null);
  // both clocks a frame at a time, as a screen would
  const step = (seconds, dt = 1 / 30) => page.evaluate(async ({ seconds, dt }) => {
    for (let s = 0; s < seconds - 1e-9; s += dt) { window.__lockClock += dt; window.__lockWall += dt; await new Promise(r => requestAnimationFrame(r)); }
  }, { seconds, dt });
  const state = () => page.evaluate(() => ({ ...window.__lock(), clock: window.__lockClock, wall: window.__lockWall }));
  const until = async (what, most = 16) => { for (let s = 0; s < most; s += 1 / 30) { const st = await state(); if (what(st)) return st; await step(1 / 30); } throw new Error('never: ' + JSON.stringify(await state())); };
  return { page, errors, step, state, until };
}

test('the actual website and native lock adapters run identical centred boot frames', async () => {
  const server = await serveDirectory(new URL('../../../../', import.meta.url).pathname), browser = await launch();
  try {
    const lock = await openLock(browser), site = await browser.newPage({ viewport: VIEW });
    await site.addInitScript(epoch => {
      window.__introClock = 100; window.__introWall = epoch + 30; Date.now = () => epoch * 1000;
    }, EPOCH);
    await site.route('**/unlock', route => route.fulfill({ json: { ok: true, workbench: { id: 'test', url: 'https://test.noah.imperfect.computer/' } } }));
    await site.goto(server.origin + '/website/index.html');
    await site.waitForFunction(() => window.__launch?.().phase === 'intro' && window.__launch().intro.started, null, { timeout: 60000 });
    await lock.page.evaluate(() => window.lock.key(1));
    await site.evaluate(async () => { (await import('/website/intro/intro.mjs?v=kinso-1')).intro.approach(); });
    const stepSite = seconds => site.evaluate(async seconds => {
      window.__introClock += seconds; window.__introWall += seconds;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, seconds);
    for (let i = 0; i < 100 && (await lock.state()).phase === 'scene'; i++) {
      await lock.step(1 / 30); await stepSite(1 / 30);
    }
    assert.deepEqual((await lock.state()).contact, [VIEW.width / 2, VIEW.height / 2], 'native touch is centred');
    const project = s => Object.fromEntries(['tau', 'bubble', 'wordmark', 'goat', 'mark', 'source', 'lens', 'starOpacity', 'contact', 'world'].map(k => [k, s[k]]));
    let last = 0;
    for (const tau of [.65, 1.19, 3, BURST + .1, WORD.out + .3, WORD.gone + .2, goatTimes().gone - .1]) {
      const dt = tau - last; await lock.step(dt, dt); await stepSite(dt); last = tau;
      const native = await lock.state(), publicState = await site.evaluate(() => window.__launch().intro);
      assert.deepEqual(project(native), project(publicState), `identical shared frame at ${tau} s`);
      if (tau === 1.19) {
        const portrait = { width: 390, height: 844 };
        await Promise.all([lock.page.setViewportSize(portrait), site.setViewportSize(portrait)]);
        await new Promise(r => setTimeout(r, 200));
        const turned = await lock.state(), publicTurned = await site.evaluate(() => window.__launch().intro);
        assert.deepEqual(turned.contact, [195, 422], 'the native touch stays centred after resize');
        assert.equal(turned.lens, null, 'the wallpaper has no star lens');
        assert.deepEqual(project(turned), project(publicTurned), 'the resized hosts still draw the same boot');
      }
    }
    assert.deepEqual(lock.errors, []);
  } finally { await browser.close(); await new Promise(r => server.server.close(r)); }
});

test('the same wheel gesture moves the full-screen lock and shorter website equally; resize keeps that speed', async () => {
  const server = await serveDirectory(new URL('../../../../', import.meta.url).pathname), browser = await launch();
  try {
    const lock = await openLock(browser), site = await browser.newPage({ viewport: { width: 1024, height: 390 } });
    await site.addInitScript(() => { window.__introClock = 100; window.__introWall = 1760083230; });
    await site.route('**/unlock', route => route.fulfill({ json: { ok: true, workbench: { id: 'test', url: 'https://test.noah.imperfect.computer/' } } }));
    await site.goto(server.origin + '/website/index.html');
    await site.waitForFunction(() => window.__launch?.().phase === 'intro' && window.__launch().intro.started, null, { timeout: 60000 });
    for (const page of [lock.page, site]) await page.evaluate(() => Object.defineProperty(screen, 'height', { configurable: true, value: 640 }));
    const gesture = async () => {
      for (const deltaY of [120, 60, -24]) for (const page of [lock.page, site]) await page.evaluate(deltaY => {
        dispatchEvent(new WheelEvent('wheel', { deltaY, cancelable: true }));
      }, deltaY);
      const native = (await lock.state()).scrolled, publicProgress = await site.evaluate(() => window.__launch().intro.scrolled);
      assert.ok(native > 0); assert.ok(Math.abs(native - publicProgress) < 1e-10, `${native} != ${publicProgress}`);
      return native;
    };
    const first = await gesture();
    await site.setViewportSize({ width: 1024, height: 520 });
    await site.waitForTimeout(200);
    assert.equal(await site.evaluate(() => window.__launch().intro.scrolled), first, 'resize does not move them');
    assert.ok(Math.abs(await gesture() - first * 2) < 1e-10, 'next gesture has exactly the same speed');
    if (process.env.SCROLL_PARITY_EVIDENCE) {
      const dir = process.env.SCROLL_PARITY_EVIDENCE;
      await mkdir(dir, { recursive: true });
      for (const page of [lock.page, site]) await page.evaluate(async () => {
        // Stop release momentum, then settle the picture on both stepped clocks.
        dispatchEvent(new TouchEvent('touchstart', { touches: [] }));
        for (let i = 0; i < 20; i++) {
          if (window.__lockClock !== undefined) window.__lockClock += .05;
          if (window.__introClock !== undefined) window.__introClock += .05;
          await new Promise(r => requestAnimationFrame(r));
        }
      });
      await lock.page.screenshot({ path: `${dir}/lock-640.png` });
      await site.screenshot({ path: `${dir}/website-520.png` });
      await writeFile(`${dir}/state.json`, JSON.stringify({ first, lock: await lock.state(), website: await site.evaluate(() => window.__launch().intro) }, null, 2));
    }
    assert.deepEqual(lock.errors, []);
  } finally { await browser.close(); await new Promise(r => server.server.close(r)); }
});

test('an autoplay-enabled host plays the lock sound with no page key or pointer gesture', async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: VIEW });
    await page.goto(`file://${PAGE}?world=dragon`);
    // Playwright evaluate() deliberately grants user activation. The real native
    // bridge does not: use CDP with userGesture:false for both calls and inspection.
    const cdp = await page.context().newCDPSession(page);
    const read = async expression => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, userGesture: false })).result.value;
    const until = async expression => {
      const end = Date.now() + 60000;
      while (Date.now() < end) { if (await read(expression)) return; await new Promise(r => setTimeout(r, 30)); }
      throw new Error('Autoplay probe timed out: ' + expression);
    };
    await until("window.__lockSaid?.includes('ready')");
    await read('window.lock.nudge(100)');
    await until('window.__lock().audible');
    assert.equal(await read('navigator.userActivation.hasBeenActive'), false);
    assert.equal(await read('window.__lock().phase'), 'bubble');
  } finally { await browser.close(); }
});

test('native counts, wrong PAM result and idle stay count-only; idle cleanly resets the same boot', async () => {
  const browser = await launch();
  try {
    const lock = await openLock(browser, { reduced: true });
    await lock.page.evaluate(() => window.lock.key(4));
    await lock.until(s => s.phase === 'bubble');
    await lock.step(WORD.gone + .1, WORD.gone + .1);
    assert.equal((await lock.state()).phase, 'box'); assert.equal((await lock.state()).dots, 4);
    await lock.page.evaluate(() => { window.lock.check(); window.lock.answer(false); });
    await lock.step(.4, .4);
    assert.equal((await lock.state()).dots, 0); assert.equal((await lock.state()).yes, false);
    await lock.page.evaluate(() => window.lock.check());
    await lock.step(61, 61); assert.equal((await lock.state()).phase, 'box', 'no idle during PAM check');
    await lock.page.evaluate(() => window.lock.answer(false));
    await lock.step(61, 61);
    const idle = await lock.state();
    assert.equal(idle.phase, 'scene'); assert.equal(idle.touched, null); assert.equal(idle.box, false);
    assert.ok(idle.said.includes('idle') && !idle.said.includes('done'));
    await lock.page.evaluate(() => window.lock.key(1));
    await lock.until(s => s.phase === 'bubble');
    assert.deepEqual(lock.errors, []);
  } finally { await browser.close(); }
});

test('the lock: wallpaper in the same bubble, the wordmark, then the bottom user and clock', async () => {
  const browser = await launch();
  try {
    const lock = await openLock(browser);
    const { page } = lock;
    await page.evaluate(() => window.lock.key(1));
    const touch = await lock.until(s => s.phase === 'bubble');
    // the page says when, to the ms, on the wall clock imperfect reads
    const said = touch.said.find(m => m.startsWith('touch:'));
    assert.ok(said, JSON.stringify(touch.said));
    assert.ok(Math.abs(Number(said.slice(6)) / 1000 - touch.touched) < 1e-9 && Math.abs(touch.touched - touch.wall) < 0.05);
    // The same sound-driven wallpaper portal as the website.
    await lock.step(0.65);
    const born = await page.evaluate(() => ({ ...window.__lock().bubble, lights: document.querySelectorAll('#spark, #glow').length }));
    assert.equal(born.lights, 1);
    assert.ok(born.glow > 0);
    assert.ok(born.R > 10, JSON.stringify(born));
    const preBurst = await page.screenshot();
    await page.evaluate(() => { window.__omitStars = true; });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const withoutGalaxy = await page.screenshot();
    const early = await diff(preBurst, withoutGalaxy, await page.evaluate(() => window.__lock().bubble));
    assert.equal(early.differ, 0, 'the wallpaper bubble has no stars');
    assert.equal(early.outside, 0, JSON.stringify(early));
    await page.evaluate(() => { window.__omitStars = false; });
    const submitted = await page.evaluate(() => window.__starSubmissions);
    assert.equal(submitted.length, 0, 'no hidden star submissions while the wallpaper is opaque');
    assert.ok(submitted.every(s => !(s.opacity > 0)), JSON.stringify(submitted));
    // it bubbles: its radius swells and shrinks, never yet opening, and nothing of the world is in yet
    const radii = [];
    for (let k = 0; k < 18; k++) { await lock.step(1 / 30); const s = await lock.state(); if (s.phase !== 'bubble') break; radii.push(s.bubble.R); assert.deepEqual(s.entrances, []); }
    assert.ok(radii.some((r, i) => i && r < radii[i - 1]) && radii.some((r, i) => i && r > radii[i - 1]), String(radii));
    assert.ok(Math.max(...radii) < VIEW.height / 2);
    // It opens on Noah's mark onto the wallpaper.
    const pop = await lock.until(s => s.phase === 'opening');
    assert.ok(Math.abs(pop.pop - BURST) < 1 / 30 + 1e-6, String(pop.pop)); // on Noah's mark
    assert.deepEqual(pop.entrances, []);
    for (let s = 0; s <= 1.2; s += 1 / 30) { assert.deepEqual((await lock.state()).entrances, []); await lock.step(1 / 30); }
    // the word alone at the very centre, whole, drawn (so no words), and no field until it has gone
    const word = () => page.evaluate(() => { const w = document.getElementById('wordmark').getBoundingClientRect(); return { dx: w.left + w.width / 2 - innerWidth / 2 - 0.02658 * w.width, dy: w.top + w.height / 2 - innerHeight / 2, shown: getComputedStyle(document.getElementById('wordmark')).visibility, field: !document.getElementById('box').hidden, words: document.body.innerText.trim(), opacity: window.__lock().wordmark.opacity, phase: window.__lock().phase }; });
    await lock.until(s => s.tau >= WORD.whole + 0.5);
    const alone = await word();
    assert.ok(Math.abs(alone.dx) < 0.6 && Math.abs(alone.dy) < 0.6, JSON.stringify(alone));
    assert.deepEqual([alone.shown, alone.field, alone.words, alone.opacity, alone.phase], ['visible', false, '', 1, 'opening']);
    const fading = await lock.until(s => s.tau >= WORD.out + 0.3);
    assert.ok(fading.wordmark.opacity > 0 && fading.wordmark.opacity < 1 && fading.wordmark.blur === 0 && fading.box === false && fading.phase === 'opening', JSON.stringify(fading));
    const first = await lock.until(s => s.box !== false);
    assert.ok(first.tau >= WORD.gone && first.wordmark.opacity === 0);
    const box = await lock.until(s => s.phase === 'box' && s.box === 1);
    const field = await page.evaluate(() => {
      const r = document.getElementById('field').getBoundingClientRect();
      return { dx: r.left + r.width / 2 - innerWidth / 2, bottom: r.bottom, inputs: document.querySelectorAll('input,textarea').length,
        name: document.querySelector('.macos-name').textContent, word: getComputedStyle(document.getElementById('wordmark')).visibility };
    });
    assert.equal(field.dx, 0); assert.ok(field.bottom > VIEW.height * .8 && field.bottom < VIEW.height);
    assert.equal(field.name, 'imperfect'); assert.equal(field.inputs, 0); assert.equal(field.word, 'hidden');
    assert.ok(Math.abs(box.tau - WORD.gone) < 1 / 30 + 1e-6, String(box.tau));
    // No native done before PAM's yes; the wallpaper stays until unlock.
    assert.equal(box.yes, false); assert.ok(!box.said.includes('done'));
    // Right at once: the field goes; done still waits for burst settlement.
    await page.evaluate(() => { window.lock.key(4); window.lock.check(); window.lock.answer(true); });
    const leaving = await lock.state();
    assert.equal(leaving.phase, 'leaving');
    assert.deepEqual(leaving.entrances, []);
    for (let i = 0; i < 3; i++) {
      await lock.step(0.06);
      const fading = await lock.state();
      assert.ok(!fading.said.includes('done'), 'native handoff waits for the burst to settle');
      assert.deepEqual(fading.entrances, []);
    }
    const done = await lock.until(s => s.said.includes('done'));
    assert.ok(done.tau >= BURST + 2.0 - 1 / 60 - 1e-6, String(done.tau));
    assert.equal(done.wordmark.opacity, 0, 'the wordmark went with the field: imperfect keeps its plain ground');
    assert.deepEqual(done.entrances, []);
    assert.deepEqual(lock.errors, []);
  } finally { await browser.close(); }
});

test('a right password while the word shows still unlocks, as soon as before, without the field', async () => {
  const browser = await launch();
  try {
    const lock = await openLock(browser);
    await lock.page.evaluate(() => window.lock.key(1));
    await lock.until(s => s.phase === 'opening');
    await lock.page.evaluate(() => { window.lock.key(4); window.lock.check(); window.lock.answer(true); });
    const leaving = await lock.until(s => s.phase === 'leaving');
    assert.ok(Math.abs(leaving.pop + 0.8 - leaving.tau) < 1 / 30 + 1e-6 && leaving.box === false, JSON.stringify(leaving));
    const done = await lock.until(s => s.said.includes('done'));
    assert.ok(done.tau < WORD.gone && done.box === false && done.wordmark.opacity === 0 && !done.said.includes('box'), JSON.stringify(done));
    assert.deepEqual(lock.errors, []);
  } finally { await browser.close(); }
});

test('reduced motion: no bubble, the wordmark, then the shared macOS lock', async () => {
  const browser = await launch();
  try {
    const lock = await openLock(browser, { reduced: true });
    await lock.page.evaluate(() => window.lock.key(1));
    const word = await lock.until(st => st.tau >= BURST + 0.1, BURST + 1);
    assert.ok(word.wordmark.opacity === 1 && word.box === false, JSON.stringify(word)); // the word, still and whole, alone
    const s = await lock.until(st => st.phase === 'box' && st.box === 1, WORD.gone + 1);
    assert.ok(s.tau >= WORD.gone && s.wordmark.opacity === 0, String(s.tau));
    assert.ok(s.said.includes('touch') && !s.said.some(m => m.startsWith('touch:')), JSON.stringify(s.said));
    assert.equal(s.bubble, null); assert.equal(s.backdrop, 'wallpaper');
    assert.deepEqual(s.entrances, []);
    assert.deepEqual(lock.errors, []);
  } finally { await browser.close(); }
});

for (const theme of [['000000', 'ffffff'], ['100c0b', 'ffe7da']]) test(`the wallpaper fills the actual bubble disc, to its rim, then grows (${theme[0]})`, async () => {
  const browser = await launch();
  try {
    const lock = await openLock(browser, { theme });
    const { page } = lock;
    await page.evaluate(() => window.lock.key(1));
    await lock.until(s => s.phase === 'bubble');
    await lock.step(BURST - 1 / 60, BURST - 1 / 60); // skip the already-tested breathing interval
    await lock.step(1 / 60 + 1e-8, 1 / 60 + 1e-8); // the exact pop frame, not partway into opening
    const measure = async () => {
      const state = await lock.state();
      const stars = await page.screenshot();
      await page.evaluate(() => { document.querySelector('#sky .macos-wallpaper').style.visibility = 'hidden'; });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const none = await page.screenshot();
      await page.evaluate(() => { document.querySelector('#sky .macos-wallpaper').style.visibility = ''; });
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      return { state, pixels: await diff(stars, none, state.bubble) };
    };
    const birth = await measure();
    assert.equal(birth.state.phase, 'opening');
    assert.ok(Math.abs(birth.state.tau - BURST) < 1e-6, JSON.stringify(birth.state));
    assert.ok(birth.pixels.differ > 100 && birth.pixels.inner > 0 && birth.pixels.quadrants === 4, JSON.stringify(birth.pixels));
    // Normalize the measured radial extent by the exact shader edge at each pixel's angle.
    // One CSS pixel includes antialiasing and the rim's half-pixel inside coverage.
    assert.equal(birth.pixels.outside, 0, JSON.stringify(birth));
    await lock.step(0.1, 1 / 60);
    const later = await measure();
    assert.ok(later.pixels.radius > birth.pixels.radius + 20, JSON.stringify({ birth, later }));
    assert.equal(later.pixels.outside, 0, JSON.stringify(later));
    assert.deepEqual(lock.errors, []);
  } finally { await browser.close(); }
});

const diff = async (a, b, bubble = null) => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(async ([a, b, bubble, path]) => {
      const read = async src => { const img = new Image(); img.src = src; await img.decode(); const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
      const [A, B] = await Promise.all([read(a), read(b)]);
      let differ = 0, worst = 0, lit = 0, extent = 0, radius = 0, inner = 0, outside = 0;
      const boundary = path && new Path2D(path), ctx = new OffscreenCanvas(1024, 640).getContext('2d');
      ctx.lineWidth = 4;
      const quadrants = new Set();
      for (let i = 0; i < A.length; i += 4) {
        const d = Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2]));
        if (d) {
          differ++;
          if (bubble) {
            const x = (i / 4) % 1024 + 0.5 - bubble.at[0], y = Math.floor(i / 4 / 1024) + 0.5 - bubble.at[1];
            const th = Math.atan2(y, x), r = Math.hypot(x, y);
            // Exactly the bubble shader's harmonics, including its animated wobble, not just nominal R.
            const term = (k, a, ph, w) => a * Math.sin(k * th + ph + w * bubble.wt + 0.8 * k * Math.sin(0.23 * bubble.wt));
            const f = 1 + bubble.wob * (term(2, .08, .4, .31) + term(3, .06, 2.1, -.42) + term(4, .045, 4, .55) + term(5, .03, 1.3, -.37) + term(6, .02, 5.2, .48));
            extent = Math.max(extent, r / f); radius = Math.max(radius, r);
            const px = x + bubble.at[0], py = y + bubble.at[1];
            if (!ctx.isPointInPath(boundary, px, py) && !ctx.isPointInStroke(boundary, px, py)) outside++;
            if (r < bubble.R * .3) inner++;
            quadrants.add((x > 0 ? 1 : 0) + (y > 0 ? 2 : 0));
          }
        }
        worst = Math.max(worst, d); if (A[i] > 60) lit++;
      }
      return { pixels: A.length / 4, differ, worst, lit, same: A.length === B.length, extent, radius, inner, outside, quadrants: quadrants.size };
    }, [...[a, b].map(buf => 'data:image/png;base64,' + buf.toString('base64')), bubble,
      bubble && bubblePath(...bubble.at, Math.max(.01, bubble.R), bubble.wt, bubble.wob, bubble)]);
  } finally { await browser.close(); }
};
