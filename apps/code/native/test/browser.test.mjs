// The agent's `browser` tool (browser.mjs) against a stand-in for the desktop
// window: a real socket answering the window's requests (as
// desktop/electron/main.mjs does) by driving a real Chromium page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createBrowser, BROWSER_TOOL, NO_SCREEN, NO_WINDOW, askWindow, openWindow, runBrowser, windowSockets, provideWindowPort, endSession, closeTabsWhenSessionsEnd } from '../browser.mjs';
import { createTabHost } from '../tabs.mjs';
import { createGueyServer } from '../../../../system/server.mjs';
import { addressOf } from '../public/js/pages.js';
import { TOOLS } from '../tools.mjs';

test('what is typed in the address field is an address or a search', () => {
  assert.equal(addressOf('example.com'), 'https://example.com/');
  assert.equal(addressOf('https://x.com/home'), 'https://x.com/home');
  assert.equal(addressOf('localhost:5173/a'), 'http://localhost:5173/a');
  assert.equal(addressOf('127.0.0.1:8080'), 'http://127.0.0.1:8080/');
  assert.equal(addressOf('hello world'), 'https://www.google.com/search?q=hello%20world');
  assert.equal(addressOf('what is 1.5?'), 'https://www.google.com/search?q=what%20is%201.5%3F');
  assert.equal(addressOf('javascript:alert(1)'), 'https://www.google.com/search?q=javascript%3Aalert(1)', 'only web addresses are opened');
  assert.equal(addressOf('file:///etc/passwd'), 'https://www.google.com/search?q=file%3A%2F%2F%2Fetc%2Fpasswd');
  assert.equal(addressOf('about:blank'), 'about:blank');
  assert.equal(addressOf('  '), '');
});

test('every harness is handed the browser tool, in fields both translations know', () => {
  assert.ok(TOOLS.some(([tool]) => tool === BROWSER_TOOL));
  for (const field of Object.values(BROWSER_TOOL.parameters.properties)) assert.ok(field.enum || ['string', 'number', 'boolean'].includes(field.type));
  assert.deepEqual(BROWSER_TOOL.parameters.required, ['action']);
});

test('the window the person turned to last is asked first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-browser-'));
  try {
    for (const [name, at] of [['browser-5067-10.sock', 1000], ['browser-5067-11.sock', 3000], ['browser-5099-12.sock', 5000], ['notes.sock', 6000]]) {
      await writeFile(join(dir, name), '');
      await utimes(join(dir, name), at, at);
    }
    assert.deepEqual(await windowSockets(5067, dir), [join(dir, 'browser-5067-11.sock'), join(dir, 'browser-5067-10.sock')], 'newest first, this port only');
    assert.deepEqual(await windowSockets(5067, join(dir, 'none')), []);
    // Left behind by a window that crashed: nobody answers, so it is cleared away.
    const stale = join(dir, 'browser-5067-10.sock');
    await assert.rejects(askWindow({ do: 'run' }, { sockets: async () => [stale], open: async () => {} }), { message: NO_WINDOW });
    await assert.rejects(stat(stale), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// An agent asked to find a post on a website once went to the desktop's
// Chromium, because the tool said no window was open. Now the tool opens one.
test('with no window open, the tool opens imperfect; without a screen only its browser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-browser-'));
  const path = join(dir, 'browser-5067-1.sock');
  const window = createSocketServer({ allowHalfOpen: true }, socket => {
    let asked = '';
    socket.on('data', chunk => { asked += chunk; });
    socket.on('end', () => socket.end(JSON.stringify({ tab: 1, url: JSON.parse(asked).url, title: 'Pi' })));
  });
  const launched = [];
  // What imperfect-open does: a window comes up and answers on its socket.
  const run = (bin, args, { env }) => {
    launched.push([bin, args, env.IMPERFECT_PORT]);
    setTimeout(() => window.listen(path), 50);
    return Object.assign(new EventEmitter(), { unref() {} });
  };
  const sockets = async () => (window.listening ? [path] : []);
  const open = options => openWindow({ ...options, env: { WAYLAND_DISPLAY: 'wayland-1' }, launcher: '/bin/imperfect-open', run });
  provideWindowPort(5067);
  try {
    const said = await runBrowser({ action: 'open', url: 'pi.dev', session: 's' }, { ask: (request, options) => askWindow(request, { ...options, sockets, open }) });
    assert.equal(said, 'Opened Pi — https://pi.dev/ (tab 1), behind the tab in front');
    assert.deepEqual(launched, [['/bin/imperfect-open', ['code'], '5067']]);
    await runBrowser({ action: 'look', session: 's' }, { ask: (request, options) => askWindow(request, { ...options, sockets, open }) }).catch(() => {});
    assert.equal(launched.length, 1, 'one window is enough');
    // From imperfect's service, a scope of its own, so a restart of the
    // service leaves the window and its tabs.
    window.close();
    await openWindow({ env: { WAYLAND_DISPLAY: 'wayland-1', INVOCATION_ID: 'service' }, launcher: '/bin/imperfect-open', run, sockets });
    assert.deepEqual(launched.at(-1), ['systemd-run', ['--user', '--scope', '--quiet', '--collect', '/bin/imperfect-open', 'code'], '5067']);
    // A window that never comes up, or a launcher that is not there.
    await assert.rejects(askWindow({ do: 'run' }, { sockets: async () => [], open: async () => {} }), { message: NO_WINDOW });
    await assert.rejects(openWindow({ env: { DISPLAY: ':0' }, launcher: join(dir, 'missing'), sockets: async () => [] }), /could not be opened here/);
    const headless = [];
    await openWindow({ env: {}, session: async () => ({}), sockets: async () => headless.length ? ['/tmp/headless.sock'] : [],
      run: (command, args, options) => { headless.push({ command, args, env: options.env }); return { on() {}, unref() {} }; } });
    assert.ok(headless[0].args.includes('--ozone-platform=headless'));
    assert.match(headless[0].args.at(-1), /desktop\/electron\/browser.mjs$/);
    assert.equal(headless[0].env.DISPLAY, undefined);
    assert.equal(headless[0].env.WAYLAND_DISPLAY, undefined);
    const scoped = [];
    await openWindow({ env: { INVOCATION_ID: 'service', ELECTRON_RUN_AS_NODE: '1' }, session: async () => ({}), sockets: async () => scoped.length ? ['/tmp/headless.sock'] : [],
      run: (command, args, options) => { scoped.push({ command, args, env: options.env }); return { on() {}, unref() {} }; } });
    assert.equal(scoped[0].command, 'systemd-run');
    assert.ok(scoped[0].args.includes('--scope'), 'the headless person browser survives backend idle-safe updates');
    assert.equal(scoped[0].env.ELECTRON_RUN_AS_NODE, undefined);
    // Started before the desktop session, the service finds the screen through the user manager.
    const fromSession = [];
    await openWindow({ env: { INVOCATION_ID: 'service' }, session: async () => ({ WAYLAND_DISPLAY: 'wayland-1' }), launcher: '/bin/imperfect-open', sockets: async () => fromSession.length ? ['/tmp/a-window.sock'] : [],
      run: (command, args, options) => { fromSession.push(options.env.WAYLAND_DISPLAY); return { on() {}, unref() {} }; } });
    assert.deepEqual(fromSession, ['wayland-1']);
  } finally {
    provideWindowPort(undefined);
    await new Promise(resolve => window.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

const SITE = {
  '/': `<title>Shop</title><h1>Welcome</h1>
    <form action="/find"><label>Find <input name="q" value="old"></label><button>Go</button></form>
    <a href="/about">About us</a>
    <button id="hidden" style="display:none">Hidden</button>
    <div contenteditable="true" aria-label="Note" id="note">draft</div>
    <input type="checkbox" checked aria-label="Remember">
    <div style="height:3000px"></div><a href="/far">Far away</a>`,
  '/about': '<title>About</title><p>We sell things.</p>',
};

// The window's side, as main.mjs answers it, with Playwright in Electron's place.
function standIn(page) {
  const here = async () => ({ url: page.url(), title: await page.title() });
  const settle = async () => { await page.waitForTimeout(300); await page.waitForLoadState(); };
  const drive = {
    run: async ({ code }) => ({ value: await page.evaluate(code) }),
    open: async ({ url }) => { await page.goto(url); },
    click: async ({ x, y }) => { await page.mouse.click(x, y); await settle(); },
    insert: async ({ text }) => { await page.keyboard.insertText(text); },
    key: async ({ key }) => { await page.keyboard.press(key); await settle(); },
    back: async () => { await page.goBack(); },
    forward: async () => { await page.goForward(); },
    capture: async () => ({ png: (await page.screenshot()).toString('base64') }),
  };
  return createSocketServer({ allowHalfOpen: true }, socket => {
    let asked = '';
    socket.on('data', chunk => { asked += chunk; });
    socket.on('end', async () => {
      let answer;
      try { const { do: action, ...request } = JSON.parse(asked); answer = { ...await drive[action](request), ...await here() }; } catch (error) { answer = { error: error.message }; }
      socket.end(JSON.stringify(answer));
    });
  });
}

test('an agent opens, reads, types, clicks, scrolls and pictures a page through the window', async () => {
  const asked = [];
  const site = createServer((req, res) => {
    const url = new URL(req.url, 'http://site');
    res.setHeader('Content-Type', 'text/html');
    if (url.pathname === '/find') { asked.push(url.searchParams.get('q')); res.end(`<title>Found</title><p>Results for ${url.searchParams.get('q')}</p>`); return; }
    res.end(SITE[url.pathname] ?? '<title>Far</title>');
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${site.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-browser-'));
  const path = join(dir, 'browser-5067-1.sock');
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const window = standIn(page);
  await new Promise(resolve => window.listen(path, resolve));
  const use = args => runBrowser(args, { ask: (request, options) => askWindow(request, { ...options, sockets: async () => [path] }) });
  try {
    assert.equal(await use({ action: 'open', url: `${at}/` }), `Opened Shop — ${at}/, behind the tab in front`);

    const seen = await use({ action: 'look' });
    assert.match(seen, /^Shop — http/);
    assert.match(seen, /Welcome/);
    const ref = name => Number(seen.match(new RegExp(`\\[(\\d+)\\] ${name}`))?.[1]);
    assert.ok(ref('input text "Find" = "old"'), seen);
    assert.ok(ref('button "Go"'), seen);
    assert.ok(ref(`link "About us" → ${at}/about`), seen);
    assert.ok(ref('editable "Note" = "draft"'), seen);
    assert.ok(ref('checkbox "Remember" \\(checked\\)'), seen);
    assert.doesNotMatch(seen.split('On screen to use')[1], /Hidden|Far away/, 'only what is on screen to use');
    assert.equal(await page.evaluate(() => typeof globalThis.imperfectRefs), 'object', 'Playwright runs the scripts in the page; Electron keeps them in a world of their own');

    // Typing replaces what is in the field, and Enter sends the form.
    assert.match(await use({ action: 'type', ref: ref('input text'), text: 'blue chairs', submit: true }), /^Typed "blue chairs" into \[\d+\] and pressed Enter\. Now at Found — /);
    assert.deepEqual(asked, ['blue chairs']);
    await assert.rejects(use({ action: 'click', ref: ref('button "Go"') }), /no \[\d+\] on the page now; look again/);
    assert.match(await use({ action: 'back' }), /^Went back to Shop/);

    let fresh = await use({ action: 'look' });
    const note = Number(fresh.match(/\[(\d+)\] editable/)[1]);
    await use({ action: 'type', ref: note, text: 'a new note' });
    assert.equal(await page.textContent('#note'), 'a new note');
    assert.equal(await use({ action: 'eval', js: 'document.title + " " + (1 + 1)' }), 'Shop 2');
    assert.equal(await use({ action: 'eval', js: '({ a: [1] })' }), '{\n "a": [\n  1\n ]\n}');

    assert.match(await use({ action: 'scroll', dy: 1000 }), /^Scrolled down 1000 pixels on Shop/);
    assert.match(await use({ action: 'scroll', dy: 5000 }), /^Scrolled down \d+ pixels on Shop/);
    fresh = await use({ action: 'look' });
    assert.match(fresh, /scrolled \d+% down/);
    const far = Number(fresh.match(/\[(\d+)\] link "Far away"/)?.[1]);
    assert.ok(far, fresh);
    assert.match(await use({ action: 'scroll', dy: -100000 }), /^Scrolled up/);
    assert.match(await use({ action: 'scroll', dy: -10 }), /^Nothing moved/);

    // A ref read before scrolling back is brought into view to be clicked.
    assert.match(await use({ action: 'click', ref: far }), /^Clicked \[\d+\]\. Now at Far — /);
    assert.match(await use({ action: 'key', key: 'Tab' }), /^Pressed Tab\. Now at Far/);

    const pictured = await use({ action: 'look', screenshot: true });
    assert.equal(pictured.length, 2);
    assert.match(pictured[0].text, /^Far — /);
    assert.equal(pictured[1].type, 'image');
    assert.equal(pictured[1].mimeType, 'image/png');
    assert.equal(Buffer.from(pictured[1].data, 'base64').subarray(1, 4).toString(), 'PNG');

    await assert.rejects(use({ action: 'fly' }), /the action is one of open, tabs, front, close, look/);
    await assert.rejects(use({ action: 'type', ref: 1 }), /type needs the text/);
  } finally {
    await new Promise(resolve => window.close(resolve));
    await browser.close();
    await new Promise(resolve => site.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

// The window's side as far as tabs go (main.mjs does this with Electron's
// pages): every request says which conversation asks and, once it has one,
// which tab; the window answers with the tab it used.
test('each tab has an id; a conversation keeps to its own tab, and only front brings one forward', async () => {
  const asked = [];
  const pages = { 7: { url: 'https://mail.example/', title: 'Mail' }, 8: { url: 'https://shop.example/', title: 'Shop' } };
  let next = 9, front = 7;
  const mine = new Map();
  const ask = async ({ do: action, session, tab, ...rest }) => {
    asked.push({ action, session, tab, ...rest });
    if (action === 'tabs') return { tabs: Object.entries(pages).map(([id, p]) => ({ tab: Number(id), ...p, front: Number(id) === front, yours: mine.get(session) === Number(id) })) };
    const id = action === 'open' && tab == null ? next++ : tab ?? mine.get(session);
    if (id == null) throw new Error('You have no tab open: open one, or name one of the person\'s (tabs lists them)');
    if (action === 'open') pages[id] = { url: rest.url, title: 'New' };
    if (action === 'front') front = id;
    mine.set(session, id);
    const page = { ...(action === 'capture' ? { png: 'iVBORw0KGgo=' } : action === 'run' ? { value: 'ran' } : {}), tab: id, ...pages[id] };
    if (action === 'close') delete pages[id];
    return page;
  };
  const use = (args, session = 'conversation-a') => runBrowser({ ...args, session }, { ask });

  assert.equal(await use({ action: 'tabs' }), '[7] Mail — https://mail.example/ (in front)\n[8] Shop — https://shop.example/');
  await assert.rejects(use({ action: 'look' }), /no tab open: open one, or name one/);
  // Opened behind the one in front; the picture is of that tab.
  const opened = await use({ action: 'open', url: 'news.example', screenshot: true });
  assert.equal(opened[0].text, 'Opened New — https://news.example/ (tab 9), behind the tab in front');
  assert.deepEqual(asked.slice(-2).map(({ action, tab, session }) => [action, tab, session]), [['open', undefined, 'conversation-a'], ['capture', 9, 'conversation-a']]);
  assert.equal(front, 7, 'opening does not take the person\'s eyes');
  // Later calls use that tab without naming it; another conversation has its own.
  assert.equal(await use({ action: 'eval', js: '1' }), 'ran');
  assert.deepEqual(asked.at(-1), { action: 'run', session: 'conversation-a', tab: undefined, code: '1', page: true });
  assert.match(await use({ action: 'tabs' }), /\[9\] New — https:\/\/news\.example\/ \(yours\)/);
  await assert.rejects(use({ action: 'key', key: 'Enter' }, 'conversation-b'), /no tab open/);
  // Naming a tab uses it, theirs too; open with a tab goes there in that tab.
  assert.equal(await use({ action: 'eval', js: 'document.title', tab: 8 }, 'conversation-b'), 'ran');
  assert.deepEqual(asked.at(-1).tab, 8);
  assert.equal(await use({ action: 'open', url: 'https://shop.example/cart', tab: 8 }, 'conversation-b'), 'Opened New — https://shop.example/cart (tab 8)');
  // Brought to the front only when asked; closed when done.
  assert.equal(await use({ action: 'front' }), 'In front now: New — https://news.example/ (tab 9)');
  assert.equal(front, 9);
  assert.equal(await use({ action: 'close' }), 'Closed New — https://news.example/ (tab 9)');
  assert.deepEqual(Object.keys(pages), ['7', '8']);
});

test('open takes the path of a page an agent made, served as show serves it', async () => {
  const key = Symbol.for('imperfect.shown');
  const before = globalThis[key];
  const added = [];
  globalThis[key] = async path => { added.push(path); return { path: `${path}/index.html`, kind: 'page', url: `https://desk.tail.ts.net:8443/shown${path.split('/').map(encodeURIComponent).join('/')}/index.html` }; };
  try {
    let url;
    const said = await runBrowser({ action: 'open', url: 'kids/city game', cwd: '/home/me/workbench', session: 's' }, { ask: async () => ({ tab: 3, url: 'https://www.google.com/search?q=kids%2Fcity%20game', title: '' }) });
    assert.match(said, /tab 3/, 'words are searched for');
    await runBrowser({ action: 'open', url: '/home/me/workbench/kids city', session: 's' }, { ask: async request => { url = request.url; return { tab: 4, url, title: 'City' }; } });
    assert.deepEqual(added, ['/home/me/workbench/kids city']);
    assert.equal(url, 'https://desk.tail.ts.net:8443/shown/home/me/workbench/kids%20city/index.html', 'at the address show gives it');
  } finally { globalThis[key] = before; }
});

// Hidden tabs never run on unseen: the tabs a session opened close when it
// ends, in every window (desktop/electron/main.mjs closes them, but for one
// in front). Ending is its tab in imperfect closed, or another session taking
// that tab's place; a session going quiet is not an ending.
test('the tabs a session opened close when the session is closed or replaced, not when it goes quiet', async () => {
  let made = 0;
  const runtime = () => {
    const events = new EventEmitter(), id = `session-${++made}`;
    let snap = { sessionId: id, sessionFile: `/tmp/${id}.jsonl`, cwd: '/tmp', messages: [], busy: false, streaming: false, failed: null };
    return { events, snapshot: () => snap, set(next) { snap = { ...snap, ...next }; events.emit('change'); }, async command() {}, async close() {} };
  };
  const runtimes = [];
  const host = await createTabHost({ createRuntime: () => { const one = runtime(); runtimes.push(one); return one; }, claudeAvailable: () => false });
  const ended = [];
  const stop = closeTabsWhenSessionsEnd(host, { end: async session => { ended.push(session); }, wait: 5 });
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  try {
    const second = await host.command({ type: 'tab-new' });
    // Working and going quiet again is not an ending.
    runtimes[0].set({ busy: true, streaming: true });
    runtimes[0].set({ busy: false, streaming: false });
    await settle();
    assert.deepEqual(ended, []);
    // Its tab closed in imperfect: it ended.
    await host.command({ type: 'tab-close', tabId: second.id });
    await settle();
    assert.deepEqual(ended, ['session-2']);
    // Another session in its place (a new one, a resume): the first ended.
    runtimes[0].set({ sessionId: 'session-9', sessionFile: '/tmp/session-9.jsonl' });
    await settle();
    assert.deepEqual(ended, ['session-2', 'session-1']);
    stop();
    await host.command({ type: 'tab-new' });
    await host.command({ type: 'tab-close', tabId: host.snapshot().tabs.at(-1).id });
    await settle();
    assert.deepEqual(ended, ['session-2', 'session-1'], 'stopped, it watches no more');
  } finally { stop(); await host.close(); }

  // Every window is told; one that cannot answer is passed by.
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-browser-'));
  const told = [];
  const windows = [1, 2].map(n => createSocketServer({ allowHalfOpen: true }, socket => {
    let asked = '';
    socket.on('data', chunk => { asked += chunk; });
    socket.on('end', () => { told.push([n, JSON.parse(asked)]); socket.end(JSON.stringify({ closed: [] })); });
  }));
  try {
    const paths = [join(dir, 'browser-5067-1.sock'), join(dir, 'browser-5067-2.sock')];
    await Promise.all(windows.map((window, i) => new Promise(resolve => window.listen(paths[i], resolve))));
    await endSession('session-1', { sockets: async () => [...paths, join(dir, 'browser-5067-3.sock')] });
    assert.deepEqual(told.sort(), [[1, { do: 'ended', session: 'session-1' }], [2, { do: 'ended', session: 'session-1' }]]);
  } finally {
    await Promise.all(windows.map(window => new Promise(resolve => window.close(resolve))));
    await rm(dir, { recursive: true, force: true });
  }
});

// The browser follows the person (createBrowser). Two computers, each its
// own imperfect with a window of its own (a stand-in socket that answers as
// main.mjs does, its tabs numbered from 2 as Electron's are, so the two
// computers' ids collide), and a session on the PC.
function fakeWindow(name, path) {
  const asked = [], pages = new Map(), mine = new Map();
  let next = 2;
  const server = createSocketServer({ allowHalfOpen: true }, socket => {
    let text = '';
    socket.on('data', chunk => { text += chunk; });
    socket.on('end', () => {
      const { do: action, session, tab, ...rest } = JSON.parse(text);
      asked.push({ do: action, session, tab, ...rest });
      let answer;
      if (action === 'ended') answer = { closed: [] };
      else if (action === 'tabs') answer = { tabs: [...pages].map(([id, url]) => ({ tab: id, url, title: name, yours: mine.get(session) === id })) };
      else {
        const id = action === 'open' && tab == null ? next++ : tab ?? mine.get(session);
        if (action === 'open') pages.set(id, rest.url);
        if (!pages.has(id)) answer = { error: 'That tab is closed; tabs lists the open ones' };
        else { mine.set(session, id); answer = { tab: id, url: pages.get(id), title: name, ...(action === 'run' ? { value: `ran on ${name}'s tab ${id}` } : {}) }; }
      }
      socket.end(JSON.stringify(answer));
    });
  });
  return new Promise(resolve => server.listen(path, () => resolve({ asked, close: () => new Promise(done => server.close(done)) })));
}

async function computers(t, names) {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-follow-'));
  const urls = {}, apps = {}, windows = {}, online = Object.fromEntries(names.map(name => [name, true]));
  t.after(async () => {
    for (const app of Object.values(apps)) await app.close();
    for (const window of Object.values(windows)) await window.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const id of names) {
    const others = names.filter(name => name !== id);
    const machines = {
      self: async () => id, selfId: async () => id, origins: async () => [], published: async () => '',
      list: async () => [{ id, name: id, url: urls[id], self: true, reachable: true }, ...others.map(other => ({ id: other, name: other, url: urls[other], self: false, reachable: online[other] }))],
      peer: async asked => (others.includes(asked) && online[asked] ? { id: asked, name: asked, url: urls[asked] } : null),
    };
    const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId: `${id}-session`, messages: [], tabs: [{ id: 't', sessionId: `${id}-session`, focused: true }] }), command: async () => ({}), close: async () => {} };
    const path = join(root, `${id}.sock`);
    windows[id] = await fakeWindow(id, path);
    apps[id] = await createGueyServer({
      stateDir: join(root, id), runtime, machines, sessionToken: `${id}-token`, identityOptions: { status: async () => ({ Self: { StableID: id } }) },
      browser: { sockets: async () => [path], open: async () => { throw new Error('no window is opened in a test'); } },
    });
    urls[id] = `http://127.0.0.1:${(await apps[id].listen()).port}`;
  }
  return { urls, apps, windows, online };
}

// A window onto a computer's sessions, at /pi or through another's /peer/,
// saying it was used, as harness.js does.
async function windowOnto(t, url) {
  const ws = new WebSocket(url.replace(/^http/, 'ws'));
  const heard = [];
  ws.on('message', raw => heard.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  t.after(() => ws.terminate());
  let n = 0;
  const used = async (machine, kind = 'desktop', ago = 0) => {
    const id = `here-${++n}`;
    ws.send(JSON.stringify({ type: 'here', id, machine, kind, ago }));
    for (const until = Date.now() + 3000; !heard.some(said => said.type === 'response' && said.id === id); await new Promise(done => setTimeout(done, 10))) {
      if (Date.now() > until) throw new Error('the computer did not hear the window');
    }
  };
  return { ws, heard, used };
}

test('a PC session\'s browser opens on the laptop window the person used, told through /peer/, and each tab keeps its computer', async t => {
  const { urls, apps, windows, online } = await computers(t, ['pc', 'laptop']);
  const use = args => runBrowser({ session: 'pc-session', ...args }, { ask: apps.pc.browser.ask });

  // The person types in imperfect on the laptop, in a PC session.
  const laptop = await windowOnto(t, `${urls.laptop}/peer/pc/pi`);
  await laptop.used('laptop');
  assert.equal(await use({ action: 'open', url: 'pi.dev' }), 'Opened laptop — https://pi.dev/ (tab 1 on laptop), behind the tab in front');
  assert.deepEqual(windows.laptop.asked.map(asked => [asked.do, asked.session, asked.url]), [['open', 'pc-session', 'https://pi.dev/']]);
  assert.deepEqual(windows.pc.asked, [], 'nothing opens on the PC');
  assert.equal(await use({ action: 'eval', js: '1' }), "ran on laptop's tab 2", 'the conversation keeps to its tab');

  // Back at the PC: a new tab opens there, though both windows call theirs 2.
  const pc = await windowOnto(t, `${urls.pc}/pi`);
  await pc.used('pc');
  assert.equal(await use({ action: 'open', url: 'example.com' }), 'Opened pc — https://example.com/ (tab 2 on pc), behind the tab in front');
  assert.equal(await use({ action: 'eval', js: '1', tab: 1 }), "ran on laptop's tab 2");
  assert.equal(await use({ action: 'eval', js: '1', tab: 2 }), "ran on pc's tab 2");
  assert.equal(await use({ action: 'eval', js: '1' }), "ran on pc's tab 2", 'its own tab, the one it used last');
  assert.equal(await use({ action: 'tabs' }), 'On pc:\n[2] pc — https://example.com/ (yours)');
  await assert.rejects(use({ action: 'look', tab: 9 }), /There is no tab 9; tabs lists the open ones/);
  // Word of an older use, arriving later, does not move the browser.
  await laptop.used('laptop', 'desktop', 60_000);
  assert.match(await use({ action: 'open', url: 'pi.dev/docs' }), /\(tab 3 on pc\)/);

  // The laptop cannot be reached: its tab says so, and the person's next
  // tab opens here.
  await laptop.used('laptop');
  online.laptop = false;
  await assert.rejects(use({ action: 'eval', js: '1', tab: 1 }), /laptop, where that tab is, cannot be reached right now/);
  assert.match(await use({ action: 'open', url: 'pi.dev/news' }), /\(tab 4 on pc\)/);
  online.laptop = true;

  // The session ends: its tabs close on both computers.
  await apps.pc.browser.end('pc-session');
  for (const name of ['pc', 'laptop']) assert.deepEqual(windows[name].asked.at(-1), { do: 'ended', session: 'pc-session', tab: undefined });

  // Only another computer's imperfect may ask the laptop's windows: not a
  // request without its exact origin, nor one through /peer/, which drops it.
  for (const url of [`${urls.laptop}/browser`, `${urls.pc}/peer/laptop/browser`]) {
    const refused = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(url.includes('/peer/') ? { origin: urls.pc } : {}) }, body: JSON.stringify({ do: 'tabs', session: 'x' }) });
    assert.equal(refused.status, 403, url);
  }
  const elsewhere = await fetch(`${urls.laptop}/browser`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"do":"tabs"}' });
  assert.equal(elsewhere.status, 403);
});

test('on the phone, the browser is the window on the computer the session is on, which the phone is told to watch', async t => {
  const { urls, apps, windows } = await computers(t, ['pc', 'laptop']);
  const use = (args, session = 'pc-session') => runBrowser({ session, ...args }, { ask: apps.pc.browser.ask });
  // The phone is served by the laptop, and has a PC session in view.
  const phone = await windowOnto(t, `${urls.laptop}/peer/pc/pi`);
  await phone.used('laptop', 'phone');
  const told = async count => {
    for (const until = Date.now() + 2000; phone.heard.filter(said => said.type === 'browse').length < count && Date.now() < until;) await new Promise(done => setTimeout(done, 10));
    return phone.heard.filter(said => said.type === 'browse');
  };
  assert.equal(await use({ action: 'open', url: 'pi.dev' }), "Opened pc — https://pi.dev/ (tab 1 on pc), behind the tab in front; the person is away from this computer and watches this browser live");
  assert.deepEqual(windows.pc.asked.map(asked => [asked.do, asked.url]), [['open', 'https://pi.dev/']], 'on the PC, where the session is');
  assert.deepEqual(windows.laptop.asked, [], 'not on the computer serving the phone');
  assert.deepEqual(await told(1), [{ type: 'browse', front: false, machine: 'pc' }], 'the phone brings up the live view of the PC behind');
  // Everything else works there, as at a desk.
  assert.equal(await use({ action: 'eval', js: '1' }), "ran on pc's tab 2");
  assert.equal(await use({ action: 'tabs' }), 'On pc:\n[1] pc — https://pi.dev/ (yours)');
  assert.match(await use({ action: 'front' }), /^In front now: pc — https:\/\/pi.dev\/ \(tab 1 on pc\); the person is away from this computer/);
  assert.deepEqual((await told(2)).at(-1), { type: 'browse', front: true, machine: 'pc' }, 'brought to the front for them to look at');
  assert.equal(windows.laptop.asked.length, 0);

  // A computer with no screen for a window says so: a sign-in the person
  // makes from the phone never quietly lands in the private browser's cookies.
  const nowhere = createBrowser({
    self: async () => ({ id: 'box', name: 'box' }), peer: async () => null,
    sockets: async () => [], open: async () => { throw new Error(NO_SCREEN); },
  });
  nowhere.seen({ machine: 'box', kind: 'phone', tell: () => assert.fail('nothing to watch') });
  for (const asked of [{ do: 'tabs', session: 's' }, { do: 'open', url: 'https://platform.openai.com/login', session: 's' }]) await assert.rejects(nowhere.ask(asked), /no screen/);
  await assert.rejects(runBrowser({ action: 'open', url: 'pi.dev', session: 's' }, { ask: nowhere.ask }), /no screen/);
  assert.match(BROWSER_TOOL.description, /their phone shows live/);
  assert.match(BROWSER_TOOL.description, /never the private browser/);
  assert.doesNotMatch(BROWSER_TOOL.description, /phone's own browser/);
});

test('explicit local and remote computers bypass the phone and continuations keep their target', async t => {
  const { urls, apps, windows, online } = await computers(t, ['pc', 'laptop']);
  const phone = await windowOnto(t, `${urls.pc}/pi`);
  await phone.used('pc', 'phone');
  const use = (args, session = 'local-session') => runBrowser({ session, ...args }, { ask: apps.pc.browser.ask });
  assert.equal(BROWSER_TOOL.parameters.properties.computer.type, 'string');
  for (const computer of ['local', 'SELF', 'pc', 'PC']) {
    assert.match(await use({ action: 'open', url: 'pi.dev', computer }), /on pc\)/);
  }
  assert.equal(await use({ action: 'eval', js: '1' }), "ran on pc's tab 5", 'without an override, the conversation keeps to its tab');
  assert.match(await use({ action: 'open', url: 'pi.dev', computer: 'LaPtOp' }, 'remote-session'), /tab 5 on laptop/);
  assert.equal(await use({ action: 'eval', js: '1' }, 'remote-session'), "ran on laptop's tab 2");
  assert.equal(await use({ action: 'eval', js: '1', computer: 'laptop', tab: 5 }, 'remote-session'), "ran on laptop's tab 2");
  assert.match(await use({ action: 'tabs', computer: 'local' }), /^On pc:/);
  assert.match(await use({ action: 'tabs', computer: 'laptop' }), /^On laptop:/);
  const counts = [windows.pc.asked.length, windows.laptop.asked.length];
  await assert.rejects(use({ action: 'open', url: 'pi.dev', computer: 'missing' }), /unknown or cannot be reached/);
  await assert.rejects(use({ action: 'eval', js: '1', computer: 'local', tab: 5 }), /does not match tab 5 on laptop/);
  await assert.rejects(use({ action: 'eval', js: '1', computer: 'laptop' }), /does not match tab 4 on pc/);
  online.laptop = false;
  await assert.rejects(use({ action: 'open', url: 'pi.dev', computer: 'laptop' }), /unknown or cannot be reached/);
  await assert.rejects(use({ action: 'eval', js: '1' }, 'remote-session'), /cannot be reached right now/);
  assert.deepEqual([windows.pc.asked.length, windows.laptop.asked.length], counts, 'failed targets never fall back');
  // The phone is told to watch whichever computer each tab opened on.
  const told = phone.heard.filter(said => said.type === 'browse');
  assert.deepEqual(told.map(said => said.machine), ['pc', 'pc', 'pc', 'pc', 'laptop'], 'each open, on the computer it was on; never a failed target');
  assert.ok(told.every(said => said.front === false), 'behind: nothing was brought to the front');
});

test('computer names are case insensitive, self ids work, and ambiguous or invalid targets fail', async () => {
  const me = { id: 'self-id', name: 'Desktop' };
  const others = [{ id: 'peer-1', name: 'Laptop', url: 'https://one' }, { id: 'peer-2', name: 'LAPTOP', url: 'https://two' }];
  const sent = [];
  const browser = createBrowser({
    self: async () => me,
    peers: async () => others,
    peer: async id => others.find(at => at.id === id),
    sockets: async () => [],
    open: async () => { throw new Error('local chosen'); },
    send: async (url, { body }) => { sent.push([url, JSON.parse(body)]); return { ok: true, json: async () => ({ tabs: [] }) }; },
  });
  browser.seen({ machine: me.id, kind: 'phone', tell: () => assert.fail('no phone fallback') });
  for (const computer of ['local', 'self', 'self-id', 'dEsKtOp']) {
    await assert.rejects(browser.ask({ do: 'tabs', computer }), /local chosen/);
  }
  await assert.rejects(browser.ask({ do: 'tabs', computer: 'laptop' }), /ambiguous/);
  for (const computer of ['', ' ', null, 123]) {
    await assert.rejects(browser.ask({ do: 'tabs', computer }), /non-empty string/);
  }
  await browser.ask({ do: 'tabs', computer: 'peer-1' });
  assert.deepEqual(sent, [['https://one/browser', { do: 'tabs' }]], 'the override is consumed here, not forwarded to another router');
});

test('the tool forwards computer on every request, including screenshot continuation', async () => {
  const requests = [];
  await runBrowser({ action: 'open', url: 'pi.dev', computer: 'local', screenshot: true }, {
    ask: async request => { requests.push(request); return request.do === 'capture' ? { png: 'picture' } : { tab: 17, url: request.url }; },
  });
  assert.deepEqual(requests.map(({ do: action, computer, tab }) => ({ action, computer, tab })), [
    { action: 'open', computer: 'local', tab: undefined },
    { action: 'capture', computer: 'local', tab: 17 },
  ]);
});

test('before any window says it was used, the browser opens on this computer, as it always did', async t => {
  const { apps, windows } = await computers(t, ['pc', 'laptop']);
  const use = args => runBrowser({ session: 'pc-session', ...args }, { ask: apps.pc.browser.ask });
  assert.equal(await use({ action: 'open', url: 'pi.dev' }), 'Opened pc — https://pi.dev/ (tab 1 on pc), behind the tab in front');
  assert.equal(await use({ action: 'eval', js: '1' }), "ran on pc's tab 2");
  assert.deepEqual(windows.laptop.asked, []);
});

test('on a hosted computer, the visitor\'s page, at any size, is told to watch the browser live; the window there is not', async t => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-hosted-'));
  const path = join(root, 'window.sock');
  const window = await fakeWindow('box', path);
  // Pages may be seen at public names for their ports.
  process.env.IMPERFECT_PAGE_ORIGIN = 'https://demo-{port}.example';
  t.after(() => { delete process.env.IMPERFECT_PAGE_ORIGIN; });
  const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId: 's', messages: [], tabs: [{ id: 't', sessionId: 's', focused: true }] }), command: async () => ({}), close: async () => {} };
  const app = await createGueyServer({
    stateDir: join(root, 'state'), runtime, hosted: true, origins: ['https://demo.example'], sessionToken: 'token',
    identityOptions: { status: async () => ({ Self: { StableID: 'box' } }) },
    machines: { self: async () => 'box', selfId: async () => 'box', origins: async () => [], published: async () => '', list: async () => [{ id: 'box', name: 'box', self: true, reachable: true }], peer: async () => null },
    browser: { sockets: async () => [path], open: async () => { throw new Error('no window is opened in a test'); } },
  });
  const port = (await app.listen()).port;
  t.after(async () => { await app.close(); await window.close(); await rm(root, { recursive: true, force: true }); });
  // A page through the demo's address, and imperfect's own window on the computer.
  const connect = async headers => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/pi`, { headers });
    const heard = [];
    ws.on('message', raw => heard.push(JSON.parse(raw)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    t.after(() => ws.terminate());
    const hello = async (kind, visible = true) => {
      const id = `hello-${heard.length}`;
      ws.send(JSON.stringify({ type: 'hello', id, kind, visible }));
      for (const until = Date.now() + 3000; !heard.some(said => said.id === id); await new Promise(done => setTimeout(done, 10))) if (Date.now() > until) throw new Error('no answer');
    };
    return { heard, hello, send: said => ws.send(JSON.stringify(said)), browse: () => heard.filter(said => said.type === 'browse') };
  };
  const visitor = await connect({ host: 'demo.example', origin: 'https://demo.example' });
  const own = await connect({});
  await visitor.hello('desktop');
  await own.hello('desktop');
  // The window there, opened on a screen no one sees, takes focus: not a person.
  const id = 'here-own';
  own.send({ type: 'here', id, machine: 'box', kind: 'desktop', ago: 0 });
  for (const until = Date.now() + 3000; !own.heard.some(said => said.id === id); await new Promise(done => setTimeout(done, 10))) if (Date.now() > until) throw new Error('no answer');
  const use = args => runBrowser({ session: 's', ...args }, { ask: app.browser.ask });
  assert.equal(await use({ action: 'open', url: 'pi.dev' }), 'Opened box — https://pi.dev/ (tab 1 on box), behind the tab in front; the person is away from this computer and watches this browser live');
  for (const until = Date.now() + 2000; !visitor.browse().length && Date.now() < until;) await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(visitor.browse(), [{ type: 'browse', front: false, machine: 'box' }], 'the visitor\'s laptop-sized page brings up the live view');
  assert.deepEqual(own.browse(), [], 'the window on the computer itself is never told');
  // A page in a hidden tab says so and is passed over for one in sight.
  const other = await connect({ host: 'demo.example', origin: 'https://demo.example' });
  await other.hello('phone', false);
  assert.match(await use({ action: 'front' }), /the person is away from this computer/);
  for (const until = Date.now() + 2000; visitor.browse().length < 2 && Date.now() < until;) await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(visitor.browse().at(-1), { type: 'browse', front: true, machine: 'box' });
  assert.deepEqual(other.browse(), []);
  // A hosted file opens at its private containing-folder origin inside the
  // computer's browser, without routing the visitor to its own loopback.
  await writeFile(join(root, 'made.html'), '<title>made</title>');
  await use({ action: 'open', url: join(root, 'made.html') });
  assert.match(window.asked.at(-1).url, /^http:\/\/[a-f0-9]{32}\.localhost:\d+\/made\.html$/);
  await use({ action: 'open', url: 'https://demo-3000.example/game?level=2' });
  assert.equal(window.asked.at(-1).url, 'http://localhost:3000/game?level=2');
  await use({ action: 'open', url: 'https://demo-3000.example.org/' });
  assert.equal(window.asked.at(-1).url, 'https://demo-3000.example.org/', 'another site is left as it is');
});
