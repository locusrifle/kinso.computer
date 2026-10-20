// The browser's tabs for real: the desktop window (desktop/electron/main.mjs)
// out of sight, in a profile of its own, onto a throwaway imperfect on a port
// of its own, so the person's window and agents are never touched. With no
// window open, an agent's `browser` tool opens one (here the hidden one, in
// place of imperfect-open), then opens tabs behind the one in front and uses them there:
// look, click, eval, a picture, timers still running. Then a page an agent
// made, as show serves it, sandboxed. Then the window's keys pressed inside
// the websites (Super+Right, Super+Left, Super+W), and a session
// ending, which closes the tabs it opened behind. Then another session in
// view: what the first one's agent opens lands in the one browser every
// session shares, behind the tab in front, and is used there, read and
// pictured, without coming to the front. Last, the person's phone watching
// the browser live (desktop/electron/live.mjs): pictures of the tab in front
// while it watches, the tabs as a list, a tab chosen from it and a tap on a
// button there, a click on the page.
//
//   node tools/check-browser-tabs.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import WebSocket from 'ws';
import { chromium } from 'playwright';
import { createGueyServer } from '../system/server.mjs';
import { createTabHost } from '../apps/code/native/tabs.mjs';
import { askWindow, endSession, openWindow, provideWindowPort, runBrowser, windowSockets } from '../apps/code/native/browser.mjs';
import { addressOf } from '../apps/code/native/public/js/pages.js';

const root = await mkdtemp(join(tmpdir(), 'imperfect-tabs-'));
const page = (colour, title) => `<title>${title}</title><body style="margin:0;background:${colour}"><h1 id="n">0</h1>
  <button style="position:absolute;left:40px;top:120px;width:200px;height:80px" onclick="document.title='${title} clicked'">Press</button>
  <script>let n = 0; setInterval(() => { document.getElementById('n').textContent = ++n; }, 100);</script></body>`;
const site = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/blue' ? page('#0000ff', 'Blue') : page('#ff0000', 'Red')); });
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const at = `http://127.0.0.1:${site.address().port}`;

let sessions = 0;
const fake = () => {
  const id = `s${++sessions}`;
  const snap = { sessionId: id, sessionFile: id, cwd: root, messages: [], busy: false, streaming: false, failed: null };
  return { events: new EventEmitter(), snapshot: () => snap, command: async () => ({ ok: true }), close: async () => {} };
};
const runtime = await createTabHost({ cwd: root, stateDir: join(root, 'tabs'), createRuntime: fake, listPiSessions: async () => [], listClaudeSessions: async () => [] });
const machine = await createGueyServer({ host: '127.0.0.1', port: 0, stateDir: join(root, 'server'), sessionToken: 'browser-tabs-fixture-only', runtime, machines: { self: async () => 'check', selfId: async () => 'check', origins: async () => [], list: async () => [], peer: async () => null } });
const port = (await machine.listen()).port;
provideWindowPort(port);

// Out of sight on X11 (Xwayland): a Wayland window never shown draws nothing,
// which is not what is being checked; a covered tab in a window on screen is.
let electron = null, stderr = '', cdp = null;
const launch = (_, args, { env }) => {
  electron = spawn(join(import.meta.dirname, '../node_modules/.bin/electron'), ['desktop/electron/main.mjs', '--hidden', '--disable-gpu', '--remote-debugging-port=0', ...(process.env.DISPLAY ? ['--ozone-platform=x11'] : []), `--user-data-dir=${join(root, 'profile')}`],
    { cwd: join(import.meta.dirname, '..'), env: { ...env, ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  electron.stderr.on('data', chunk => { stderr += chunk; });
  return electron;
};

// The first pixel of a PNG: under every filter, the first row's first pixel is as it is.
function firstPixel(base64) {
  const png = Buffer.from(base64, 'base64');
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
}
const use = (args, session = 'conversation-a') => runBrowser({ ...args, session }, { ask: (request, options) => askWindow(request, { ...options, open: asked => openWindow({ ...asked, run: launch }) }) });
try {
  // No window is open: the first thing asked of the tool opens one, and Red
  // in it, in front; Blue behind it.
  assert.deepEqual(await windowSockets(port), []);
  const red = Number((await use({ action: 'open', url: `${at}/red` })).match(/\(tab (\d+)\)/)[1]);
  assert.equal((await windowSockets(port)).length, 1, 'the tool opened a window');
  const blue = Number((await use({ action: 'open', url: `${at}/blue` })).match(/\(tab (\d+)\)/)[1]);
  let tabs = await use({ action: 'tabs' });
  console.log(tabs);
  assert.match(tabs, new RegExp(`\\[${red}\\] Red .*\\(in front\\)`));
  assert.match(tabs, new RegExp(`\\[${blue}\\] Blue .*\\(yours\\)`));

  // A quiet opening leaves the session in view. A human reveals the browser
  // before checking guest pixels; off-canvas guests cannot paint.
  const endpoint = stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
  assert.ok(endpoint, 'the isolated desktop has a debugging endpoint');
  cdp = await chromium.connectOverCDP(endpoint);
  const shell = cdp.contexts()[0].pages().find(page => page.url().startsWith(`http://127.0.0.1:${port}/`));
  assert.ok(shell, 'the canvas page');
  assert.ok(await shell.evaluate(() => document.querySelector('.canvas-strip').scrollLeft === 0), 'a quiet browser opening leaves the view alone');
  await shell.keyboard.press('Meta+Shift+B');
  await new Promise(r => setTimeout(r, 300));

  // Blue, behind Red, used without naming it: read, pictured, clicked, its timers running.
  const seen = await use({ action: 'look', screenshot: true });
  assert.match(seen[0].text, /^Blue — /);
  assert.equal(seen[1].mimeType, 'image/png');
  assert.deepEqual(firstPixel(seen[1].data), [0, 0, 255], 'a picture of the tab behind, not the one in front');
  const press = Number(seen[0].text.match(/\[(\d+)\] button "Press"/)[1]);
  assert.match(await use({ action: 'click', ref: press }), /Now at Blue clicked/);
  const before = Number(await use({ action: 'eval', js: "document.getElementById('n').textContent" }));
  await new Promise(r => setTimeout(r, 1000));
  const after = Number(await use({ action: 'eval', js: "document.getElementById('n').textContent" }));
  assert.ok(after - before >= 5, `timers run behind: ${before} -> ${after}`);
  assert.match(await use({ action: 'tabs' }), new RegExp(`\\[${red}\\] Red — [^\\n]* \\(in front\\)`), 'Red is still in front, unclicked');
  // Red, in front, pictured too.
  assert.deepEqual(firstPixel((await use({ action: 'look', tab: red, screenshot: true }))[1].data), [255, 0, 0]);

  // Another conversation has no tab of its own until it opens or names one.
  await assert.rejects(use({ action: 'look' }, 'conversation-b'), /no tab open/);
  // Brought to the front when asked; closed when done.
  assert.match(await use({ action: 'front', tab: blue }), /^In front now: Blue clicked/);
  assert.match(await use({ action: 'tabs' }), new RegExp(`\\[${blue}\\] Blue clicked .*\\(in front\\)`));
  assert.match(await use({ action: 'close', tab: red }), /^Closed Red/);
  // Closing is acknowledged before the renderer removes its guest.
  for (const deadline = Date.now() + 3000; /Red/.test(tabs = await use({ action: 'tabs' })) && Date.now() < deadline;) await new Promise(r => setTimeout(r, 20));
  assert.doesNotMatch(tabs, /Red/);

  // A page an agent made, at the address show gives it: on the page
  // listener, an origin of its own (off a tailnet, 127.0.0.1 at imperfect's
  // port + 1), so it keeps its saves (a reload later, they are there), its
  // module scripts load, and imperfect is out of its reach.
  await mkdir(join(root, 'game'));
  await writeFile(join(root, 'game', 'index.html'), '<title>Game</title><p>stars</p><script type="module" src="./game.js"></script>');
  await writeFile(join(root, 'game', 'game.js'), "document.title = `Game ${localStorage.getItem('stars') ?? 'new'}`;");
  const opened = await use({ action: 'open', url: join(root, 'game') });
  assert.match(opened, /^Opened Game new — http:\/\/127\.0\.0\.1:\d+\/shown\//);
  const address = opened.match(/ — (\S+) \(tab/)[1];
  assert.notEqual(new URL(address).port, String(port), 'not imperfect\'s own');
  assert.equal(await use({ action: 'eval', js: "localStorage.setItem('stars', '3'), 'kept'" }), 'kept');
  await use({ action: 'eval', js: 'location.reload(), 1' });
  await new Promise(r => setTimeout(r, 1000));
  assert.match(await use({ action: 'look' }), new RegExp(`^Game 3 — ${address.replaceAll('.', '\\.')}`), 'the save outlived a reload');
  assert.equal(await use({ action: 'eval', js: `fetch('http://127.0.0.1:${port}/sessions.json').then(r => r.status, e => e.name)` }), 'TypeError', 'imperfect is not its to ask');
  assert.equal(await use({ action: 'eval', js: "fetch('/files/list').then(r => r.status)" }), '404', 'nor is anything but pages on its own origin');
  // Its address, opened again as it is: saves and all.
  assert.match(await use({ action: 'open', url: address }), /^Opened Game 3 — /);
  await use({ action: 'close' });
  console.log(await use({ action: 'tabs' }));
  const game = Number((await use({ action: 'tabs' })).match(/\[(\d+)\] Game/)[1]);

  // Observe only this throwaway hidden host, never the installed window.
  assert.deepEqual(await shell.evaluate(() => [...document.querySelectorAll('.canvas-strip > .wm-window')].sort((a, b) => a.style.order - b.style.order).map(el => el.classList.contains('entry-screen') ? 'conversation' : el.classList.contains('wm-files') ? 'files' : 'browser')), ['conversation', 'files', 'browser'], 'the native browser opens in the next place on the right');
  const header = await shell.evaluate(() => {
    const bar = document.querySelector('.wm-browser .gui-window-bar').getBoundingClientRect();
    const address = document.querySelector('.gui-window-address').getBoundingClientRect();
    const guest = document.querySelector('.browser-page.front webview').getBoundingClientRect();
    const controls = document.querySelector('.browser-controls').getBoundingClientRect();
    const strip = document.querySelector('.browser-tab-strip').getBoundingClientRect();
    return { barBottom: bar.bottom, addressTop: address.top, addressBottom: address.bottom, controlsTop: controls.top, controlsBottom: controls.bottom, stripBottom: strip.bottom, guestTop: guest.top, height: bar.height };
  });
  assert.equal(header.height, 72);
  assert.ok(header.stripBottom <= header.controlsTop + 1, 'tabs occupy the upper header row');
  assert.ok(header.addressTop >= header.controlsTop && header.addressBottom <= header.controlsBottom + 1, 'the URL is contained in the lower navigation row');
  assert.ok(Math.abs(header.controlsBottom - header.barBottom + 1) <= 1, 'the lower row ends at the divider');
  assert.ok(Math.abs(header.guestTop - header.barBottom) <= 1, 'the native guest starts below the header');
  if (process.env.BROWSER_NATIVE_PREVIEW) await shell.screenshot({ path: process.env.BROWSER_NATIVE_PREVIEW });

  // Production tab strip, with actual Electron guests (not FAKE_DESK). Keep
  // the earlier browser-tool/history/timer/live checks intact below.
  const stripTabs = shell.locator('.wm-browser .browser-tab');
  assert.equal(await shell.locator('.wm-browser .browser-tab-strip').count(), 1);
  assert.equal(await shell.locator('.wm-browser .browser-count,.wm-browser .browser-list').count(), 0);
  assert.equal(await stripTabs.count(), 2);
  assert.deepEqual(await stripTabs.locator('.browser-tab-title').allTextContents(), ['Blue clicked', 'Game 3']);
  assert.equal(await stripTabs.first().getAttribute('aria-selected'), 'true');
  await stripTabs.first().focus();
  await shell.keyboard.press('End');
  assert.equal(await stripTabs.last().getAttribute('aria-selected'), 'true');
  assert.equal(await stripTabs.last().evaluate(tab => tab === document.activeElement), true);
  await shell.keyboard.press('Home');
  assert.equal(await stripTabs.first().getAttribute('aria-selected'), 'true');
  assert.equal(await stripTabs.evaluateAll(tabs => tabs.filter(tab => tab.tabIndex === 0).length), 1);
  const nativeGeometry = () => shell.evaluate(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
    const panel = document.querySelector('.wm-browser'), row = panel.querySelector('.browser-tabs');
    return { bar: rect(panel.querySelector('.gui-window-bar')), controls: rect(panel.querySelector('.browser-controls')), address: rect(panel.querySelector('.gui-window-address')), tops: [...row.children].map(node => node.getBoundingClientRect().top), overflow: row.scrollWidth > row.clientWidth };
  });
  const geometryBefore = await nativeGeometry();
  const extras = [];
  for (let index = 0; index < 10; index++) extras.push(Number((await use({ action: 'open', url: `${at}/strip-${index}` }, 'strip-check')).match(/\(tab (\d+)\)/)[1]));
  await shell.waitForFunction(() => document.querySelectorAll('.wm-browser .browser-tab').length === 12);
  const geometryAfter = await nativeGeometry();
  assert.ok(geometryAfter.overflow, 'real native strip scrolls with twelve tabs');
  assert.equal(new Set(geometryAfter.tops.map(Math.round)).size, 1, 'native tabs never wrap');
  assert.deepEqual(geometryAfter.address, geometryBefore.address, 'overflow cannot displace the real address field');
  assert.deepEqual(geometryAfter.controls, geometryBefore.controls);
  assert.equal(geometryAfter.bar[3], 72);
  await stripTabs.first().focus();
  await stripTabs.first().evaluate(tab => { window.retainedNativeTab = tab; });
  await use({ action: 'eval', tab: extras.at(-1), js: "document.title = 'Agent research.html', 1" }, 'strip-check');
  await shell.waitForFunction(() => document.querySelector('.wm-browser .browser-tab:last-child')?.classList.contains('driven') || [...document.querySelectorAll('.wm-browser .browser-tab.driven')].some(tab => tab.textContent.includes('Agent research')));
  assert.equal(await stripTabs.first().evaluate(tab => tab === retainedNativeTab && tab === document.activeElement), true, 'native guest updates retain strip DOM/focus');
  assert.equal(await stripTabs.last().locator('.browser-tab-title').textContent(), 'Agent research');
  // Middle click on the wrapper and explicit x both remove real guests.
  await shell.locator('.wm-browser .browser-tab-item').last().click({ button: 'middle' });
  await shell.waitForFunction(() => document.querySelectorAll('.wm-browser .browser-tab').length === 11);
  assert.doesNotMatch(await use({ action: 'tabs' }, 'strip-check'), new RegExp(`\\[${extras.at(-1)}\\]`));
  await shell.locator('.wm-browser .browser-tab-close').last().click();
  await shell.waitForFunction(() => document.querySelectorAll('.wm-browser .browser-tab').length === 10);
  for (const tab of extras.slice(0, -2)) await use({ action: 'close', tab }, 'strip-check');
  await shell.waitForFunction(() => document.querySelectorAll('.wm-browser .browser-tab').length === 2);
  await shell.locator('.wm-browser .browser-new').click();
  await shell.waitForFunction(() => document.querySelectorAll('.wm-browser .browser-tab').length === 3);
  assert.equal(await shell.locator('.wm-browser .browser-tab.front .browser-tab-title').textContent(), 'New tab');
  assert.equal(await shell.locator('.wm-browser .browser-page.front webview').getAttribute('src'), 'about:blank');
  await shell.locator('.wm-browser .browser-page.front .browser-start').waitFor();
  const pinNames = ['Gmail', 'X', 'imperfect.computer', 'YouTube'];
  assert.deepEqual(await shell.locator('.wm-browser .browser-page.front .browser-start-pin').evaluateAll(all => all.map(one => one.getAttribute('aria-label'))), pinNames);
  assert.deepEqual(await shell.locator('.wm-browser .browser-pin').evaluateAll(all => all.map(one => one.getAttribute('aria-label'))), pinNames);
  const blank = (await askWindow({ do: 'tabs', session: 'start-check' })).tabs.find(one => one.front);
  assert.equal(blank.url, 'about:blank');
  assert.equal((await askWindow({ do: 'run', tab: blank.tab, session: 'start-check', page: true, code: 'document.body.innerHTML' })).value, '', 'real agent guest stays blank under start chrome');
  if (process.env.BROWSER_NATIVE_START_PREVIEW) await shell.screenshot({ path: process.env.BROWSER_NATIVE_START_PREVIEW });
  await stripTabs.last().focus(); await shell.keyboard.press('Control+w');
  await shell.waitForFunction(() => document.querySelectorAll('.wm-browser .browser-tab').length === 2);
  await stripTabs.first().focus(); await shell.keyboard.press('Control+t');
  await shell.waitForFunction(() => document.querySelectorAll('.wm-browser .browser-tab').length === 3);
  await shell.locator('.wm-browser .browser-tab-close').last().click();
  await shell.waitForFunction(() => document.querySelectorAll('.wm-browser .browser-tab').length === 2);
  await use({ action: 'front', tab: blue });
  console.log('ok: real Electron strip selects/focuses, retains DOM under agent updates, overflows without wrapping, creates tabs and closes guests via x/middle/Ctrl+W');

  const selected = () => shell.evaluate(() => document.querySelector('.wm-focused')?.className);
  // Super+arrows inside a real guest bring the next pane out of sight into
  // view with the keys, without changing browser tabs/history.
  // Super+W still closes the tab in front.
  const red2 = Number((await use({ action: 'open', url: `${at}/red` }, 'conversation-b')).match(/\(tab (\d+)\)/)[1]);
  const inFront = async () => Number((await use({ action: 'tabs' })).match(/\[(\d+)\][^\n]*\(in front\)/)?.[1]);
  const keyIn = async key => { await use({ action: 'key', key, tab: await inFront() }).catch(error => { if (!/closed/.test(error.message)) throw error; }); await new Promise(r => setTimeout(r, 300)); };
  assert.equal(await inFront(), blue);
  const beforeGuestKeys = await stripTabs.count();
  await keyIn('Control+t');
  await shell.waitForFunction(count => document.querySelectorAll('.wm-browser .browser-tab').length === count + 1, beforeGuestKeys);
  await shell.locator('.wm-browser .browser-page.front .browser-start').waitFor();
  assert.equal(await shell.locator('.wm-browser .browser-page.front webview').getAttribute('src'), 'about:blank');
  await keyIn('Control+w');
  await shell.waitForFunction(count => document.querySelectorAll('.wm-browser .browser-tab').length === count, beforeGuestKeys);
  await use({ action: 'front', tab: blue });
  console.log('ok: real guest Ctrl+T/Ctrl+W forward new/close, with chrome-only blank start');
  await keyIn('Super+ArrowRight');
  assert.match(await selected(), /wm-browser/, 'right edge never wraps');
  assert.equal(await inFront(), blue, 'Super+Right never changes browser tabs');
  // Left: Files if it is partly out of sight, else past it to the conversation.
  for (let i = 0; i < 2 && !/entry-screen/.test(await selected()); i++) await keyIn('Super+ArrowLeft');
  assert.match(await selected(), /entry-screen/, 'forwarded guest chord transfers keyboard ownership');
  assert.equal(await inFront(), blue, 'Super+Left never changes browser tabs');
  await keyIn('Super+ArrowLeft');
  assert.match(await selected(), /entry-screen/, 'left edge never wraps');
  for (let i = 0; i < 2 && !/wm-browser/.test(await selected()); i++) await keyIn('Super+ArrowRight');
  assert.match(await selected(), /wm-browser/);
  await shell.waitForFunction(() => {
    const pane = document.querySelector('.wm-browser').getBoundingClientRect(), strip = document.querySelector('.canvas-strip').getBoundingClientRect();
    return pane.left >= strip.left - 2 && pane.right <= strip.right + 2;
  });
  await use({ action: 'front', tab: red2 }, 'conversation-b');
  // A person's keyboard is in the page they clicked in.
  const pressMe = Number((await use({ action: 'look', tab: red2 }, 'conversation-b')).match(/\[(\d+)\] button "Press"/)[1]);
  await use({ action: 'click', ref: pressMe, tab: red2 }, 'conversation-b');
  await keyIn('Super+w');
  tabs = await use({ action: 'tabs' });
  assert.doesNotMatch(tabs, new RegExp(`\\[${red2}\\]`), 'Super+W closed the tab in front');
  assert.match(tabs, new RegExp(`\\[${blue}\\]`));
  console.log(tabs);
  // Its session ends: the tabs it opened close, but for the one in front.
  await use({ action: 'front', tab: game });
  await endSession('conversation-a');
  await new Promise(r => setTimeout(r, 300));
  tabs = await use({ action: 'tabs' });
  console.log(tabs);
  assert.doesNotMatch(tabs, new RegExp(`\\[${blue}\\]`), 'a tab it opened, behind, closed');
  assert.match(tabs, new RegExp(`\\[${game}\\][^\\n]*\\(in front\\)`), 'the one in front stays');

  // Another session started, the window follows it; the browser stays as it
  // is (public/js/windows.js). The first session's agent opens a tab: in the
  // same browser, behind the one in front of the person, and there it is
  // read, pictured, and keeps its timers.
  const first = runtime.snapshot().tabs[0].sessionId;
  await runtime.command({ type: 'tab-new', agent: 'pi' });
  await new Promise(r => setTimeout(r, 1500));
  const away = Number((await use({ action: 'open', url: `${at}/blue` }, first)).match(/\(tab (\d+)\)/)[1]);
  tabs = await use({ action: 'tabs' }, first);
  console.log(tabs);
  assert.match(tabs, new RegExp(`\\[${away}\\] Blue — [^\\n]*\\(yours\\)$`, 'm'), 'behind, not in front of the person');
  assert.match(tabs, new RegExp(`\\[${game}\\][^\\n]*\\(in front\\)`), 'the tab in front is as it was');
  assert.match(await use({ action: 'tabs' }, 'conversation-b'), new RegExp(`\\[${away}\\] Blue`), 'one set of tabs, the same from every session');
  const there = await use({ action: 'look', screenshot: true }, first);
  assert.match(there[0].text, /^Blue — /);
  assert.deepEqual(firstPixel(there[1].data), [0, 0, 255], 'pictured out of sight');
  const was = Number(await use({ action: 'eval', js: "document.getElementById('n').textContent" }, first));
  await new Promise(r => setTimeout(r, 1000));
  assert.ok(Number(await use({ action: 'eval', js: "document.getElementById('n').textContent" }, first)) - was >= 5, 'its timers run out of sight');
  // The phone watching, on its connection to this computer.
  const phone = new WebSocket(`ws://127.0.0.1:${port}/browser/live`);
  const heard = [];
  phone.on('message', raw => heard.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => { phone.once('open', resolve); phone.once('error', reject); });
  const hear = async (check, what) => {
    for (const end = Date.now() + 10_000; !heard.some(check); await new Promise(r => setTimeout(r, 50))) if (Date.now() > end) throw new Error(`the phone never heard ${what}: ${JSON.stringify(heard.map(said => (said.frame ? { ...said, frame: said.frame.length } : said)))}`);
    return heard.findLast(check);
  };
  phone.send(JSON.stringify({ do: 'watch', width: 780, height: 1600 }));
  const list = (await hear(said => said.tabs, 'the tabs')).tabs;
  console.log(list);
  const shot = await hear(said => said.frame, 'a picture');
  assert.match(shot.frame, /^\/9j\//, 'a JPEG');
  assert.ok(shot.width > 0 && shot.height > 0, 'with the page\'s size');
  phone.send('{"ack":true}');
  // Blue, chosen from the list: its pictures come, and a tap on its button
  // is a click there.
  const blueTab = list.find(one => /^Blue/.test(one.title)).tab;
  phone.send(JSON.stringify({ do: 'front', tab: blueTab }));
  const blueShot = await hear(said => said.frame && said.tab === blueTab, 'Blue pictured');
  phone.send('{"ack":true}');
  assert.match(await use({ action: 'tabs' }), new RegExp(`\\[${blueTab}\\] Blue[^\\n]*\\(in front\\)`), 'in front in the window too');
  // Its button is at 40..240 by 120..200 on the page.
  assert.ok(blueShot.width > 240 && blueShot.height > 200);
  // Input meant for the tab of an older picture reaches nothing.
  const olderTab = shot.tab;
  phone.send(JSON.stringify({ do: 'tap', tab: olderTab, x: 140, y: 160 }));
  await hear(said => said.error === 'The tab in front changed; look again', 'a stale tap refused');
  phone.send(JSON.stringify({ do: 'tap', tab: blueTab, x: 140, y: 160 }));
  await hear(said => said.tabs?.some(one => one.tab === blueTab && one.title === 'Blue clicked'), 'the click');
  await hear(said => said.field === 'text', 'the field kind');
  // A finger drawn up scrolls the page down; typed text and Enter reach it.
  await use({ action: 'eval', js: "document.body.style.height = '5000px', document.body.insertAdjacentHTML('afterbegin', '<input id=box autofocus>'), document.getElementById('box').focus(), 1", tab: blueTab }, first);
  phone.send(JSON.stringify({ do: 'scroll', tab: blueTab, x: 300, y: 300, dy: 400 }));
  await new Promise(r => setTimeout(r, 800));
  assert.ok(Number(await use({ action: 'eval', js: 'scrollY', tab: blueTab }, first)) > 0, 'scrolled down');
  await use({ action: 'eval', js: "scrollTo(0, 0), document.getElementById('box').focus(), document.getElementById('box').onkeydown = e => { if (e.key === 'Enter') document.title = 'Entered ' + e.target.value; }, 1", tab: blueTab }, first);
  phone.send(JSON.stringify({ do: 'type', tab: blueTab, text: 'hello', enter: true }));
  await hear(said => said.tabs?.some(one => one.tab === blueTab && one.title === 'Entered hello'), 'the typing');
  // A password field tapped: the phone is told, so its box hides what is typed.
  await use({ action: 'eval', js: "document.body.insertAdjacentHTML('afterbegin', '<input type=password id=pw style=\"position:fixed;left:260px;top:20px;width:180px;height:40px;z-index:9\">'), 1", tab: blueTab }, first);
  heard.length = 0;
  phone.send(JSON.stringify({ do: 'tap', tab: blueTab, x: 350, y: 40 }));
  await hear(said => said.field === 'password', 'a password field');
  phone.send(JSON.stringify({ do: 'type', tab: blueTab, text: 'not-a-real-secret' }));
  await new Promise(r => setTimeout(r, 400));
  assert.match(await use({ action: 'eval', js: "document.getElementById('pw').value", tab: blueTab }, first), /not-a-real-secret/);
  phone.close();
  console.log('ok: the phone watches the tab in front, chooses another, clicks, scrolls and types in it');
  console.log('ok: tabs behind are drawn, pictured, clicked and keep their timers; the keys work inside websites; an ended session leaves none behind; a session out of view opens its tabs behind in the one shared browser, drawn and running');

  // One ordinary Google search in this throwaway Electron window/profile.
  // Do not accept consent, solve captcha, spoof a client or retry around a
  // block. The requested URL is deterministic; network/page state is evidence,
  // informational rather than a flaky regression assertion.
  const query = 'imperfect computer';
  const expectedGoogle = 'https://www.google.com/search?q=imperfect%20computer';
  assert.equal(addressOf(query), expectedGoogle);
  const google = await askWindow({ do: 'open', url: 'about:blank', session: 'google-check' });
  let navigationError = null;
  try { await use({ action: 'open', url: query, tab: google.tab }, 'google-check'); }
  catch (error) { navigationError = error.message; }
  await use({ action: 'front', tab: google.tab }, 'google-check');
  await shell.keyboard.press('Meta+Shift+B');
  const observation = await askWindow({ do: 'run', tab: google.tab, session: 'google-check', page: true,
    code: '({url: location.href, title: document.title, text: (document.body?.innerText || "").slice(0, 1200)})' }).then(answer => answer.value, error => ({ error: error.message }));
  console.log('Google informational observation:', JSON.stringify({ requested: expectedGoogle, navigationError, ...observation }));
  if (process.env.BROWSER_GOOGLE_PREVIEW) await shell.screenshot({ path: process.env.BROWSER_GOOGLE_PREVIEW });
} catch (error) { console.log(stderr.split('\n').slice(-30).join('\n')); throw error; } finally {
  await cdp?.close();
  // Gone before its profile is taken away, which it writes to until then.
  if (electron && electron.exitCode === null && electron.signalCode === null) { const gone = new Promise(resolve => electron.once('exit', resolve)); electron.kill(); await gone; }
  await machine.close();
  site.close();
  await rm(root, { recursive: true, force: true });
}
