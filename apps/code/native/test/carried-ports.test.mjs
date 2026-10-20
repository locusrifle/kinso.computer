// What an agent shows, played on any of the person's screens: the phone, or
// another of their computers. The owning computer serves it on a listener of
// its own (system/shown.mjs), at one address every screen loads as it is: a
// file under /shown/, a page it runs on its loopback carried under /port/.
// Two real machine servers, a real dev page and a real Chromium; nothing of
// the person's is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, get } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createGueyServer } from '../../../../system/server.mjs';
import { createShown } from '../../../../system/shown.mjs';
import { publishedAt } from '../../../../system/machines.mjs';
import { createTabHost } from '../tabs.mjs';
import { runShow } from '../code-control.mjs';
import { windowOf } from '../public/js/pages.js';
import { withPaneShortcut } from '../public/js/pane-shortcut.js';

function fakeRuntime() {
  const snap = { sessionId: 's', sessionFile: 's', cwd: '/work', messages: [], busy: false, streaming: false, failed: null };
  return { events: new EventEmitter(), snapshot: () => snap, command: async () => ({ ok: true }), close: async () => {} };
}

// A dev page: its scripts are modules, named relative to it.
function devPage(seen) {
  const pages = {
    '/': ['text/html', '<title>Dev</title><script type="module" src="./src/main.js"></script><p>dev page</p>'],
    '/src/main.js': ['text/javascript', "import { word } from './word.js'; document.body.dataset.ran = word; fetch('api').then(r => r.text()).then(t => { document.body.dataset.api = t; });"],
    '/src/word.js': ['text/javascript', "export const word = 'carried';"],
    '/api': ['text/plain', 'ok'],
    '/landed': ['text/html', '<p id="landed">landed</p>'],
  };
  return createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie, referer: req.headers.referer });
    if (req.url === '/go') { res.writeHead(302, { location: '/landed' }).end(); return; }
    const [type, body] = pages[req.url] ?? [];
    if (!type) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': type, 'set-cookie': 'dev=1', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" }).end(body);
  });
}

// A request with the headers a browser sends (fetch sets its own Host).
const ask = (url, headers) => new Promise((resolve, reject) => get(url, { headers }, res => { res.resume(); resolve([res.statusCode, res.headers.location ?? null, res.headers['content-security-policy'] ?? null]); }).on('error', reject));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('what an agent shows has one address, on its computer\'s page listener, that plays on every screen with its saves', async () => {
  const root = await mkdtemp(join(tmpdir(), 'carried-ports-'));
  const seen = [];
  const dev = devPage(seen), other = createServer((req, res) => res.end('private'));
  const [port, otherPort] = [await listen(dev), await listen(other)];
  await mkdir(join(root, 'game'));
  await writeFile(join(root, 'game', 'index.html'), '<title>Game</title><p id="game">game</p>');
  const urls = {}, apps = {};
  let browser;
  try {
    // The laptop first: what show opens registers on the last made, the
    // desktop. On the tailnet the desktop is desk.test, and publishes its
    // page listener there (here over plain http, mapped to loopback).
    for (const [id, peer] of [['laptop', 'desktop'], ['desktop', 'laptop']]) {
      const runtime = await createTabHost({ cwd: root, stateDir: join(root, id), createRuntime: fakeRuntime, listPiSessions: async () => [], listClaudeSessions: async () => [] });
      const name = `${id === 'desktop' ? 'desk' : 'lap'}.test`;
      apps[id] = await createGueyServer({
        host: '127.0.0.1', port: 0, stateDir: join(root, `${id}-server`), runtime,
        machines: {
          self: async () => id, selfId: async () => id,
          origins: async () => (urls[id] ? [urls[id].replace('127.0.0.1', name)] : []),
          published: async pagePort => `http://${name}:${pagePort}`,
          list: async () => [],
          peer: async asked => (asked === peer ? { id: peer, name: peer, url: urls[peer], reachable: true } : null),
        },
      });
      urls[id] = `http://127.0.0.1:${(await apps[id].listen()).port}`;
    }
    const add = async (base, path) => {
      const res = await fetch(`${base}/shown/add`, { method: 'POST', headers: { 'content-type': 'application/json', origin: urls.laptop }, body: JSON.stringify({ path }) });
      return [res.status, await res.json()];
    };
    const through = `${urls.laptop}/peer/desktop`;

    // show opens local HTML in Files; its assets still have an isolated address.
    assert.equal(windowOf(await runShow({ path: join(root, 'game') })).target, join(root, 'game', 'index.html'));
    const game = (await add(through, join(root, 'game')))[1].url;
    assert.match(game, /^http:\/\/desk\.test:\d+\/shown\/.*\/game\/index\.html$/);
    const pages = `http://127.0.0.1:${new URL(game).port}`;
    // Nothing is carried until an agent opens it; asked through the laptop,
    // the desktop says where a page of its own is.
    assert.equal((await fetch(`${pages}/port/${port}/`)).status, 404);
    assert.match((await add(through, `http://localhost:${port}/`))[1].error, /nothing an agent opened is running on port/);
    assert.equal(windowOf(await runShow({ path: `http://127.0.0.1:${port}/app?x=1#top` })).target, `http://desk.test:${new URL(game).port}/port/${port}/app?x=1#top`);
    const shown = windowOf(await runShow({ path: `http://127.0.0.1:${port}/` })).target;
    assert.deepEqual(await add(through, `http://localhost:${port}/`), [200, { path: `http://localhost:${port}/`, kind: 'page', url: `http://desk.test:${new URL(game).port}/port/${port}/` }]);
    assert.deepEqual((await add(through, join(root, 'game')))[1].url, game, 'Files gets the same isolated address for relative assets');
    assert.equal((await add(through, `http://localhost:${otherPort}/`))[0], 500, 'another port on that computer is not carried');
    assert.equal((await fetch(`${pages}/port/${otherPort}/`)).status, 404);

    // The page, as its server answers, sandboxed with an origin of its own;
    // its server sees localhost and nothing of the page origin's.
    const page = await fetch(`${pages}/port/${port}/`, { headers: { cookie: 'page=secret' } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /dev page/);
    assert.match(page.headers.get('content-security-policy'), /^sandbox allow-scripts.* allow-same-origin$/);
    assert.equal(page.headers.get('set-cookie'), null);
    assert.equal(page.headers.get('x-frame-options'), null);
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(seen.at(-1), { url: '/', host: `localhost:${port}`, origin: undefined, cookie: undefined, referer: undefined });
    // A redirect stays carried.
    const moved = await fetch(`${pages}/port/${port}/go`, { redirect: 'manual' });
    assert.deepEqual([moved.status, moved.headers.get('location')], [302, './landed']);
    const bare = await fetch(`${pages}/port/${port}`, { redirect: 'manual' });
    assert.deepEqual([bare.status, bare.headers.get('location')], [301, `${port}/`]);

    // The page listener answers pages and nothing else, by this computer's
    // names only; imperfect's own server answers no pages, and nothing of
    // another computer's is relayed as one.
    for (const path of ['/', '/sessions.json', '/files/list', '/js/site.js', '/health', '/src/main.js']) assert.equal((await fetch(`${pages}${path}`)).status, 404, path);
    assert.equal((await fetch(`${pages}/shown/add`, { method: 'POST', body: `{"path":"${root}"}` })).status, 404, 'a page cannot make imperfect serve another folder');
    assert.equal((await ask(`${pages}/port/${port}/`, { host: `desk.test:${new URL(game).port}` }))[0], 200);
    assert.equal((await ask(`${pages}/port/${port}/`, { host: `rebound.example:${new URL(game).port}` }))[0], 403, 'a website pointing its own name here gets nothing');
    for (const path of [new URL(game).pathname, `/port/${port}/`]) {
      assert.equal((await fetch(`${urls.desktop}${path}`)).status, 404, path);
      assert.equal((await fetch(`${through}${path}`)).status, 404, `through: ${path}`);
    }
    assert.equal((await fetch(`${urls.desktop}/sessions.json`, { headers: { origin: `http://desk.test:${new URL(game).port}` } })).status, 403, 'a page is not imperfect');

    // In a real Chromium: the laptop's window (the session on the desktop),
    // and the desktop's own, play the same address, and keep its saves.
    browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--host-resolver-rules=MAP desk.test 127.0.0.1, MAP lap.test 127.0.0.1'] });
    const tab = await browser.newPage();
    const errors = []; tab.on('pageerror', e => errors.push(e.message));
    const play = async (at, base, target, ready) => {
      await tab.goto(`${at}/health`);
      await tab.evaluate(async ({ base, target }) => {
        const strip = document.createElement('div'), face = document.createElement('section'), output = document.createElement('div');
        Object.assign(strip.style, { position: 'relative', height: '600px' });
        face.className = 'code-face';
        const link = Object.assign(document.createElement('a'), { href: '#', textContent: 'the page' });
        link.dataset.page = target;
        output.append(link); face.append(output); strip.append(face); document.body.replaceChildren(strip);
        const { mountWindows } = await import('/js/windows.js');
        const { mountPages } = await import('/js/pages.js');
        const { mountWorkbench } = await import('/js/workbench-view.js');
        const host = document.createElement('div'); strip.append(host);
        const workbench = mountWorkbench({ host });
        mountPages({ output, wm: mountWindows({ conversation: face }), base: () => base,
          onFolder: (path, options) => workbench.open(path, options) });
        link.click();
      }, { base, target });
      const frame = tab.frameLocator('.browser-page iframe, .workbench-view-page iframe');
      await frame.locator(ready).waitFor({ timeout: 10_000 });
      assert.deepEqual(errors, [], `browser chrome works at ${at}, including plain-HTTP computer names`);
      return frame.locator('body').evaluate(() => { try { const saved = localStorage.getItem('stars'); localStorage.setItem('stars', '3'); return [location.href, saved]; } catch (error) { return [location.href, error.name]; } });
    };
    assert.deepEqual(await play(urls.laptop, '/peer/desktop', shown, 'body[data-ran="carried"][data-api="ok"]'), [shown, null], 'from the laptop, the desktop\'s page as it is');
    assert.deepEqual(await play(urls.laptop.replace('127.0.0.1', 'lap.test'), '/peer/desktop', shown, 'body[data-ran="carried"]'), [shown, '3'], 'and again, by name (as the phone), its saves kept');
    assert.deepEqual(await play(urls.desktop, '', shown, 'body[data-ran="carried"]'), [shown, '3'], 'the desktop\'s own window, the same');
    // An older conversation names the local address; the desktop says where it is.
    assert.deepEqual(await play(urls.laptop, '/peer/desktop', `http://localhost:${port}/`, 'body[data-ran="carried"]'), [`http://desk.test:${new URL(game).port}/port/${port}/`, '3']);
    assert.deepEqual(await play(urls.laptop, '/peer/desktop', join(root, 'game', 'index.html'), '#game'), [game, '3'], 'and a file by its path');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    for (const app of Object.values(apps)) await app.close();
    dev.close(); other.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a running dev server\'s port is carried; a stopped one, or a site, is not', async () => {
  const root = await mkdtemp(join(tmpdir(), 'carried-dev-'));
  let running = true;
  const before = globalThis[Symbol.for('imperfect.shown')];
  const servers = () => ({ list: () => [{ id: 's1', running, url: 'http://localhost:5173/' }, { id: 's2', running: true, url: '' }] });
  const shown = createShown({ stateDir: root, servers });
  const pagePort = (await shown.listen(0)).port;
  const answer = async path => {
    let status, text = '';
    const res = { headersSent: false, writeHead(code) { status = code; this.headersSent = true; return this; }, end(chunk) { text += chunk ?? ''; return this; }, on() {}, setHeader() {} };
    const req = { method: 'POST', url: '/shown/add', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ path })); } };
    assert.equal(await shown.handle(req, res, '/shown/add'), true);
    return [status, JSON.parse(text)];
  };
  try {
    assert.deepEqual(await answer('http://localhost:5173/'), [200, { path: 'http://localhost:5173/', kind: 'page', url: `http://127.0.0.1:${pagePort}/port/5173/` }], 'off a tailnet, on this computer alone');
    running = false;
    assert.equal((await answer('http://localhost:5173/'))[0], 500);
    // The window asking carries nothing; show opening does.
    assert.equal((await answer('http://localhost:8080/app'))[0], 500);
    const show = globalThis[Symbol.for('imperfect.shown')];
    await assert.rejects(show('https://example.com/'), /not a page running on this computer/);
    await assert.rejects(show('http://localhost:22/'), /not a page running on this computer/, 'never a system port');
    assert.deepEqual(await show('http://127.0.0.1:8080/app'), { path: 'http://localhost:8080/app', kind: 'page', url: `http://127.0.0.1:${pagePort}/port/8080/app` });
    assert.equal((await answer('http://localhost:8080/'))[0], 200);
  } finally { globalThis[Symbol.for('imperfect.shown')] = before; await shown.close(); await rm(root, { recursive: true, force: true }); }
});

test('in the live demo a page has the demo\'s name for its port, and shown files the page listener\'s', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shown-demo-'));
  const before = globalThis[Symbol.for('imperfect.shown')];
  const shown = createShown({ stateDir: root, servers: () => ({ list: () => [] }), pageOrigin: 'https://demo-{port}.imperfect.computer' });
  const pagePort = (await shown.listen(0)).port;
  try {
    await writeFile(join(root, 'a.png'), 'png');
    const show = globalThis[Symbol.for('imperfect.shown')];
    assert.equal((await show('http://localhost:5173/x?y=1')).url, 'https://demo-5173.imperfect.computer/x?y=1');
    assert.equal((await show(join(root, 'a.png'))).url, `https://demo-${pagePort}.imperfect.computer/files/raw?path=${encodeURIComponent(join(root, 'a.png'))}`);
    assert.match(await shown.sources(), new RegExp(`https://demo-${pagePort}\\.imperfect\\.computer`));
  } finally { globalThis[Symbol.for('imperfect.shown')] = before; await shown.close(); await rm(root, { recursive: true, force: true }); }
});

test('a shown file is served from its folder, sandboxed with an origin of its own, and nothing beside it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shown-files-'));
  const before = globalThis[Symbol.for('imperfect.shown')];
  const shown = createShown({ stateDir: join(root, 'state'), servers: () => ({ list: () => [] }) });
  const pages = `http://127.0.0.1:${(await shown.listen(0)).port}`;
  try {
    await mkdir(join(root, 'city'));
    await writeFile(join(root, 'city', 'index.html'), '<title>City</title>');
    await writeFile(join(root, 'secret.txt'), 'no');
    assert.deepEqual(await globalThis[Symbol.for('imperfect.shown')](join(root, 'city')), { path: join(root, 'city', 'index.html'), kind: 'page', url: `${pages}/shown${join(root, 'city', 'index.html')}` });
    const page = await fetch(`${pages}/shown${join(root, 'city', 'index.html')}`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), withPaneShortcut('<title>City</title>'));
    assert.match(page.headers.get('content-security-policy'), /^sandbox allow-scripts.* allow-same-origin$/);
    assert.equal(page.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${pages}/shown${join(root, 'secret.txt')}`)).status, 404);
    assert.equal((await fetch(`${pages}/shown${join(root, 'city', 'index.html')}`, { method: 'POST' })).status, 404);
  } finally { globalThis[Symbol.for('imperfect.shown')] = before; await shown.close(); await rm(root, { recursive: true, force: true }); }
});

test('the tailnet address of the page listener is read off what tailscale serve publishes for this computer', () => {
  const serve = { Web: {
    'desk.tail.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5067' } } },
    'desk.tail.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5068' } } },
    'oldname.tail.ts.net:9443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5068' } } },
  } };
  assert.equal(publishedAt(serve, 'desk.tail.ts.net', 5068), 'https://desk.tail.ts.net:8443');
  assert.equal(publishedAt(serve, 'desk.tail.ts.net', 5067), 'https://desk.tail.ts.net');
  assert.equal(publishedAt(serve, 'desk.tail.ts.net', 5071), '', 'not published: this computer alone');
  assert.equal(publishedAt(null, 'desk.tail.ts.net', 5068), '');
  assert.equal(publishedAt(serve, '', 5068), '', 'off the tailnet');
});
