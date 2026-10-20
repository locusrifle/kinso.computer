// Exact deployed origins; only transports are fixtures. The concept document,
// its assets/CSP and the nested product frontend are real, not screenshots.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { harnessFixture } from '../../apps/code/native/test/fixtures/harness-page.mjs';
import { createLockerServer } from '../server.mjs';
import { openStore } from '../store.mjs';
import { launchChromium } from '../../tools/test-browser.mjs';
import { productPolicy as readProductPolicy } from '../../apps/code/test/fixtures/product-policy.mjs';

const SITE = 'https://kinso.computer', COMPUTER = 'https://computer.kinso.computer', CONCEPT = `${SITE}/kinso/`;
const EMBED = `${CONCEPT}?v=kinso-embed-1`;
const evidence = process.env.KINSO_STILLS && resolve(process.env.KINSO_STILLS);
const publicDir = new URL('../public/', import.meta.url).pathname;
// Read the applied policy from the real server, not a synthesized frame-src.
// Only the fixture door's ancestor and agent WebSocket transport differ.
const { policy: serverPolicy } = await readProductPolicy();
assert.match(serverPolicy, /; frame-src 'self' https:\/\/kinso\.computer\/kinso\/ ;/);
const productPolicy = serverPolicy.replace("frame-ancestors 'none'", `frame-ancestors ${SITE}`);

for (const width of [1920, 390]) test(`Kinso ${width}: exact trusted nested concept iframe, never a remote browser`, { timeout: 60000 }, async t => {
  try { await access(join(publicDir, 'store/kinso/index.html')); }
  catch { t.skip('Requires the ignored Kinso concept rebuild; no copied font/logo is committed.'); return; }
  const store = openStore();
  const locker = await createLockerServer({ store, stripe: null,
    mail: { configured: false, async send() { throw new Error('No mail in proof'); } },
    tell: async () => { throw new Error('No notifications in proof'); },
    config: { secure: false, hosts: 'store.invalid', stripe: {} }, port: 0,
    log: { info() {}, warn() {}, error() {} } });
  const transport = `http://127.0.0.1:${(await locker.listen()).port}`;
  t.after(async () => { await locker.close(); store.close(); });
  const wire = [], frameViolations = [];
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'] });
  t.after(() => browser.close());
  const f = await harnessFixture({ browser, launchFrame: true, productOrigin: COMPUTER, launchOrigin: SITE,
    hasTouch: width === 390, viewport: { width, height: width === 390 ? 844 : 1080 },
    machines: [{ id: 'fixture', self: true, hosted: true, reachable: true }],
    snapshot: { harnesses: [{ agent: 'pi', ready: true }, { agent: 'claude', ready: true }, { agent: 'codex', ready: true }] },
    handleRequest: async (req, res, path) => {
      if (/(^|\/)browser(?:\/|$)/.test(path)) { wire.push(path); res.writeHead(500).end('Remote browser forbidden'); return true; }
      // harnessFixture redirects only its WebSocket onto this exact loopback transport.
      if (path === '/') res.setHeader('content-security-policy', productPolicy.replace("connect-src 'self'", `connect-src 'self' ws://${req.headers.host}`));
      if (path === '/files/list') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ path: '/fixture', home: '/fixture', entries: [] })); return true;
      }
      return false;
    },
    onBrowserLive: (ws, req) => { wire.push(req.url); ws.close(); },
  });
  t.after(() => f.close());
  const { page, product } = f;
  const requests = [], sockets = [];
  page.on('request', req => requests.push(req.url()));
  page.on('websocket', ws => sockets.push(ws.url()));
  await product.evaluate(() => {
    window.frameViolations = [];
    addEventListener('securitypolicyviolation', e => { if (e.effectiveDirective === 'frame-src') frameViolations.push(e.blockedURI); });
  });
  const conceptPolicies = [];
  await page.route(`${CONCEPT}**`, async route => {
    const response = await route.fetch({ url: route.request().url().replace(SITE, transport), maxRedirects: 0 });
    assert.ok([200, 206].includes(response.status()), 'only successful local content, never redirects');
    if (route.request().isNavigationRequest()) {
      assert.equal(response.status(), 200);
      assert.equal(route.request().url(), EMBED);
      conceptPolicies.push(response.headers()['content-security-policy']);
      assert.equal(conceptPolicies.at(-1), "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; form-action 'none'; frame-ancestors 'self' https://computer.kinso.computer https://kinso.computer https://www.kinso.computer; base-uri 'none'");
    }
    return route.fulfill({ response });
  });
  const assemble = async step => {
    await page.evaluate(({ step, origin }) => document.querySelector('iframe').contentWindow.postMessage({ type: 'imperfect:assemble', step }, origin), { step, origin: COMPUTER });
    await page.waitForFunction(step => messages.some(m => m.type === 'imperfect:assembled' && m.step === step), step);
  };
  await assemble('browser');
  const frame = product.locator('iframe.kinso-concept');
  await frame.waitFor({ state: 'visible' });
  assert.equal(await frame.getAttribute('src'), EMBED);
  assert.equal(new URL(await frame.getAttribute('src')).origin, SITE);
  assert.equal(new URL(await frame.getAttribute('src')).pathname, '/kinso/');
  assert.equal(new URL(await frame.getAttribute('src')).search, '?v=kinso-embed-1');
  assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts allow-same-origin');
  assert.equal(await frame.getAttribute('title'), 'Kinso Computer · concept');
  const nested = page.frames().find(frame => frame.url() === EMBED);
  assert.ok(nested); assert.equal(nested.parentFrame(), product);
  await nested.locator('body').filter({ hasText: /US\$39/ }).waitFor();
  await nested.evaluate(() => document.fonts.ready);
  assert.match(await nested.title(), /Kinso Computer/);
  assert.equal(await nested.locator('link[href*="site.css"]').count(), 1);
  assert.ok(await nested.locator('img').evaluateAll(imgs => imgs.some(img => img.complete && img.naturalWidth > 0)), 'real concept images rendered');
  // Open messages are guarded by exact parent source/origin and done state.
  await assemble('done');
  await page.evaluate(({ origin, url }) => {
    const target = document.querySelector('iframe').contentWindow;
    for (let i = 0; i < 3; i++) target.postMessage({ type: 'imperfect:open', url }, origin);
  }, { origin: COMPUTER, url: CONCEPT });
  await product.evaluate(() => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))));
  assert.equal(await product.locator('iframe.kinso-concept').count(), 1);
  assert.equal(await product.locator('.wm-live, webview, .browser-live-frame').count(), 0);
  assert.equal(await product.getByRole('textbox', { name: 'Address', exact: true }).inputValue(), CONCEPT);
  assert.equal(await product.getByRole('textbox', { name: 'Address', exact: true }).getAttribute('readonly'), '');
  const site = product.locator('#session-rail .session-rail-open[title="kinso.computer"]');
  assert.equal(await site.count(), 1, 'one canonical Sites entry');
  assert.equal(await site.innerText(), 'kinso.computer', 'no fetch version in Sites title');
  // Focus layout's sidebar replaces the hidden tab-strip +. New page
  // reuses the concept; no Google, no extra real browser tab.
  await product.getByText('New page', { exact: true }).click();
  assert.equal(await product.locator('iframe.kinso-concept').count(), 1);
  // The normal shortcut, hidden dock action, and background browse event all
  // use the same local tab. None resolves home metadata or opens /browser/live.
  await product.locator('#entry-input').focus();
  await page.keyboard.press('Alt+Shift+B');
  await product.locator('.entry-browser').evaluate(button => button.click());
  f.send({ type: 'browse', machine: 'another-fixture-computer' });
  await product.evaluate(() => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))));
  assert.equal(await product.locator('iframe.kinso-concept').count(), 1);
  // Ordinary reload and the sidebar both reuse this existing window architecture.
  if (width === 390) await product.getByRole('button', { name: 'collapse the agents', exact: true }).click();
  const navigated = page.waitForEvent('framenavigated', { predicate: frame => frame.url() === EMBED });
  const reload = product.getByRole('button', { name: 'Reload', exact: true });
  await reload.click();
  const reloaded = await navigated;
  await reloaded.locator('body').filter({ hasText: /US\$39/ }).waitFor();
  assert.equal(await product.getByRole('textbox', { name: 'Address', exact: true }).inputValue(), CONCEPT, 'reload keeps the canonical tab address');
  assert.equal(await frame.getAttribute('src'), EMBED, 'reload keeps the fixed fetch version');
  assert.equal(conceptPolicies.length, 2, 'initial load and explicit reload, never repeated opens');
  assert.equal(page.url(), `${SITE}/assembly-fixture`, 'main address remains Kinso');
  assert.deepEqual(wire, []);
  assert.ok(!requests.some(url => /\/browser(?:[/?]|$)|google\.com|imperfect\.computer\/shop/.test(url)));
  assert.ok(!sockets.some(url => /\/browser(?:[/?]|$)/.test(url)));
  frameViolations.push(...await product.evaluate(() => frameViolations));
  assert.deepEqual(frameViolations, []);
  assert.deepEqual(f.errors, []);
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `embed-${width}.png`), caret: 'hide' });
    await writeFile(join(evidence, `embed-${width}.json`), JSON.stringify({ width, top: page.url(), computer: product.url(), concept: reloaded.url(), wire, sockets, frameViolations, errors: f.errors, serverPolicy, productPolicy, conceptPolicies, canonicalAddress: CONCEPT, limits: 'Real server frame-src and locker concept CSP; fixture door ancestor and agent transport. No deployed door, live server or real phone checked.' }, null, 2));
  }
  // The actual product frame-src rejects adjacent paths and other origins.
  for (const url of [`${SITE}/shop`, `${SITE}/kinso-other/`, 'https://www.kinso.computer/kinso/', 'https://kinso.computer.evil.invalid/kinso/']) {
    const denied = page.waitForEvent('console', { predicate: msg => /frame-src/.test(msg.text()) });
    await product.evaluate(url => {
      const child = document.createElement('iframe'); child.src = url;
      child.className = 'policy-rejection-proof'; document.body.append(child);
    }, url);
    assert.match((await denied).text(), /frame-src/);
    assert.ok(!requests.includes(url), 'CSP denies the request before transport');
    await product.locator('.policy-rejection-proof').evaluate(child => child.remove());
  }
  // Even a trusted immediate computer parent cannot admit an unknown
  // grandparent: CSP must validate the entire chain, not just the referrer.
  const outsider = page;
  try {
    await outsider.route('**/*', route => route.abort());
    await outsider.route('https://untrusted.invalid/**', route => route.fulfill({ contentType: 'text/html', body: `<iframe src="${COMPUTER}/hostile-wrapper"></iframe>` }));
    await outsider.route(`${COMPUTER}/hostile-wrapper`, route => route.fulfill({ contentType: 'text/html', body: `<iframe src="${EMBED}"></iframe>` }));
    await outsider.route(`${CONCEPT}**`, async route => route.fulfill({ response: await route.fetch({ url: route.request().url().replace(SITE, transport), maxRedirects: 0 }) }));
    const denied = outsider.waitForEvent('console', { predicate: msg => /frame-ancestors/.test(msg.text()) });
    await outsider.goto('https://untrusted.invalid/');
    assert.match((await denied).text(), /frame-ancestors/);
    assert.ok(!outsider.frames().some(frame => frame.url() === EMBED), 'untrusted grandparent never displays the concept');
  } finally { /* fixture owns this page's lifetime */ }
});
