import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createFiles } from '../../../../system/files.mjs';

const publicRoot = new URL('../public/', import.meta.url);
// This is a delivery deadline, not the browser's startup/transport timeout.
// A ten-second safety refresh cannot pass these mutation checks.
const UPDATE_MS = 1800;
const shell = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--paper:#000;--ink:#ddd;--muted:#888;--pi-accent:#d4d4d4;--theme-bg:var(--paper);--theme-ink:var(--ink);--theme-accent:var(--pi-accent)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px sans-serif}#host{position:relative;height:100dvh}
</style><main id="host"></main>`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < end, message);
    await pause(20);
  }
}
const row = (page, name) => page.locator('.workbench-item').filter({
  has: page.locator('.workbench-name').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
});
const lists = requests => requests.filter(request => new URL(request.url, 'http://fixture').pathname.endsWith('/files/list'));
const feeds = requests => requests.filter(request => new URL(request.url, 'http://fixture').pathname.endsWith('/files/events'));
const originalNames = Array.from({ length: 100 }, (_, i) => `row-${String(i).padStart(3, '0')}.txt`);
async function inventory(page, extra = [], removed = []) {
  assert.deepEqual((await page.locator('.workbench-name').allTextContents()).sort(),
    [...originalNames.filter(name => !removed.includes(name)), ...extra].sort(), 'full visible folder matches the actual filesystem');
}

// Real createFiles behind a fake computer's HTTP door. In remote mode the
// browser reaches this door through createGueyServer's production peer relay:
// prefix routing, streaming fetch, headers and 304 forwarding are not mocked.
async function fixture(t, { width, remote = false, reducedMotion = 'reduce' }) {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-files-live-browser-'));
  const home = join(root, 'home'), dir = join(root, remote ? 'pc-folder' : 'folder');
  await mkdir(home); await mkdir(dir);
  const previous = Object.fromEntries(['HOME', 'IMPERFECT_PREFIX'].map(key => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.IMPERFECT_PREFIX = join(home, '.imperfect');
  const files = createFiles({ thumbnailDir: join(root, 'thumbnails'), pictureMakers: [] });
  const requests = [], gatewayRequests = [], errors = [], failures = [], streams = new Set();
  const control = { offline: false, listGate: null, releaseLists: null };
  let browser, context, owner, gateway;
  // Install cleanup before anything capable of failing or opening a socket.
  t.after(async () => {
    control.releaseLists?.();
    try { await browser?.close(); }
    finally {
      try {
        for (const stream of streams) stream.destroy();
        files.close?.();
        gateway?.server.closeAllConnections();
        await gateway?.close();
      } finally {
        try {
          owner?.closeAllConnections();
          if (owner) await new Promise(resolve => owner.close(resolve));
        } finally {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
          }
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  });
  for (let i = 0; i < 100; i++) {
    const path = join(dir, `row-${String(i).padStart(3, '0')}.txt`);
    await writeFile(path, 'original'); await utimes(path, 100, 100);
  }
  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  };
  owner = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const record = { url: req.url, headers: { ...req.headers }, status: null };
    requests.push(record);
    res.once('finish', () => { record.status = res.statusCode; record.etag = res.getHeader('etag'); });
    try {
      if (url.pathname === '/files/events') {
        if (control.offline) return json(res, { error: 'Fixture owner feed disconnected' }, 503);
        streams.add(res); res.once('close', () => streams.delete(res));
      }
      // Every read is owned by the fixture; never list the person's home.
      if (url.pathname.startsWith('/files/')) {
        const asked = url.searchParams.get('path');
        if (asked !== dir && !asked?.startsWith(`${dir}/`)) return json(res, { error: 'Outside fixture folder' }, 403);
        if (url.pathname === '/files/list') await control.listGate;
        if (await files(req, res, url.pathname, url.search)) return;
      }
      if (url.pathname === '/projects.json') return json(res, { root: join(root, 'projects'), projects: [] });
      if (url.pathname === '/machines.json') return json(res, { machines: [
        { id: 'laptop', name: 'Laptop', self: true, reachable: true, capabilities: ['files'] },
        { id: 'pc', name: 'PC', reachable: true, capabilities: ['files'] },
      ] });
      if (!remote && url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(shell); return; }
      if (!remote && /\.(js|css)$/.test(url.pathname)) {
        res.setHeader('content-type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
        res.end(await readFile(new URL(url.pathname.slice(1), publicRoot))); return;
      }
      if (url.pathname !== '/favicon.ico') failures.push(`Unexpected owner request: ${req.url}`);
      res.writeHead(404).end();
    } catch (error) { failures.push(error.stack); if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  let origin = `http://127.0.0.1:${owner.address().port}`;
  if (remote) {
    // Import under the isolated HOME too; no real sessions, credentials,
    // discovery, browser window, projects or installed service are involved.
    const { createGueyServer } = await import('../../../../system/server.mjs');
    const ownerOrigin = origin;
    const snapshot = { sessionId: null, cwd: home, busy: false, failed: null, messages: [], tabs: [] };
    const runtime = { events: new EventEmitter(), snapshot: () => snapshot,
      command: async () => { throw new Error('Files fixture must never command an agent'); }, close: async () => {} };
    const machines = { self: async () => 'laptop', selfId: async () => 'laptop', origins: async () => [],
      published: async () => '', peer: async id => id === 'pc' ? { id, name: 'PC', url: ownerOrigin, reachable: true } : null,
      list: async () => [
        { id: 'laptop', name: 'Laptop', self: true, reachable: true, capabilities: ['files'] },
        { id: 'pc', name: 'PC', reachable: true, capabilities: ['files'] },
      ] };
    gateway = await createGueyServer({ port: 0, stateDir: join(root, 'gateway'), cwd: home, runtime, machines,
      sessionToken: 'files-live-fixture-token', projects: { root: join(root, 'projects') },
      identityOptions: { status: async () => ({ Self: { StableID: 'laptop' } }) } });
    gateway.server.on('request', req => gatewayRequests.push({ url: req.url, headers: { ...req.headers } }));
    origin = `http://127.0.0.1:${(await gateway.listen()).port}`;
  }
  browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion,
    ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  const responses = [];
  page.on('response', response => { if (response.url().includes('/files/list')) responses.push({ url: response.url(), status: response.status() }); });
  // Serve only the fixture document instead of starting the agent harness.
  // JS/CSS, all Files requests and the peer relay remain production code.
  if (remote) await page.route(`${origin}/`, route => route.fulfill({ contentType: 'text/html', body: shell }));
  await page.goto(`${origin}/`);
  const base = remote ? '/peer/pc' : '';
  await page.evaluate(async ({ dir, base }) => {
    const { mountWorkbench } = await import('/js/workbench-view.js');
    window.workbench = mountWorkbench({ host: document.querySelector('#host') });
    await workbench.open(dir, { base });
  }, { dir, base });
  await row(page, 'row-000.txt').waitFor();
  await until(() => feeds(requests).length > 0, 'production UI opens its owner feed');
  return { page, context, dir, base, root, requests, gatewayRequests, responses, control, streams, errors, failures, width, remote };
}

// Readiness is the real owner feed plus a completed full revalidation,
// not a status label in the interface.
async function ready(f) {
  await until(() => f.streams.size > 0 && lists(f.requests).length > 1
    && lists(f.requests).every(request => request.status !== null), 'owner feed and listing are ready');
}
async function mutation(f, description, mutate, predicate, arg) {
  const before = Date.now();
  await mutate();
  await f.page.waitForFunction(predicate, arg, { timeout: UPDATE_MS, polling: 20 });
  const elapsed = Date.now() - before;
  assert.ok(elapsed < UPDATE_MS, `${description} arrives without UI interaction in ${elapsed}ms`);
  console.log(`${f.remote ? 'peer' : 'local'} ${f.width}px ${description}: ${elapsed}ms`);
}
async function rememberAnchor(page) {
  return page.evaluate(() => {
    const items = document.querySelector('.workbench-items');
    const top = items.getBoundingClientRect().top;
    const anchor = [...items.children].find(node => node.getBoundingClientRect().bottom > top + 1);
    window.keptRows = new Map([...items.children].map(node => [node.title, node]));
    window.keptAnchor = anchor;
    return { name: anchor.querySelector('.workbench-name').textContent,
      y: anchor.getBoundingClientRect().top, scroll: items.scrollTop };
  });
}
async function stable(page, anchor, selected = ['row-045.txt'], excluded = []) {
  const found = await page.evaluate(excluded => {
    const items = document.querySelector('.workbench-items');
    return {
      sameRows: [...items.children].filter(node => window.keptRows.has(node.title) && !excluded.includes(node.querySelector('.workbench-name').textContent))
        .every(node => window.keptRows.get(node.title) === node),
      anchorConnected: window.keptAnchor.isConnected,
      anchorY: window.keptAnchor.getBoundingClientRect().top,
      selected: [...items.querySelectorAll('[aria-selected="true"] .workbench-name')].map(node => node.textContent),
      cursor: items.querySelector('.workbench-cursor .workbench-name')?.textContent,
    };
  }, excluded);
  assert.equal(found.sameRows, true, 'unchanged rows retain the identical DOM nodes');
  assert.equal(found.anchorConnected, true, 'visible anchor is retained');
  assert.ok(Math.abs(found.anchorY - anchor.y) <= 1, `scroll anchored to ${anchor.name}: ${anchor.y} -> ${found.anchorY}`);
  assert.deepEqual(found.selected.sort(), [...selected].sort(), 'selection follows paths, not new indices');
  if (selected.length) assert.equal(found.cursor, selected.at(-1), 'keyboard cursor follows the selected path');
}
async function evidence(f, label) {
  if (!process.env.FILES_LIVE_SCREENSHOT_DIR) return;
  await mkdir(process.env.FILES_LIVE_SCREENSHOT_DIR, { recursive: true });
  await f.page.screenshot({ path: join(process.env.FILES_LIVE_SCREENSHOT_DIR, `files-live-${f.remote ? 'peer' : 'local'}-${f.width}-${label}.png`) });
}
function healthy(f) {
  assert.deepEqual(f.errors, [], 'no browser exceptions');
  assert.deepEqual(f.failures, [], 'no unexpected owner requests or server exceptions');
  const eventRequests = feeds(f.requests);
  assert.ok(eventRequests.length);
  for (const request of eventRequests) {
    const url = new URL(request.url, 'http://fixture');
    assert.equal(url.searchParams.get('path'), f.dir);
    assert.match(url.searchParams.get('window'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'feed has a real window UUID');
  }
  assert.equal(new Set(eventRequests.map(request => new URL(request.url, 'http://fixture').searchParams.get('window'))).size, 1, 'reconnect retains window identity');
  if (f.remote) {
    const reads = f.gatewayRequests.filter(request => /\/files\/(list|events|peek|thumbnail)(?:\?|$)/.test(request.url));
    assert.ok(reads.some(request => request.url.startsWith('/peer/pc/files/list')));
    assert.ok(reads.some(request => request.url.startsWith('/peer/pc/files/events')));
    assert.ok(reads.every(request => request.url.startsWith('/peer/pc/')), 'remote reads and feeds exclusively use owner routing, never gateway disk');
  }
}

for (const width of [1200, 390]) for (const remote of [false, true]) {
  test(`Files live ${width}px ${remote ? 'real peer gateway' : 'local'}: mutations preserve rows, selection, scroll, menu and address`, { timeout: 120000 }, async t => {
    const f = await fixture(t, { width, remote });
    const { page, dir } = f;
    await ready(f);
    await row(page, 'row-045.txt').click({ modifiers: ['Control'] });
    // Put a stable existing row at the viewport edge; new newest-first rows
    // inserted above it must adjust scrollTop rather than move what is seen.
    await page.evaluate(() => {
      const items = document.querySelector('.workbench-items');
      const at = [...items.children].find(node => node.querySelector('.workbench-name').textContent === 'row-040.txt');
      items.scrollTop += at.getBoundingClientRect().top - items.getBoundingClientRect().top;
    });
    await page.waitForTimeout(50); // settle the explicit scroll before recording
    const anchor = await rememberAnchor(page);
    assert.ok(anchor.scroll > 0, 'fixture really is scrolled');
    await mutation(f, 'create', () => writeFile(join(dir, 'new.txt'), 'new'),
      () => [...document.querySelectorAll('.workbench-name')].some(node => node.textContent === 'new.txt'));
    await stable(page, anchor);
    await inventory(page, ['new.txt']);
    await mutation(f, 'rename', () => rename(join(dir, 'new.txt'), join(dir, 'renamed.txt')),
      () => {
        const names = [...document.querySelectorAll('.workbench-name')].map(node => node.textContent);
        return names.includes('renamed.txt') && !names.includes('new.txt');
      });
    await stable(page, anchor);
    await inventory(page, ['renamed.txt']);
    await mutation(f, 'modify size', () => writeFile(join(dir, 'row-080.txt'), 'changed body has 25 bytes'),
      () => [...document.querySelectorAll('.workbench-item')].some(node => node.querySelector('.workbench-name')?.textContent === 'row-080.txt' && node.querySelector('.workbench-size')?.textContent === '25 bytes'));
    await stable(page, anchor, ['row-045.txt'], ['row-080.txt']);
    await inventory(page, ['renamed.txt']);
    await mutation(f, 'delete', () => rm(join(dir, 'renamed.txt')),
      () => ![...document.querySelectorAll('.workbench-name')].some(node => node.textContent === 'renamed.txt'));
    await stable(page, anchor, ['row-045.txt'], ['row-080.txt']);
    await inventory(page);

    // A genuine Files menu, opened with its supported keyboard gesture.
    // The mutation is below the viewport and retains mtime, so this tests
    // menu preservation independently of anchor-induced scrolling.
    await page.locator('.workbench-view-count').focus();
    await page.locator('.workbench-view-count').press('ArrowDown');
    await page.getByRole('dialog', { name: 'Files views' }).evaluate(node => { window.keptMenu = node; });
    await mutation(f, 'modify with menu open', async () => {
      await writeFile(join(dir, 'row-090.txt'), 'menu stays'); await utimes(join(dir, 'row-090.txt'), 100, 100);
    }, () => [...document.querySelectorAll('.workbench-item')].some(node => node.querySelector('.workbench-name')?.textContent === 'row-090.txt' && node.querySelector('.workbench-size')?.textContent === '10 bytes'));
    assert.equal(await page.evaluate(() => window.keptMenu.isConnected && window.keptMenu === document.querySelector('.workbench-menu')), true, 'open menu retains its DOM and contents');
    await page.keyboard.press('Escape');

    await page.locator('.workbench').focus();
    await page.keyboard.press('Control+l');
    const typed = page.locator('.workbench-type');
    await typed.fill(`${dir}/unfinished draft`);
    await typed.evaluate(node => { node.setSelectionRange(5, 12); window.keptTyped = node; });
    await mutation(f, 'create while typing', () => writeFile(join(dir, 'while-typing.txt'), 'draft stays'),
      () => [...document.querySelectorAll('.workbench-name')].some(node => node.textContent === 'while-typing.txt'));
    assert.deepEqual(await typed.evaluate(node => ({ same: node === window.keptTyped, focused: node === document.activeElement,
      value: node.value, start: node.selectionStart, end: node.selectionEnd })),
    { same: true, focused: true, value: `${dir}/unfinished draft`, start: 5, end: 12 }, 'address draft, selection and focus survive automatic refresh');
    assert.equal(await page.evaluate(() => workbench.where().path), dir, 'refresh does not navigate to draft');
    await stable(page, anchor, ['row-045.txt'], ['row-080.txt', 'row-090.txt']);
    await inventory(page, ['while-typing.txt']);
    await page.keyboard.press('Escape');
    await evidence(f, 'updated');

    await mutation(f, 'delete selected path', () => rm(join(dir, 'row-045.txt')),
      () => ![...document.querySelectorAll('.workbench-name')].some(node => node.textContent === 'row-045.txt'));
    assert.deepEqual(await page.locator('.workbench-item[aria-selected="true"] .workbench-name').allTextContents(), [], 'deleted selection is not transferred to the row at its old index');
    await inventory(page, ['while-typing.txt'], ['row-045.txt']);
    assert.ok(lists(f.requests).some(request => request.headers['if-none-match']), 'automatic refresh uses the owner ETag');
    healthy(f);
  });
}

for (const width of [1200, 390]) test(`Files live ${width}px: right-click menu survives deferred live reorder`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { width });
  const { page, dir } = f;
  await ready(f);
  await row(page, 'row-045.txt').hover();
  await mutation(f, 'create under pointer before right-click', () => writeFile(join(dir, 'menu-race.txt'), 'newest'),
    () => [...document.querySelectorAll('.workbench-name')].some(node => node.textContent === 'menu-race.txt'));
  assert.ok(await page.locator('.workbench-items').evaluate(node => node.scrollTop > 0), 'fixture is scrolled when deferred order reconciles');
  await page.locator('.workbench-view-count').click({ button: 'right' });
  await page.waitForTimeout(150); // allow the queued programmatic scroll event
  assert.equal(await page.getByRole('dialog', { name: 'Files views' }).isVisible(), true,
    'automatic anchor-scroll triggered by leaving rows must not close the newly opened menu');
  healthy(f);
});

for (const reducedMotion of ['no-preference', 'reduce']) test(`Files live: departure stays in its slot (${reducedMotion})`, { timeout: 60000 }, async t => {
  const f = await fixture(t, { width: reducedMotion === 'reduce' ? 390 : 1200, reducedMotion });
  const { page, dir } = f;
  await ready(f);
  const target = await row(page, 'row-000.txt').boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  const position = await page.evaluate(path => {
    const item = [...document.querySelectorAll('.workbench-item')].find(node => node.dataset.path === path);
    const box = item.getBoundingClientRect();
    window.departures = [];
    new MutationObserver(changes => {
      for (const change of changes) for (const node of change.addedNodes) {
        if (node.classList?.contains('workbench-row-leaving') && node.title === path) {
          const at = node.getBoundingClientRect();
          departures.push({ y: at.top, height: at.height, inert: node.inert, hidden: node.getAttribute('aria-hidden'),
            duration: getComputedStyle(node).animationDuration });
        }
      }
    }).observe(document.querySelector('.workbench-items'), { childList: true });
    return { y: box.top, height: box.height };
  }, join(dir, 'row-000.txt'));
  await mutation(f, 'delete with motion preference', () => rm(join(dir, 'row-000.txt')),
    () => ![...document.querySelectorAll('.workbench-item')].some(node => node.dataset.path.endsWith('/row-000.txt')));
  const departures = await page.evaluate(() => window.departures);
  if (reducedMotion === 'reduce') assert.deepEqual(departures, [], 'reduced motion does not create a departure animation');
  else {
    assert.equal(departures.length, 1);
    assert.ok(Math.abs(departures[0].y - position.y) <= 1, 'the fade occupies the deleted row, not its neighbour');
    assert.equal(departures[0].height, position.height);
    assert.equal(departures[0].inert, true); assert.equal(departures[0].hidden, 'true');
    assert.equal(departures[0].duration, '0.14s');
  }
  healthy(f);
});

for (const width of [1200, 390]) test(`Files live ${width}px: peer feed drop, reconnect, focus and visibility revalidate`, { timeout: 120000 }, async t => {
  const f = await fixture(t, { width, remote: true });
  const { page, dir } = f;
  await ready(f);
  // Changing the directory's own mtime invalidates its watcher but not the
  // child listing. The UI's actual conditional request must receive a 304
  // through the real relay, retaining the cached rows.
  const beforeConditional = lists(f.requests).length;
  await utimes(dir, 200, 200);
  await until(() => lists(f.requests).length > beforeConditional, 'watch invalidation conditionally validates the listing', UPDATE_MS);
  await until(() => f.responses.some(response => response.status === 304), 'real gateway forwards conditional 304', UPDATE_MS);
  const beforeFocus = lists(f.requests).length;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(() => lists(f.requests).length > beforeFocus, 'focus triggers a full list revalidation');
  await ready(f);

  const addressWidth = (await page.locator('.workbench-address').boundingBox()).width;
  await page.evaluate(() => { window.connectionRows = [...document.querySelectorAll('.workbench-item')]; });
  f.control.offline = true;
  const beforeDrop = feeds(f.requests).length;
  for (const stream of f.streams) stream.destroy();
  await until(() => feeds(f.requests).slice(beforeDrop).some(request => request.status === 503),
    'disconnected owner rejects the actual reconnect attempt');
  assert.equal((await page.locator('.workbench-address').boundingBox()).width, addressWidth,
    'connection loss does not resize breadcrumbs or an address draft');
  assert.equal(await page.evaluate(() => window.connectionRows.every(node => node.isConnected)), true,
    'a disconnected stream retains the current folder DOM instead of replacing it with an error');
  assert.equal(await page.evaluate(() => workbench.where().base), '/peer/pc', 'connection loss preserves remote ownership');
  await evidence(f, 'disconnected');
  const beforeReconnect = lists(f.requests).length, beforeFeed = feeds(f.requests).length;
  await writeFile(join(dir, 'during-disconnect.txt'), 'missed by old connection');
  f.control.listGate = new Promise(resolve => { f.control.releaseLists = resolve; });
  f.control.offline = false;
  await until(() => feeds(f.requests).length > beforeFeed && lists(f.requests).length > beforeReconnect,
    'reconnected feed requests a full listing');
  await page.waitForTimeout(100);
  assert.equal(await row(page, 'during-disconnect.txt').count(), 0, 'fixture genuinely holds the missed listing');
  f.control.releaseLists(); f.control.listGate = null;
  await row(page, 'during-disconnect.txt').waitFor({ timeout: 15000 });
  await ready(f);
  assert.ok(lists(f.requests).length > beforeReconnect, 'reconnect performs a full listing, not just listening for future changes');
  await until(() => lists(f.requests).slice(beforeReconnect).some(request => request.status === 200), 'reconnect receives a successful full listing including missed changes');

  // Headless Chromium has no physical app switch. Exercise the visibility
  // handler with DOM visibility notifications, but leave its real HTTP and
  // filesystem intact. A hidden view must release the SSE resource.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await until(() => f.streams.size === 0, 'hidden folder releases its actual owner stream', 5000);
  const beforeVisible = lists(f.requests).length;
  await writeFile(join(dir, 'while-hidden.txt'), 'visible again');
  await page.evaluate(() => {
    delete document.visibilityState; delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await row(page, 'while-hidden.txt').waitFor({ timeout: 15000 });
  await ready(f);
  assert.ok(lists(f.requests).length > beforeVisible, 'becoming visible revalidates the full list');
  await evidence(f, 'reconnected');
  healthy(f);
});
