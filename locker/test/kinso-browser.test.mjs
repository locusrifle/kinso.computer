import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { launchChromium } from '../../tools/test-browser.mjs';
import { WebSocket } from 'ws';
import { kinsoLaunch } from './fixtures/kinso-launch.mjs';
import { visibleCursor } from './fixtures/visible-cursor.mjs';

// The fixture password is never a real person's password. Hold only the animation clock, not its rendered styles.
for (const reduced of [false, true]) test(`Kinso unlock ${reduced ? 'Reduce Motion fades without lifting' : 'fades its UI before lifting the live sea over a still desktop'}`, { timeout: 90000 }, async () => {
  const f = await kinsoLaunch();
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const shots = process.env.KINSO_LIFT_STILLS && resolve(process.env.KINSO_LIFT_STILLS);
  try {
    if (shots) await mkdir(shots, { recursive: true });
    await context.addInitScript(() => { window.__introClock = window.__macosClock = 100; });
    const page = await context.newPage();
    await page.goto(f.url);
    await page.waitForFunction(() => window.__launch?.().phase === 'intro', null, { timeout: 60000 });
    await page.keyboard.press('ArrowDown');
    await page.evaluate(async () => {
      for (let i = 0; i < 140; i++) {
        window.__introClock += .1; window.__macosClock += .1;
        await new Promise(ok => requestAnimationFrame(ok));
      }
    });
    await page.waitForFunction(() => window.__launch().phase === 'ready');
    assert.match(await page.locator('.mac-wall').evaluate(el => getComputedStyle(el).backgroundImage), /\/wallpaper-kinso\.webp/);
    if (!reduced) {
      await page.locator('#password').fill('wrong'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__launch().lock.state === 'wrong');
      await page.evaluate(async () => {
        window.__macosClock += .05;
        await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
      });
      assert.notEqual(await page.locator('.macos-field').evaluate(el => el.style.transform), 'translateX(0px)');
      assert.equal(await page.locator('#lockScreen').getAttribute('data-departure'), null);
      await page.evaluate(async () => {
        window.__macosClock += .5;
        await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
      });
      assert.equal(await page.locator('#password').inputValue(), '');
      assert.equal(await page.evaluate(() => window.__launch().lock.state), 'idle');
    }
    await page.evaluate(() => {
      window.__liftSamples = [];
      const sample = () => {
        const lock = document.querySelector('#lockScreen'), desktop = document.querySelector('#macScreen');
        const dock = document.querySelector('.mac-dock').getBoundingClientRect(), menu = document.querySelector('.mac-bar').getBoundingClientRect();
        window.__liftSamples.push({ at: window.__macosClock, departure: lock.dataset.departure, hidden: lock.hidden,
          ui: Number(getComputedStyle(document.querySelector('.macos-lock-content')).opacity), y: lock.getBoundingClientRect().y,
          transform: getComputedStyle(lock).transform, opacity: Number(getComputedStyle(lock).opacity),
          desktop: !desktop.hidden && Number(getComputedStyle(desktop).opacity) === 1,
          dock: [dock.x, dock.y, dock.width, dock.height], menu: [menu.x, menu.y, menu.width, menu.height],
          film: window.__launch().kinso.film?.segment });
        if (lock.dataset.departure !== 'done') requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.locator('#password').fill('kinso'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#lockScreen').dataset.departure === 'fade');
    const base = await page.evaluate(() => window.__macosClock);
    const step = async offset => page.evaluate(async time => {
      window.__macosClock = time;
      await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(ok))));
    }, base + offset);
    const times = reduced ? [0, .075] : [0, .1, .22, .3, .4, .5, .65, .85];
    for (const [i, time] of times.entries()) {
      await step(time);
      if (shots) await page.screenshot({ path: join(shots, `${reduced ? 'reduced' : 'kinso'}-${String(i).padStart(2, '0')}-${Math.round(time * 1000)}ms.png`), caret: 'hide' });
    }
    await step(reduced ? .17 : 1.05);
    await page.waitForFunction(() => document.querySelector('#lockScreen').hidden);
    assert.equal(await page.locator('#introScreen').isHidden(), true);
    assert.equal(await page.evaluate(() => window.__launch().kinso.sharks.swimming), false);
    assert.match(await page.locator('.launch-wallpaper').evaluate(el => getComputedStyle(el).backgroundImage), /\/wallpaper-kinso\.webp/);
    const samples = await page.evaluate(() => window.__liftSamples);
    if (reduced) {
      assert.ok(samples.filter(s => s.departure).every(s => s.transform === 'none'), 'Reduce Motion never translates the sheet');
      assert.ok(samples.some(s => s.opacity > 0 && s.opacity < 1), 'the whole sheet fades instead');
      assert.ok(samples.filter(s => s.departure && !s.hidden).every(s => s.desktop), 'the decoded desktop is present through the reduced-motion fade');
    } else {
      const moving = samples.filter(s => !s.hidden && s.y < 0);
      assert.ok(moving.length > 2);
      assert.ok(samples.some(s => s.ui === 0 && s.y === 0 && !s.hidden), 'UI reaches zero while the sea is still stationary');
      assert.ok(moving.every(s => s.ui === 0 && s.desktop && s.film === 'none'), 'the full desktop is underneath; film waits for the sheet');
      assert.ok(moving.every(s => JSON.stringify(s.dock) === JSON.stringify(moving[0].dock) && JSON.stringify(s.menu) === JSON.stringify(moving[0].menu)), 'Dock and menu never jump');
      assert.equal(await page.locator('#lockScreen').evaluate(el => el.style.transform), 'translateY(-100%)');
      const settled = samples.findLast(s => s.hidden);
      assert.deepEqual(settled.dock, moving[0].dock);
      assert.deepEqual(settled.menu, moving[0].menu);
    }
    if (shots) {
      await page.screenshot({ path: join(shots, reduced ? 'reduced-settled.png' : 'kinso-settled.png'), caret: 'hide' });
      await writeFile(join(shots, reduced ? 'reduced-timeline.json' : 'kinso-timeline.json'), JSON.stringify(samples, null, 2));
    }
    await page.reload();
    await page.waitForFunction(() => window.__launch?.().phase === 'intro', null, { timeout: 60000 });
    assert.equal(await page.evaluate(() => window.__launch().lock.unlocked), false, 'reload still asks again');
  } finally { await context.close(); await browser.close(); await f.close(); }
});

// Full-HD and phone stills, each one real sequence. No installed server, model or inbox.
const evidenceRoot = process.env.KINSO_STILLS && resolve(process.env.KINSO_STILLS);
for (const width of [1920, 390]) test(`Kinso ${width}: burst, sharks, film slots, every build beat and exact returned-computer handoff`, { timeout: 240000 }, async () => {
  const height = width === 390 ? 844 : 1080;
  const evidence = evidenceRoot && join(evidenceRoot, String(width));
  const f = await kinsoLaunch({ exactOrigins: true });
  let browser, context;
  const faults = [], requests = [], sockets = [], responses = [], stages = [], cursors = [];
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
      cursors.push(await visibleCursor(page, name));
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
    await clock(contact); await shot('touch');
    await clock(contact + 2); await shot('bubble');
    const { BURST } = await import('../../website/bootup.mjs');
    const { WORD, FIELD_IN } = await import('../../website/wordmark.mjs');
    const draw = [];
    for (const seconds of [0, .4, .8, 1.2, 1.7, 2.5]) {
      await clock(contact + BURST + seconds); await shot(`draw-${seconds.toFixed(1)}`);
      draw.push(await page.locator('#wordmark').evaluate(el => ({ progress: el.dataset.draw, duration: el.dataset.drawDuration,
        opacity: getComputedStyle(el).opacity, pixels: el.toDataURL() })));
      assert.equal(await page.evaluate(() => window.__launch().intro.wordmark.shine), null, 'Kinso never receives a shine');
    }
    const logo = await page.locator('#wordmark').boundingBox();
    assert.ok(Math.abs((width < height ? logo.width / width : logo.height / height) - (width < height ? .36 : .22)) < .001);
    if (draw[0].progress !== 'fallback') {
      assert.ok(Number(draw[0].progress) < 1e-10, 'draw begins at the bubble opening, not hidden inside it');
      assert.ok(Number(draw[1].progress) > 0 && Number(draw[1].progress) < Number(draw[2].progress));
      assert.ok(Number(draw[2].progress) < Number(draw[3].progress));
      assert.equal(Number(draw[4].progress), 1); assert.equal(Number(draw[5].progress), 1);
      const spec = await page.evaluate(async () => (await fetch('/kinso/logo-draw.json')).json());
      assert.equal(Number(draw[0].duration), spec.periodMs * spec.draw.frames[1][0], 'Kinso duration is applied, not the loading loop period');
      const reference = await page.evaluate(async spec => {
        const image = new Image(); image.src = '/kinso/logo-draw.svg';
        if (!await new Promise(ok => { image.onload = () => ok(true); image.onerror = () => ok(false); })) return null;
        const svg = new DOMParser().parseFromString(await (await fetch('/kinso/logo-draw.svg')).text(), 'image/svg+xml').documentElement;
        svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); document.body.append(svg);
        const b = svg.getBBox(); svg.remove();
        const pad = spec.strokeWidth / 2, c = document.querySelector('#wordmark');
        const ref = document.createElement('canvas'); ref.width = c.width; ref.height = c.height;
        const ctx = ref.getContext('2d'), bw = b.width + 2 * pad, bh = b.height + 2 * pad;
        const scale = Math.min(c.width / bw, c.height / bh);
        ctx.setTransform(scale, 0, 0, scale, (c.width - bw * scale) / 2 - (b.x - pad) * scale,
          (c.height - bh * scale) / 2 - (b.y - pad) * scale);
        const box = spec.viewBox.split(' ').map(Number); ctx.drawImage(image, ...box);
        const expected = ctx.getImageData(0, 0, c.width, c.height).data;
        const actual = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let pixels = 0, error = 0;
        for (let i = 0; i < expected.length; i += 4) if (expected[i + 3] > 240) {
          pixels++; for (let ch = 0; ch < 4; ch++) error += Math.abs(expected[i + ch] - actual[i + ch]);
        }
        return { pixels, error };
      }, spec);
      if (reference) { assert.ok(reference.pixels > 500); assert.ok(reference.error / reference.pixels < 3, 'finished paths, strokes and gradient match Kinso’s original SVG'); }
      for (let i = 1; i <= 3; i++) {
        const expected = await page.evaluate(async ({ spec, seconds }) => {
          const el = document.createElement('div'); document.body.append(el);
          const animation = el.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: spec.periodMs * spec.draw.frames[1][0], easing: `cubic-bezier(${spec.draw.easing.join(',')})`, fill: 'both',
          });
          animation.pause(); animation.currentTime = seconds * 1000;
          const result = Number(getComputedStyle(el).opacity); animation.cancel(); el.remove(); return result;
        }, { spec, seconds: [0, .4, .8, 1.2][i] });
        assert.ok(Math.abs(Number(draw[i].progress) - expected) < .0001, 'draw matches the browser’s original easing');
      }
    }
    assert.equal(draw[4].pixels, draw[5].pixels, 'finished artwork holds, no loading fade or loop');
    assert.equal(draw[5].opacity, '1');
    // Freeze only the wake clock; unlock and the film subsequently use their real clock.
    await page.evaluate(() => { window.__macosClock = 200; });
    await clock(contact + WORD.gone + .001);
    await page.waitForFunction(() => window.__launch().phase === 'ready');
    for (const fraction of [.25, .5, 1]) {
      await page.evaluate(async t => { window.__macosClock = t; await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))); }, 200 + FIELD_IN * fraction);
      await shot(`password-arrives-${fraction}`);
      const box = await page.locator('#wordmark').boundingBox();
      if (fraction < 1) assert.ok(box.height < logo.height && box.height > logo.height * .75, 'shrink is gradual');
    }
    await page.waitForFunction(() => window.__launch().kinso.sharks.swimming);
    await page.waitForTimeout(1800); await shot('lock-sharks');
    assert.equal(await page.locator('#wordmark').evaluate(el => getComputedStyle(el).opacity), '1', 'the logo stays through the lock');
    const settled = await page.locator('#wordmark').boundingBox();
    const user = await page.locator('.macos-user').boundingBox();
    assert.ok(Math.abs(settled.height / logo.height - .75) < .001, 'one persistent logo shrinks to three quarters');
    assert.ok(Math.abs(user.y - settled.y - settled.height - 22) < 1, 'field sits directly below the new logo box');
    assert.ok(Math.abs(user.x + user.width / 2 - width / 2) < 1, 'field is centred');
    assert.equal(await page.locator('.macos-avatar, .macos-name').count(), 0, 'no separate icon or name');
    if (width === 390) {
      await page.setViewportSize({ width, height: 420 });
      await page.waitForFunction(() => document.querySelector('#password').getBoundingClientRect().bottom < 420);
      await shot('keyboard-room');
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => document.querySelector('#password').getBoundingClientRect().top > 420);
    }
    await page.evaluate(() => {
      const at = window.__macosClock, start = performance.now();
      Object.defineProperty(window, '__macosClock', { configurable: true, get: () => at + (performance.now() - start) / 1000 });
    });
    assert.equal(await page.locator('#fallback').getAttribute('href'), null);
    await page.locator('#password').fill('kinso'); await shot('typing');
    assert.ok(Math.abs((await page.locator('#wordmark').boundingBox()).height / logo.height - .75) < .001, 'typing keeps the settled identity');
    await page.keyboard.press('Enter');
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
    assert.equal(await page.locator('[data-menu="code"], .shell-code-window').count(), 0);
    assert.deepEqual(await page.locator('.shell-menu-side [data-menu]').evaluateAll(items => items.map(el => el.dataset.menu)),
      ['apple', 'app', 'file', 'edit', 'view', 'window', 'help']);
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
    if (evidence) await writeFile(join(evidence, 'result.json'), JSON.stringify({ stages, cursors, draw: draw.map(({ pixels, ...rest }) => rest), faults, sockets, browserCalls: f.product.seen.browser, assembly: state.assembly.history, conceptAvailable: concept.ok() }, null, 2));
  } catch (error) {
    if (evidence) await writeFile(join(evidence, 'failure.json'), JSON.stringify({ message: error.message, faults, requests, responses, sockets,
      product: f.product.seen, frames: await Promise.all((context?.pages()[0]?.frames() ?? []).map(async frame => ({
        path: new URL(frame.url()).pathname, text: await frame.locator('body').innerText({ timeout: 1000 }).catch(() => '(unavailable)'),
      }))) }, null, 2));
    throw error;
  } finally { await context?.close(); await browser?.close(); await f.close(); }
});
