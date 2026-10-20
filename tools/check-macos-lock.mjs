// Run under flock /tmp/imperfect-browser-tests.lock. These fixtures never touch the installed lock or service.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChromium } from './test-browser.mjs';
import { macosLaunch } from '../locker/test/fixtures/macos-launch.mjs';

const out = resolve(process.argv[2] || '/tmp/imperfect-macos-lock'); await mkdir(out, { recursive: true });
const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=document-user-activation-required'] });
const states = {}, shot = async (page, name, state) => { await page.screenshot({ path: join(out, name + '.png') }); states[name] = state; console.log(name); };
let f;
try {
  f = await macosLaunch(browser); await f.page.keyboard.press('ArrowDown'); await f.step(2.2); await f.step(6);
  await shot(f.page, 'website-wordmark-dark', await f.state());
  await f.page.emulateMedia({ colorScheme: 'light' }); await f.page.waitForTimeout(850);
  await shot(f.page, 'website-wordmark-light', await f.state());
  await f.page.emulateMedia({ colorScheme: 'dark' }); await f.page.waitForTimeout(850); await f.step(3); await f.step(.4);
  await shot(f.page, 'website-lock-dark', await f.state());
  await f.page.emulateMedia({ colorScheme: 'light' }); await f.page.waitForTimeout(850);
  await shot(f.page, 'website-lock-light', await f.state());
  await f.page.emulateMedia({ colorScheme: 'dark' }); await f.page.waitForTimeout(850);
  await f.page.locator('#password').fill('refused'); await f.page.keyboard.press('Enter');
  await f.page.waitForFunction(() => window.__launch().lock.state === 'wrong'); await f.step(.06, .02);
  await shot(f.page, 'website-wrong', await f.state()); await f.step(.5);
  await f.page.setViewportSize({ width: 390, height: 844 }); await shot(f.page, 'website-lock-phone', await f.state());
  await f.page.setViewportSize({ width: 390, height: 420 }); await shot(f.page, 'website-lock-keyboard', await f.state());
  await f.page.setViewportSize({ width: 1440, height: 900 });
  await f.page.locator('#password').fill('fixture-password'); await f.page.keyboard.press('Enter');
  await f.page.waitForFunction(() => window.__launch().phase === 'mac-unlocking'); await f.step(.12, .02);
  await shot(f.page, 'website-unlock', await f.state()); await f.step(.18, .03);
  await shot(f.page, 'website-desktop', await f.state()); await f.step(.5);
  await f.page.waitForFunction(() => !!document.querySelector('.genie-mesh')); await f.step(.25, .05);
  await shot(f.page, 'website-genie-restore', await f.state()); await f.step(.4);
  await f.page.waitForFunction(() => window.__launch().phase === 'quicktime');
  await shot(f.page, 'website-quicktime-hud', await f.state()); await f.step(2.3);
  await shot(f.page, 'website-quicktime-hidden-hud', await f.state());
  await f.page.locator('#quicktimeVideo').evaluate(video => { video.currentTime = video.duration - .05; });
  await f.page.waitForFunction(() => window.__launch().quicktime.ending); await f.step(.25, .05);
  await shot(f.page, 'website-genie-minimize', await f.state()); await f.step(.4);
  await f.page.waitForFunction(() => window.__launch().phase === 'mac');
  await shot(f.page, 'website-after-film', await f.state());
  await f.page.locator('#skip').evaluate(el => el.click());
  await f.page.waitForFunction(() => window.__launch().phase === 'demo', null, { timeout: 30000 });
  await shot(f.page, 'website-finished', await f.state());
  states.websiteErrors = f.errors; states.csp = f.refusals; await f.close(); f = null;
  for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport, colorScheme: 'dark' }); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { window.__lockClock = 100; window.__lockWall = 1760083230; });
    await page.goto(pathToFileURL(resolve('desktop/lock/index.html')).href + '?epoch=1760083200');
    await page.waitForFunction(() => window.__lockSaid?.includes('ready'));
    const step = dt => page.evaluate(async dt => { window.__lockClock += dt; window.__lockWall += dt; await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))); }, dt);
    await shot(page, `native-${name}-opener`, await page.evaluate(() => window.__lock()));
    await page.evaluate(() => window.lock.key(5));
    for (let i = 0; i < 30 && await page.evaluate(() => window.__lock().phase !== 'bubble'); i++) await step(.1);
    await step(1.2); await shot(page, `native-${name}-bubble`, await page.evaluate(() => window.__lock()));
    await step(5); await shot(page, `native-${name}-wordmark`, await page.evaluate(() => window.__lock()));
    await step(3); await step(.4); await shot(page, `native-${name}-lock`, await page.evaluate(() => window.__lock()));
    await page.evaluate(() => { window.lock.check(); window.lock.answer(false); }); await step(.06);
    await shot(page, `native-${name}-wrong`, await page.evaluate(() => window.__lock())); await step(.5);
    await page.evaluate(() => { window.lock.key(4); window.lock.check(); window.lock.answer(true); }); await step(.12);
    await shot(page, `native-${name}-unlock`, await page.evaluate(() => window.__lock())); await step(.2); await step(.01);
    await shot(page, `native-${name}-handover`, await page.evaluate(() => window.__lock()));
    states[`native-${name}-errors`] = errors; await page.close();
  }
} finally { await writeFile(join(out, 'states.json'), JSON.stringify(states, null, 2)); await f?.close(); await browser.close(); }
