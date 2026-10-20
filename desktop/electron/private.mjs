// The private browser: the `browser` tool's headless mode
// (apps/code/native/browser.mjs), for an agent to research on its own without
// the person's window. The machine starts it, with Chromium's headless
// platform and no display in its environment, so nothing of it can appear on
// any screen; it speaks one JSON request and answer a line on stdin and
// stdout, and leaves when the machine does (its stdin closes).
//
// Nothing of the person's is in it: a profile of its own in a fresh folder,
// removed once it has gone, and each session's tabs in a session (cookies,
// storage, cache) of their own, held in memory and gone when that session
// ends. No popups, downloads, permissions, dialogs, sign-in prompts or sound.
import { app, BrowserWindow, session as sessions } from 'electron';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DRIVE, watchArrivals, privateBackendAddress } from './drive.mjs';

// The machine names the folder for itself (apps/code/native/browser.mjs)
// and removes it once this has gone; one a machine killed outright left
// behind is cleared by the next.
for (const name of readdirSync(tmpdir())) {
  const pid = Number(/^imperfect-private-(\d+)-/.exec(name)?.[1]);
  if (pid && !alive(pid)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
// On a Mac nothing of it shows in the Dock or the menu bar either.
if (process.platform === 'darwin') app.dock?.hide();
const profile = process.env.IMPERFECT_PRIVATE_PROFILE || mkdtempSync(join(tmpdir(), `imperfect-private-${process.pid}-`));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => app.quit());

const port = Number(process.env.IMPERFECT_PORT) || 5067;
const MOST_TABS = 8; // a session's
const web = url => { try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; } };
// Never imperfect itself, which a page here could otherwise drive.
const ours = url => privateBackendAddress(url, port);

const tabs = new Map(); // id -> { page, session }
const theirs = new Map(); // session -> the id of the tab it last used
const partitions = new Map(); // session -> its in-memory partition
let made = 0;

function sessionOf(session) {
  if (!partitions.has(session)) {
    const partition = `private-${++made}`; // no persist: prefix, so in memory only
    const it = sessions.fromPartition(partition);
    it.setPermissionRequestHandler((_, __, allow) => allow(false));
    it.setPermissionCheckHandler(() => false);
    // Covers frames and subresources too, not only top-level navigation.
    it.webRequest.onBeforeRequest((details, answer) => answer({ cancel: ours(details.url) }));
    it.on('will-download', (event, item) => { event.preventDefault(); item.cancel(); });
    partitions.set(session, partition);
  }
  return partitions.get(session);
}

function newTab(session) {
  if ([...tabs.values()].filter(tab => tab.session === session).length >= MOST_TABS) throw new Error(`A session can have ${MOST_TABS} private tabs; close one first`);
  const win = new BrowserWindow({
    show: false, focusable: false, width: 1280, height: 800, paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: true, partition: sessionOf(session), sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, disableDialogs: true, spellcheck: false, webviewTag: false,
    },
  });
  win.setContentSize(1280, 800);
  const page = win.webContents;
  page.setAudioMuted(true);
  page.setVisualZoomLevelLimits(1, 1);
  // A new tab from a website opens as the next page of the same one.
  page.setWindowOpenHandler(({ url }) => { if (web(url) && !ours(url)) page.loadURL(url).catch(() => {}); return { action: 'deny' }; });
  for (const leaving of ['will-navigate', 'will-redirect']) page.on(leaving, event => { if (!web(event.url) || ours(event.url)) event.preventDefault(); });
  page.on('will-prevent-unload', event => event.preventDefault());
  page.on('login', (event, _, __, callback) => { event.preventDefault(); callback(); });
  page.on('select-client-certificate', (event, _, __, callback) => { event.preventDefault(); callback(); });
  page.on('dom-ready', () => page.insertCSS('* { scrollbar-width: none !important; }', { cssOrigin: 'user' }).catch(() => {}));
  watchArrivals(page);
  tabs.set(page.id, { page, session, win });
  page.once('destroyed', () => tabs.delete(page.id));
  return page;
}

function close(id) {
  const tab = tabs.get(id);
  tabs.delete(id);
  if (tab && !tab.win.isDestroyed()) tab.win.destroy();
}

async function ended(session) {
  const closing = [...tabs].filter(([, tab]) => tab.session === session).map(([id]) => id);
  closing.forEach(close);
  theirs.delete(session);
  const partition = partitions.get(session);
  partitions.delete(session);
  if (partition) {
    const it = sessions.fromPartition(partition);
    await Promise.all([it.clearStorageData(), it.clearCache(), it.clearAuthCache(), it.closeAllConnections()].map(done => done.catch(() => {})));
  }
  return { closed: closing, left: tabs.size };
}

function tabFor(session, id) {
  const wanted = id ?? theirs.get(session);
  if (wanted == null) throw new Error('You have no private tab open: open one with headless: true');
  const tab = tabs.get(Number(wanted));
  if (!tab || tab.page.isDestroyed()) throw new Error('That private tab is closed; tabs lists the open ones');
  if (tab.session !== session) throw new Error('That private tab is another session\'s');
  return tab.page;
}

const about = page => ({ tab: page.id, url: page.getURL(), title: page.getTitle() });
async function drive({ do: action, session = '', tab: id, ...asked }) {
  session = String(session);
  if (action === 'ended') return ended(session);
  if (action === 'tabs') return { tabs: [...tabs.values()].filter(tab => tab.session === session).map(tab => ({ ...about(tab.page), yours: theirs.get(session) === tab.page.id })) };
  if (action === 'front') throw new Error('A private tab has no window to bring to the front: no one can see it. look with screenshot: true to see it, or open it without headless for the person.');
  if (!Object.hasOwn(DRIVE, action) && action !== 'close') throw new Error(`The private browser does not know how to ${action}`);
  if (action === 'open' && (!web(asked.url) || ours(asked.url))) throw new Error('The private browser opens web addresses only');
  const page = action === 'open' && id == null ? newTab(session) : tabFor(session, id);
  theirs.set(session, page.id);
  if (action === 'close') { const was = about(page); close(page.id); return { ...was, left: tabs.size }; }
  // DOM/refs can be ready before the hidden offscreen compositor's hit-test
  // regions are. capturePage waits for this page to composite; a fixed sleep
  // or a queued paint from an earlier frame can still drop the mouse events.
  if (action === 'click') {
    let late;
    try {
      const image = await Promise.race([page.capturePage(), new Promise((_, reject) => {
        late = setTimeout(() => reject(new Error('The private page did not draw in time')), 15_000);
      })]);
      if (image.isEmpty()) throw new Error('The private page did not draw');
    } finally { clearTimeout(late); }
  }
  const done = await DRIVE[action](page, asked);
  if (page.isDestroyed()) throw new Error('The tab was closed');
  return { ...done, ...about(page) };
}

app.on('window-all-closed', () => {}); // tabs come and go; the machine says when to leave
app.whenReady().then(() => {
  const say = answer => process.stdout.write(`${JSON.stringify(answer)}\n`);
  createInterface({ input: process.stdin }).on('line', async line => {
    let asked;
    try { asked = JSON.parse(line); } catch { return; }
    const { id, ...request } = asked;
    try { say({ id, ...await drive(request) }); } catch (error) { say({ id, error: error.message }); }
  }).on('close', () => app.quit());
  say({ ready: true });
});
