import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { PNG, readBody } from './fixtures/harness-page.mjs';
import { solitaryMachines } from '../../../../system/machines.mjs';

// Entirely synthetic: production frontend, fake inventory/snapshots/files on loopback.
const root = new URL('../public/', import.meta.url);
const machines = [
  { id: 'laptop', name: 'Laptop', self: true, reachable: true, capabilities: ['files'] },
  { id: 'pc', name: 'PC', home: true, reachable: true, capabilities: ['files'] },
];
const snapshot = owned => ({
  agent: 'pi', sessionId: owned ? `${owned}-session` : null, cwd: '/fixture',
  model: { provider: 'fixture', id: 'fixture' }, messages: [], stats: {}, ui: {}, queue: { items: [] },
  tabs: owned ? [{ id: `${owned}-tab`, sessionId: `${owned}-session`, focused: true, agent: 'pi', name: owned }] : [],
});

test('Files resolves only its unowned default from home metadata', { timeout: 360000 }, async t => {
  const html = (await readFile(new URL('index.html', root), 'utf8')).replace(/<script[^>]*src="\/js\/site.js"[^>]*><\/script>/, '');
  const browser = await launchChromium({ args: ['--no-sandbox'] });
  async function fixture({ inventory = machines, owned = null, restored, kept, delaySnapshot = 0, holdInventory = false, inventoryUnavailable = false, filesUnavailable = false, holdThumbnails = false, holdLocalList = false, pictureCount = 1, delayFirstInventory = 0 } = {}) {
    const requests = [], commands = [], clients = [];
    let inventories = 0;
    let releaseInventory;
    const gate = holdInventory ? new Promise(resolve => { releaseInventory = resolve; }) : Promise.resolve();
    let releaseThumbnails, releaseLocalList;
    const thumbnails = holdThumbnails ? new Promise(resolve => { releaseThumbnails = resolve; }) : Promise.resolve();
    const localList = holdLocalList ? new Promise(resolve => { releaseLocalList = resolve; }) : Promise.resolve();
    const settings = { inventory, inventoryUnavailable, filesUnavailable };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://fixture');
      const path = url.pathname.replace(/^\/peer\/pc/, '');
      requests.push({ url: req.url, method: req.method });
      const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      try {
        if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html + '<style>#entry-terminal{height:650px!important}.entry-screen{height:450px;min-height:0}</style>'); return; }
        if (path === '/machines.json') {
          const first = inventories++ === 0;
          if (first && delayFirstInventory) await new Promise(resolve => setTimeout(resolve, delayFirstInventory));
          await gate;
          if (settings.inventoryUnavailable) { res.statusCode = 503; json({ error: 'Inventory unavailable' }); }
          else json({ machines: settings.inventory });
          return;
        }
        if (path === '/files/list') {
          if (!url.pathname.startsWith('/peer/')) await localList;
          if (settings.filesUnavailable && url.pathname.startsWith('/peer/')) { res.statusCode = 503; json({ error: 'PC offline' }); return; }
          const folder = url.searchParams.get('path') || '/home/pc';
          const entry = (name, dir = false) => ({ name, path: `${folder}/${name}`, dir, size: 10, mtime: 1 });
          json({ path: folder, entries: folder === '/' ? [] : folder.endsWith('/projects') ? [entry('App', true)] : [entry('Page.html'), ...Array.from({ length: pictureCount }, (_, i) => entry(i ? `picture${i}.png` : 'picture.png')), entry('projects', true)] }); return;
        }
        if (path === '/files/peek') {
          const file = url.searchParams.get('path');
          json({ path: file, name: file.split('/').at(-1), kind: 'text', size: 10, mtime: 1 }); return;
        }
        if (path === '/files/thumbnail' || /\/projects\/App\/picture$/.test(path)) { await thumbnails; res.setHeader('Content-Type', 'image/png'); res.end(PNG); return; }
        if (path === '/shown/add' || path === '/shown/view') { const body = await readBody(req); requests.at(-1).body = body; const target = body.target ?? body.path; json({ ...(path === '/shown/view' ? { stream: false } : {}), url: /^https?:/.test(target) ? target : `http://${req.headers.host}${url.pathname.replace(/\/(add|view)$/, '')}${target}` }); return; }
        if (path.startsWith('/shown/')) { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Synthetic PC page</h1>'); return; }
        if (path === '/projects.json') { json({ root: '/home/pc/projects', projects: [{ name: 'App', picture: 1 }] }); return; }
        if (path === '/projects/App/start') { json({ url: `http://${req.headers.host}/peer/pc/shown/home/pc/projects/App/index.html` }); return; }
        if (path === '/projects/hold') { json({ ok: true }); return; }
        if (path.endsWith('.json')) { json({ providers: [], machines: [] }); return; }
        res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
        res.end(await readFile(new URL(path.slice(1), root)));
      } catch { res.statusCode = 404; res.end(); }
    });
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
      clients.push(ws);
      const owner = req.url.startsWith('/peer/') ? 'pc' : 'laptop';
      const data = snapshot(owner === 'laptop' ? owned : restored?.owner === 'pc' ? 'pc' : null);
      const push = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'snapshot', data })); };
      if (delaySnapshot && owner === 'laptop') setTimeout(push, delaySnapshot); else push();
      ws.on('message', raw => {
        const c = JSON.parse(raw); commands.push({ owner, ...c });
        const answer = c.type === 'snapshot' ? data : c.type === 'tab-focus' ? { snapshot: data } : c.type === 'harness' ? { startable: ['pi'] } : {};
        // Preserve the chooser's pre-existing one-computer auto-create attempt,
        // but refuse it: no synthetic fixture starts a session either.
        ws.send(JSON.stringify({ type: 'response', id: c.id, success: c.type !== 'tab-new', error: c.type === 'tab-new' ? 'Fixture refuses agent creation' : undefined, data: answer }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let context;
    const errors = [];
    // Registered before creating the context: a setup failure must not retain a
    // held HTTP request, websocket or browser context for the rest of the file.
    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      releaseInventory?.(); releaseThumbnails?.(); releaseLocalList?.();
      try { await context?.close(); }
      finally {
        for (const ws of clients) ws.terminate();
        await new Promise(resolve => wss.close(resolve));
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      }
    };
    t.after(cleanup);
    try {
      context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      if (restored || kept) await context.addInitScript(({ restored, kept }) => {
        if (restored) sessionStorage.setItem('imperfect.surface-code-view', JSON.stringify(restored));
        if (kept) localStorage.setItem('imperfect.workbench.tabs', JSON.stringify(kept));
      }, { restored, kept });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.evaluate(async () => {
        const { mountGueyPi } = await import('/js/harness.js');
        window.harness = mountGueyPi({ hooks: { canFocus: () => true } });
      });
      const lists = () => requests.filter(req => req.url.includes('/files/list'));
      const close = async () => {
        await cleanup();
        assert.equal(commands.filter(c => ['prompt', 'session-attach'].includes(c.type)).length, 0, 'never submits prompts or attaches history');
        const autoCreates = commands.filter(c => c.type === 'tab-new');
        if (autoCreates.length) assert.ok(settings.inventory.filter(m => m.self || m.reachable).length === 1 || inventory.filter(m => m.self || m.reachable).length === 1, 'only the unchanged single-computer chooser may attempt creation');
        assert.deepEqual(errors, []);
      };
      return { page, lists, requests, commands, settings, releaseInventory, releaseThumbnails, releaseLocalList, close };
    } catch (error) { await cleanup(); throw error; }
  }
  const row = (page, name) => page.locator('.workbench-item').filter({ has: page.getByText(name, { exact: true }) });
  try {
    await t.test('hosted solitary home does not wait for a delayed conversation snapshot', async () => {
      const inventory = (await solitaryMachines('hosted-fixture').list()).map(machine => ({ ...machine, home: true }));
      const f = await fixture({ inventory, delaySnapshot: 6000 });
      try {
        await row(f.page, 'Page.html').waitFor({ timeout: 2000 });
        assert.equal(f.lists()[0].url, '/files/list?path=');
        assert.doesNotMatch(await f.page.locator('.workbench-note').innerText(), /Finding|unavailable/);
        assert.equal(await f.page.evaluate(() => harness.guiSnapshot().sessionId), null, 'Files opens before the conversation arrives');
      } finally { await f.close(); }
    });
    await t.test('laptop blank first Files waits for authority; PC paths, HTML Launch and thumbnails stay remote', async () => {
      const f = await fixture({ holdInventory: true });
      try {
        await f.page.locator('.workbench-note').filter({ hasText: 'Finding Files computer' }).waitFor();
        assert.equal(f.lists().length, 0, 'no local mount while inventory loads');
        assert.equal(await f.page.locator('.workbench-view-count').evaluate(node => node.inert), true, 'new tabs cannot race the default lookup');
        await f.page.locator('.workbench-address').click();
        assert.equal(await f.page.locator('.workbench-type').isVisible(), false, 'typed paths wait for their computer');
        await f.page.evaluate(() => harness.openFiles('/home/pc/materials'));
        assert.equal(f.lists().length, 0, 'external folder opening also waits');
        f.releaseInventory();
        await row(f.page, 'Page.html').waitFor();
        assert.equal(f.lists().at(-1).url, '/peer/pc/files/list?path=%2Fhome%2Fpc%2Fmaterials');
        assert.equal(await f.page.locator('.workbench-crumb').first().getAttribute('title'), 'PC filesystem root');
        await f.page.waitForFunction(() => document.activeElement?.dataset?.owner === 'pc');
        await f.page.locator('.workbench-picture img').waitFor();
        assert.match(await f.page.locator('.workbench-picture img').getAttribute('src'), /^\/peer\/pc\/files\/thumbnail\?path=%2Fhome%2Fpc%2Fmaterials%2Fpicture.png/);
        assert.equal(await row(f.page, 'Page.html').locator('.workbench-launch').count(), 1);
        await row(f.page, 'Page.html').dblclick();
        await f.page.waitForFunction(() => document.querySelector('.workbench-view-page iframe')?.src.includes('/peer/pc/shown/home/pc/materials/Page.html'));
        assert.deepEqual(f.requests.find(req => req.url === '/peer/pc/shown/view').body, { target: '/home/pc/materials/Page.html', reload: false });
        await f.page.evaluate(() => harness.openFiles('/home/pc/projects'));
        await row(f.page, 'App').waitFor();
        assert.match(await row(f.page, 'App').locator('img').getAttribute('src'), /^\/peer\/pc\/projects\/App\/picture/);
        await row(f.page, 'App').locator('.workbench-preview').click();
        await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('imperfect.workbench.tabs')).tabs.some(tab => tab.owner === 'pc' && tab.app?.project === 'App'));
        assert.equal(await f.page.locator('.wm-browser').count(), 0, 'peer project launches inside Files');
        // This routing fixture supplies a same-origin URL; it must be refused,
        // not allowed to expose host controls. Real isolated playback is tested separately.
        await f.page.getByText(/App must have its own page origin/).waitFor();
        assert.ok(f.requests.some(req => req.url === '/peer/pc/projects/App/start'));
        assert.ok(f.lists().every(req => req.url.startsWith('/peer/pc/')), 'never reads absolute PC paths on laptop');
        assert.equal(f.commands.filter(c => c.type === 'tab-focus').length, 0, 'Files default does not choose an execution owner');
      } finally { await f.close(); }
    });
    for (const [name, options, expected] of [
      ['blank laptop first Files opens PC home', {}, '/peer/pc/files/list?path='],
      ['owned local snapshot arriving after inventory stays local', { owned: 'laptop', delaySnapshot: 200 }, '/files/list?path='],
      ['owned local restore uses known Files inventory before harness inventory arrives', { owned: 'laptop', restored: { owner: 'laptop', tabId: 'laptop-tab', windows: [] }, delayFirstInventory: 200 }, '/files/list?path='],
      ['owned PC restored session stays PC', { restored: { owner: 'pc', tabId: 'pc-tab', windows: [] } }, '/peer/pc/files/list?path='],
      ['no home single local stays local', { inventory: [machines[0]] }, '/files/list?path='],
      ['PC first Files home=self stays local', { inventory: [{ ...machines[1], self: true }] }, '/files/list?path='],
      ['restored explicit local Files remains local', { restored: { windows: [{ kind: 'files', at: { path: '/local/kept', base: '' } }] } }, '/files/list?path=%2Flocal%2Fkept'],
      ['restored explicit PC Files remains PC', { restored: { windows: [{ kind: 'files', at: { path: '/pc/kept', base: '/peer/pc' } }] } }, '/peer/pc/files/list?path=%2Fpc%2Fkept'],
      ['saved explicit local Workbench tab remains local', { kept: { tabs: [{ owner: '', path: '/local/saved', file: null }], active: 0 } }, '/files/list?path=%2Flocal%2Fsaved'],
      ['saved explicit PC Workbench tab remains PC', { kept: { tabs: [{ owner: 'pc', path: '/pc/saved', file: null }], active: 0 } }, '/peer/pc/files/list?path=%2Fpc%2Fsaved'],
    ]) await t.test(name, async () => {
      const f = await fixture(options);
      try {
        await row(f.page, 'Page.html').waitFor();
        assert.equal(f.lists()[0].url, expected);
        if (options.owned) assert.equal(await f.page.evaluate(() => harness.guiSnapshot().sessionId), 'laptop-session');
        await f.page.evaluate(() => harness.openFiles('/absolute/next'));
        await f.page.waitForFunction(() => document.querySelector('.workbench-path').textContent.includes('next'));
        assert.equal(f.lists().at(-1).url, `${expected.startsWith('/peer/') ? '/peer/pc' : ''}/files/list?path=%2Fabsolute%2Fnext`);
      } finally { await f.close(); }
    });
    await t.test('queued PC thumbnails keep their source when the user explicitly selects local', async () => {
      const f = await fixture({ holdThumbnails: true, holdLocalList: true, pictureCount: 8 });
      const until = async check => {
        const end = Date.now() + 15000;
        while (!check()) { assert.ok(Date.now() < end, 'thumbnail requests arrived'); await new Promise(resolve => setTimeout(resolve, 10)); }
      };
      try {
        await row(f.page, 'Page.html').waitFor();
        await until(() => f.requests.filter(req => req.url.includes('/files/thumbnail')).length === 4);
        await f.page.getByRole('button', { name: 'PC filesystem root', exact: true }).click();
        await f.page.getByRole('button', { name: 'Choose a computer', exact: true }).click();
        await f.page.getByRole('button', { name: 'Laptop Reachable' }).click();
        f.releaseThumbnails();
        assert.equal(f.requests.filter(req => req.url.includes('/files/thumbnail')).length, 4, 'root cancels the old queue');
        assert.ok(f.requests.filter(req => req.url.includes('/files/thumbnail')).every(req => req.url.startsWith('/peer/pc/')));
        f.releaseLocalList();
      } finally { await f.close(); }
    });
    await t.test('explicit Files computer while default is loading wins', async () => {
      const f = await fixture({ holdInventory: true });
      try {
        await f.page.evaluate(() => harness.openFiles('/local/explicit', { base: '' }));
        f.releaseInventory();
        await row(f.page, 'Page.html').waitFor();
        assert.ok(f.lists().length >= 1);
        assert.equal(f.lists()[0].url, '/files/list?path=%2Flocal%2Fexplicit', 'the explicit folder is read first');
        assert.ok(f.lists().every(request => ['/files/list?path=%2Flocal%2Fexplicit', '/files/list?path='].includes(request.url)),
          'opening, live revalidation and sidebar Home metadata retain the explicit local owner; the default lookup never wins');
      } finally { await f.close(); }
    });
    await t.test('offline home permits an explicit local computer without an automatic local mount', async () => {
      const f = await fixture({ inventory: [machines[0], { ...machines[1], reachable: false }] });
      try {
        await f.page.locator('.workbench-note').filter({ hasText: /PC unavailable/ }).waitFor();
        assert.equal(f.lists().length, 0);
        await f.page.getByRole('button', { name: 'Choose a computer', exact: true }).click();
        await f.page.getByRole('button', { name: 'Laptop Reachable' }).click();
        await row(f.page, 'Page.html').waitFor();
        assert.equal(f.lists()[0].url, '/files/list?path=', 'local is used only after the explicit computer choice');
      } finally { await f.close(); }
    });
    for (const [name, options, listed] of [
      ['offline home', { inventory: [machines[0], { ...machines[1], reachable: false }] }, false],
      ['inventory unavailable', { inventoryUnavailable: true }, false],
      ['PC fails after reachable metadata', { filesUnavailable: true }, true],
    ]) await t.test(`${name}: explicit unavailable and retry, never local fallback`, async () => {
      const f = await fixture(options);
      try {
        await f.page.locator('.workbench-note').filter({ hasText: /unavailable/ }).waitFor();
        assert.equal(f.lists().length > 0, listed);
        assert.ok(f.lists().every(req => req.url.startsWith('/peer/pc/')));
        f.settings.inventory = machines; f.settings.inventoryUnavailable = false; f.settings.filesUnavailable = false;
        await f.page.getByRole('button', { name: 'Retry', exact: true }).click();
        await row(f.page, 'Page.html').waitFor();
        assert.ok(f.lists().every(req => req.url.startsWith('/peer/pc/')));
      } finally { await f.close(); }
    });
  } finally { await browser.close(); }
});
