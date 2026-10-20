// What imperfect's window does differently on a Mac (main.mjs asks).
//
// There is no systemd there to keep the machine (system/start.mjs) running,
// so the window starts a keeper for it (desktop/mac/keeper.mjs), detached, as
// imperfect.app's own child: it outlives the window, and macOS asks the
// person once, in imperfect's name, before anything of theirs (Desktop,
// Documents, Downloads) is read. Where node and the checkout are, the Mac's
// installer wrote down in ~/.imperfect/mac.json (desktop/mac/install.mjs);
// an app opened from the Dock has none of the shell's PATH.
//
// The rest is what a Mac app is expected to have: a menu bar (without one
// Cmd+C and Cmd+V do nothing), Cmd+W hiding the window rather than ending
// anything, the Dock icon bringing it back, a Dock menu, and folders dropped
// on the icon opening in Workbench.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell, webContents } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerFiles } from './mac-files.mjs';

export const MAC = process.platform === 'darwin';
const home = homedir();
const prefix = process.env.IMPERFECT_PREFIX || join(home, '.imperfect');
// The checkout this window runs from (desktop/electron/..).
export const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const executable = path => { try { return statSync(path).isFile(); } catch { return false; } };
const versionOf = name => name.replace(/^v/, '').split('.').map(Number);
const newer = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); return 0; };

// node, the checkout and the PATH the machine runs with.
export function macRuntime({ file = join(prefix, 'mac.json') } = {}) {
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* not installed by the script: look */ }
  let node = [saved.node, process.env.IMPERFECT_NODE].find(path => path && executable(path)) ?? '';
  if (!node) {
    const installs = join(home, '.local/share/mise/installs/node');
    const found = (() => { try { return readdirSync(installs); } catch { return []; } })()
      .filter(name => /^\d+\.\d+\.\d+$/.test(name) && versionOf(name)[0] >= 22 && executable(join(installs, name, 'bin/node')))
      .sort((a, b) => newer(versionOf(b), versionOf(a)));
    node = found.length ? join(installs, found[0], 'bin/node') : ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(executable) ?? '';
  }
  const path = [...new Set([node && dirname(node), join(home, '.local/share/mise/shims'), join(home, '.local/bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin',
    '/usr/local/bin', '/Applications/Tailscale.app/Contents/MacOS', '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...(saved.path ?? [])].filter(Boolean))].join(':');
  return { root: saved.root && existsSync(join(saved.root, 'system/start.mjs')) ? saved.root : ROOT, node, path };
}

// The environment the machine and its agents get: the shell's, as far as a
// Dock-opened app can know it.
export function machineEnv(runtime, port) {
  return {
    ...process.env,
    PATH: runtime.path, HOME: home, IMPERFECT_PREFIX: prefix, IMPERFECT_PORT: String(port),
    LANG: process.env.LANG || 'en_US.UTF-8', LC_CTYPE: process.env.LC_CTYPE || 'UTF-8',
    SHELL: process.env.SHELL || '/bin/zsh', USER: process.env.USER || process.env.LOGNAME || '',
  };
}

// The keeper, started once; it starts the machine and starts it again
// whenever it stops (an update, a restart asked for), until it is stopped.
export function startKeeper(port) {
  const runtime = macRuntime();
  if (!runtime.node) throw new Error('node is not installed here: run desktop/mac/install.mjs from the imperfect checkout once');
  const env = machineEnv(runtime, port);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(runtime.node, [join(runtime.root, 'desktop/mac/keeper.mjs')], { cwd: runtime.root, env, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return runtime;
}

// A small window while the machine starts, rather than a Dock icon bouncing
// for as long as that takes (the first start installs packages).
export function startingWindow() {
  const shown = new BrowserWindow({ width: 320, height: 220, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, backgroundColor: '#000000', center: true, show: false });
  shown.loadFile(join(ROOT, 'desktop/mac/starting.html')).catch(() => {});
  shown.once('ready-to-show', () => { if (!shown.isDestroyed()) shown.show(); });
  return shown;
}

// Said where the person will see it, then the reason the app stops.
export function tellFailure(reason, detail = '') {
  try { new Notification({ title: 'imperfect', body: reason }).show(); } catch { /* none */ }
  dialog.showErrorBox('imperfect could not start', `${reason}${detail ? `\n\n${detail}` : ''}`);
}

export const macClip = {
  read: async () => clipboard.readText(),
  write: text => clipboard.writeText(String(text)),
};

// Workbench on a Mac: its files opened in their apps, or shown in Finder
// (mac-files.mjs).
export const macFiles = fromCanvas => answerFiles(fromCanvas, {
  open: path => shell.openPath(path), reveal: path => shell.showItemInFolder(path), handle: (name, fn) => ipcMain.handle(name, fn),
});

export const defaultBrowser = () => { try { return app.isDefaultProtocolClient('https'); } catch { return false; } };

// The menu bar. send(key) is a window key (keys.mjs names); open(asked) is an
// imperfect-open (a session, or Workbench at a folder); hide() puts the
// window away; tab() is the website tab the keyboard is in, if it is.
export function macMenu({ send, open, hide, websiteFocused, restart, logs }) {
  const item = (label, accelerator, click) => ({ label, accelerator, click });
  return Menu.buildFromTemplate([
    { role: 'appMenu', submenu: [
      { role: 'about' },
      { type: 'separator' },
      item('Restart imperfect', undefined, restart),
      // Opened at login it stays hidden (main.mjs), its machine there for the
      // person's phone and their other computers.
      { label: 'Open at Login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
        click: entry => app.setLoginItemSettings({ openAtLogin: entry.checked }) },
      // Links from every other app open as imperfect's tabs; macOS asks the
      // person first. Undone in System Settings, Desktop & Dock.
      { label: 'Make imperfect the Default Browser…', enabled: !defaultBrowser(),
        click: () => { app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https'); } },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit', label: 'Quit imperfect' },
    ] },
    { label: 'File', submenu: [
      item('New Session', 'CmdOrCtrl+N', () => open({ face: 'code' })),
      item('New Browser Tab', 'CmdOrCtrl+T', () => send('newTab')),
      item('Workbench', 'CmdOrCtrl+Shift+O', () => open({ face: 'files', path: '' })),
      item('Home Folder', 'CmdOrCtrl+Shift+H', () => open({ face: 'files', path: home })),
      item('Downloads', 'CmdOrCtrl+Alt+L', () => open({ face: 'files', path: join(home, 'Downloads') })),
      { type: 'separator' },
      // In a website, its tab; anywhere else, the window, as a Mac's Cmd+W does.
      item('Close', 'CmdOrCtrl+W', () => (websiteFocused() ? send('closeTab') : hide())),
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      item('Browser', 'CmdOrCtrl+Shift+B', () => send('browser')),
      item('Fill the Window', 'CmdOrCtrl+Shift+F', () => send('full')),
      item('Change the Layout', 'CmdOrCtrl+Shift+L', () => send('layout')),
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      item('Previous Session', 'CmdOrCtrl+Alt+Up', () => send('up')),
      item('Next Session', 'CmdOrCtrl+Alt+Down', () => send('down')),
      ...[1, 2, 3, 4, 5].map(n => item(`Session ${n}`, `CmdOrCtrl+${n}`, () => send(`session${n}`))),
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      item('imperfect\'s Log', undefined, () => shell.openPath(logs)),
      item('imperfect.computer', undefined, () => shell.openExternal('https://imperfect.computer')),
    ] },
  ]);
}

// The website tab the keyboard is in, by its contents' id, if it is one.
export const focusedWebsite = tabs => { const focused = webContents.getFocusedWebContents?.(); return Boolean(focused && tabs.has(focused.id)); };
