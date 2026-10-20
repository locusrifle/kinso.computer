// What imperfect's own page may ask of its window. Websites inside it get none of this.
const { contextBridge, ipcRenderer } = require('electron');

// imperfect OS's screen lock: { epoch, touched } while it holds, else null (main.mjs, lock.mjs). Heard from the start, so
// no change is missed before the page listens.
let lock = null;
try { lock = ipcRenderer.sendSync('lock?') ?? null; } catch {}
const lockHeard = [];
ipcRenderer.on('lock', (_, state) => { lock = state; for (const fn of lockHeard) fn(state); });

// A Mac's window draws its own buttons over the page's top band, which then
// moves the window (imperfect.css, body.mac-window).
if (process.platform === 'darwin') addEventListener('DOMContentLoaded', () => document.body?.classList.add('mac-window'));

// The page's ground, for the window's own colour under it (ground.mjs): told when the page and each new theme's
// stylesheet load (site.js), and when the system turns light or dark under Automatic.
let ground = '';
const tellGround = () => {
  const colour = getComputedStyle(document.documentElement).getPropertyValue('--theme-bg').trim();
  if (colour && colour !== ground) ipcRenderer.send('ground', ground = colour);
};
addEventListener('load', tellGround);
document.addEventListener('load', event => { if (event.target?.id === 'theme-css') tellGround(); }, true); // an element's load never reaches window
matchMedia('(prefers-color-scheme: light)').addEventListener('change', tellGround);

contextBridge.exposeInMainWorld('imperfectDesk', {
  // The windows' keys, heard in websites and frames (main.mjs), and whether
  // Alt answers for Super here (keys.mjs: not under sway).
  onKey: fn => ipcRenderer.on('key', (_, key) => fn(key)),
  fullWindow: active => ipcRenderer.send('pane-full-window', Boolean(active)),
  altAlias: ipcRenderer.sendSync('alt-alias') !== false,
  // The modifier imperfect's keys are held with: 'meta' (Super), or 'alt'
  // (Option) on a Mac, where Cmd is the Mac's own (keys.mjs).
  mod: ipcRenderer.sendSync('desk-mod') === 'alt' ? 'alt' : 'meta',
  // A Mac's window: its title bar is the page's top band (public/css).
  mac: process.platform === 'darwin',
  // A Mac's file, in the app it opens in or in Finder (mac.mjs macFiles):
  // each answers '' when done, else why not; opener, the app's name.
  ...(process.platform === 'darwin' ? {
    macOpen: path => ipcRenderer.invoke('mac-open', path),
    macReveal: path => ipcRenderer.invoke('mac-reveal', path),
    macOpener: path => ipcRenderer.invoke('mac-opener', path),
  } : {}),
  // The native host can be focused while its website owns the keyboard.
  isFocused: () => ipcRenderer.sendSync('window-focused') === true,
  // The browser's tabs (public/js/pages.js), which agents use too (main.mjs).
  onBrowse: fn => ipcRenderer.on('browse', (_, asked) => fn(asked)),
  onTab: fn => ipcRenderer.on('tab', (_, asked) => fn(asked)),
  front: id => ipcRenderer.send('front', id),
  // imperfect-open again: a new session, or Workbench at a folder (main.mjs).
  onOpen: fn => { ipcRenderer.on('open', (_, asked) => fn(asked)); ipcRenderer.send('opens'); },
  // The computer woke from sleep (main.mjs).
  onResume: fn => ipcRenderer.on('resume', () => fn()),
  // A download done: { url, path (where it went, '' if it failed), state } (downloads.mjs).
  onDownload: fn => ipcRenderer.on('download', (_, done) => fn(done)),
  // The screen lock, now and at each change.
  onLock: fn => { lockHeard.push(fn); fn(lock); },
});
