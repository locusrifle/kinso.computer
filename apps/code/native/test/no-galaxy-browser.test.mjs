import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { serveDirectory } from '../../../../tools/serve.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const evidence = process.env.GALAXY_EVIDENCE;
const frame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
async function shot(page, name) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${name}.png` });
}
for (const fallback of [false, true]) test(`native boot, login and unlock never submit particles (${fallback ? 'no WebGL' : 'normal motion'})`, async () => {
  const server = await serveDirectory(root), browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url()));
    await page.addInitScript(fallback => {
      window.__lockClock = 100; window.__lockWall = 1760083230; window.__particleDraws = 0;
      if (fallback) {
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(kind, ...args) { return /webgl/.test(kind) ? null : get.call(this, kind, ...args); };
      } else {
        for (const type of [WebGLRenderingContext, WebGL2RenderingContext]) {
          for (const name of ['drawArrays', 'drawElements']) {
            const draw = type.prototype[name];
            type.prototype[name] = function(...args) { if (args[0] === this.POINTS) window.__particleDraws++; return draw.apply(this, args); };
          }
        }
      }
    }, fallback);
    await page.goto(server.origin + '/desktop/lock/index.html?bg=121214&ink=ffffff');
    await page.waitForFunction(() => window.__lockSaid?.includes('ready') || window.__lockError, null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__lockError ?? null), null);
    const step = async seconds => {
      await page.evaluate(seconds => { window.__lockClock += seconds; window.__lockWall += seconds; }, seconds);
      await frame(page);
    };
    const state = () => page.evaluate(() => ({ ...window.__lock(), particles: window.__particleDraws,
      wallpaper: getComputedStyle(document.querySelector('#sky .macos-wallpaper')).opacity,
      ground: getComputedStyle(document.getElementById('sky')).backgroundColor,
      canvases: [...document.querySelectorAll('canvas')].map(e => e.id),
    }));
    const prefix = fallback ? 'fallback' : 'native';
    await shot(page, `${prefix}-painting`);
    await page.evaluate(() => window.lock.key(4));
    for (let i = 0; i < 80 && (await state()).phase === 'scene'; i++) await step(.05);
    assert.equal((await state()).phase, 'bubble');
    await step(.65); await shot(page, `${prefix}-bubble`);
    await step(6.1 - (await state()).tau); await shot(page, `${prefix}-wordmark`);
    await step(8.7 - (await state()).tau);
    assert.equal((await state()).phase, 'box'); await step(.4); await shot(page, `${prefix}-login`);
    await page.evaluate(() => { window.lock.check(); window.lock.answer(false); }); await step(.4);
    assert.equal((await state()).yes, false);
    await page.evaluate(() => { window.lock.key(4); window.lock.check(); window.lock.answer(true); });
    await step(.125); await shot(page, `${prefix}-mid-unlock`);
    const mid = await state();
    assert.equal(mid.ground, 'rgb(18, 18, 20)');
    assert.ok(+mid.wallpaper < 1 && +mid.wallpaper > 0);
    await step(.2); const done = await state(); await shot(page, `${prefix}-released`);
    assert.ok(done.said.includes('done'), 'only the fake native PAM result releases this presentation');
    assert.equal(done.particles, 0, 'neither painting motes nor an unlock star canvas is submitted');
    assert.deepEqual(done.canvases, ['scene', 'wordmark']);
    assert.ok(!requests.some(url => /\/(sky|stars|scene|air)\.mjs|blackhole|kept-sky/.test(url)));
    assert.deepEqual(errors, []);
    if (evidence) await writeFile(`${evidence}/${prefix}-state.json`, JSON.stringify({ mid, done, requests }, null, 2));
  } finally { await browser.close(); await new Promise(r => server.server.close(r)); }
});
test('the website retains its wallpaper lock and account pages keep a solid background', async () => {
  const server = await serveDirectory(root + 'website/'), browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url()));
    await page.addInitScript(() => { window.__introClock = 100; window.__introWall = 1760083230; });
    await page.route('**/unlock', route => route.fulfill({ json: { ok: false } }));
    await page.goto(server.origin + '/index.html');
    await page.waitForFunction(() => window.__launch?.().phase === 'intro', null, { timeout: 60000 });
    await page.evaluate(async () => { (await import('/intro/intro.mjs?v=kinso-1')).intro.approach(); });
    for (let i = 0; i < 140 && (await page.evaluate(() => window.__launch().phase)) !== 'ready'; i++) {
      await page.evaluate(() => { window.__introClock += .1; window.__introWall += .1; }); await frame(page);
    }
    assert.equal(await page.evaluate(() => window.__launch().phase), 'ready');
    assert.equal(await page.locator('#galaxyScene').count(), 0);
    await page.waitForTimeout(400); await shot(page, 'website-login');
    assert.ok(!requests.some(url => /\/(sky|stars|scene|air)\.mjs|blackhole/.test(url)));
    assert.deepEqual(errors, []);
    await page.goto(server.origin + '/host.html');
    const backdrop = await page.evaluate(() => ({ image: getComputedStyle(document.body, '::before').backgroundImage, content: getComputedStyle(document.body, '::before').content }));
    assert.deepEqual(backdrop, { image: 'none', content: 'none' }); await shot(page, 'account-ground');
  } finally { await browser.close(); await new Promise(r => server.server.close(r)); }
});
