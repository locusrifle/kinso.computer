import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { launchChromium } from '../../../../tools/test-browser.mjs';

// Production chrome, iframe documents and observers; deterministic owner
// transport for HTTPS/blank identity (no external sites or start injection).
// Real Electron scoped/fixed ownership is covered by pinned-browser*.
async function fixture(width) {
  const requests = [];
  const root = new URL('../public/', import.meta.url);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname.endsWith('/shown/view')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push({ path: url.pathname, ...body });
      const two = url.pathname.startsWith('/peer/two');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ stream: true, tab: two ? 21 : 11, url: body.target })); return;
    }
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html');
      res.end('<link rel="stylesheet" href="/css/gui-transcript.css"><style>body{margin:0}#host{position:fixed;inset:100px 0 80px}.browser{height:100%}</style><input id="outside"><div id="host"></div>'); return;
    }
    if (url.pathname === '/local') {
      res.setHeader('content-type', 'text/html'); res.end('<title>Local notes</title><h1>Local notes</h1>'); return;
    }
    try {
      res.setHeader('content-type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(url.pathname.slice(1), root)));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    window.owners = {
      one: { tabs: [{ tab: 11, url: 'http://localhost:5173/original', title: 'Original' }, { tab: 12, url: 'https://example.test/read', title: 'Reading' }], next: 12, front: 11 },
      two: { tabs: [{ tab: 21, url: 'http://localhost:5174/other', title: 'Other owner' }], next: 21, front: 21 },
    };
    window.sockets = [];
    window.WebSocket = class {
      constructor(url) {
        this.url = String(url); this.owner = this.url.includes('/peer/two/') ? owners.two : owners.one;
        this.readyState = 0; this.sent = []; sockets.push(this);
        setTimeout(() => { if (this.readyState !== 3) { this.readyState = 1; this.onopen?.(); } }, 0);
      }
      hear(said) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(said) }); }
      snapshot() {
        const proof = { scope: 'browser', watching: this.pin };
        this.hear({ ...proof, tabs: this.owner.tabs.map(one => ({ ...one, front: one.tab === this.owner.front })) });
        if (this.pin !== null) this.hear({ ...proof, tab: this.pin, frame: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', width: 1, height: 1 });
      }
      send(raw) {
        const said = JSON.parse(raw); this.sent.push(said);
        if (said.do === 'watch') {
          this.pin = said.tab;
          if (said.resume && !this.owner.tabs.some(one => one.tab === this.pin)) this.pin = this.owner.tabs[0]?.tab ?? null;
          this.snapshot(); return;
        }
        if (said.do === 'front') { this.pin = this.owner.front = said.tab; this.snapshot(); }
        if (said.do === 'new') {
          const fresh = { tab: ++this.owner.next, url: 'about:blank', title: '' };
          this.owner.tabs.push(fresh); this.owner.front = fresh.tab;
          // The native list can arrive before the awaiting new command pins
          // its actual returned page. Don't overwrite the cleared address.
          this.snapshot(); this.pin = fresh.tab; this.snapshot();
        }
        if (said.do === 'close') {
          this.owner.tabs = this.owner.tabs.filter(one => one.tab !== said.tab);
          for (const ws of sockets.filter(ws => ws.owner === this.owner && ws.readyState === 1)) {
            if (ws.pin === said.tab) ws.pin = this.owner.tabs[0]?.tab ?? null;
            ws.snapshot();
          }
        }
        if (said.do === 'navigate') {
          const one = this.owner.tabs.find(one => one.tab === said.tab); one.url = said.url; one.title = ''; this.snapshot();
        }
      }
      close() { this.readyState = 3; this.onclose?.(); }
    };
    const { mountPages } = await import('/js/pages.js');
    let wins = [], focused;
    window.wm = {
      list: () => wins, focused: () => focused,
      open(spec) { const win = { ...spec, el: spec.body }; wins.push(win); focused = win; document.querySelector('#host').append(spec.body); return win; },
      close(win) { win.onClose(); win.el.remove(); wins = wins.filter(one => one !== win); }, show() {}, reveal() {}, full() {},
    };
    window.pages = mountPages({ output: document.createElement('div'), wm });
    window.seed = 'http://localhost:5173/original';
    window.current = () => sockets.findLast(ws => ws.readyState === 1);
  });
  return { page, requests, errors, close: async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

for (const width of [1200, 390]) test(`scoped ${width}px: focused address follows front only, CtrlT clears/focuses; HTTPS/blank/offline restore preserves owner`, { timeout: 30000 }, async () => {
  const f = await fixture(width), { page } = f;
  const address = page.locator('#host .gui-window-address');
  try {
    await page.evaluate(() => pages.open(seed, { base: '/peer/one' }));
    await page.locator('.browser-tab[data-tab="12"]').waitFor();
    await address.fill('unfinished search');
    await page.evaluate(() => { owners.one.tabs[0].title = 'Metadata only'; current().snapshot(); });
    assert.equal(await address.inputValue(), 'unfinished search');
    await page.evaluate(() => pages.flick(1));
    assert.equal(await address.inputValue(), 'https://example.test/read', 'front change overrides focused field');
    await address.press('Control+t');
    await page.locator('.browser-tab.front[data-tab="13"]').waitFor();
    assert.equal(await address.inputValue(), ''); assert.equal(await address.evaluate(el => document.activeElement === el), true);
    await address.press('Control+w');
    assert.equal(await address.inputValue(), 'http://localhost:5173/original');
    await page.locator('.browser-tab[data-tab="12"]').click();
    let saved = await page.evaluate(() => pages.at(wm.list()[0]));
    assert.deepEqual(saved[0], { target: 'https://example.test/read', base: '/peer/one', stream: true, preview: 'http://localhost:5173/original', tab: 12 });
    // Transport loss empties only the drawn list, never location/ownership.
    await page.evaluate(() => current().close());
    assert.deepEqual(await page.evaluate(() => pages.at(wm.list()[0])), saved);
    const requests = f.requests.length;
    await page.evaluate(saved => { wm.close(wm.list()[0]); owners.one.tabs = owners.one.tabs.filter(one => one.tab !== 11); pages.reopen(saved); }, saved);
    await page.locator('.browser-tab.front[data-tab="12"]').waitFor();
    assert.equal(f.requests.length, requests, 'restore never resolves obsolete original');
    assert.equal(await page.locator('#host iframe,#host webview').count(), 0);
    assert.equal(await page.evaluate(() => current().url.includes('/peer/one/browser/live')), true);
    assert.equal(await address.inputValue(), 'https://example.test/read');
    await page.locator('.browser-new').click();
    await page.locator('.browser-tab.front[data-tab="14"]').waitFor();
    saved = await page.evaluate(() => pages.at(wm.list()[0]));
    assert.equal(saved[0].target, 'about:blank'); assert.equal(saved[0].tab, 14); assert.equal(saved[0].stream, true);
    await page.evaluate(saved => { wm.close(wm.list()[0]); pages.reopen(saved); }, saved);
    await page.locator('.browser-tab.front[data-tab="14"]').waitFor();
    assert.equal(await page.locator('.browser-start:not([hidden])').count(), 1);
    assert.equal(await page.evaluate(() => owners.one.tabs.find(one => one.tab === 14).url), 'about:blank');
    assert.equal(f.requests.length, requests);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const width of [1200, 390]) test(`mixed ${width}px: local and other-owner pages remain reachable/manageable through the remote chooser`, { timeout: 30000 }, async () => {
  const f = await fixture(width), { page } = f;
  try {
    await page.evaluate(() => pages.open(`${location.origin}/local`, { asItIs: true }));
    await page.frameLocator('#host iframe').getByRole('heading', { name: 'Local notes' }).waitFor();
    await page.evaluate(() => pages.open(seed, { base: '/peer/one' }));
    await page.locator('.browser-tab[data-tab="11"]').waitFor();
    await page.getByRole('button', { name: 'Pages', exact: true }).click();
    await page.locator('.browser-panel-entry').getByRole('button', { name: 'Local notes', exact: true }).click();
    assert.equal(await page.locator('.browser-page.front iframe').count(), 1);
    assert.equal(await page.locator('.browser-tab-strip').count(), 1);
    await page.evaluate(() => pages.open(seed, { base: '/peer/one' }));
    await page.locator('.browser-tab[data-tab="11"]').waitFor();
    await page.evaluate(() => pages.open('http://localhost:5174/other', { base: '/peer/two' }));
    await page.locator('.browser-tab[data-tab="21"]').waitFor();
    await page.getByRole('button', { name: 'Pages', exact: true }).click();
    assert.equal(await page.locator('.browser-panel-entry').count(), 3);
    await page.locator('.browser-panel-entry').getByRole('button', { name: 'Original', exact: true }).click();
    await page.locator('.browser-tab.front[data-tab="11"]').waitFor();
    await page.waitForFunction(() => sockets.filter(ws => ws.readyState === 1).length === 1 && current().url.includes('/peer/one/') && current().sent.some(said => said.do === 'watch'));
    assert.equal(await page.evaluate(() => sockets.filter(ws => ws.readyState === 1).length), 1, 'one current owner stream');
    await page.getByRole('button', { name: 'Pages', exact: true }).click();
    await page.getByRole('button', { name: 'Close page Other owner', exact: true }).click();
    assert.equal(await page.locator('.browser-panel-entry').count(), 2);
    assert.equal(await page.evaluate(() => pages.tabs().length), 2);
    assert.equal(await page.evaluate(() => owners.two.tabs.length), 1, 'closing a holder disposes its viewer, not owner tab');
    await page.getByRole('button', { name: 'Pages', exact: true }).click();
    await page.getByRole('button', { name: 'New local tab', exact: true }).click();
    await page.locator('.browser-page.front iframe').waitFor();
    assert.equal(await page.locator('.browser-start:not([hidden])').count(), 1);
    assert.equal(await page.evaluate(() => owners.one.tabs.length), 2, 'local new never creates an owner tab');
    assert.equal(await page.locator('.browser-tab-strip').count(), 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
