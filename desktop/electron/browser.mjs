// The person's browser on a computer without a screen. No canvas, compositor
// or galaxy: just website pages, shared with the person through live.mjs.
// This is NOT the private browser: cookies persist and every session can use
// the person's tabs. The tool and live view use the usual owner-only socket.
// Five minutes unused and unwatched closes the tabs, not their logins. The
// backend launches this in an independent scope, so its updates do not close
// a browser someone is watching. Neither private.mjs nor the canvas changes.
import { app, BrowserWindow, nativeTheme, session } from 'electron';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DRIVE, watchArrivals } from './drive.mjs';
import { answer, createLive } from './live.mjs';
import { createBrowserIdle } from './browser-idle.mjs';
import { installWebsitePopups } from './popups.mjs';

const port = Number(process.env.IMPERFECT_PORT) || 5067;
const dir = join(homedir(), '.imperfect');
const profile = join(dir, `browser-profile-${port}`);
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
const path = join(dir, `browser-${port}-${process.pid}.sock`);
const counter = join(profile, 'tab-number');
let made = 0;
try {
  made = Number(readFileSync(counter, 'utf8'));
  if (!Number.isSafeInteger(made) || made < 0) throw new Error('Invalid browser tab counter');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const tabs = new Map(), windows = new Map(), theirs = new Map(), opened = new Map();
let front = null, server, live;
const sizes = new Map();
const web = url => { try { return url === 'about:blank' || /^https?:$/.test(new URL(url).protocol); } catch { return false; } };
// Never open the machine's harness as a website in the agent's browser.
const ours = url => { try { const at = new URL(url); return ['localhost', '127.0.0.1', '[::1]'].includes(at.hostname) && Number(at.port) === port; } catch { return false; } };
const about = page => ({ tab: page.id, url: page.getURL(), title: page.getTitle() });
const idle = createBrowserIdle({ watching: () => live?.watching() ?? 0, stop: () => app.quit() });
function close(id) {
  const win = windows.get(id);
  if (win && !win.isDestroyed()) win.destroy();
  windows.delete(id); tabs.delete(id); sizes.delete(id);
  if (front === id) front = tabs.keys().next().value ?? null;
  void live.changed();
}
function newTab(options = {}, opener = null) {
  const viewport = { width: 1280, height: 800, scale: 1 };
  const win = new BrowserWindow({ ...options, show: false, focusable: false, width: Math.round(viewport.width * viewport.scale), height: Math.round(viewport.height * viewport.scale),
    webPreferences: { ...options.webPreferences, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, disableDialogs: true, spellcheck: false } });
  win.setContentSize(Math.round(viewport.width * viewport.scale), Math.round(viewport.height * viewport.scale));
  const page = win.webContents;
  // Electron ids restart at one each launch. Use durable positive ids on the
  // wire, so a stale agent reference fails closed rather than clicking elsewhere.
  if (made >= Number.MAX_SAFE_INTEGER) throw new Error('Browser tab numbers exhausted');
  const id = ++made;
  writeFileSync(`${counter}.tmp`, String(id), { mode: 0o600 });
  renameSync(`${counter}.tmp`, counter);
  const exposed = new Proxy({}, { get(_, key) {
    if (key === 'id') return id;
    const value = page[key];
    return typeof value === 'function' ? value.bind(page) : value;
  } });
  page.setVisualZoomLevelLimits(1, 1);
  page.setZoomFactor(viewport.scale);
  // Page zoom is origin-specific in Electron; keep our pixel density across
  // navigation too, without changing the CSS viewport or any headed page.
  page.on('did-navigate', () => page.setZoomFactor(viewport.scale));
  installWebsitePopups(page, { ours, createWindow: options => {
    const popup = newTab(options, id);
    front = popup.id;
    void live.changed();
    return windows.get(popup.id).webContents;
  } });
  for (const leaving of ['will-navigate', 'will-redirect']) page.on(leaving, event => { if (!web(event.url) || ours(event.url)) event.preventDefault(); });
  page.on('will-prevent-unload', event => event.preventDefault());
  page.on('login', (event, _, __, callback) => { event.preventDefault(); callback(); });
  page.on('select-client-certificate', (event, _, __, callback) => { event.preventDefault(); callback(); });
  watchArrivals(exposed);
  tabs.set(id, exposed); windows.set(id, win); sizes.set(id, viewport);
  page.once('destroyed', () => { tabs.delete(id); windows.delete(id); sizes.delete(id); if (front === id) front = tabs.has(opener) ? opener : tabs.keys().next().value ?? null; void live.changed(); });
  live.observe(exposed);
  if (front == null) front = id;
  return exposed;
}
async function drive({ do: action, session: who = '', tab: id, ...asked }) {
  const done = idle.begin();
  try {
    who = String(who);
    if (action === 'tabs') return { tabs: [...tabs.values()].map(page => ({ ...about(page), front: page.id === front, yours: theirs.get(who) === page.id })) };
    if (action === 'ended') {
      const closing = [...opened.get(who) ?? []].filter(id => id !== front && tabs.has(id));
      opened.delete(who); theirs.delete(who); closing.forEach(close); return { closed: closing };
    }
    if (!Object.hasOwn(DRIVE, action) && !['front', 'close'].includes(action)) throw new Error(`The browser does not know how to ${action}`);
    if (action === 'open' && (!web(asked.url) || ours(asked.url))) throw new Error('The browser opens web addresses only');
    const fresh = action === 'open' && id == null;
    const page = fresh ? newTab() : tabs.get(Number(id ?? theirs.get(who)));
    if (!page || page.isDestroyed()) throw new Error('That tab is closed; tabs lists the open ones');
    theirs.set(who, page.id);
    if (fresh) opened.set(who, (opened.get(who) ?? new Set()).add(page.id));
    if (action === 'close') { const was = about(page); close(page.id); return was; }
    if (action === 'front') { front = page.id; await live.changed(); return about(page); }
    live.driving(page);
    let said;
    try { said = await DRIVE[action](page, asked); }
    finally { if (!page.isDestroyed()) live.driving(page); }
    if (page.isDestroyed()) throw new Error('The tab was closed');
    await live.changed();
    return { ...said, ...about(page) };
  } finally { done(); }
}
app.on('window-all-closed', () => {});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => app.quit());
let quitting = false;
app.on('before-quit', event => {
  if (!primary || quitting || !app.isReady()) return;
  event.preventDefault(); quitting = true; idle.stop();
  // An idle exit is not the end of the person's browsing session. Chromium
  // otherwise drops session cookies, even though persistent logins survive.
  void (async () => {
    const cookies = await session.defaultSession.cookies.get({});
    writeFileSync(join(profile, 'session-cookies.json'), JSON.stringify(cookies.filter(cookie => cookie.session)), { mode: 0o600 });
    await session.defaultSession.cookies.flushStore();
  })().catch(error => console.error(`browser cookies: ${error.message}`)).finally(() => app.quit());
});
app.on('will-quit', () => { idle.stop(); server?.close(); if (primary) rmSync(path, { force: true }); });
app.whenReady().then(async () => {
  if (!primary) return;
  try {
    const cookies = JSON.parse(readFileSync(join(profile, 'session-cookies.json'), 'utf8'));
    for (const cookie of cookies) {
      const { session: _, hostOnly, ...details } = cookie;
      if (hostOnly) delete details.domain;
      await session.defaultSession.cookies.set({ ...details, url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}` });
    }
  } catch { /* no previous browsing session */ }
  session.defaultSession.setPermissionRequestHandler((_, __, allow) => allow(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', (event, item) => { event.preventDefault(); item.cancel(); });
  live = createLive({ tabs: () => tabs, front: () => front,
    toFront: id => { front = id; },
    launch: async () => {
      if (front == null) { const page = newTab(); await page.loadURL('about:blank'); }
    },
    create: async () => {
      const page = newTab();
      front = page.id;
      await page.loadURL('about:blank');
      return page;
    },
    close,
    // With no screen of its own, its pages take the appearance of whoever
    // watches them, light or dark, as their own screen would show them.
    appearance: scheme => { nativeTheme.themeSource = scheme; },
    draw: page => page.capturePage({ x: 0, y: 0, width: 1, height: 1 }),
    fit: async (page, size) => {
      const viewport = sizes.get(page.id);
      if (!viewport || page.isDestroyed()) throw new Error('That tab is closed');
      Object.assign(viewport, size);
      // Screencasts capture the native surface, not emulated DPR. A scaled
      // surface plus page zoom gives both CSS panel dimensions and crisp JPEGs.
      windows.get(page.id)?.setContentSize(Math.round(size.width * size.scale), Math.round(size.height * size.scale));
      page.setZoomFactor(size.scale);
    },
  });
  server = createServer({ allowHalfOpen: true }, socket => {
    idle.touch();
    socket.on('close', () => idle.touch());
    answer(socket, { drive, live });
  });
  server.on('error', error => { console.error(error.message); app.quit(); });
  server.listen(path, () => chmodSync(path, 0o600));
  idle.touch();
});
