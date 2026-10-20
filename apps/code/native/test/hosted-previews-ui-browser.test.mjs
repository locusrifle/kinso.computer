import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { launchChromium } from '../../../../tools/test-browser.mjs';

const root = new URL('../public/', import.meta.url);
async function fixture(run) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      const peer = url.pathname.startsWith('/peer/host');
      const path = url.pathname.replace(/^\/peer\/host/, '');
      const json = answer => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer)); };
      if (path === '/') { res.setHeader('content-type', 'text/html'); return res.end('<link rel="stylesheet" href="/css/gui-transcript.css"><style>body{margin:0}.canvas-strip{position:relative;height:800px}#files{height:600px;position:relative}</style><div id="files"></div><div class="canvas-strip"><section class="code-face"><div id="output"></div></section></div>'); }
      if (path === '/machines.json') return json({ machines: [{ id: 'desktop', self: true, home: true, reachable: true, capabilities: ['files'] }, { id: 'host', reachable: true, capabilities: ['files'] }] });
      if (path === '/files/list') {
        if (/\.(html|pdf)$/.test(url.searchParams.get('path'))) { res.statusCode = 404; return json({ error: "That isn't a folder" }); }
        return json({ path: '/w', entries: [{ name: 'page.html', path: '/w/page.html', size: 1 }, { name: 'paper.pdf', path: '/w/paper.pdf', size: 1 }] });
      }
      if (path === '/projects') return json({ projects: [] });
      if (path === '/files/peek') { const file = url.searchParams.get('path'); return json({ path: file, name: file.split('/').at(-1), kind: file.endsWith('.pdf') ? 'pdf' : file.endsWith('.png') ? 'image' : file.endsWith('.mp4') ? 'video' : file.endsWith('.mp3') ? 'audio' : 'text', size: 1 }); }
      if (path === '/shown/view') {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw); requests.push({ base: peer ? '/peer/host' : '', ...body });
        if (body.target.includes('broken')) { res.statusCode = 503; return json({ error: 'Server stopped' }); }
        return json(peer ? { stream: true, tab: body.target.includes('pdf') ? 56 : body.target.includes('5173') ? 57 : 55, url: 'http://localhost:5173/deep?x=1' } : { stream: false, url: `http://localhost:${server.address().port}/plain` });
      }
      if (path === '/plain') { res.setHeader('content-type', 'text/html'); return res.end('<button>Native page</button>'); }
      res.setHeader('content-type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), root)));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.setDefaultTimeout(5000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      window.sockets = [];
      window.WebSocket = class {
        constructor(url) {
          this.url = url; this.readyState = 0; this.sent = []; sockets.push(this);
          setTimeout(() => { if (this.readyState === 3) return; this.readyState = 1; this.onopen?.(); }, 0);
        }
        hear(said) { this.onmessage?.({ data: JSON.stringify(said) }); }
        send(raw) {
          const said = JSON.parse(raw); this.sent.push(said);
          if (said.do === 'watch') setTimeout(() => {
            const proof = { watching: said.tab, ...(said.scope ? { scope: said.scope } : {}) };
            this.hear({ ...proof, tabs: [{ tab: 1, title: 'Human tab', front: true }, { tab: said.tab, title: 'Preview', front: false }] });
            this.hear({ ...proof, frame: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', width: 1200, height: 700, tab: said.tab });
          }, 0);
        }
        close() { this.readyState = 3; this.onclose?.(); }
      };
    });
    await run({ page, requests });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

test('Workbench owns fixed page/PDF/app streams, reloads repeated show, retries expiry, and disposes only its viewer', { timeout: 30000 }, () => fixture(async ({ page, requests }) => {
  await page.evaluate(async () => {
    const { mountWorkbench } = await import('/js/workbench-view.js');
    window.workbench = mountWorkbench({ host: document.querySelector('#files') });
    await workbench.open('/w/page.html', { base: '/peer/host' });
  });
  await page.waitForFunction(() => sockets.some(ws => ws.sent.some(said => said.do === 'watch' && said.tab === 55)));
  assert.equal(await page.locator('.workbench-view iframe').count(), 0);
  assert.equal(await page.locator('.workbench-view .browser-tabs').count(), 0, 'no shared front-follow browser strip');
  assert.deepEqual(requests[0], { base: '/peer/host', target: '/w/page.html', reload: false });
  await page.evaluate(() => workbench.open('/w/page.html', { base: '/peer/host', quiet: true }));
  await page.waitForFunction(() => sockets.filter(ws => ws.sent.some(said => said.tab === 55)).length >= 2);
  assert.equal(requests.at(-1).reload, true, 'showing an updated HTML creation reloads the reused browser tab');
  assert.equal(await page.evaluate(() => sockets[0].readyState), 3);
  await page.evaluate(() => sockets.at(-1).hear({ watching: 55, expired: true, error: 'That preview tab is closed' }));
  await page.locator('.workbench-view-line', { hasText: 'Preview expired' }).waitFor();
  await page.getByRole('button', { name: 'Retry / reload' }).click();
  await page.waitForFunction(() => sockets.at(-1).readyState === 1);
  assert.equal(requests.at(-1).reload, true);
  await page.evaluate(async () => {
    const { mountViewer } = await import('/js/workbench-open.js');
    const host = document.createElement('div'); host.style.cssText = 'height:300px;position:relative'; document.body.prepend(host);
    window.other = mountViewer({ doc: document, host, base: () => '/peer/host' });
    await other.app({ path: '/w/app', name: 'App' }, async () => 'http://localhost:5173/deep?x=1');
  });
  await page.waitForFunction(() => sockets.some(ws => ws.readyState === 1 && ws.sent.some(said => said.tab === 57)));
  await page.evaluate(() => workbench.back());
  assert.equal(await page.evaluate(() => sockets.some(ws => ws.readyState === 1 && ws.sent.some(said => said.tab === 57))), true, 'closing one viewer keeps the other stream');
  await page.evaluate(async () => { other.remove(); await workbench.open('/w/paper.pdf', { base: '/peer/host' }); });
  await page.waitForFunction(() => sockets.some(ws => ws.readyState === 1 && ws.sent.some(said => said.tab === 56)));
  assert.equal(requests.at(-1).target, '/w/paper.pdf');
  assert.equal(await page.locator('.workbench-view-pdf iframe').count(), 0);
  await page.evaluate(() => workbench.back());
  assert.equal(await page.evaluate(() => sockets.every(ws => ws.readyState === 3)), true);
  await page.evaluate(() => workbench.open('/w/page.html', { base: '' }));
  await page.frameLocator('.workbench-view-page iframe').getByRole('button', { name: 'Native page' }).waitFor();
  assert.equal(requests.at(-1).base, '', 'desktop peer choice remains native');
  const beforeMedia = requests.length;
  await page.evaluate(async () => {
    const { mountViewer } = await import('/js/workbench-open.js');
    const host = document.createElement('div'); document.body.append(host);
    const viewer = mountViewer({ doc: document, host, base: () => '/peer/host' });
    for (const [path, tag] of [['/w/image.png', 'img'], ['/w/film.mp4', 'video'], ['/w/sound.mp3', 'audio']]) {
      await viewer.show({ path, name: path.split('/').at(-1) });
      if (!host.querySelector(tag)?.src.includes('/peer/host/files/raw?')) throw new Error('Media must stay native');
    }
    viewer.remove();
  });
  assert.equal(requests.length, beforeMedia, 'hosted media never opens a streamed browser tab');
}));

test('an unmarked fixed-watch reply clears preview pixels and requires explicit Retry without reconnecting', { timeout: 30000 }, () => fixture(async ({ page, requests }) => {
  await page.evaluate(async () => {
    const { mountWorkbench } = await import('/js/workbench-view.js');
    window.workbench = mountWorkbench({ host: document.querySelector('#files') });
    await workbench.open('/w/page.html', { base: '/peer/host' });
  });
  await page.locator('.workbench-view .browser-live-frame[src]').waitFor();
  const sent = await page.evaluate(() => {
    window.oldSocket = sockets.at(-1);
    oldSocket.hear({ tabs: [{ tab: 55, front: true }] });
    return oldSocket.sent.length;
  });
  await page.locator('.browser-live-note', { hasText: 'The open browser predates hosted previews. Stop watching for five idle minutes, then Retry.' }).waitFor();
  assert.equal(await page.locator('.browser-live-frame[src]').count(), 0, 'stale pixels removed');
  await page.evaluate(() => oldSocket.hear({ frame: 'late old pixels', tab: 55 }));
  await page.locator('.browser-live-view').click();
  await page.getByRole('textbox', { name: 'Type into the page' }).fill('must not send');
  await page.getByRole('button', { name: 'Type', exact: true }).click();
  await page.waitForTimeout(2200);
  assert.deepEqual(await page.evaluate(() => [sockets.length, oldSocket.readyState, oldSocket.sent.length]), [1, 3, sent]);
  assert.equal(await page.locator('.browser-live-frame[src]').count(), 0);
  await page.getByRole('button', { name: 'Retry / reload' }).click();
  await page.waitForFunction(() => sockets.length === 2 && sockets.at(-1).readyState === 1);
  await page.locator('.browser-live-frame[src]').waitFor();
  assert.equal(requests.at(-1).reload, true, 'Retry resolves a new endpoint-backed watch');
}));

test('pages local/PDF streams are independent of the portal, recover errors and dispose on close', { timeout: 30000 }, () => fixture(async ({ page, requests }) => {
  await page.evaluate(async () => {
    const { mountPages } = await import('/js/pages.js');
    const { mountWindows } = await import('/js/windows.js');
    window.wm = mountWindows({ conversation: document.querySelector('.code-face') });
    window.pages = mountPages({ output: document.querySelector('#output'), wm, base: () => '/peer/host' });
    pages.open('http://localhost:5173/deep?x=1');
  });
  await page.waitForFunction(() => sockets.some(ws => ws.sent.some(said => said.tab === 57)));
  assert.deepEqual(requests[0], { base: '/peer/host', target: 'http://localhost:5173/deep?x=1', reload: false });
  assert.equal(await page.locator('.wm-browser iframe').count(), 0);
  assert.equal(await page.locator('.wm-live').count(), 0, 'not shared portal watch');
  await page.evaluate(() => { pages.shown('http://localhost:5173/deep?x=1', '/peer/host'); });
  await page.waitForFunction(() => pages.tabs()[0]?.stale === false);
  assert.equal(await page.evaluate(() => sockets.filter(ws => ws.sent.some(said => said.tab === 57)).length), 1, 'quiet re-show refreshes the page without replacing the mutable scoped watcher');
  assert.equal(requests.at(-1).reload, true);
  await page.evaluate(() => sockets.at(-1).hear({ watching: 57, closed: true, error: 'That preview tab is closed' }));
  await page.getByRole('button', { name: 'Retry preview' }).click();
  await page.waitForFunction(() => sockets.at(-1).readyState === 1);
  const pdf = `http://${'a'.repeat(32)}.localhost:5068/paper.pdf`;
  await page.evaluate(target => pages.open(target), pdf);
  await page.waitForFunction(() => sockets.some(ws => ws.sent.some(said => said.tab === 56)));
  assert.equal(requests.at(-1).target, pdf, 'browser-local file origins are never loaded on the client');
  await page.evaluate(() => wm.close(wm.list().find(win => win.kind === 'browser')));
  assert.equal(await page.evaluate(() => sockets.every(ws => ws.readyState === 3)), true);
  await page.evaluate(() => pages.open('http://localhost:5173/broken'));
  await page.locator('.gui-window-error', { hasText: 'Server stopped' }).waitFor();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForTimeout(100);
  assert.equal(requests.at(-1).reload, true);
}));
