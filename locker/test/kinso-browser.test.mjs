import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launchChromium } from '../../tools/test-browser.mjs';
import { WebSocket } from 'ws';
import { kinsoLaunch } from './fixtures/kinso-launch.mjs';

// Full-HD and phone stills, each one real sequence. No installed server, model or inbox.
const evidenceRoot = process.env.KINSO_STILLS && resolve(process.env.KINSO_STILLS);
for (const width of [1920, 390]) test(`Kinso ${width}: burst, sharks, film slots, every build beat and exact returned-computer handoff`, { timeout: 240000 }, async () => {
  const height = width === 390 ? 844 : 1080;
  const evidence = evidenceRoot && join(evidenceRoot, String(width));
  const f = await kinsoLaunch({ exactOrigins: true });
  let browser, context;
  const faults = [], requests = [], sockets = [], responses = [], stages = [];
  try {
    if (evidence) await mkdir(evidence, { recursive: true });
    browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'] });
    context = await browser.newContext({ viewport: { width, height }, hasTouch: width === 390, deviceScaleFactor: 1 });
    // Exact deployed origins, with HTTP + agent WebSocket transports sent
    // only to isolated loopback fixtures. No public DNS/network requests.
    const origins = new Map([[f.origin, f.transportOrigin], [f.product.origin, f.product.transportOrigin]]);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()), transport = origins.get(url.origin);
      if (!transport) return route.abort();
      // SSE is a transport too: route.fetch buffers forever on a live stream.
      if (url.origin === f.product.origin && url.pathname === '/files/events') return route.fulfill({ contentType: 'text/event-stream', body: ': isolated fixture\nretry: 60000\n\n' });
      // Resolve fixture redirects here: Chromium/Electron may follow a
      // fulfilled 302 outside interception. Never let it reach public DNS.
      const headers = { ...await route.request().allHeaders(), host: url.host };
      let target = `${transport}${url.pathname}${url.search}`, response;
      const cookies = [];
      for (let hop = 0; hop < 5; hop++) {
        response = await route.fetch({ url: target, headers, maxRedirects: 0 });
        const cookie = response.headers()['set-cookie'];
        if (cookie) { cookies.push(cookie); headers.cookie = [...cookies.map(value => value.split(';')[0])].join('; '); }
        if (![301, 302, 303, 307, 308].includes(response.status())) break;
        const next = new URL(response.headers().location, target);
        assert.equal(next.origin, transport, 'fixture redirects never leave loopback');
        target = next.href;
      }
      assert.ok(![301, 302, 303, 307, 308].includes(response.status()), 'bounded fixture redirect chain');
      return route.fulfill({ response, headers: { ...response.headers(), ...(cookies.length ? { 'set-cookie': cookies.join('\n') } : {}) } });
    });
    await context.routeWebSocket('**/*', async route => {
      sockets.push(route.url());
      const url = new URL(route.url()), transport = origins.get(url.origin.replace(/^ws/, 'http'));
      if (!transport) { route.close(); return; }
      const cookies = await context.cookies(f.product.origin);
      const ws = new WebSocket(`${transport.replace(/^http/, 'ws')}${url.pathname}${url.search}`, {
        headers: { origin: f.product.origin, cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') },
      });
      const queued = [];
      route.onMessage(message => { if (ws.readyState === WebSocket.OPEN) ws.send(message); else queued.push(message); });
      ws.on('open', () => { for (const message of queued) ws.send(message); });
      ws.on('message', data => route.send(String(data)));
      ws.on('error', () => route.close());
      ws.on('close', () => route.close());
      route.onClose(() => ws.close());
    });
    await context.addInitScript(() => { window.__introClock = 100; window.__kinsoRate = 3; });
    const page = await context.newPage();
    page.on('pageerror', e => faults.push(e.message));
    page.on('request', req => { requests.push(new URL(req.url()).pathname); });
    page.on('response', response => responses.push({ path: new URL(response.url()).pathname, status: response.status() }));
    const shot = async name => {
      stages.push(name);
      const caption = page.locator('.kinso-caption:visible');
      if (await caption.count()) {
        const box = await caption.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= height,
          `${name}: narration stays inside the screen: ${JSON.stringify(box)}`);
      }
      if (evidence) await page.screenshot({ path: join(evidence, `${String(stages.length).padStart(2, '0')}-${name}.png`), caret: 'hide' });
    };
    const clock = async t => page.evaluate(async t => {
      window.__introClock = t;
      await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
    }, t);
    await page.goto(f.url);
    await page.waitForFunction(() => window.__launch?.().phase === 'intro', null, { timeout: 60000 });
    assert.equal(await page.title(), 'Kinso Computer');
    await shot('opener');
    await page.keyboard.press('ArrowDown');
    for (let i = 1; i < 80 && (await page.evaluate(() => window.__launch().intro.phase)) === 'scene'; i++) await clock(100 + i * .2);
    const contact = await page.evaluate(() => window.__launch().intro.soundAt);
    await clock(contact + 2); await shot('bubble');
    await clock(contact + 5.7); await shot('burst');
    await clock(contact + 7.5); await shot('kinso-wordmark');
    await clock(contact + 9);
    await page.waitForFunction(() => window.__launch().phase === 'ready');
    await shot('password-arrives');
    await page.waitForFunction(() => window.__launch().kinso.sharks.swimming);
    await page.waitForTimeout(1800); await shot('lock-sharks');
    assert.equal(await page.locator('.macos-name').textContent(), 'Kinso');
    assert.equal(await page.locator('#fallback').getAttribute('href'), null);
    await page.locator('#password').fill('kinso'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__launch().lock.unlocked);
    // Authentication finishes before the lock/desktop crossfade. Capture
    // the desktop, not the password dots from the preceding painted frame.
    await page.waitForFunction(() => document.querySelector('#lockScreen').hidden && document.querySelector('#introScreen').hidden
      && !document.querySelector('#macScreen').hidden && Number(getComputedStyle(document.querySelector('#macScreen')).opacity) === 1);
    await shot('unlocked-desktop');
    await page.waitForFunction(() => window.__launch().kinso.film?.segment === 'opener' && !!document.querySelector('.kinso-film-caption')?.textContent);
    await shot('part-one-placeholder');
    await page.waitForFunction(() => window.__launch().kinso.film?.segment === 'launch', null, { timeout: 45000 });
    await shot('launch-video-placeholder');
    await page.waitForFunction(() => window.__launch().phase === 'mac');
    await page.waitForFunction(() => document.querySelector('.kinso-film')?.dataset.place === 'behind' && Number(getComputedStyle(document.querySelector('.kinso-film')).opacity) < .01);
    await shot('empty-window');
    const product = page.frame({ url: url => url.origin === f.product.origin });
    assert.ok(product, 'the authenticated product frame exists');
    assert.equal(await product.locator('html').getAttribute('data-brand'), 'kinso', 'the product is branded at its own exact origin');
    for (const step of ['claude', 'codex', 'files', 'browser', 'messages']) {
      await page.waitForFunction(step => window.__launch().assembly.history.some(row => row.step === step && row.paintedAt !== null), step, { timeout: 45000 });
      await shot(`build-${step}`);
      const messages = product.locator('.sidebar-head-title', { hasText: /^Messages$/ });
      assert.equal(await messages.count(), step === 'messages' ? 1 : 0, 'Messages joins only at its own beat');
    }
    await page.waitForFunction(() => window.__launch().kinso.film?.place === 'front', null, { timeout: 20000 });
    await shot('film-becomes-file');
    await page.waitForFunction(() => window.__launch().kinso.build.beat === 6);
    await shot('race');
    await page.waitForFunction(() => window.__launch().kinso.build.beat === 7, null, { timeout: 30000 });
    await shot('business');
    await page.waitForFunction(() => window.__launch().phase === 'demo', null, { timeout: 30000 });
    await shot('yours-to-use');
    await page.waitForFunction(() => !!document.querySelector('.shell-code-window'), null, { timeout: 20000 });
    await shot('code');
    await page.waitForFunction(() => window.__launch().kinso.build.narration.stopped, null, { timeout: 20000 });
    await shot('end');
    const state = await page.evaluate(() => window.__launch());
    assert.deepEqual(state.assembly.history.filter(row => row.paintedAt !== null).map(row => row.step), ['bare', 'claude', 'codex', 'files', 'browser', 'messages', 'done']);
    assert.equal(state.lock.workbench, 'kinso'); assert.equal(state.demoVerified, true);
    assert.equal(state.phone.loaded, false);
    assert.equal(state.kinso.film.recorded.opener, false); assert.equal(state.kinso.film.recorded.launch, false);
    assert.ok(f.product.seen.requests.some(req => req.path === '/door/ticket'));
    const frame = await page.locator('#computer').getAttribute('src');
    assert.equal(new URL(frame).origin, f.product.origin, 'uses the URL returned by unlock, not a named computer');
    assert.equal(new URL(frame).searchParams.get('for'), 'kinso');
    assert.deepEqual(faults, []);
    assert.ok(!requests.some(path => /wabi|kinso-variations|launch-video-wabi/i.test(path)), 'never loads a reference film');
    assert.deepEqual(f.product.seen.browser, [], 'Kinso never starts or navigates a VM browser');
    assert.deepEqual(f.product.seen.watches, [], 'Kinso never subscribes to remote browser video');
    assert.ok(!sockets.some(url => /\/browser(?:[/?]|$)/.test(url)), 'no remote browser WebSocket even opens');
    assert.equal(new URL(page.url()).origin, 'https://kinso.computer', 'visitor stays on Kinso');
    assert.ok(!f.product.seen.requests.some(row => /(?:^|\/)browser(?:\/|$)/.test(row.path)));
    assert.equal(await product.locator('iframe.kinso-concept').getAttribute('src'), 'https://kinso.computer/kinso/?v=kinso-embed-1');
    assert.equal(await product.getByRole('textbox', { name: 'Address', exact: true }).inputValue(), 'https://kinso.computer/kinso/');
    // The concept itself, on the same site's address; ignored Kinso assets are optional in a clean checkout.
    const concept = await context.request.get(`${f.transportOrigin}/kinso/`);
    if (concept.ok()) {
      await page.goto(`${f.origin}/kinso/`);
      await page.waitForTimeout(500);
      assert.match(await page.locator('body').textContent(), /US\$39/);
      await shot('concept-us39');
    }
    if (evidence) await writeFile(join(evidence, 'result.json'), JSON.stringify({ stages, faults, sockets, browserCalls: f.product.seen.browser, assembly: state.assembly.history, conceptAvailable: concept.ok() }, null, 2));
  } catch (error) {
    if (evidence) await writeFile(join(evidence, 'failure.json'), JSON.stringify({ message: error.message, faults, requests, responses, sockets,
      product: f.product.seen, frames: await Promise.all((context?.pages()[0]?.frames() ?? []).map(async frame => ({
        path: new URL(frame.url()).pathname, text: await frame.locator('body').innerText({ timeout: 1000 }).catch(() => '(unavailable)'),
      }))) }, null, 2));
    throw error;
  } finally { await context?.close(); await browser?.close(); await f.close(); }
});
