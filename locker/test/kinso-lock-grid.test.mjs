import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { launchChromium } from '../../tools/test-browser.mjs';
import { kinsoLaunch } from './fixtures/kinso-launch.mjs';

const evidence = process.env.KINSO_STILLS && resolve(process.env.KINSO_STILLS);
// Review the spacing worker's exact module without editing/cherry-picking its owned source.
const rendererOverlay = process.env.KINSO_SHARKS_MODULE && resolve(process.env.KINSO_SHARKS_MODULE);
test('Kinso light grid: the colour logo stays through password wake, entering sharks and ticket unlock', { timeout: 120000 }, async () => {
  const f = await kinsoLaunch();
  let browser, context;
  const faults = [], requests = [], frames = [];
  try {
    if (evidence) await mkdir(evidence, { recursive: true });
    browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await context.route('**/*', route => {
      const u = new URL(route.request().url());
      if (rendererOverlay && u.origin === f.origin && u.pathname === '/for-kinso/sharks.mjs') return route.fulfill({ path: rendererOverlay, contentType: 'text/javascript' });
      return [f.origin, f.product.origin].includes(u.origin) || ['data:', 'blob:'].includes(u.protocol) ? route.continue() : route.abort();
    });
    // Observation only. No fixed clock, forced opacity, shark pose or synthetic application state.
    await context.addInitScript(() => {
      window.__lockFrames = []; window.__lockPixels = [];
      let sampled = -Infinity, emptyGrid = null;
      const observe = () => {
        const s = window.__launch?.(), now = performance.now();
        if (s?.kinso && s.intro?.tau >= 6.8 && s.intro.tau < 13) {
          const word = document.querySelector('#wordmark'), content = document.querySelector('.macos-lock-content');
          window.__lockFrames.push({ now, wall: performance.timeOrigin + now, tau: s.intro.tau, phase: s.phase,
            word: Number(getComputedStyle(word).opacity), user: document.querySelector('#lockScreen').hidden ? 0 : Number(getComputedStyle(content).opacity),
            swimming: s.kinso.sharks.swimming });
          const sea = document.querySelector('.kinso-sharks');
          if (!emptyGrid && sea && s.phase !== 'ready') emptyGrid = sea.getContext('2d').getImageData(0, 0, sea.width, sea.height).data;
          if (s.phase === 'ready' && now - sampled > 50) {
            sampled = now;
            const c = document.querySelector('.kinso-sharks'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let dark = 0, edgeDark = 0, changed = 0, left = c.width, right = -1, top = c.height, bottom = -1;
            for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
              const i = (y * c.width + x) * 4;
              if (emptyGrid && (d[i] !== emptyGrid[i] || d[i + 1] !== emptyGrid[i + 1] || d[i + 2] !== emptyGrid[i + 2] || d[i + 3] !== emptyGrid[i + 3])) changed++;
              if (d[i] < 210 && d[i + 1] < 210 && d[i + 2] < 210 && d[i + 3] > 0) {
                dark++; if (x === 0 || y === 0 || x === c.width - 1 || y === c.height - 1) edgeDark++;
                left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
              }
            }
            window.__lockPixels.push({ now, tau: s.intro.tau, dark, edgeDark, changed, box: dark ? { left, right, top, bottom } : null });
          }
        }
        requestAnimationFrame(() => setTimeout(observe, 0));
      };
      // Read after all frame callbacks (including mountLock.render), not before the
      // lock's callback with its preceding-frame opacity on a busy test machine.
      requestAnimationFrame(() => setTimeout(observe, 0));
    });
    const page = await context.newPage();
    page.on('pageerror', e => faults.push(e.message));
    page.on('request', r => requests.push(new URL(r.url()).pathname));
    const shot = async name => { if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), caret: 'hide' }); };
    await page.goto(f.url);
    await page.waitForFunction(() => window.__launch?.().phase === 'intro', null, { timeout: 60000 });
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => window.__launch().intro.tau > 7 && window.__launch().intro.tau < 8, null, { timeout: 30000 });
    await shot('01-before-password');
    const cdp = await context.newCDPSession(page);
    cdp.on('Page.screencastFrame', frame => {
      frames.push(frame);
      void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    await page.waitForFunction(() => window.__launch().phase === 'ready');
    await page.waitForTimeout(1500);
    await cdp.send('Page.stopScreencast');
    const observed = await page.evaluate(() => ({ timeline: window.__lockFrames, pixels: window.__lockPixels }));
    // Keep raw compositor frames and time-correlated computed styles, not reconstructed pictures.
    if (evidence) {
      const dir = join(evidence, 'transition'); await mkdir(dir, { recursive: true });
      const captured = [];
      for (const [i, frame] of frames.entries()) {
        const wall = frame.metadata.timestamp * 1000;
        const nearest = observed.timeline.reduce((a, b) => Math.abs(a.wall - wall) < Math.abs(b.wall - wall) ? a : b);
        const name = `${String(i).padStart(3, '0')}.png`;
        await writeFile(join(dir, name), Buffer.from(frame.data, 'base64'));
        captured.push({ name, wall, nearest, deltaMs: nearest.wall - wall });
      }
      await writeFile(join(evidence, 'transition.json'), JSON.stringify({ ...observed, captured, rendererOverlay: rendererOverlay || null,
        rendererSha256: createHash('sha256').update(await readFile(rendererOverlay || new URL('../../website/for-kinso/sharks.mjs', import.meta.url))).digest('hex') }, null, 2));
    }
    const ready = observed.timeline.filter(row => row.phase === 'ready');
    assert.ok(ready.length > 3, 'observed the actual fade');
    assert.ok(ready[0].tau >= 8.61 && ready[0].tau < 8.95, 'wake starts on WORD.gone, shared with the logo shrink');
    assert.ok(ready.some(row => row.user > .1 && row.user < .9), 'the password still wakes gradually');
    assert.ok(ready.every(row => row.word === 1), 'the logo stays visible throughout the wake');
    assert.ok(ready.some(row => row.word === 1 && row.user === 1));
    assert.equal(observed.pixels[0].dark, 0, 'enter:true starts with every shark fully outside the visible canvas');
    assert.equal(observed.pixels[0].changed, 0, 'first swimming frame is pixel-identical to the empty grid, including pale cells');
    // Plankton can produce isolated interior pixels before the bodies reach the edge.
    // Record that honestly; do not mistake the particles' global bbox for a shark silhouette.
    assert.ok(observed.pixels.some(row => row.edgeDark > 0), 'visible body cells cross the canvas edge after the blank entrance');
    assert.ok(observed.pixels.some(row => row.dark > 20), 'sharks really enter after wake');
    await page.waitForTimeout(2200); await shot('05-settled-grid-lock');
    assert.equal(await page.locator('.macos-avatar, .macos-name').count(), 0);
    assert.equal(await page.locator('.macos-lock').evaluate(el => getComputedStyle(el).color), 'rgb(48, 48, 46)');
    assert.equal(await page.locator('#sky .macos-wallpaper').evaluate(el => getComputedStyle(el).display), 'none');
    assert.equal(await page.locator('#wordmark').evaluate(el => getComputedStyle(el).opacity), '1');
    assert.equal(await page.locator('#wordmark').evaluate(el => el.width > 0 && el.height > 0), true);
    assert.ok(requests.includes('/kinso/a/aa106999c9d67289.png'), 'their real colour logo requested');
    assert.ok(requests.includes('/kinso/logo-draw.json'), 'their app animation requested from the local rebuild');
    await page.locator('#password').fill('wrong'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__launch().phase === 'ready' && document.querySelector('#password').value === '');
    await page.locator('#password').fill('kinso'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#lockScreen').hidden && document.querySelector('#introScreen').hidden &&
      !document.querySelector('#macScreen').hidden && Number(getComputedStyle(document.querySelector('#macScreen')).opacity) === 1);
    await shot('06-unlocked-desktop');
    assert.match(await page.locator('.mac-wall').evaluate(el => getComputedStyle(el).backgroundImage), /\/wallpaper-kinso\.webp/);
    assert.equal(await page.evaluate(() => window.__launch().kinso.sharks.swimming), false);
    await page.waitForFunction(() => window.__launch().demoVerified);
    assert.ok(f.product.seen.tickets.some(row => row.valid && row.id === 'kinso'));
    assert.equal(new URL(await page.locator('#computer').getAttribute('src')).origin, f.product.origin);
    assert.ok(!requests.some(path => /wabi|kinso-variations/i.test(path)));
    assert.deepEqual(faults, []);
    // Original imperfect is not dressed in Kinso's light ground or lock ink.
    await context.clearCookies();
    await page.goto(f.origin);
    await page.waitForFunction(() => window.__launch?.().phase === 'intro', null, { timeout: 60000 });
    assert.equal(await page.locator('body').getAttribute('data-company'), null);
    assert.equal(await page.locator('.kinso-sharks').count(), 0);
    assert.match(await page.locator('.mac-wall').evaluate(el => getComputedStyle(el).backgroundImage), /\/wallpaper\.webp/);
    assert.equal(await page.locator('.macos-lock').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
    assert.notEqual(await page.locator('#sky .macos-wallpaper').evaluate(el => getComputedStyle(el).display), 'none');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => window.__launch().phase === 'ready', null, { timeout: 15000 });
    await page.waitForTimeout(400); await shot('07-original-imperfect-lock');
    assert.equal(await page.locator('#wordmark').evaluate(el => getComputedStyle(el).opacity), '0');
    assert.equal(await page.locator('.macos-name').textContent(), 'imperfect');
    await context.clearCookies(); await page.emulateMedia({ reducedMotion: 'reduce' });
    // A clean checkout has no untracked Kinso image; still draw a compact, coloured mark rather than a word.
    await context.route('**/kinso/a/aa106999c9d67289.png', route => route.abort());
    await context.route('**/kinso/logo-draw.json*', route => route.abort());
    await page.goto(f.url);
    await page.waitForFunction(() => window.__launch?.().phase === 'intro', null, { timeout: 60000 });
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => window.__launch().phase === 'ready', null, { timeout: 15000 });
    await page.waitForTimeout(250); await shot('08-reduced-motion-grid-fallback');
    assert.equal(await page.locator('#wordmark').evaluate(el => getComputedStyle(el).opacity), '1');
    assert.ok(await page.locator('#wordmark').evaluate(el => {
      const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
      let colour = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128 && Math.abs(d[i] - d[i + 2]) > 20) colour++;
      return colour > 100;
    }), 'the missing-image stand-in is a colour outline');
    assert.equal(await page.evaluate(() => window.__launch().kinso.sharks.swimming), false, 'Reduce Motion stays on the quiet grid; no pre-rolled shark pop');
    await page.locator('#password').fill('kinso'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#lockScreen').hidden);
    assert.equal(await page.locator('#lockScreen').evaluate(el => getComputedStyle(el).transform), 'none');
    assert.deepEqual(faults, []);
    if (evidence) await writeFile(join(evidence, 'result.json'), JSON.stringify({ faults, ticketAccepted: true, originalImperfectUnchanged: true, reducedMotionQuietGrid: true, rendererOverlay: rendererOverlay || null }, null, 2));
  } finally { await context?.close(); await browser?.close(); await f.close(); }
});
