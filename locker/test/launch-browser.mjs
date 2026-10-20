// Real launch + real hosted product front-end, one browser/page scenario at a time.
// Computer/model/browser/Stripe transports are isolated fixtures, not live-VM proof.
// Parent runner MUST hold flock /tmp/imperfect-browser-tests.lock and use the
// documented systemd scope (CPUQuota=300%, MemoryMax=4G). Never run alongside another browser.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { launchChromium } from '../../tools/test-browser.mjs';
import { createLockerServer } from '../server.mjs';
import { openStore } from '../store.mjs';
import { INSTALL_COMMAND } from '../shop.mjs';
import { command, createSiteLocks, readTicket } from '../site-locks.mjs';
import { launchProductFixture } from './fixtures/launch-product.mjs';
import { WORD } from '../../website/wordmark.mjs';
import { goatTimes } from '../../website/intro/goat.mjs';

const evidence = resolve(process.argv[2] || process.env.STILLS || '/tmp/imperfect-launch-browser');
await mkdir(evidence, { recursive: true });
const privateDir = await mkdtemp(join(tmpdir(), 'launch-browser-'));
const credentials = join(privateDir, 'credentials');
const files = { file: join(credentials, 'site-locks.json'), doorFile: join(credentials, 'site-door-secret'), credentials, out() {} };
let appOrigin;
await command(['door-secret'], files);
const product = await launchProductFixture({ launchOrigin: () => appOrigin,
  verifyTicket: async ticket => readTicket(ticket, await readFile(files.doorFile)) });
await command(['replace', 'noah', 'noah', product.origin, '--ticket'], files);
const store = openStore();
const locks = createSiteLocks({ ...files, secure: false, log: { error() {} } });
// Exercise the worktree's REAL standalone Shop and receipt routes. Only
// Stripe and sale notifications are isolated; never fabricate VM stream pixels.
let shop, checkoutSerial = 0;
const sessions = new Map();
const stripe = {
  async checkoutSession(params, options) {
    const id = `cs_test_browser${++checkoutSerial}`;
    shop.created.push({ id, params, options });
    sessions.set(id, { id, payment_status: 'unpaid', amount_total: params.line_items[0].price_data.unit_amount,
      metadata: params.metadata, customer_details: { email: 'supporter@example.test' } });
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  },
  async retrieveSession(id) {
    shop.retrieved.push(id);
    assert.ok(sessions.has(id), 'only this visit’s isolated checkout may be retrieved');
    return sessions.get(id);
  },
};
const app = await createLockerServer({ store, stripe, tell: async words => shop.told.push(words),
  mail: { configured: false, async send() { throw new Error('Browser fixture must not send mail'); } },
  config: { secure: false, hosts: '127.0.0.1', stripe: { rentPrice: '', webhookSecret: '' } },
  siteLocks: locks, port: 0, log: { info() {}, warn() {}, error() {} } });
appOrigin = `http://127.0.0.1:${(await app.listen()).port}`;
console.log('Isolated launch/product origins:', appOrigin, product.origin);
assert.equal((await fetch(`${product.origin}/?face=code&launch=phone`)).status, 401, 'secondary root cannot load without the first ticket’s cookie');
while (loadavg()[0] >= 5) await new Promise(ok => setTimeout(ok, 10000));
const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'] });
const sizes = { desktop: { width: 1600, height: 900 }, portrait: { width: 390, height: 844 }, landscape: { width: 844, height: 390 } };
let page, context, label, errors, pendingShots, phoneChecks, drops, filmRequests, passes = 0, desktopProductStyle;
const state = () => page.evaluate(() => window.__launch());
const productFrame = phone => page.frames().find(frame => {
  if (!frame.url().startsWith(product.origin) || frame.url().includes('/door/ticket')) return false;
  return (new URL(frame.url()).searchParams.get('launch') === 'phone') === phone;
});
const child = () => productFrame(false);
const phoneChild = () => productFrame(true);
const shot = name => page.screenshot({ path: join(evidence, `${label}-${name}.png`), caret: 'hide', scale: 'css' });
const twoFrames = () => page.evaluate(() => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))));
async function clock(t) { await page.evaluate(t => { window.__introClock = t; }, t); await twoFrames(); }
async function open(name, { reduced = false, mode = 'ready', platform = name === 'portrait' ? 'iPhone' : name === 'landscape' ? 'MacIntel' : 'Linux x86_64' } = {}) {
  await context?.close();
  while (loadavg()[0] >= 5) await new Promise(ok => setTimeout(ok, 10000));
  console.log('PAGE', name, 'load1', loadavg()[0]);
  label = name; errors = []; pendingShots = []; phoneChecks = []; drops = []; filmRequests = []; product.reset(); product.mode = mode;
  sessions.clear();
  shop = { posts: [], created: [], retrieved: [], told: [], polls: 0, offer: 0 };
  context = await browser.newContext({ viewport: sizes[name] || sizes.desktop, deviceScaleFactor: 2,
    hasTouch: name === 'portrait', reducedMotion: reduced ? 'reduce' : 'no-preference' });
  context.setDefaultTimeout(20000);
  // No production requests, including same-tab isolated Checkout.
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === appOrigin && /^\/media\/|\.mp4$/.test(url.pathname)) filmRequests.push(url.pathname);
    if (url.origin === appOrigin && url.pathname === '/shop/offer') shop.offer++;
    if (url.origin === appOrigin && url.pathname === '/shop/code') {
      assert.equal(request.method(), 'POST'); shop.posts.push(request.postDataJSON());
    }
    if (url.origin === appOrigin && url.pathname === '/shop/code/status') {
      assert.ok(sessions.has(url.searchParams.get('session'))); shop.polls++;
    }
    // Store requests reach createLockerServer unchanged. Only Stripe is HTML.
    if (url.origin === 'https://checkout.stripe.com') {
      const checkout = shop.created.find(entry => url.pathname === `/c/pay/${entry.id}`);
      assert.ok(checkout, 'Checkout URL came from the real server receipt');
      const returned = new URL(checkout.params.success_url.replace('{CHECKOUT_SESSION_ID}', checkout.id));
      assert.equal(returned.origin, 'https://imperfect.computer');
      assert.equal(returned.pathname, '/shop/thanks');
      const href = `${appOrigin}${returned.pathname}${returned.search}`;
      return route.fulfill({ contentType: 'text/html', body: `<title>Isolated Checkout fixture</title><a id="test-return" href="${href.replaceAll('&', '&amp;')}">Return to imperfect</a>` });
    }
    if ([appOrigin, product.origin].includes(url.origin) || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    errors.push(`Blocked unexpected external browser request: ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  await context.exposeFunction('captureLaunchFrame', async (kind, detail) => {
    if (kind === 'drop') drops.push(detail);
    if (kind === 'phone') {
      const check = inspectPhone(detail).catch(error => { errors.push(error.stack); return { ...detail, error: error.message }; }); phoneChecks.push(check);
      const capture = shot(`phone-${detail.phase}`); pendingShots.push(capture);
      await Promise.all([check, capture]); return;
    }
    const name = kind === 'drop' ? `drop-${detail.name}-sound` : `drop-${detail.step}-painted`;
    const capture = shot(name); pendingShots.push(capture); await capture;
  });
  await context.addInitScript(({ productOrigin, launchOrigin, platform }) => {
    // The visitor's OS labels vary, never the native product iframe geometry.
    if (location.origin === launchOrigin) {
      Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
      Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: undefined });
      if (platform === 'iPhone') Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
    }
    window.__introClock = 100;
    window.__voices = []; window.__dropSounds = []; window.__dropTargets = []; window.__drops = []; window.__acks = []; window.__phases = [];
    window.__phoneEvents = []; window.__phoneAcks = []; window.__phoneLoads = []; window.__primaryReadyAt = null;
    window.__chooserSamples = 0; window.__chooserLost = []; window.__openRequests = [];
    if (location.origin === productOrigin) {
      window.__browserConnections = [];
      window.WebSocket = new Proxy(window.WebSocket, { construct(target, args) {
        if (new URL(args[0], location.href).pathname === '/browser/live') window.__browserConnections.push(String(args[0]));
        return Reflect.construct(target, args);
      } });
      // Sample every actual assembly paint, after the real parent first asks
      // for one (not the unready bootstrap hidden behind the film).
      let observing = false;
      addEventListener('message', event => {
        if (event.source === parent && event.origin === launchOrigin && event.data?.type === 'imperfect:assemble') observing = true;
        if (event.source === parent && event.origin === launchOrigin && event.data?.type === 'imperfect:open') window.__openRequests.push(event.data);
      });
      const inspect = () => {
        const step = document.documentElement?.dataset.assemblyStep;
        if (observing && ['bare', 'claude', 'codex', 'files', 'browser', 'done'].includes(step)) {
          const chooser = document.querySelector('.agent-choose');
          const agents = [...document.querySelectorAll('.agent-choose button[data-agent]')].filter(node => node.getBoundingClientRect().width && getComputedStyle(node).visibility !== 'hidden');
          const expected = step === 'bare' ? 1 : step === 'claude' ? 2 : 3;
          window.__chooserSamples++;
          if (!chooser || !chooser.getBoundingClientRect().width || getComputedStyle(chooser).visibility === 'hidden' || getComputedStyle(chooser).display === 'none' || agents.length !== expected) window.__chooserLost.push({ step, count: agents.length, at: performance.now() });
        }
        requestAnimationFrame(inspect);
      };
      requestAnimationFrame(inspect);
    }
    window.__documentIdentity = Math.random().toString(36).slice(2);
    window.__cspViolations = [];
    addEventListener('securitypolicyviolation', event => window.__cspViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
    if (navigator.clipboard) Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.__copied = text; } });
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function() {
      if (!this.muted && this.src.includes('/line-')) {
        const entry = { src: this.src.split('/').at(-1), at: performance.now() }; window.__voices.push(entry);
        this.addEventListener('ended', () => { entry.endedAt = performance.now(); }, { once: true, capture: true });
      }
      if (!this.muted && this.src.includes('drag-to-trash')) {
        window.__dropSounds.push(performance.now());
        const r = document.querySelector('[data-app="trash"]')?.getBoundingClientRect();
        window.__dropTargets.push(r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
      }
      return play.call(this);
    };
    if (location.origin !== launchOrigin) return;
    addEventListener('imperfect:sequence', e => window.__phases.push(e.detail.phase));
    addEventListener('imperfect:phone', e => {
      const detail = { ...e.detail, observedAt: performance.now() };
      window.__phoneEvents.push(detail); void window.captureLaunchFrame('phone', detail);
    });
    new MutationObserver(records => {
      for (const record of records) if (record.target.id === 'phoneComputer' && record.attributeName === 'src' && record.target.getAttribute('src')) {
        window.__phoneLoads.push({ src: record.target.src, at: performance.now(), ready: window.__primaryReadyAt !== null, verified: window.__launch?.().demoVerified });
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['src'] });
    addEventListener('imperfect:drop', e => {
      const detail = { ...e.detail, observedAt: performance.now() };
      window.__drops.push(detail); void window.captureLaunchFrame('drop', detail);
    });
    addEventListener('message', event => {
      if (event.origin !== productOrigin) return;
      if (event.source === document.querySelector('#phoneComputer')?.contentWindow) {
        if (event.data?.type === 'imperfect:assembled') window.__phoneAcks.push({ step: event.data.step, at: performance.now() });
        return;
      }
      if (event.source !== document.querySelector('#computer')?.contentWindow) return;
      if (event.data?.type === 'imperfect:demo-ready') window.__primaryReadyAt = performance.now();
      if (event.data?.type !== 'imperfect:assembled') return;
      window.__acks.push({ step: event.data.step, at: performance.now() });
      if (['claude', 'codex', 'files', 'browser'].includes(event.data.step)) void window.captureLaunchFrame('painted', event.data);
    });
  }, { productOrigin: product.origin, launchOrigin: appOrigin, platform });
  page = await context.newPage();
  page.on('pageerror', error => { errors.push(error.message); console.error('PAGE ERROR', error.message); });
  await page.goto(appOrigin);
  await page.waitForFunction(() => window.__launch?.().phase === 'intro');
}
async function unlock({ skip = false } = {}) {
  if (skip) {
    await page.locator('#skip').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__launch().phase === 'ready');
  }
  await page.locator('#password').fill('noah'); await page.locator('#password').press('Enter');
}
async function opener() {
  assert.equal((await state()).lock.shown, false);
  assert.equal(product.seen.requests.length, 0, 'no computer requested before lock');
  await shot('00-opener');
  const vp = page.viewportSize(); await page.mouse.move(vp.width / 2, vp.height / 2);
  for (let i = 0; i < 6 && !(await state()).intro.scrolled; i++) {
    await page.mouse.wheel(0, 100); await page.waitForTimeout(100); await clock(100.1 + i * .01);
  }
  assert.ok((await state()).intro.scrolled > 0, 'real wheel approaches');
  await page.keyboard.press('ArrowDown');
  for (let i = 1; i < 80 && (await state()).intro.phase === 'scene'; i++) await clock(100.2 + i * .2);
  const contact = (await state()).intro.soundAt;
  assert.notEqual(contact, null);
  await clock(contact + WORD.gone - .8); await shot('01-wordmark');
  await clock(contact + goatTimes().whole + .2); await shot('02-goat');
  await clock(contact + goatTimes().gone + .5);
  await page.waitForFunction(() => window.__launch().phase === 'ready'); await shot('03-lock');
  await page.locator('#password').fill('wrong'); await page.locator('#password').press('Enter');
  await page.waitForFunction(() => document.querySelector('#lock').dataset.state === 'wrong');
  assert.equal((await state()).lock.unlocked, false);
  assert.equal((await state()).phase, 'ready');
  assert.equal(await page.locator('#filmScreen').getAttribute('aria-hidden'), 'true');
  assert.equal(product.seen.requests.length, 0, 'a wrong password never opens the computer');
  await page.waitForFunction(() => document.querySelector('#lock').dataset.state === 'idle');
  await unlock();
  // No film (the v8 trailer is archived): the unlock goes straight to the Mac, the real product asked for at once
  // under the sky the lock was on.
  await page.waitForFunction(() => window.__launch().phase === 'mac');
  assert.ok(await page.locator('#introScreen').isVisible(), 'the sky stays while the computer loads'); await shot('04-unlocked');
  await page.waitForFunction(() => window.__launch().demoVerified);
  assert.deepEqual((await page.evaluate(() => window.__phases)).filter(phase => phase.startsWith('film')), [], 'no film phases');
  assert.equal(await page.locator('#film').getAttribute('src'), null, 'the video is given no film');
  assert.deepEqual(filmRequests, [], 'nothing is downloaded for a film');
  assert.ok(await page.locator('#action').isHidden(), 'no Play film button');
  assert.equal(await page.locator('#computer').count(), 1);
  assert.equal(await page.locator('iframe').count(), 2, 'primary product plus inert real phone, never illustrated app');
  assert.equal(await page.locator('#demoScreen > iframe#computer').count(), 1, 'exactly one primary product document');
  return child().evaluate(() => window.__documentIdentity);
}
async function nativeRect(selector) {
  return page.locator(selector).evaluate(element => {
    const stage = document.querySelector('#macScreen').getBoundingClientRect(), r = element.getBoundingClientRect(), scale = stage.width / 1600;
    return { x: (r.x - stage.x) / scale, y: (r.y - stage.y) / scale, width: r.width / scale, height: r.height / scale };
  });
}
function nearRect(actual, expected, message, tolerance = .1) {
  for (const key of Object.keys(expected)) assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance, `${message} ${key}: ${actual[key]} vs ${expected[key]}`);
}
const DEFAULT_RECT = { x: 160, y: 25, width: 1280, height: 796 };
const noSessionWrites = () => assert.deepEqual(product.seen.commands.filter(c => ['tab-new', 'prompt'].includes(c.type)), [], 'neither product frame may start a session or send a prompt');
async function geometry() {
  const stage = await page.locator('#macScreen').boundingBox();
  const vp = page.viewportSize(), scale = Math.min(vp.width / 1600, vp.height / 900);
  for (const [key, expected] of Object.entries({ width: 1600 * scale, height: 900 * scale, x: (vp.width - 1600 * scale) / 2, y: (vp.height - 900 * scale) / 2 })) {
    assert.ok(Math.abs(stage[key] - expected) < 1.5, `16:9 contain stage ${key}: ${stage[key]} vs ${expected}`);
  }
  const dimensions = await child().evaluate(() => [innerWidth, innerHeight]);
  assert.deepEqual(dimensions, [1280, 796], 'exact native desktop iframe at every viewport');
  nearRect(await nativeRect('[data-window-id="imperfect"]'), DEFAULT_RECT, 'default Mac window');
  const dock = await nativeRect('.mac-dock');
  nearRect(dock, { y: 822, height: 72 }, 'Dock native band');
  assert.ok(Math.abs(900 - dock.y - dock.height - 6) < .1, 'Dock bottom is six points above stage bottom');
  return dimensions;
}
async function chooser(step, frame = child()) {
  await frame.locator('.agent-choose').waitFor();
  // Query and measure in ONE page task. Locator.evaluateAll can hand its
  // callback nodes detached by an intervening native chooser re-render.
  const snapshot = await frame.evaluate(() => {
    const nodes = [...document.querySelectorAll('.agent-choose button[data-agent]')];
    return {
    agents: nodes.filter(n => n.getBoundingClientRect().width > 0 && getComputedStyle(n).visibility !== 'hidden').map(n => n.dataset.agent).sort(),
    options: nodes.map(n => ({ agent: n.dataset.agent, width: n.getBoundingClientRect().width, visibility: getComputedStyle(n).visibility, display: getComputedStyle(n).display, classes: n.className })),
    root: document.documentElement.dataset.assemblyStep, chooser: document.querySelector('.agent-choose')?.outerHTML,
    window: document.querySelector('.entry-screen')?.className, body: document.body.className,
    };
  });
  const expected = (step === 'bare' ? ['pi'] : step === 'claude' ? ['pi', 'claude'] : ['pi', 'claude', 'codex']).sort();
  if (JSON.stringify(snapshot.agents) !== JSON.stringify(expected)) {
    await writeFile(join(evidence, `${label}-chooser-failure-${step}.json`), JSON.stringify(snapshot, null, 2));
    await shot(`chooser-failure-${step}`);
  }
  assert.deepEqual(snapshot.agents, expected);
  assert.equal(await frame.locator('[data-computer="local"]').isDisabled(), true);
  assert.equal(await frame.locator('[data-computer="cloud"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await frame.locator('.agent-choose-hint').count(), 0);
  assert.equal(await frame.locator('.kept-sky').count(), 0, 'no framed galaxy');
}
async function inspectPhone(detail) {
  assert.ok(['shown', 'returned'].includes(detail.phase), 'known phone beat event');
  assert.ok(Number.isFinite(detail.at));
  await chooser('browser');
  const main = await nativeRect('[data-window-id="imperfect"]');
  const before = await page.evaluate(() => window.__beforePhoneRect);
  assert.equal(await child().evaluate(() => window.__documentIdentity), await page.evaluate(() => window.__beforePhoneIdentity));
  assert.equal(await page.evaluate(() => document.querySelector('#computer') === window.__sameComputerFrame), true, 'phone beat never detaches primary iframe');
  if (detail.phase === 'shown') {
    nearRect(main, { ...before, x: before.x - 320 }, 'main moves left, without resizing');
    const phone = page.locator('.mac-phone');
    assert.equal(await phone.evaluate(el => el.inert), true, 'phone simulation stays inert');
    assert.equal(await page.locator('#phoneComputer').evaluate(el => el.closest('[inert]') !== null || el.inert), true);
    assert.equal(await phoneChild().evaluate(() => location.href), `${product.origin}/?face=code&launch=phone`);
    assert.deepEqual(await phoneChild().evaluate(() => [innerWidth, innerHeight]), [390, 844]);
    assert.equal(await phoneChild().locator('html.launch-phone').count(), 1);
    assert.equal(await phoneChild().locator('#entry-terminal.phone-layout').count(), 1, 'actual product phone layout, not a scaled desktop');
    await phoneChild().waitForFunction(() => document.documentElement.dataset.assemblyStep === 'done');
    await chooser('done', phoneChild());
    await assemblyGuards(phoneChild(), '#phoneComputer', '__phoneAcks');
    const rect = await nativeRect('.mac-phone');
    assert.ok(Math.abs(rect.x - 1220) < 25 && Math.abs(rect.y - 80) < 25, 'phone enters the right side of native stage');
    assert.ok(Math.abs(rect.width - 390 * .78) < 30 && Math.abs(rect.height - 844 * .78) < 30, 'phone sits near .78 native scale');
    const roots = product.seen.roots.filter(root => root.launch === 'phone');
    assert.deepEqual(roots, [{ authenticated: true, launch: 'phone', face: 'code' }], 'second root uses the first ticket’s cookie exactly once');
    assert.equal(product.seen.tickets.length, 1, 'phone never asks for a second ticket');
    const visibleCookie = await phoneChild().evaluate(() => document.cookie);
    assert.ok(!visibleCookie.includes('launch-fixture='), 'authentication cookie is HttpOnly');
  } else nearRect(main, before, 'phone returns the exact preceding main rectangle');
  noSessionWrites();
  return { ...detail, main, phoneIdentity: await phoneChild().evaluate(() => window.__documentIdentity) };
}
async function assertChooserStayed(frame = child()) {
  const sample = await frame.evaluate(() => ({ samples: window.__chooserSamples, lost: window.__chooserLost }));
  assert.ok(sample.samples > 0, 'observed actual chooser frames');
  assert.deepEqual(sample.lost, [], 'the complete current chooser remained visible at every painted assembly/phone/done frame');
}
async function assemblyGuards(frame, selector, ackKey) {
  const before = await page.evaluate(key => window[key].length, ackKey);
  // Duplicate done is acknowledged by the real receiver; wrong source or origin
  // must not be acknowledged even though its payload is otherwise valid.
  await frame.evaluate(origin => {
    const data = { type: 'imperfect:assemble', step: 'done' };
    dispatchEvent(new MessageEvent('message', { data, origin, source: window }));
    dispatchEvent(new MessageEvent('message', { data, origin: 'https://not-the-launch.example', source: parent }));
  }, appOrigin);
  for (let i = 0; i < 4; i++) await twoFrames();
  assert.equal(await page.evaluate(key => window[key].length, ackKey), before, `${selector} ignores forged assembly`);
  await page.evaluate(({ selector, origin }) => document.querySelector(selector).contentWindow.postMessage({ type: 'imperfect:assemble', step: 'done' }, origin), { selector, origin: product.origin });
  await page.waitForFunction(({ key, count }) => window[key].length === count + 1, { key: ackKey, count: before });
  await chooser('done', frame);
}
async function build(identity) {
  await page.waitForFunction(() => window.__launch().mac.revealed && document.querySelector('#curtain').hidden);
  await child().waitForFunction(() => document.documentElement.dataset.assemblyStep === 'bare');
  await chooser('bare'); await shot('05-bare');
  const browserBeforeDone = product.seen.browser.length;
  await page.evaluate(origin => document.querySelector('#computer').contentWindow.postMessage({ type: 'imperfect:open', url: 'https://imperfect.computer/shop?os=mac' }, origin), product.origin);
  for (let i = 0; i < 4; i++) await twoFrames();
  assert.equal(product.seen.browser.length, browserBeforeDone, 'building primary refuses Shop until assembly is done');
  await page.locator('.mac-dock').screenshot({ path: join(evidence, `${label}-dock-initial-2x.png`), scale: 'device' });
  const dimensions = await geometry(), windowBox = await page.locator('.mac-window').boundingBox();
  await page.evaluate(({ rect, identity }) => {
    window.__beforePhoneRect = rect; window.__beforePhoneIdentity = identity;
    window.__sameComputerFrame = document.querySelector('#computer');
  }, { rect: await nativeRect('.mac-window'), identity });
  for (const step of ['claude', 'codex', 'files', 'browser']) {
    await page.waitForFunction(step => window.__acks.some(ack => ack.step === step), step, { timeout: 40000 });
    await chooser(step);
    if (step === 'files') await child().locator('.workbench').first().waitFor();
    if (step === 'browser') await child().locator('.browser-live-view').first().waitFor();
    if (step !== 'browser') assert.deepEqual(await page.locator('.mac-window').boundingBox(), windowBox, 'same window geometry throughout assembly before the phone beat');
    else assert.deepEqual(await child().evaluate(() => [innerWidth, innerHeight]), dimensions, 'phone slide never resizes primary viewport');
  }
  await page.waitForFunction(() => window.__launch().phase === 'demo', null, { timeout: 45000 });
  await Promise.all(pendingShots);
  const phoneEvidence = await Promise.all(phoneChecks);
  assert.deepEqual(errors, [], 'phone event inspections completed without errors');
  assert.deepEqual(phoneEvidence.map(event => event.phase), ['shown', 'returned']);
  assert.equal(phoneEvidence[0].phoneIdentity, phoneEvidence[1].phoneIdentity, 'same phone document through return');
  assert.equal(await child().evaluate(() => window.__documentIdentity), identity, 'same real document from the unlock to done');
  assert.deepEqual(await geometry(), dimensions);
  assert.deepEqual(drops.map(drop => drop.name), ['claude', 'chatgpt', 'finder', 'safari', 'final-cut', 'imovie', 'notes']);
  const timing = await page.evaluate(() => ({ drops: window.__drops, sounds: window.__dropSounds, targets: window.__dropTargets, acks: window.__acks, voices: window.__voices, phases: window.__phases,
    phone: window.__phoneEvents, phoneAcks: window.__phoneAcks, phoneLoads: window.__phoneLoads }));
  assert.equal(timing.phoneLoads.length, 1, 'phone document loaded only once');
  assert.ok(timing.phoneLoads.every(load => load.ready && load.verified), 'phone only loads after primary exact-source readiness');
  assert.ok(timing.phoneAcks.some(ack => ack.step === 'done'), 'phone independently acknowledges done');
  assert.ok(timing.phone[0].at >= timing.acks.find(ack => ack.step === 'browser').at, 'phone follows real browser paint');
  assert.ok(timing.phone[1].at < timing.drops[4].observedAt, 'phone returns before the trash beat');
  assert.ok(timing.phone[1].at - timing.phone[0].at >= 1000, 'phone is held briefly, not flashed');
  assert.equal(timing.sounds.length, 7, 'one sound for every actual drop');
  for (let i = 0; i < timing.drops.length; i++) {
    const drop = timing.drops[i], sound = timing.sounds[i];
    assert.ok(Math.abs(sound - drop.observedAt) <= 35, `${drop.name}: sound on drop frame`);
    const target = i < 4 ? windowBox : timing.targets[i];
    assert.ok(drop.x >= target.x && drop.x <= target.x + target.width && drop.y >= target.y && drop.y <= target.y + target.height, `${drop.name}: correct drop target`);
    if (i < 4) {
      const step = ['claude', 'codex', 'files', 'browser'][i];
      const ack = timing.acks.find(ack => ack.step === step && ack.at >= drop.observedAt - 2);
      assert.ok(ack, `${step}: painted acknowledgment`);
      assert.ok(ack.at - sound <= 80 && ack.at >= sound - 2, `${step}: sound-to-painted ${ack.at - sound}ms <=80ms`);
    }
  }
  const voices = timing.voices;
  assert.deepEqual(voices.map(voice => voice.src), ['line-0.m4a', 'line-1.m4a', 'line-2.m4a', 'line-3.m4a', 'line-4.m4a', 'line-phone.m4a', 'line-5.m4a', 'line-6.m4a'], 'exactly eight real recordings, phone between browser and trash');
  assert.ok(voices.every(voice => voice.endedAt > voice.at), 'all real recordings finish');
  for (let i = 1; i < voices.length; i++) assert.ok(voices[i].at >= voices[i - 1].endedAt, 'narration never overlaps/truncates');
  const duration = voices.at(-1).endedAt - voices[0].at;
  assert.ok(duration >= 18000 && duration <= 43000, `simple build with a brief phone beat, measured ${duration}ms`);
  assert.deepEqual(product.seen.tickets, [{ valid: true, id: 'noah' }], 'one valid ticket per visit for both product roots');
  noSessionWrites();
  await chooser('done'); await assertChooserStayed(); await assertChooserStayed(phoneChild());
  await assemblyGuards(child(), '#computer', '__acks');
  assert.equal(product.tabs.length, 1, 'one Google browser tab, not one per step');
  assert.equal(product.seen.browser.filter(c => c.do === 'open').length, 1);
  await writeFile(join(evidence, `${label}-timing.json`), JSON.stringify({ ...timing, phoneEvidence, duration, roots: product.seen.roots, runtimeCommands: product.seen.commands.map(c => c.type), browser: product.seen.browser, assembly: (await state()).assembly }, null, 2));
  const nativeStyle = await child().evaluate(() => ({
    cancel: getComputedStyle(document.querySelector('.agent-choose-cancel')).display,
    harness: [...document.querySelectorAll('.agent-choose-harness')].map(button => [button.offsetWidth, button.offsetHeight]),
    computer: [...document.querySelectorAll('[data-computer]')].map(button => [button.offsetWidth, button.offsetHeight]),
    rail: getComputedStyle(document.querySelector('.session-rail-open')).minHeight,
  }));
  assert.equal(nativeStyle.cancel, 'none', 'a coarse pointer must not enable mobile chooser controls inside the desktop');
  if (desktopProductStyle) assert.deepEqual(nativeStyle, desktopProductStyle, 'the real product has identical desktop metrics at every viewport/pointer type');
  else desktopProductStyle = nativeStyle;
  await shot('trash-beat'); await shot('finished');
}
async function menu(key, item) {
  await page.locator(`.shell-menu-trigger[data-menu="${key}"]`).click();
  if (item) await page.getByRole('menuitem', { name: item }).click();
}
async function shell() {
  const main = page.locator('[data-window-id="imperfect"]');
  const identity = await child().evaluate(() => window.__documentIdentity);
  await page.evaluate(() => { window.__sameComputerFrame = document.querySelector('#computer'); });
  const scale = page.viewportSize().width === 1600 ? 1 : Math.min(page.viewportSize().width / 1600, page.viewportSize().height / 900);
  const desktop = await page.locator('#macScreen').boundingBox();
  await page.mouse.click(desktop.x + 30 * scale, desktop.y + 450 * scale);
  assert.equal(await page.locator('.shell-app-menu').innerText(), 'Finder');
  assert.equal(await main.getAttribute('data-focused'), 'false');
  const focusBox = await page.locator('#computer').boundingBox();
  await page.mouse.click(focusBox.x + focusBox.width * .7, focusBox.y + 12 * scale);
  await page.waitForFunction(() => document.querySelector('.shell-app-menu').textContent === 'imperfect');
  assert.equal(await main.getAttribute('data-focused'), 'true');
  const lightMetrics = await main.locator('.shell-lights').evaluate(group => {
    const style = getComputedStyle(group), button = getComputedStyle(group.firstElementChild);
    return { left: style.left, top: style.top, gap: style.gap, width: button.width, height: button.height };
  });
  assert.deepEqual(lightMetrics, { left: '20px', top: '11px', gap: '8px', width: '12px', height: '12px' });
  if (label === 'desktop') {
    await main.locator('.shell-lights').hover();
    await main.locator('.shell-lights').screenshot({ path: join(evidence, 'desktop-lights-hover-2x.png'), scale: 'device' });
  }
  // All menu/status items open real authored menus/popovers, switch on hover,
  // and Escape closes. Disabled items remain disabled.
  await menu('window'); await shot('menu');
  await page.locator('[data-menu="file"]').hover();
  assert.equal(await page.getByRole('menu', { name: 'File', exact: true }).count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('menu').count(), 0);
  for (const key of ['apple', 'app', 'file', 'edit', 'view', 'window', 'help', 'shop', 'control', 'wifi', 'battery', 'spotlight', 'siri', 'clock']) {
    await menu(key);
    assert.equal(await page.locator('.shell-menu,.shell-popover').count(), 1, `${key} is clickable`);
    if (key === 'edit') assert.equal(await page.getByRole('menuitem', { name: /^Undo/ }).isDisabled(), true);
    await page.keyboard.press('Escape');
  }
  await menu('apple', /^About This Mac$/);
  await page.locator('[data-window-id="about"]').waitFor(); await shot('about');
  await page.getByRole('button', { name: 'Close About This Mac', exact: true }).click();
  // Drag actual iframe titlebar pixels, not a forged message or parent overlay.
  const before = await main.boundingBox(), frameBox = await page.locator('#computer').boundingBox();
  await page.mouse.move(frameBox.x + frameBox.width * .7, frameBox.y + 12 * scale);
  await page.mouse.down();
  await page.mouse.move(frameBox.x + frameBox.width * .7 + 55 * scale, frameBox.y + 37 * scale, { steps: 8 });
  await page.mouse.up(); await twoFrames();
  const after = await main.boundingBox();
  assert.ok(after.x - before.x > 30 * scale && after.y - before.y > 10 * scale, 'real framed product drag moves window at current stage scale');
  await shot('moved');
  await menu('window', /^Minimize/);
  await page.waitForFunction(() => document.querySelector('[data-window-id="imperfect"]').dataset.windowState === 'minimized');
  const thumbnail = page.locator('[data-window-thumbnail="imperfect"]');
  assert.equal(await thumbnail.count(), 1, 'minimized window has its own Dock thumbnail');
  assert.equal(await thumbnail.locator('iframe').count(), 0, 'thumbnail never duplicates the product document');
  const order = await page.locator('.mac-dock').evaluate(dock => {
    const children = [...dock.children];
    return { divider: children.findLastIndex(el => el.classList.contains('shell-dock-divider')),
      thumb: children.findIndex(el => el.dataset.windowThumbnail === 'imperfect'), trash: children.findIndex(el => el.dataset.app === 'trash') };
  });
  assert.ok(order.divider < order.thumb && order.thumb < order.trash, 'thumbnail is after separator and before Trash');
  assert.ok((await thumbnail.boundingBox()).width > 0);
  assert.equal(await page.locator('iframe').count(), 2);
  await shot('minimized');
  await thumbnail.getByRole('button', { name: 'Restore imperfect', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-window-id="imperfect"]').dataset.windowState === 'open');
  const reverse = await main.evaluate(el => el.getAnimations().map(a => a.effect.getKeyframes()));
  assert.ok(reverse.some(keys => keys[0].scale !== keys.at(-1).scale && /^1(?: 1)?$/.test(keys.at(-1).scale)), 'thumbnail click restores with the reverse scale animation');
  await main.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
  assert.equal(await thumbnail.count(), 0, 'restoring removes only the CSS thumbnail');
  nearRect(await main.boundingBox(), { x: after.x, y: after.y, width: after.width, height: after.height }, 'minimize restores moved rectangle', .5);
  await shot('restored-from-thumbnail');
  await page.getByRole('button', { name: 'Close imperfect', exact: true }).click();
  assert.equal(await main.getAttribute('data-window-state'), 'closed');
  assert.equal(await page.locator('[data-app="imperfect"] .mac-run').count(), 1, 'closing window keeps running dot');
  await page.locator('[data-app="imperfect"] .dock-icon').click();
  nearRect(await nativeRect('[data-window-id="imperfect"]'), DEFAULT_RECT, 'closed window reopens at default geometry');
  await shot('reopened');
  assert.equal(await page.evaluate(() => document.querySelector('#computer') === window.__sameComputerFrame), true);
  assert.equal(await child().evaluate(() => window.__documentIdentity), identity, 'close/minimize/reopen never reloads product');
  const unzoomed = await main.boundingBox();
  await page.getByRole('button', { name: 'Zoom imperfect', exact: true }).click();
  nearRect(await nativeRect('[data-window-id="imperfect"]'), { x: 0, y: 25, width: 1600, height: 796 }, 'green zoom fills the exact menu-to-Dock band');
  assert.deepEqual(await child().evaluate(() => [innerWidth, innerHeight]), [1600, 796], 'zoom changes the same product’s viewport');
  await shot('zoomed');
  await page.getByRole('button', { name: 'Zoom imperfect', exact: true }).click();
  nearRect(await main.boundingBox(), { x: unzoomed.x, y: unzoomed.y, width: unzoomed.width, height: unzoomed.height }, 'green unzoom restores rectangle');
  assert.deepEqual(await child().evaluate(() => [innerWidth, innerHeight]), [1280, 796]);
  await page.locator('[data-app="trash"] .dock-icon').click();
  const trash = page.locator('[data-window-id="trash"]'); await trash.waitFor();
  assert.deepEqual(await trash.locator('.shell-finder-item span').allTextContents(), ['Final Cut Pro.app', 'iMovie.app', 'Notes.app']);
  assert.equal(await page.locator('[data-app="trash"]').getAttribute('data-full'), 'true');
  await shot('trash-window');
  await page.getByRole('button', { name: 'Close Trash', exact: true }).click();
  const tiles = await page.locator('.dock-slot .dock-icon img').evaluateAll(images => {
    const scale = document.querySelector('#macScreen').getBoundingClientRect().width / 1600;
    return images.filter(img => img.getBoundingClientRect().width > 0).map(img => ({ w: img.getBoundingClientRect().width / scale, h: img.getBoundingClientRect().height / scale, ready: img.complete && img.naturalWidth > 0 }));
  });
  assert.ok(tiles.length >= 5 && tiles.every(tile => tile.ready && Math.abs(tile.w - 64) < .1 && Math.abs(tile.h - 64) < .1), 'even loaded Dock grid, including actual transforms rather than just computed CSS width');
  await page.waitForTimeout(700); // Capture the resting icon grid, not a clipped launch bounce.
  await page.locator('.mac-dock').screenshot({ path: join(evidence, `${label}-dock-2x.png`), scale: 'device' });
  await shopBridge();
  assert.equal(await child().evaluate(() => window.__documentIdentity), identity, 'Shop never reloads product');
  noSessionWrites(); await chooser('done'); await assertChooserStayed();
  await shot('usable-real-product');
}
async function shopOpenGuards(url) {
  const before = product.seen.browser.length;
  await child().evaluate(({ url, origin }) => {
    const data = { type: 'imperfect:open', url };
    dispatchEvent(new MessageEvent('message', { data, origin, source: window }));
    dispatchEvent(new MessageEvent('message', { data, origin: 'https://not-the-launch.example', source: parent }));
  }, { url, origin: appOrigin });
  const invalid = [
    'http://imperfect.computer/shop', 'https://www.imperfect.computer/shop',
    'https://imperfect.computer.evil.test/shop', 'https://imperfect.computer/shop/',
    'https://imperfect.computer/account', 'https://imperfect.computer/shop#receipt',
    'https://someone@imperfect.computer/shop', 'https://imperfect.computer:444/shop',
    'https://imperfect.computer:443/shop', 'https://imperfect.computer/shop#',
    'https://imperfect.computer/shop?os=macos', 'https://imperfect.computer/shop?os=phone',
    'https://imperfect.computer/shop?os=mac&os=linux', 'https://imperfect.computer/shop?extra=1',
    'https://imperfect.computer/shop?os=mac&extra=1', 'javascript:alert(1)',
  ];
  await page.evaluate(({ origin, invalid }) => {
    for (const url of invalid) document.querySelector('#computer').contentWindow.postMessage({ type: 'imperfect:open', url }, origin);
    const phone = document.querySelector('#phoneComputer');
    if (phone?.getAttribute('src')) phone.contentWindow.postMessage({ type: 'imperfect:open', url: 'https://imperfect.computer/shop?os=mac' }, origin);
  }, { origin: product.origin, invalid });
  for (let i = 0; i < 4; i++) await twoFrames();
  assert.equal(product.seen.browser.length, before, 'wrong source/origin, invalid URLs and inert phone never reach browser transport');
}
async function shopBridge({ repeat = true } = {}) {
  const main = page.locator('[data-window-id="imperfect"]');
  const identity = await child().evaluate(() => window.__documentIdentity);
  await page.evaluate(() => { window.__sameComputerFrame ||= document.querySelector('#computer'); });
  const phoneIdentity = phoneChild() && await phoneChild().evaluate(() => window.__documentIdentity);
  const os = { desktop: 'linux', portrait: 'mobile', landscape: 'mac', 'windows-shop': 'windows' }[label];
  assert.ok(os, 'explicit visitor OS expectation for every Shop integration case');
  const url = `https://imperfect.computer/shop?os=${os}`;
  const remotePlatform = await child().evaluate(() => navigator.platform);
  assert.match(remotePlatform, /Linux/, 'visitor mocking never changes the Linux computer showing its browser');
  await shopOpenGuards(url);
  await child().locator('.browser-live-view').waitFor();
  // Real product shortcut closes the pane, not its remote browser/tab.
  await child().locator('.browser-live-note').click(); // Focus the real iframe; no picture exists to send input to.
  await child().locator('.browser-live-view').hover();
  await page.keyboard.press('Alt+w');
  await child().locator('.wm-live').waitFor({ state: 'detached' });
  assert.equal(product.tabs.length, 1, 'closing a browser pane preserves the Google tab');
  const opensBefore = product.seen.browser.filter(command => command.do === 'open').length;
  const receipts = [];
  for (const previous of repeat ? ['minimized', 'closed', 'minimized'] : ['closed']) {
    if (previous === 'minimized') await menu('window', /^Minimize/);
    else await page.getByRole('button', { name: 'Close imperfect', exact: true }).click();
    await page.waitForFunction(previous => document.querySelector('[data-window-id="imperfect"]').dataset.windowState === previous, previous);
    const beforeMessage = await child().evaluate(() => window.__openRequests.length);
    await menu('shop', /^Shop imperfect/);
    await child().waitForFunction(({ count, url }) => window.__openRequests.length === count + 1 && window.__openRequests.at(-1).url === url, { count: beforeMessage, url });
    assert.equal(await main.getAttribute('data-window-state'), 'open', 'Shop restores the same closed/minimized main window');
    assert.equal(await main.getAttribute('data-focused'), 'true', 'Shop focuses the main imperfect window');
    assert.equal(await page.locator('.shell-app-menu').innerText(), 'imperfect');
    await child().locator('.browser-live-view').waitFor({ state: 'visible' });
    await child().waitForFunction(url => document.querySelector('.wm-live .gui-window-address')?.value === url, url);
    assert.equal(await child().locator('.wm-live').count(), 1, 'one visible real browser pane, including after it was closed');
    assert.match(await child().locator('.browser-live-note').innerText(), /Isolated test transport: external websites are not loaded/);
    assert.equal(await page.locator('[data-window-id="shop"],[data-window-thumbnail="shop"]').count(), 0, 'Shop has no extra Mac window or Dock thumbnail');
    assert.equal(await page.locator('iframe').count(), 2, 'only persistent primary and inert phone frames');
    assert.equal(await child().evaluate(() => window.__documentIdentity), identity);
    assert.equal(await page.evaluate(() => document.querySelector('#computer') === window.__sameComputerFrame), true);
    const sent = await child().evaluate(() => window.__openRequests.at(-1));
    assert.deepEqual(sent, { type: 'imperfect:open', url }, 'parent posts the exact narrow Shop contract');
    const official = product.tabs.filter(tab => new URL(tab.url).origin === 'https://imperfect.computer' && new URL(tab.url).pathname === '/shop');
    assert.equal(official.length, 1, 'repeated menu entries reuse ONE Shop browser tab');
    assert.equal(product.tabs.length, 2, 'Google plus Shop, not an accumulating tab per click');
    assert.equal(official[0].url, url, 'Shop keeps visitor provenance, not the remote Linux platform or a switched instruction label');
    assert.equal(official[0].front, true);
    assert.ok(product.seen.browser.some(command => command.do === 'front' && command.tab === official[0].tab), 'real browser front transport used');
    await main.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))));
    await twoFrames();
    nearRect(await nativeRect('[data-window-id="imperfect"]'), DEFAULT_RECT, 'Shop restores the full native main window, not a mid-animation miniature');
    receipts.push({ previous, url, tab: official[0].tab, main: await nativeRect('[data-window-id="imperfect"]') });
  }
  assert.equal(product.seen.browser.filter(command => command.do === 'open').length, opensBefore + 1, 'only one new native Shop tab across restores');
  assert.ok(product.seen.browserSources.every(source => !source || !new URL(source).searchParams.has('launch')), 'phone root never calls browser tools');
  assert.ok(product.seen.watchSources.every(source => !source || !new URL(source).searchParams.has('launch')), 'phone root never watches the browser');
  assert.ok((await child().evaluate(() => window.__browserConnections)).length > 0, 'primary really watches the browser');
  if (phoneIdentity) {
    assert.equal(await phoneChild().evaluate(() => window.__documentIdentity), phoneIdentity);
    assert.deepEqual(await phoneChild().evaluate(() => window.__browserConnections), [], 'inert phone never connects to the browser stream');
  }
  assert.equal(await page.locator('#computer').evaluate(el => el === window.__sameComputerFrame), true);
  await chooser('done'); await assertChooserStayed(); noSessionWrites();
  await shot('main-Shop'); // Honest isolated-stream state, NOT a fabricated Shop render.
  await writeFile(join(evidence, `${label}-shop-bridge.json`), JSON.stringify({ receipts, remotePlatform, browser: product.seen.browser, tabs: product.tabs }, null, 2));
}
async function directShop() {
  // The fixture stream cannot show HTTP pages. This extra NORMAL page is a
  // test-only receipt of the actual public store, never a substitute VM frame.
  const viewport = await child().locator('.browser-live-view').evaluate(view => ({ width: view.clientWidth, height: view.clientHeight }));
  assert.ok(Number.isInteger(viewport.width) && viewport.width > 0 && Number.isInteger(viewport.height) && viewport.height > 0);
  const direct = await context.newPage();
  const requests = [], assets = [], failures = [], violations = [];
  direct.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  direct.on('response', response => { if (new URL(response.url()).origin === appOrigin) assets.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  direct.on('pageerror', error => failures.push(error.message));
  direct.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
  direct.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused.*(?:script|style)/i.test(message.text())) violations.push(message.text()); });
  await direct.setViewportSize(viewport);
  const capture = name => direct.screenshot({ path: join(evidence, `${label}-${name}.png`), caret: 'hide', scale: 'css' });
  async function install(platform) {
    assert.equal(await direct.locator('#install-command').innerText(), INSTALL_COMMAND);
    assert.equal(await direct.locator('#install-label').innerText(), platform === 'mac' ? 'Install on your Mac' : 'Install on Linux');
    assert.equal(await direct.locator('#install-hint').innerText(), platform === 'mac' ? 'Open Terminal and paste this.' : 'Paste this in a terminal.');
    assert.equal(await direct.locator(`[data-platform="${platform}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await direct.locator(`[data-platform="${platform === 'mac' ? 'linux' : 'mac'}"]`).getAttribute('aria-pressed'), 'false');
    assert.equal(await direct.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'real pane-width page has no horizontal overflow');
  }
  try {
    const response = await direct.goto(`${appOrigin}/shop?os=mac`);
    assert.equal(response.status(), 200, 'normal standalone GET, not a Mac-shell dependency');
    assert.equal(response.headers()['cache-control'], 'no-store');
    assert.ok(response.headers()['content-security-policy'], 'real store CSP is enforced');
    assert.deepEqual(await direct.evaluate(() => window.__cspViolations), []);
    assert.equal(await direct.evaluate(() => navigator.platform), 'Linux x86_64');
    await direct.locator('[data-invite]:visible').waitFor();
    assert.match(await direct.locator('[data-rent-note]').innerText(), /not.*open|invitation/i);
    assert.match(await direct.locator('.shop-price').first().innerText(), /40/);
    assert.equal(await direct.locator('iframe').count(), 0, 'public Shop has no launch/product frame dependency');
    assert.ok(requests.every(request => !/\/mac\/|\/js\/harness/.test(new URL(request.url).pathname)));
    for (const path of ['/shop.js', '/shop.css', '/shop-platform.mjs']) assert.ok(assets.some(asset => asset.path === path && asset.status === 200), `${path} really loaded under CSP`);
    await capture('shop-page');
    const untouched = { posts: shop.posts.length, polls: shop.polls, created: shop.created.length, retrieved: shop.retrieved.length, pages: context.pages().length };
    await direct.locator('[data-code-bypass]').click();
    await direct.locator('#install-panel').waitFor({ state: 'visible' });
    await install('mac'); // Query provenance overrides this page's Linux navigator.
    await direct.locator('[data-platform="linux"]').click(); await install('linux');
    await direct.locator('[data-platform="mac"]').click(); await install('mac');
    await direct.locator('#copy-command').click();
    await direct.waitForFunction(command => window.__copied === command, INSTALL_COMMAND);
    await capture('shop-page-code');
    assert.deepEqual({ posts: shop.posts.length, polls: shop.polls, created: shop.created.length, retrieved: shop.retrieved.length, pages: context.pages().length }, untouched, 'bypass/switch/copy makes no checkout, status request, Stripe retrieval or new tab');
    assert.equal(await direct.locator('#shop-code-form [type="submit"]').isEnabled(), true, 'optional payment remains available');
    await direct.locator('#shop-amount').fill('0');
    await direct.locator('#shop-code-form [type="submit"]').click();
    await direct.locator('[data-error]').filter({ hasText: /amount/i }).waitFor();
    assert.equal(shop.posts.length, untouched.posts, 'invalid amount never reaches the server');
    await direct.locator('#shop-amount').fill('12.34');
    const pageCount = context.pages().length, samePage = direct;
    await direct.locator('#shop-code-form [type="submit"]').click();
    await direct.waitForURL('https://checkout.stripe.com/**');
    assert.equal(direct, samePage); assert.equal(context.pages().length, pageCount, 'Buy replaces THIS page, no Checkout popup');
    const checkout = shop.created.at(-1);
    assert.equal(new URL(direct.url()).pathname, `/c/pay/${checkout.id}`);
    assert.deepEqual(shop.posts, [{ amount: 12.34, os: 'mac' }], 'real POST preserves visitor OS despite Linux rendering and instruction switches');
    assert.equal(shop.created.length, 1);
    assert.equal(checkout.params.line_items[0].price_data.unit_amount, 1234, 'actual server converts dollars to Stripe cents');
    assert.equal(checkout.params.line_items[0].price_data.currency, 'usd');
    assert.equal(checkout.params.metadata.product, 'source-support');
    assert.equal(checkout.params.mode, 'payment'); assert.ok(checkout.options.idempotencyKey);
    assert.equal(new URL(checkout.params.success_url).searchParams.get('os'), 'mac');
    assert.equal(new URL(checkout.params.cancel_url).searchParams.get('os'), 'mac');
    assert.equal(shop.polls, 0); assert.deepEqual(shop.retrieved, [], 'unpaid Checkout waits for the human, not a client status timer');
    await capture('shop-checkout-fixture');
    sessions.get(checkout.id).payment_status = 'paid';
    await direct.locator('#test-return').click();
    await direct.waitForURL(`${appOrigin}/shop/thanks?**`);
    assert.equal(new URL(direct.url()).searchParams.get('os'), 'mac');
    await direct.getByRole('heading', { name: 'Thank you', exact: true }).waitFor();
    await direct.waitForFunction(() => document.querySelector('#install-label')?.textContent === 'Install on your Mac');
    await install('mac');
    assert.equal(await direct.evaluate(() => navigator.platform), 'Linux x86_64');
    assert.equal(context.pages().length, pageCount, 'receipt returns to the same normal browser page');
    assert.ok(shop.retrieved.includes(checkout.id), 'actual thanks server retrieves paid Stripe session in-process');
    assert.equal(shop.told.length, 1, 'real paid store notifies only the isolated sale sink');
    await direct.locator('#copy-command').click();
    await direct.waitForFunction(command => window.__copied === command, INSTALL_COMMAND);
    await direct.evaluate(() => scrollTo(0, 0)); await capture('shop-thanks');
    await direct.locator('[data-platform="linux"]').click(); await install('linux');
    await direct.locator('[data-platform="mac"]').click(); await install('mac');
    assert.equal(shop.polls, 0, 'standalone Shop and Thanks NEVER call legacy HTTP status polling');
    assert.ok(requests.every(request => !new URL(request.url).pathname.startsWith('/shop/code/status')));
    assert.deepEqual(await direct.evaluate(() => window.__cspViolations), []);
    assert.deepEqual(violations, []); assert.deepEqual(failures, []); assert.deepEqual(errors, []);
    await writeFile(join(evidence, `${label}-shop-page.json`), JSON.stringify({ viewport, navigator: 'Linux x86_64', os: 'mac', requests, assets, ...shop, command: INSTALL_COMMAND }, null, 2));
    noSessionWrites(); passes++; console.log('PASS standalone Shop: real pane dimensions, same-tab isolated Stripe, real paid Thanks, OS override and no polling');
  } finally { await direct.close(); await page.bringToFront(); }
}
async function security({ offline = false } = {}) {
  await open(offline ? 'offline' : 'late', { reduced: true, mode: offline ? 'offline' : 'manual' });
  await unlock({ skip: true });
  await page.waitForFunction(() => window.__launch().mac.finished && window.__launch().mac.revealed);
  await page.evaluate(() => postMessage({ type: 'imperfect:demo-ready' }, '*'));
  await twoFrames();
  assert.equal((await state()).demoVerified, false, 'parent-source forged readiness refused');
  assert.equal(await page.locator('#demoScreen').getAttribute('aria-hidden'), 'true');
  await shot('unverified');
  const beforeShop = product.seen.browser.length;
  await menu('shop', /^Shop imperfect/); await twoFrames();
  assert.equal(product.seen.browser.length, beforeShop, 'unverified/offline Shop never contacts browser transport');
  assert.deepEqual(await child().evaluate(() => window.__openRequests), [], 'parent does not post Shop before exact authenticated readiness');
  assert.match(await page.locator('#announce').textContent(), /shop|computer|ready|connect|opening|unavailable|wait/i, 'unready Shop uses the existing live announcement, not the hidden film prompt');
  if (offline) {
    await page.locator('.mac-offline').waitFor(); product.mode = 'ready';
    await page.locator('#macRetry').click();
  } else {
    await child().evaluate(origin => parent.postMessage({ type: 'imperfect:demo-ready' }, origin), appOrigin);
  }
  await page.waitForFunction(() => window.__launch().phase === 'demo');
  await shot('recovered');
  await geometry(); await chooser('done');
  noSessionWrites();
  assert.equal(product.seen.roots.filter(root => root.launch === 'phone').length, 0, 'skip/reduced recovery never loads phone');
  await child().evaluate(() => { location.href = '/elsewhere'; });
  await page.waitForFunction(() => !window.__launch().demoVerified);
  assert.equal(await page.locator('#demoScreen').getAttribute('aria-hidden'), 'true', 'navigation revokes readiness');
  assert.deepEqual(errors, []); passes++; console.log('PASS', label, 'exact-source readiness, hidden error, recovery, navigation revocation');
}
try {
  for (const name of Object.keys(sizes)) {
    if (process.env.ONLY && !['all', name].includes(process.env.ONLY)) continue;
    await open(name); const identity = await opener(); await build(identity); await shell();
    await Promise.all(pendingShots); assert.deepEqual(errors, []);
    passes++; console.log('PASS', name, 'real product/phone assembly, desktop shell and scoped Shop browser bridge');
    if (name === 'desktop') await directShop();
  }
  if (!process.env.ONLY || ['all', 'reduced'].includes(process.env.ONLY)) {
    await open('reduced', { reduced: true }); await unlock({ skip: true });
    await page.waitForFunction(() => window.__launch().phase === 'demo');
    await chooser('done'); await geometry(); await shot('finished');
    assert.equal(drops.length, 0, 'skip/reduced motion goes straight to finished product');
    assert.deepEqual(filmRequests, [], 'no film downloaded on the skip path either');
    noSessionWrites();
    const skipped = await page.evaluate(() => ({ events: window.__phoneEvents, loads: window.__phoneLoads, voices: window.__voices,
      phoneSrc: document.querySelector('#phoneComputer')?.getAttribute('src') }));
    assert.deepEqual(skipped.events, [], 'skip/reduced motion has no phone slide');
    assert.deepEqual(skipped.loads, [], 'skip/reduced motion does not load the phone document');
    assert.ok(!skipped.phoneSrc, 'phone remains an unloaded inert frame on skip');
    assert.deepEqual(skipped.voices, [], 'skip/reduced motion plays no new narration');
    assert.equal(product.seen.roots.filter(root => root.launch === 'phone').length, 0);
    assert.deepEqual(product.seen.tickets, [{ valid: true, id: 'noah' }]);
    assert.deepEqual(errors, []); passes++; console.log('PASS reduced/skip: lock retained; real finished chooser without animation');
  }
  if (!process.env.ONLY || ['all', 'windows-shop'].includes(process.env.ONLY)) {
    await open('windows-shop', { reduced: true, platform: 'Win32' }); await unlock({ skip: true });
    await page.waitForFunction(() => window.__launch().phase === 'demo');
    await chooser('done'); await shopBridge({ repeat: false }); noSessionWrites();
    assert.deepEqual(errors, []); passes++; console.log('PASS Windows visitor: scoped Shop message with os=windows');
  }
  if (!process.env.ONLY || ['all', 'offline'].includes(process.env.ONLY)) await security({ offline: true });
  if (!process.env.ONLY || ['all', 'late'].includes(process.env.ONLY)) await security();
  console.log(`${passes} browser scenarios passed`);
} finally {
  await context?.close(); await browser.close(); await app.close(); store.close();
  await product.close(); await rm(privateDir, { recursive: true, force: true });
}
