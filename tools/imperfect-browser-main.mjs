// imperfect's own browser for tests and checks: the Electron its window is
// built on, with nothing on screen. Playwright drives it over DevTools
// through imperfect-browser.mjs. Electron's DevTools cannot make a page or a
// private profile itself, so this side does: each Playwright context is an
// in-memory session, each page a window never shown. It also keeps those
// sessions' cookies and downloads, which Electron's DevTools cannot reach.
//
// The launcher talks to it over a WebSocket whose address it prints first.
import { app, BrowserWindow, Menu, session, webContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

// Shown only when a test asks to be watched (headless: false). No dock icon
// otherwise, and no menu: a test pressing Cmd+W or Cmd+Q must reach the
// page, not close the window or end the browser.
const shown = process.env.IMPERFECT_BROWSER_SHOWN === '1';
if (!shown) app.dock?.hide();
app.on('window-all-closed', () => {});

// A window never shown gets one frame a second once it has painted, so
// animations, idle callbacks and observers would lag as no browser's do.
// Unwatched, pages render offscreen instead: every frame, nothing on screen.
// Ozone's virtual Linux display can host normal windows without showing
// anything on a person's desktop. Keep its native input/compositor path:
// Electron's OSR view does not deliver native touch scrolling faithfully.
const virtualDisplay = process.platform === 'linux' && app.commandLine.getSwitchValue('ozone-platform') === 'headless';
const hidden = { show: shown || virtualDisplay, paintWhenInitiallyHidden: true };
const webPreferences = { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, offscreen: !shown && !virtualDisplay };
// Pages a page opens stay hidden too.
app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { ...hidden, webPreferences } }));
});

const windows = new Map(); // targetId -> BrowserWindow
const behaviours = new Map(); // session -> { behavior, downloadPath, eventsEnabled }
const downloads = new Map(); // guid -> DownloadItem
let send = () => {};

// What a page is to DevTools: its target, and the profile it is in.
async function targetInfo(contents) {
  const own = !contents.debugger.isAttached();
  if (own) contents.debugger.attach('1.3');
  try { return (await contents.debugger.sendCommand('Target.getTargetInfo')).targetInfo; }
  finally { if (own) contents.debugger.detach(); }
}

// The page a target is: one made here, or one a page opened.
async function contentsOf(targetId) {
  if (windows.has(targetId)) return windows.get(targetId).webContents;
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const info = await targetInfo(contents).catch(() => null);
    if (info?.targetId === targetId) return contents;
  }
  return null;
}

function profile(partition) {
  const chosen = partition ? session.fromPartition(partition) : session.defaultSession;
  if (!behaviours.has(chosen)) {
    behaviours.set(chosen, null);
    chosen.on('will-download', (event, item, contents) => {
      const want = behaviours.get(chosen);
      if (!want || want.behavior === 'deny') { item.cancel(); return; }
      const guid = randomUUID();
      downloads.set(guid, item);
      item.setSavePath(join(want.downloadPath, want.behavior === 'allowAndName' ? guid : item.getFilename()));
      if (!want.eventsEnabled) return;
      const progress = state => send({ method: 'Browser.downloadProgress', params: { guid, totalBytes: item.getTotalBytes(), receivedBytes: item.getReceivedBytes(), state } });
      targetInfo(contents).then(info => {
        send({ method: 'Browser.downloadWillBegin', params: { frameId: info.targetId, guid, url: item.getURL(), suggestedFilename: item.getFilename() } });
        item.on('updated', () => progress('inProgress'));
        item.once('done', (_, state) => { downloads.delete(guid); progress(state === 'completed' ? 'completed' : 'canceled'); });
        if (item.getState() !== 'progressing') progress(item.getState() === 'completed' ? 'completed' : 'canceled');
      }, () => {});
    });
  }
  return chosen;
}

// DevTools' cookies and Electron's, one to the other.
const toSameSite = { Strict: 'strict', Lax: 'lax', None: 'no_restriction' };
const fromSameSite = { strict: 'Strict', lax: 'Lax', no_restriction: 'None' };
function devtoolsCookie(cookie) {
  const out = {
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
    expires: cookie.session || cookie.expirationDate === undefined ? -1 : cookie.expirationDate,
    size: cookie.name.length + cookie.value.length, httpOnly: cookie.httpOnly, secure: cookie.secure, session: Boolean(cookie.session),
    priority: 'Medium', sameParty: false, sourceScheme: cookie.secure ? 'Secure' : 'NonSecure', sourcePort: -1,
  };
  if (fromSameSite[cookie.sameSite]) out.sameSite = fromSameSite[cookie.sameSite];
  return out;
}
function electronCookie(cookie) {
  // A domain with a leading dot reaches its subdomains; without one, only that host.
  const host = String(cookie.domain ?? '').replace(/^\./, '');
  const out = { url: cookie.url || `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`, name: cookie.name, value: cookie.value };
  if (!cookie.url && String(cookie.domain ?? '').startsWith('.')) out.domain = cookie.domain;
  if (cookie.path) out.path = cookie.path;
  if (cookie.secure !== undefined) out.secure = cookie.secure;
  if (cookie.httpOnly !== undefined) out.httpOnly = cookie.httpOnly;
  if (cookie.expires !== undefined && cookie.expires >= 0) out.expirationDate = cookie.expires;
  if (toSameSite[cookie.sameSite]) out.sameSite = toSameSite[cookie.sameSite];
  return out;
}

const commands = {
  async createTarget({ partition, url = 'about:blank', width = 1280, height = 720 }) {
    const window = new BrowserWindow({ ...hidden, width, height, useContentSize: true, webPreferences: { ...webPreferences, session: profile(partition) } });
    const info = await targetInfo(window.webContents);
    windows.set(info.targetId, window);
    window.once('closed', () => windows.delete(info.targetId));
    if (webPreferences.offscreen) window.webContents.setFrameRate(60);
    window.webContents.loadURL(url).catch(() => {});
    return { targetId: info.targetId, browserContextId: info.browserContextId };
  },
  // Electron prints with its own printToPDF; DevTools' Page.printToPDF it lacks.
  async printToPDF({ targetId, options }) {
    const contents = await contentsOf(targetId);
    if (!contents) throw new Error(`No page ${targetId} to print`);
    const inches = (value, fallback) => (typeof value === 'number' ? value : fallback);
    const pdf = await contents.printToPDF({
      landscape: Boolean(options.landscape), displayHeaderFooter: Boolean(options.displayHeaderFooter),
      printBackground: Boolean(options.printBackground), scale: inches(options.scale, 1),
      pageSize: { width: inches(options.paperWidth, 8.5), height: inches(options.paperHeight, 11) },
      margins: { top: inches(options.marginTop, 0.4), bottom: inches(options.marginBottom, 0.4), left: inches(options.marginLeft, 0.4), right: inches(options.marginRight, 0.4) },
      pageRanges: options.pageRanges || '', headerTemplate: options.headerTemplate || '', footerTemplate: options.footerTemplate || '',
      preferCSSPageSize: Boolean(options.preferCSSPageSize), generateTaggedPDF: options.generateTaggedPDF ?? true,
      generateDocumentOutline: Boolean(options.generateDocumentOutline),
    });
    return { data: pdf.toString('base64') };
  },
  async closeTarget({ targetId }) {
    const window = windows.get(targetId);
    if (!window) return { found: false };
    window.destroy();
    return { found: true };
  },
  async disposeProfile({ partition }) {
    const chosen = profile(partition);
    for (const window of BrowserWindow.getAllWindows()) if (window.webContents.session === chosen) window.destroy();
    await chosen.clearStorageData().catch(() => {});
    return {};
  },
  async setDownloadBehavior({ partition, behavior, downloadPath, eventsEnabled }) {
    behaviours.set(profile(partition), { behavior, downloadPath, eventsEnabled });
    return {};
  },
  async cancelDownload({ guid }) { downloads.get(guid)?.cancel(); return {}; },
  async getCookies({ partition }) { return { cookies: (await profile(partition).cookies.get({})).map(devtoolsCookie) }; },
  async setCookies({ partition, cookies }) {
    for (const cookie of cookies) await profile(partition).cookies.set(electronCookie(cookie));
    return {};
  },
  async clearCookies({ partition }) { await profile(partition).clearStorageData({ storages: ['cookies'] }); return {}; },
};

// Not a top-level await: Electron is not ready until this module has loaded.
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const token = randomUUID();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: `/${token}` });
  server.on('connection', socket => {
    send = message => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message)); };
    socket.on('message', async raw => {
      const { id, method, params } = JSON.parse(String(raw));
      try { send({ id, result: await commands[method](params ?? {}) }); }
      catch (error) { send({ id, error: error?.message ?? String(error) }); }
    });
    socket.on('close', () => app.quit());
  });
  server.on('listening', () => process.stdout.write(`imperfect-browser ws://127.0.0.1:${server.address().port}/${token}\n`));
});
