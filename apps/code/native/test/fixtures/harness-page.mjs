// The complete production harness on a real page on loopback, with a fake
// backend: no running service, credentials, runtime or agent is touched.
// Shared by the browser tests of the windows and the browser's tabs.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { launchChromium, TEST_TIMEOUT } from '../../../../../tools/test-browser.mjs';
import { LAYOUT_CHOICE } from '../../public/js/layout-choice.js';

export const readBody = async req => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body || '{}'); };
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

// Where the desktop strip is. A person's MOD arrow moves it at once
// (windows.js), so there is nothing to wait for.
export const settled = (page, selector = '.canvas-strip') => page.evaluate(selector => document.querySelector(selector).scrollLeft, selector);

// The desktop window, as far as the page can tell: Electron's bridge
// (preload.cjs) and a <webview> that keeps its address and history, takes
// the keys, and is a page with an id once its first page is ready. What the
// window would send is the page's to call: browseFromWindow, tabFromWindow,
// keyFromWindow (a key heard inside a website).
export const FAKE_DESK = () => {
  const said = globalThis.deskSaid = [];
  globalThis.imperfectDesk = {
    close() {},
    onBrowse: fn => { globalThis.browseFromWindow = fn; },
    onTab: fn => { globalThis.tabFromWindow = fn; },
    onKey: fn => { globalThis.keyFromWindow = fn; },
    front: id => said.push(['front', id]),
  };
  // Chromium's <webview> is a plain element; this gives each one Electron's ways.
  const make = document.createElement.bind(document);
  let pages = 100;
  document.createElement = (tag, ...rest) => {
    const element = make(tag, ...rest);
    if (tag !== 'webview') return element;
    const id = ++pages;
    element.tabIndex = -1;
    setTimeout(() => element.dispatchEvent(new Event('dom-ready')));
    return Object.defineProperties(element, {
      src: { get() { return this.getAttribute('src'); }, set(url) { this.setAttribute('src', url); } },
      getWebContentsId: { value() { return id; } },
      canGoBack: { value() { return this.back > 0; } },
      canGoForward: { value() { return false; } },
      goBack: { value() { this.wentBack = true; } },
      goForward: { value() {} },
      reload: { value() { this.reloaded = (this.reloaded ?? 0) + 1; } },
    });
  };
};

// The harness mounted on index.html (without site.js). fixture.push(tab)
// sends a snapshot, fixture.send(message) anything else the computer tells
// its windows; fixture.answer(command) may answer a command (else {}).
// machines: the computers /machines.json lists (none, unless given).
// layout: the window's layout when a test is about the scrolling or dwindle
// layouts. Like a native desk, a browser starts in focus; layout is an explicit
// choice, legacyLayout a saved choice and reload from before the focus reset.
export async function harnessFixture({ desk = false, messages, viewport = { width: 1200, height: 900 }, hasTouch = false, machines = [], handleRequest = async () => false, onBrowserLive = null, site = false, themeCSS = '', browser: suppliedBrowser = null, layout = null, legacyLayout = null, launchFrame = false, productOrigin = launchFrame ? 'https://noah.imperfect.computer' : null, launchOrigin = 'https://imperfect.computer', answer = () => undefined, snapshot = {} }) {
  const root = new URL('../../public/', import.meta.url);
  const html = await readFile(new URL('index.html', root), 'utf8');
  const index = site || launchFrame ? html : html.replace(/<script[^>]*src="\/js\/site.js"[^>]*><\/script>/, '');
  const base = { agent: 'pi', sessionId: 'thread-a', cwd: '/fixture', model: { provider: 'fixture', id: 'fixture' }, queue: { items: [] }, stats: {}, ui: {}, tabs: [{ id: 'tab-a', sessionId: 'thread-a', focused: true, agent: 'pi', name: 'A', prompt: 'make a game', status: 'idle' }] };
  const fixture = { tab: { ...base, busy: false, messages, ...snapshot }, machines, commands: [], added: [], holds: [], started: [], poster: PNG, imageRequests: [], answer };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://fixture').pathname;
      const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      if (await handleRequest(req, res, path)) return;
      if (path === '/theme.css') { res.setHeader('Content-Type', 'text/css'); res.end(themeCSS); return; }
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(index + '<style>#harness-reach{display:none}#entry-terminal{height:650px!important}.entry-screen{height:450px;min-height:0}</style>'); return; }
      // The computer says where a thing named by its path or local address plays.
      if (path === '/shown/add' || path === '/shown/view') { const body = await readBody(req); const asked = body.target ?? body.path; fixture.added.push(asked); json({ ...(path === '/shown/view' ? { stream: false } : {}), url: /^https?:/.test(asked) ? asked : `http://${req.headers.host}/shown${asked}` }); return; }
      if (path === '/shown/preview') { json({ local: false }); return; }
      if (path.startsWith('/shown/')) { fixture.imageRequests.push(req.url); res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-store'); res.end(fixture.poster); return; }
      // Projects (system/projects.mjs): started, and held while a tab shows one.
      if (path === '/projects/hold') { fixture.holds.push(await readBody(req)); json({ ok: true }); return; }
      const project = /^\/projects\/([^/]+)\/start$/.exec(path);
      if (project) { fixture.started.push(project[1]); json({ url: `http://${req.headers.host}/shown/projects/${project[1]}/index.html` }); return; }
      if (path.endsWith('.json')) { json(path.includes('usage') ? { providers: [], machines: [] } : { machines: fixture.machines }); return; }
      res.setHeader('Content-Type', /\.m?js$/.test(path) ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), root)));
    } catch { res.statusCode = 404; res.end(); }
  });
  // fixture.mute() silences the sockets open now, as a network dying under
  // them does; while fixture.refuse is set, new ones are turned away. An
  // answer may be a promise, for one that comes late.
  const wss = new WebSocketServer({ server, verifyClient: () => !fixture.refuse });
  const muted = new WeakSet();
  fixture.mute = () => { for (const ws of wss.clients) muted.add(ws); };
  fixture.send = message => { for (const ws of wss.clients) if (!muted.has(ws)) ws.send(JSON.stringify(message)); };
  fixture.sendFrom = (owner, message) => { for (const ws of wss.clients) if (!muted.has(ws) && ws.owner === owner) ws.send(JSON.stringify(message)); };
  fixture.push = next => { fixture.tab = next; fixture.send({ type: 'snapshot', data: next }); };
  wss.on('connection', (ws, req) => {
    if (req.url.endsWith('/browser/live') && onBrowserLive) { onBrowserLive(ws, req); return; }
    ws.owner = /^\/peer\/([^/]+)/.exec(req.url)?.[1] || '';
    ws.send(JSON.stringify({ type: 'snapshot', data: fixture.tab }));
    ws.on('message', raw => {
      if (muted.has(ws)) return;
      const c = JSON.parse(raw);
      fixture.commands.push(c);
      const reply = data => { if (!muted.has(ws)) ws.send(JSON.stringify({ type: 'response', id: c.id, success: true, data: data ?? (c.type === 'snapshot' ? fixture.tab : {}) })); };
      const data = fixture.answer(c, ws.owner);
      if (typeof data?.then === 'function') data.then(reply, error => { if (!muted.has(ws)) ws.send(JSON.stringify({ type: 'response', id: c.id, success: false, error: error?.message || String(error) })); }); else reply(data);
    });
  });
  let browser, ready = false;
  fixture.close = async () => {
    try {
      // A supplied browser (screenshot batches) is shared: close only this fixture's context.
      if (suppliedBrowser) await fixture.page?.context().close(); else await browser?.close();
    } finally {
      for (const ws of wss.clients) ws.terminate();
      try {
        await new Promise(r => wss.close(r));
      } finally {
        server.closeAllConnections();
        await new Promise(r => server.close(r));
      }
    }
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    // Screenshot batches share one process; each fixture still owns its context.
    // Pin standalone touch fixtures before the first paint: Electron's fine
    // pointer can otherwise win the CDP touch-context initialization race.
    browser = suppliedBrowser ?? await launchChromium({ headless: true, args: ['--no-sandbox', ...(hasTouch
      ? ['--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2'] : [])] });
    const page = fixture.page = await browser.newPage({ viewport, hasTouch });
    page.setDefaultTimeout?.(TEST_TIMEOUT);
    fixture.errors = []; page.on('pageerror', e => fixture.errors.push(e.message));
    if (layout || legacyLayout) await page.addInitScript(({ layout, legacyLayout, key }) => {
      if (legacyLayout && localStorage.getItem('imperfect.layout-choice')) return;
      if (layout) localStorage.setItem(key, layout);
      if (legacyLayout) localStorage.setItem('imperfect.layout-choice', legacyLayout);
      sessionStorage.setItem('imperfect.surface-code-view', JSON.stringify({ layout: legacyLayout || layout, oneLayout: legacyLayout ? true : key }));
    }, { layout, legacyLayout, key: LAYOUT_CHOICE });
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (productOrigin) {
      // Real origins and the production origin guard; only test transport is
      // routed onto loopback. Other external requests cannot reach production.
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      if (launchFrame) await page.route(`${launchOrigin}/**`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>html,body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><script>window.messages=[];addEventListener("message",e=>{if(e.source===document.querySelector("iframe")?.contentWindow&&e.origin===${JSON.stringify(productOrigin)})messages.push(e.data)});</script><iframe src="${productOrigin}/"></iframe>` }));
      await page.route(`${productOrigin}/**`, async route => route.fulfill({ response: await route.fetch({ url: route.request().url().replace(productOrigin, origin) }) }));
      await page.addInitScript(({ socketOrigin, productOrigin }) => {
        const Native = WebSocket;
        globalThis.WebSocket = class extends Native { constructor(url, protocols) { super(String(url).replace(productOrigin.replace(/^http/, 'ws'), socketOrigin), protocols); } };
      }, { socketOrigin: origin.replace(/^http/, 'ws'), productOrigin });
    }
    if (site && desk) await page.addInitScript(FAKE_DESK);
    await page.goto(launchFrame ? `${launchOrigin}/assembly-fixture` : productOrigin || origin);
    if (desk && !site) await page.evaluate(FAKE_DESK);
    // desk may say more of the window, as preload.cjs would: { altAlias: false } is sway.
    if (typeof desk === 'object') await page.evaluate(more => Object.assign(globalThis.imperfectDesk, more), desk);
    if (!site && !launchFrame) await page.evaluate(async () => {
      const { mountGueyPi } = await import('/js/harness.js');
      window.harness = mountGueyPi({ hooks: { canFocus: () => true } });
    });
    if (!site && !launchFrame) await page.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-a');
    if (launchFrame) {
      fixture.product = page.frame({ url: `${productOrigin}/` });
      await fixture.product.locator('#entry-terminal.fresh .fresh-question, :root[data-brand="kinso"] #entry-input[placeholder="what do you want?"]').first().waitFor();
    } else await page.locator('#entry-output .gui-assistant, #entry-terminal.fresh .fresh-question, :root[data-brand="kinso"] #entry-input[placeholder="what do you want?"]').first().waitFor();
    // A snapshot/attached transcript is not a painted, font-stable window.
    // Give every fixture the same settled starting frame by finishing the
    // window's entrance at once rather than watching it play (it was most of
    // a fixture's time); later transitions remain real and are observed by
    // the individual behaviour tests.
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => { for (const animation of document.getAnimations()) if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish(); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    ready = true;
    return fixture;
  } finally {
    if (!ready) await fixture.close();
  }
}
