// A window onto the loopback machine `system/start.mjs` already runs.
// Closing the window must not stop the machine. It is Chromium, like the
// phone and like a visitor's browser, so what plays in one plays in all.
// Any website opens inside it, as a tab in its browser (a <webview> in the
// canvas), signed in with the window's own cookies.
import { app, BrowserWindow, Menu, session, ipcMain, powerMonitor } from 'electron';
import { installNativeClose, nativeCloseKey } from './close.mjs';
import { installEditing } from './edit.mjs';
import { createDownloads } from './downloads.mjs';
import { followGround, ground } from './ground.mjs';
import { angleBackend } from './gpu.mjs';
import { installWebsitePopups, websiteAddress } from './popups.mjs';
import { DRIVE, settle, watchArrivals } from './drive.mjs';
import { altAlias, deskModifier, modifierKey, windowKey as keyOf } from './keys.mjs';
import { MAC, focusedWebsite, macClip, macFiles, macMenu, startingWindow, startKeeper, tellFailure } from './mac.mjs';
import { answer, createLive } from './live.mjs';
import { watchLock } from './lock.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, rmSync, utimesSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Desktop helpers must never block Electron's native event loop (clipboard
// owners and systemd jobs can hang). Every helper has a finite deadline.
const run = (command, args) => promisify(execFile)(command, args, { timeout: 2000, killSignal: 'SIGKILL' });
const port = Number(process.env.IMPERFECT_PORT) || 5067;
// Alt as an unannounced Super for imperfect's keys: not under sway (keys.mjs).
// The page asks as it loads (preload.cjs).
const ALT_ALIAS = altAlias();
ipcMain.on('alt-alias', event => { event.returnValue = ALT_ALIAS; });
// Super, or Option on a Mac, where Cmd is the Mac's own (keys.mjs).
const MOD = deskModifier();
// Before any contents exists, including websites and native popup windows.
installEditing(app, { mod: MOD });
ipcMain.on('desk-mod', event => { event.returnValue = MOD; });
const origin = `http://127.0.0.1:${port}`;

// The desktop knows this window as imperfect-code (its app id), matching
// imperfect-code.desktop.
app.setName('imperfect-code');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
// On AMD, pages draw through Vulkan, unless the command line chose (gpu.mjs).
if (!['use-angle', 'use-gl', 'disable-gpu'].some(name => app.commandLine.hasSwitch(name))) {
  const angle = angleBackend();
  if (angle) app.commandLine.appendSwitch('use-angle', angle);
}
if (MAC) app.setAboutPanelOptions({ applicationName: 'imperfect', applicationVersion: app.getVersion(), website: 'https://imperfect.computer' });

function arg(name, argv = process.argv) {
  const at = argv.indexOf(name);
  return at > 0 ? argv[at + 1] : undefined;
}

// One window for the person: imperfect-open again (the desktop's own key for it) comes to the
// one already open, as a new session in it, or Workbench at the folder asked
// for, rather than a second window. A hidden window opened to check it
// (tools/check-browser-tabs.mjs) stands apart, holding nothing and asking
// nothing of the real one.
const hidden = process.argv.includes('--hidden');
const asked = argv => ({ face: arg('--face', argv) ?? 'code', path: arg('--path', argv) ?? '' });
const primary = hidden || app.requestSingleInstanceLock(asked(process.argv));
if (!primary) app.quit();
// What a later launch asks, held until the page is listening for it.
const opens = [];
let win = null, listening = false;
function deliver() {
  if (!win || win.isDestroyed()) return;
  if (opens.length) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    // Wayland lets no window take focus for itself; Hyprland brings it.
    if (process.env.HYPRLAND_INSTANCE_SIGNATURE) run('hyprctl', ['dispatch', 'focuswindow', `pid:${process.pid}`]).catch(() => {});
  }
  while (listening && opens.length) {
    const one = opens.shift();
    // A link from another app (imperfect the Mac's browser): a tab.
    if (one.face === 'web') win.webContents.send('browse', { url: one.url });
    else win.webContents.send('open', one);
  }
}
app.on('second-instance', (_, argv, __, data) => {
  const face = data?.face ?? asked(argv).face;
  opens.push(face === 'files' ? { face, path: String(data?.path ?? asked(argv).path) } : { face: 'code' });
  deliver();
});
// On a Mac a folder or a file dropped on the Dock icon, or opened with
// imperfect from Finder, opens in Workbench (this Mac's, whichever computer
// Workbench was showing); a link from another app, imperfect being the
// Mac's browser, opens as a tab. Either can come before the window.
app.on('open-file', (event, path) => {
  event.preventDefault();
  opens.push({ face: 'files', path, here: true });
  deliver();
});
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (/^https?:\/\//i.test(url)) { opens.push({ face: 'web', url }); deliver(); }
});

async function healthy() {
  try {
    const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) });
    return (await res.text()).includes('native-gui');
  } catch { return false; }
}

// A machine that will not come is a sentence, not a crash: a desktop
// notification, because stderr from a keybinding is read by nobody.
async function machine() {
  if (await healthy()) return;
  // A Mac has no systemd: imperfect's own keeper starts the machine (mac.mjs).
  let starting = null;
  if (MAC) {
    try { startKeeper(port); }
    catch (error) { tellFailure(error.message); app.exit(1); return; }
    if (!hidden) starting = startingWindow();
  } else await run('systemctl', ['--user', 'start', '--no-block', 'imperfect-code.service']).catch(() => {});
  // The first start on a Mac may install the checkout's packages first.
  const deadline = Date.now() + (MAC ? 180_000 : 40_000);
  try {
    while (Date.now() < deadline) {
      if (await healthy()) return;
      await new Promise(r => setTimeout(r, 200));
    }
  } finally { if (starting && !starting.isDestroyed()) starting.destroy(); }
  const reason = `imperfect: the machine is not running on 127.0.0.1:${port}`;
  if (MAC) { tellFailure(reason, `What it said is in ${join(homedir(), '.imperfect', 'logs', 'imperfect.log')}.`); app.exit(1); return; }
  console.error(`${reason}\nimperfect: try \`systemctl --user status imperfect-code.service\``);
  await run('notify-send', ['-t', '6000', reason]).catch(() => {});
  app.exit(1);
}

function href() {
  const url = new URL(`${origin}/`);
  const face = arg('--face'), path = arg('--path');
  if (face) url.searchParams.set('face', face);
  if (face === 'files' && path) url.searchParams.set('path', path);
  return url.href;
}

const web = url => /^https?:$/.test(new URL(url).protocol);
// imperfect itself. What agents show plays in a tab from an origin of its
// own (system/shown.mjs), which is not this.
const ours = url => new URL(url).origin === origin;

// A download lands in Downloads, never over a file already there; its path
// goes on the clipboard, unless the person copied something else meanwhile,
// and the page is told where it went (downloads.mjs).
const clip = MAC ? macClip : {
  read: async () => { try { return (await run('wl-paste', ['--no-newline'])).stdout; } catch { return null; } },
  write: text => {
    // stdin is streamed asynchronously too; a stalled clipboard cannot trap close.
    const child = execFile('wl-copy', ['--type', 'text/plain'], { timeout: 2000, killSignal: 'SIGKILL' }, () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  },
};

// The browser's tabs, for an agent's `browser` tool
// (apps/code/native/browser.mjs) to use as the person would: it asks here,
// on a socket only they can open, and the page gets real input, from the
// mouse and keyboard as far as it can tell, in front or not. The tool knows
// what to do; this only does it (drive.mjs), and says where the page is now.
// Each window answers on a socket of its own; the one the person turned to
// last is the one the tool asks first (apps/code/native/browser.mjs).
// A first line { do: 'watch' } is the person's phone watching the browser
// live instead (live.mjs): the socket stays open, a line at a time.
function browserSocket(win, drive, live) {
  const path = join(homedir(), '.imperfect', `browser-${port}-${process.pid}.sock`);
  rmSync(path, { force: true });
  const server = createServer({ allowHalfOpen: true }, socket => answer(socket, { drive, live }));
  server.on('error', error => console.error(`imperfect: the browser socket: ${error.message}`));
  server.listen(path, () => chmodSync(path, 0o600));
  win.on('focus', () => { const now = new Date(); try { utimesSync(path, now, now); } catch { /* not yet listening */ } });
  win.on('closed', () => server.close());
}

app.whenReady().then(async () => {
  if (!primary) return;
  await machine();
  // A Mac's menu bar is where its keys live (Cmd+C, Cmd+V, Cmd+Q...): it has
  // one (mac.mjs, set once the window is made); elsewhere there is none.
  if (!MAC) Menu.setApplicationMenu(null);
  const downloads = createDownloads({ dir: app.getPath('downloads'), clip, tell: done => { if (win && !win.isDestroyed()) win.webContents.send('download', done); } });
  session.defaultSession.on('will-download', (_, item) => downloads(item));
  // The dock's mic records a spoken prompt: the microphone, never a camera, for
  // imperfect itself. Websites get what a browser would give them.
  session.defaultSession.setPermissionRequestHandler((contents, permission, allow, details) => {
    if (permission === 'media') return allow(ours(details.requestingUrl) ? !(details.mediaTypes ?? []).includes('video') : false);
    // A picture pasted into the composer: the page reads the clipboard itself.
    if (permission === 'clipboard-read') return allow(ours(details.requestingUrl));
    allow(['fullscreen', 'clipboard-sanitized-write', 'notifications', 'pointerLock'].includes(permission));
  });

  const face = arg('--face');
  win = new BrowserWindow({
    title: face === 'files' ? 'Workbench' : 'imperfect',
    width: 1280, height: 800, show: false,
    // A Mac's window keeps its own three buttons, over the page's top band
    // (public/css/imperfect.css, body.mac-window); elsewhere no frame at all.
    ...(MAC ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 13, y: 9 }, backgroundColor: await ground(), minWidth: 640, minHeight: 420 } : { frame: false }),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      webviewTag: true,
    },
  });
  // On a Mac closing the window puts it away (the Dock icon brings it back)
  // and only quitting ends it; the machine runs on either way.
  let quitting = false;
  if (MAC) {
    app.on('before-quit', () => { quitting = true; });
    win.on('close', event => { if (quitting) return; event.preventDefault(); if (win.isFullScreen()) win.setFullScreen(false); win.hide(); });
    app.on('activate', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
    followGround(win);
  } else installNativeClose(win);
  win.setMenu(null);
  // The computer woke or was unlocked: the page asks its sockets at once, as
  // when it is looked at again (harness.js), rather than showing what it had
  // before it slept. A page whose renderer died, or that could not be had
  // (the machine restarting), is loaded again rather than left blank.
  const resumed = () => { if (!win.isDestroyed()) win.webContents.send('resume'); };
  powerMonitor.on('resume', resumed);
  powerMonitor.on('unlock-screen', resumed);
  let reloadedAt = 0;
  const again = (url = href()) => {
    const wait = Math.max(1000, reloadedAt + 10_000 - Date.now());
    setTimeout(() => { if (!win.isDestroyed()) { reloadedAt = Date.now(); win.loadURL(url).catch(() => {}); } }, wait);
  };
  win.webContents.on('render-process-gone', (_, { reason }) => { if (reason !== 'clean-exit') again(); });
  // -3 is a load given up for another; that one is still coming.
  win.webContents.on('did-fail-load', (_, code, __, url, mainFrame) => { if (mainFrame && code !== -3 && ours(url)) again(url); });
  win.webContents.setVisualZoomLevelLimits(1, 1);
  // A window opened to check it (tools/check-browser-tabs.mjs) stays out of sight.
  // Opened at login (Open at Login, mac.mjs), it waits in the Dock.
  const atLogin = MAC && app.getLoginItemSettings().wasOpenedAtLogin;
  win.once('ready-to-show', () => { if (!hidden && !atLogin) win.show(); });

  // A website asked for from the canvas opens inside it, as a tab.
  const browse = url => win.webContents.send('browse', { url });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (web(url) && !ours(url)) browse(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', event => {
    if (ours(event.url)) return;
    event.preventDefault();
    if (web(event.url)) browse(event.url);
  });
  // The windows' keys (keys.mjs), heard here in websites and frames. Alt
  // answers for Super only where the window manager keeps Super; the page is
  // told the same (preload.cjs).
  const windowKey = input => keyOf(input, { alias: ALT_ALIAS, mod: MOD });
  let paneFullWindow = false;
  ipcMain.on('pane-full-window', (event, active) => {
    if (event.sender === win.webContents) paneFullWindow = active === true;
  });
  win.webContents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) paneFullWindow = false;
  });
  const hearKeys = (contents, { inFrames = false, popup = null } = {}) => contents.on('before-input-event', (event, input) => {
    // Ctrl+Shift+W closes the native host, even with a guest focused or a
    // disconnected canvas. Super+W remains the canvas/tab close command.
    if (nativeCloseKey(input)) {
      event.preventDefault();
      if (!input.isAutoRepeat) (popup ?? win).close();
      return;
    }
    // Host main-frame bindings stay in the harness. Guests and child frames
    // have no bridge, so forward only the browser's unmodified Ctrl chords.
    if (input.type === 'keyDown' && input.control && !input.alt && !input.meta && !input.shift && ['KeyT', 'KeyW'].includes(input.code)) {
      if (contents !== win.webContents || contents.focusedFrame?.parent) {
        event.preventDefault();
        if (!input.isAutoRepeat) {
          if (popup && input.code === 'KeyW') popup.close();
          else win.webContents.send('key', input.code === 'KeyT' ? 'newTab' : 'closeTab');
        }
      }
      return;
    }
    // MOD going down or up inside a website or frame, for picking windows up.
    const modifier = modifierKey(input, { alias: ALT_ALIAS, mod: MOD });
    if (modifier) {
      if (!input.isAutoRepeat && (contents !== win.webContents || contents.focusedFrame?.parent)) win.webContents.send('key', modifier);
      return;
    }
    const escape = paneFullWindow && input.type === 'keyDown' && input.code === 'Escape' && input.key === 'Escape' && !input.alt && !input.meta && !input.control && !input.shift;
    const key = escape ? 'restoreFullWindow' : windowKey(input);
    if (!key || (inFrames && !contents.focusedFrame?.parent)) return;
    event.preventDefault();
    if (!input.isAutoRepeat) {
      if (popup && key === 'close') popup.close();
      else win.webContents.send('key', key);
    }
  });
  hearKeys(win.webContents, { inFrames: true });
  // A website inside the canvas is a website: no bridge into imperfect. Every
  // tab keeps drawing and running while another is in front of it, so an
  // agent can use one the person is not looking at.
  let attaching = '';
  win.webContents.on('will-attach-webview', (_, prefs, params) => {
    attaching = params.src ?? '';
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.backgroundThrottling = false;
  });
  // The browser's tabs (public/js/pages.js), each a page known by its id, and
  // the one the person has in front.
  const tabs = new Map(), popupWindows = new Map();
  let front = null;
  // Auth popups are native child windows, not replacement webviews: Chromium
  // owns their opener, POST body, named-window reuse and script-driven close.
  const tellTab = (id, action) => {
    const popup = popupWindows.get(id);
    if (!popup) return win.webContents.send('tab', { id, do: action });
    if (action === 'close') popup.close();
    else if (['front', 'reveal'].includes(action) && !hidden) { popup.show(); popup.focus(); }
  };
  // The person's phone watching this browser (live.mjs): it follows the tab
  // in front and the tabs as they come, go and change.
  const live = createLive({
    tabs: () => tabs, front: () => front,
    toFront: id => { front = id; tellTab(id, 'front'); },
    launch: async () => {
      const page = tabs.get(front) ?? tabs.values().next().value ?? await (launching ??= opening('about:blank').finally(() => { launching = null; }));
      front = page.id;
      // A portal launch is the person's explicit request to see this pane,
      // unlike an agent selecting a tab behind their conversation.
      tellTab(page.id, 'reveal');
    },
    create: async () => {
      // Unlike launch, a new-tab command never reuses a blank front tab.
      const page = await opening('about:blank');
      front = page.id;
      win.webContents.send('tab', { id: page.id, do: 'front' });
      return page;
    },
    close: id => tellTab(id, 'close'),
    // Headed zoom is shared by origin with the canvas and other tabs. Keep
    // its native density instead of zooming unrelated views for a phone DPR.
    maxScale: 1,
    nativeScale: page => page.getZoomFactor(),
    // Resize the actual guest viewport, not the JPEG. Each tab keeps its
    // own metrics, so a pinned remote viewer never resizes another tab.
    fit: async (page, size) => {
      const popup = popupWindows.get(page.id);
      if (popup) {
        const saved = popup.getContentSize();
        popup.setContentSize(size.width, size.height);
        return async () => { if (!popup.isDestroyed()) popup.setContentSize(...saved); };
      }
      const zoom = page.getZoomFactor() / win.webContents.getZoomFactor();
      // Fit the native guest surface without changing any origin's zoom.
      const saved = await win.webContents.executeJavaScript(`(() => {
        const view = [...document.querySelectorAll('webview')].find(view => { try { return view.getWebContentsId() === ${page.id}; } catch { return false; } });
        if (!view) throw new Error('That browser view is closed');
        const saved = { width: view.style.width, height: view.style.height };
        view.style.width = ${JSON.stringify(`${Math.round(size.width * zoom)}px`)};
        view.style.height = ${JSON.stringify(`${Math.round(size.height * zoom)}px`)};
        return saved;
      })()`);
      return async () => {
        if (page.isDestroyed()) return;
        await win.webContents.executeJavaScript(`(() => {
          const view = [...document.querySelectorAll('webview')].find(view => { try { return view.getWebContentsId() === ${page.id}; } catch { return false; } });
          if (view) { view.style.width = ${JSON.stringify(saved.width)}; view.style.height = ${JSON.stringify(saved.height)}; }
        })()`).catch(() => {});
      };
    },
    // Wake the canvas compositor without showing or focusing its window.
    draw: page => (popupWindows.get(page.id)?.webContents ?? win.webContents).capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true, stayAwake: true }),
  });
  const fromCanvas = event => event.sender === win.webContents;
  // imperfect OS's screen lock: while it holds, the page shows only its sky; as it goes, the rest comes in over it
  // (lock.mjs, public/js/arrival.js). The page asks once as it loads, then hears each change.
  const lock = watchLock(state => { if (!win.isDestroyed()) win.webContents.send('lock', state); });
  ipcMain.on('lock?', event => { event.returnValue = fromCanvas(event) ? lock.now() : null; });
  ipcMain.on('window-focused', event => { event.returnValue = fromCanvas(event) && win.isFocused(); });
  ipcMain.on('front', (event, id) => { if (fromCanvas(event)) { front = id; void live.changed(); } });
  // The page says when it hears launches; a reload stops it hearing until it says so again.
  ipcMain.on('opens', event => { if (fromCanvas(event)) { listening = true; deliver(); } });
  win.webContents.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => { if (isMainFrame && !isSameDocument) listening = false; });
  function registerWebsite(guest, popup = null, opener = null) {
    const id = guest.id;
    guest.setVisualZoomLevelLimits(1, 1);
    hearKeys(guest, { popup });
    // A website beside the conversation scrolls with no scrollbar drawn.
    guest.on('dom-ready', () => guest.insertCSS('* { scrollbar-width: none !important; }', { cssOrigin: 'user' }).catch(() => {}));
    installWebsitePopups(guest, {
      ours, windowOptions: { parent: win, show: !hidden },
      onWindow: child => { child.setMenu(null); registerWebsite(child.webContents, child, id); },
    });
    // A popup is a website too, never a way into the machine's harness.
    for (const leaving of ['will-navigate', 'will-redirect']) guest.on(leaving, event => { if (!websiteAddress(event.url, ours)) event.preventDefault(); });
    tabs.set(id, guest);
    if (popup) { popupWindows.set(id, popup); front = id; }
    watchArrivals(guest);
    guest.once('destroyed', () => {
      tabs.delete(id); popupWindows.delete(id);
      if (front === id) {
        front = tabs.has(opener) ? opener : tabs.keys().next().value ?? null;
        if (front != null) tellTab(front, 'front');
      }
      void live.changed();
    });
    live.observe(guest);
    if (popup) void live.changed();
  }
  win.webContents.on('did-attach-webview', (_, guest) => {
    registerWebsite(guest);
    const asked = waiting.findIndex(one => one.url === attaching);
    if (asked >= 0) waiting.splice(asked, 1)[0].resolve(guest);
  });

  // An agent's `browser` (apps/code/native/browser.mjs). A new tab opens
  // behind, in the one browser every session shares (public/js/pages.js), and
  // is known by its address as it arrives.
  let launching = null;
  const waiting = [];
  function opening(url) {
    return new Promise((resolve, reject) => {
      const one = { url, resolve: tab => { clearTimeout(late); resolve(tab); } };
      const late = setTimeout(() => { waiting.splice(waiting.indexOf(one), 1); reject(new Error('The window did not open the tab')); }, 10_000);
      waiting.push(one);
      win.webContents.send('browse', { url, behind: true });
    });
  }
  // Each conversation uses the tab it last opened or used, unless it names
  // another: never just the one the person happens to be looking at.
  const theirs = new Map();
  // The tabs a conversation opened close when its session ends (closed, or
  // another taking its place: apps/code/native/browser.mjs), so none is left
  // running unseen; the one the person has in front stays, theirs now.
  const opened = new Map();
  function ended(session) {
    const closing = [...(opened.get(session) ?? [])].filter(id => id !== front && tabs.has(id));
    opened.delete(session);
    theirs.delete(session);
    for (const id of closing) tellTab(id, 'close');
    return { closed: closing };
  }
  function tabFor(session, id) {
    const wanted = id ?? theirs.get(session);
    if (wanted == null) throw new Error('You have no tab open: open one, or name one of the person\'s (tabs lists them)');
    const tab = tabs.get(Number(wanted));
    if (!tab || tab.isDestroyed()) throw new Error('That tab is closed; tabs lists the open ones');
    return tab;
  }
  const about = tab => ({ tab: tab.id, url: tab.getURL(), title: tab.getTitle() });
  const drive = async ({ do: action, session = '', tab: id, ...asked }) => {
    session = String(session);
    if (action === 'tabs') return { tabs: [...tabs.values()].map(tab => ({ ...about(tab), front: tab.id === front, yours: theirs.get(session) === tab.id })) };
    if (action === 'ended') return ended(session);
    if (!Object.hasOwn(DRIVE, action) && action !== 'front' && action !== 'close') throw new Error(`The window does not know how to ${action}`);
    const fresh = action === 'open' && id == null;
    const page = fresh ? await opening(asked.url) : tabFor(session, id);
    theirs.set(session, page.id);
    if (fresh) opened.set(session, (opened.get(session) ?? new Set()).add(page.id));
    // Brought to the front, or closed, only when asked: the canvas does it.
    const tell = what => tellTab(page.id, what);
    if (action === 'front' || action === 'close') {
      if (action === 'front') { front = page.id; void live.changed(); }
      const was = about(page); tell(action); return was;
    }
    // While an agent uses a tab, the tab says so.
    const driving = () => { tell('driving'); live.driving(page); };
    driving();
    let done;
    try { done = fresh ? await settle(page) : await DRIVE[action](page, asked); }
    finally { if (!page.isDestroyed()) driving(); }
    if (page.isDestroyed()) throw new Error('The tab was closed');
    return { ...done, ...about(page) };
  };

  // The tool asks only once the page is up, so a tab it opens has a canvas
  // to open in (public/js/pages.js).
  // One that could not be had is loaded again (above); the tool waits for it.
  if (MAC) {
    macFiles(event => fromCanvas(event) && event.senderFrame === win.webContents.mainFrame);
    const send = key => { if (!win.isDestroyed()) win.webContents.send('key', key); };
    const open = one => { opens.push(one); deliver(); };
    const show = () => { if (!win.isDestroyed()) { win.show(); win.focus(); } };
    const restart = () => fetch(`${origin}/health`).then(() => {
      // Through the handoff, as tools/restart.mjs asks: once no agent is working.
      const socket = new WebSocket(`ws://127.0.0.1:${port}/pi`);
      socket.onopen = () => { socket.send(JSON.stringify({ type: 'machine-restart', id: 'restart' })); setTimeout(() => socket.close(), 2000); };
    }).catch(() => {});
    Menu.setApplicationMenu(macMenu({
      send: key => { show(); send(key); }, open: one => { show(); open(one); }, hide: () => { const front = BrowserWindow.getFocusedWindow(); (front && front !== win ? front : win).close(); },
      websiteFocused: () => focusedWebsite(tabs), restart, logs: join(homedir(), '.imperfect', 'logs', 'imperfect.log'),
    }));
    app.dock?.setMenu(Menu.buildFromTemplate([
      { label: 'New Session', click: () => { show(); open({ face: 'code' }); } },
      { label: 'Workbench', click: () => { show(); open({ face: 'files', path: '' }); } },
      { label: 'Browser', click: () => { show(); send('browser'); } },
    ]));
  }
  await win.loadURL(href()).catch(() => new Promise(resolve => win.webContents.once('did-finish-load', resolve)));
  browserSocket(win, drive, live);
});

// Closing the window leaves the machine running. On a Mac the app stays
// too, in the Dock, as Mac apps do.
app.on('window-all-closed', () => { if (!MAC) app.quit(); });
