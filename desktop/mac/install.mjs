// imperfect on a Mac, installed from this checkout, or brought up to it.
// ./install.sh runs this on a Mac; it can be run itself too:
//
//   node desktop/mac/install.mjs          install, or refresh what is out of date
//   node desktop/mac/install.mjs undo     take imperfect.app and its place in the Dock away
//                                         (keeps ~/.imperfect and this checkout)
//
// Nothing here needs sudo. In order, each step only when it is out of date:
//
//   1. the checkout's packages (npm ci) and its Electron, for this Mac
//   2. ~/.imperfect: machine.json, and mac.json, which tells imperfect.app
//      where this checkout and node are (an app opened from the Dock has no
//      shell PATH to find them by)
//   3. imperfect.app in /Applications (else ~/Applications): the checkout's
//      Electron, named imperfect, with a plain silver icon (no mark). Its own code is
//      one line: it opens the window that lives in this checkout
//      (desktop/electron/main.mjs), so a new version of the window comes with
//      the checkout, and only a new Electron needs a new app. Signed for this
//      Mac alone (ad hoc), as nothing is downloaded with it.
//   4. a place in the Dock, then imperfect.app opened: it starts imperfect's
//      machine (desktop/mac/keeper.mjs), which stays running.
//   5. with Tailscale signed in, what agents show is published to the
//      person's own devices at :8443, as on Linux.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMacPackages } from './packages.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const home = homedir();
const prefix = process.env.IMPERFECT_PREFIX || join(home, '.imperfect');
const port = Number(process.env.IMPERFECT_PORT) || 5067;
export const BUNDLE_ID = 'computer.imperfect.code';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const say = text => console.log(`\x1b[1m${text}\x1b[0m`);
const note = text => console.error(`imperfect: ${text}`);
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const tryRun = (command, args, options) => { try { return run(command, args, options); } catch { return null; } };
const writable = dir => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } };
const sha = (...parts) => { const hash = createHash('sha256'); for (const part of parts) hash.update(part); return hash.digest('hex'); };
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
// imperfect.app asked to quit, only while it is running, so that asking
// never opens it. Its machine runs on.
const quitApp = () => {
  if (tryRun('/usr/bin/pgrep', ['-f', 'imperfect\\.app/Contents/MacOS/imperfect']) === null) return;
  tryRun('/usr/bin/osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`], { timeout: 15_000 });
};

// Where imperfect.app goes: /Applications when this user may write there
// (an administrator's Mac), else their own ~/Applications.
export const appPath = () => (writable('/Applications') ? '/Applications/imperfect.app' : join(home, 'Applications/imperfect.app'));

// The app's own code: the window from the checkout mac.json names.
export const STUB = `// imperfect.app's own code is only this (desktop/mac/install.mjs made it):
// the window lives in the checkout ~/.imperfect/mac.json names, so it is
// updated with the checkout, and only a new Electron needs a new app.
import { app, dialog } from 'electron';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = process.env.IMPERFECT_PREFIX || join(homedir(), '.imperfect');
let root = join(homedir(), 'imperfect');
try { root = JSON.parse(readFileSync(join(prefix, 'mac.json'), 'utf8')).root || root; } catch { /* the usual place */ }
try {
  await import(pathToFileURL(join(root, 'desktop/electron/main.mjs')).href);
} catch (error) {
  await app.whenReady();
  dialog.showErrorBox('imperfect could not open', \`Its window is in \${root}, and it could not be loaded:\\n\\n\${error.message}\\n\\nRun ./install.sh in the imperfect checkout again.\`);
  app.exit(1);
}
`;

// What macOS is told about the app (Info.plist), besides Electron's own.
// Its icon is named by what is in it: macOS keeps an app's icon by name, and
// would go on showing the old one in the Dock and Finder after a new one came.
export const iconName = picture => `imperfect-${sha(picture).slice(0, 10)}.icns`;
export function plist(version, icon = 'imperfect.icns') {
  const why = 'imperfect\'s Workbench and your agents work with the files you keep here.';
  return {
    CFBundleExecutable: 'imperfect', CFBundleName: 'imperfect', CFBundleDisplayName: 'imperfect',
    CFBundleIdentifier: BUNDLE_ID, CFBundleShortVersionString: version, CFBundleVersion: version,
    CFBundleIconFile: icon, LSApplicationCategoryType: 'public.app-category.developer-tools',
    NSHumanReadableCopyright: 'Copyright © 2026 Locus. MIT licence.',
    NSMicrophoneUsageDescription: 'imperfect hears a prompt you speak into the mic in its input bar.',
    NSCameraUsageDescription: 'A website in imperfect\'s browser asked for the camera.',
    NSDesktopFolderUsageDescription: why, NSDocumentsFolderUsageDescription: why, NSDownloadsFolderUsageDescription: why,
    NSRemovableVolumesUsageDescription: why, NSNetworkVolumesUsageDescription: why,
    // Folders and files open in Workbench: dropped on the Dock icon, or
    // Open With in Finder; never what opens them unless the person says so.
    CFBundleDocumentTypes: [
      { CFBundleTypeName: 'Folder', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.folder'] },
      { CFBundleTypeName: 'Web page', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.html', 'public.xhtml'] },
      { CFBundleTypeName: 'Document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.data', 'public.content'] },
    ],
    // Links: imperfect can be the Mac's browser (its menu, or System Settings).
    CFBundleURLTypes: [{ CFBundleURLName: 'Web site URL', CFBundleURLSchemes: ['http', 'https'] }],
  };
}

function setPlist(file, values) {
  for (const [key, value] of Object.entries(values)) {
    const kind = typeof value === 'string' ? ['-string', value] : ['-json', JSON.stringify(value)];
    run('/usr/bin/plutil', ['-replace', key, ...kind, file]);
  }
}

// 1. Packages, when the lockfile changed since they were installed.
function packages() {
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` };
  installMacPackages(root, { beforeInstall: () => {
    // Installation must not replace packages beneath the keeper's machine.
    // Startup does the rebuild after an idle handoff instead. A stale reused
    // pid can conservatively decline installation, never interrupt anything.
    let held = {};
    try { held = JSON.parse(readFileSync(join(prefix, 'keeper.json'), 'utf8')); } catch { /* not kept */ }
    let active = false;
    if (Number.isInteger(held.pid) && held.pid > 0) {
      try { process.kill(held.pid, 0); active = true; } catch (error) { active = error.code === 'EPERM'; }
    }
    let listenPort = port;
    try { const saved = JSON.parse(readFileSync(join(prefix, 'machine.json'), 'utf8')).port; if (Number.isInteger(saved) && saved > 0 && saved <= 65535) listenPort = saved; } catch { /* default */ }
    active ||= tryRun('/usr/bin/curl', ['--fail', '--silent', '--max-time', '2', `http://127.0.0.1:${listenPort}/health`]) !== null;
    if (active) throw new Error('dependencies changed while imperfect is running; restart it when idle, then run this installer again');
  } });
  // Electron 44 fetches its runtime with an installer of its own, not npm's.
  if (!existsSync(join(root, 'node_modules/electron/dist/Electron.app'))) {
    say('fetching Electron for this Mac');
    const done = spawnSync(process.execPath, [join(root, 'node_modules/electron/install.js')], { cwd: root, env, stdio: 'inherit' });
    if (done.status !== 0) throw new Error('Electron could not be fetched');
  }
}

// 2. ~/.imperfect.
function settings() {
  mkdirSync(join(prefix, 'logs'), { recursive: true, mode: 0o700 });
  if (!existsSync(join(prefix, 'machine.json'))) {
    json(join(prefix, 'machine.json'), { port, origins: [], authentication: true });
    say(`wrote ${join(prefix, 'machine.json')}`);
  }
  const mac = { root, node: process.execPath, path: [] };
  const file = join(prefix, 'mac.json');
  if (!existsSync(file) || readFileSync(file, 'utf8') !== `${JSON.stringify(mac, null, 2)}\n`) json(file, mac);
  if (!existsSync(join(home, 'AGENTS.md')) && !existsSync(join(home, 'CLAUDE.md'))) {
    writeFileSync(join(home, 'AGENTS.md'), '# For the agents on this computer\n\nEach new creation gets its own folder in ~/workbench. When I want to keep something, make it a git repo under ~/projects and commit it.\n');
    say(`wrote ${join(home, 'AGENTS.md')}, the instructions your agents read (yours to change)`);
  }
}

// 3. imperfect.app, made again when its Electron, code, icon or plist changed.
function bundle() {
  const electron = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version;
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const icon = readFileSync(join(root, 'desktop/mac/icon-1024.png'));
  const told = plist(version, iconName(icon));
  const made = sha(electron, STUB, JSON.stringify(told), icon);
  const target = appPath();
  const meta = join(target, 'Contents/Resources/app/package.json');
  if (existsSync(meta) && JSON.parse(readFileSync(meta, 'utf8')).imperfectBuild === made) return { target, fresh: false };
  say(`making ${target} (Electron ${electron})`);
  const stage = mkdtempSync(join(tmpdir(), 'imperfect-app-'));
  try {
    const app = join(stage, 'imperfect.app');
    run('/usr/bin/ditto', [join(root, 'node_modules/electron/dist/Electron.app'), app]);
    run('/bin/mv', [join(app, 'Contents/MacOS/Electron'), join(app, 'Contents/MacOS/imperfect')]);
    const resources = join(app, 'Contents/Resources');
    rmSync(join(resources, 'default_app.asar'), { force: true });
    rmSync(join(resources, 'electron.icns'), { force: true });
    mkdirSync(join(resources, 'app'));
    writeFileSync(join(resources, 'app/main.mjs'), STUB);
    json(join(resources, 'app/package.json'), { name: 'imperfect', productName: 'imperfect', version, type: 'module', main: 'main.mjs', electron, imperfectBuild: made });
    // The icon at every size macOS asks for, from the one picture.
    const set = join(stage, 'imperfect.iconset');
    mkdirSync(set);
    for (const side of [16, 32, 128, 256, 512]) {
      run('/usr/bin/sips', ['-z', String(side), String(side), join(root, 'desktop/mac/icon-1024.png'), '--out', join(set, `icon_${side}x${side}.png`)]);
      run('/usr/bin/sips', ['-z', String(side * 2), String(side * 2), join(root, 'desktop/mac/icon-1024.png'), '--out', join(set, `icon_${side}x${side}@2x.png`)]);
    }
    run('/usr/bin/iconutil', ['-c', 'icns', set, '-o', join(resources, told.CFBundleIconFile)]);
    setPlist(join(app, 'Contents/Info.plist'), told);
    tryRun('/usr/bin/xattr', ['-cr', app]);
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
    // The app being replaced is asked to quit first; its machine runs on.
    if (existsSync(target)) {
      quitApp();
      rmSync(target, { recursive: true, force: true });
    }
    mkdirSync(dirname(target), { recursive: true });
    run('/usr/bin/ditto', [app, target]);
    tryRun(LSREGISTER, ['-f', target]);
    // The Dock draws what it kept until it starts again.
    try { rmSync(join(execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim(), 'com.apple.dock.iconcache'), { force: true }); } catch { /* the Dock keeps none */ }
    tryRun('/usr/bin/killall', ['Dock']);
  } finally { rmSync(stage, { recursive: true, force: true }); }
  return { target, fresh: true };
}

// 4. The Dock, once.
const DOCK_TILE = target => `<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://${encodeURI(target)}/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>`;
function dock(target) {
  const apps = tryRun('/usr/bin/defaults', ['read', 'com.apple.dock', 'persistent-apps']) ?? '';
  if (apps.includes('imperfect.app')) return;
  run('/usr/bin/defaults', ['write', 'com.apple.dock', 'persistent-apps', '-array-add', DOCK_TILE(target)]);
  tryRun('/usr/bin/killall', ['Dock']);
  say('imperfect is in the Dock (drag it out to remove it)');
}
// Undone: its tile goes too, rather than staying as a question mark.
function leaveDock() {
  const dir = mkdtempSync(join(tmpdir(), 'imperfect-dock-'));
  try {
    const file = join(dir, 'dock.plist');
    if (tryRun('/usr/bin/defaults', ['export', 'com.apple.dock', file]) === null) return false;
    const ours = [];
    for (let at = 0; tryRun('/usr/bin/plutil', ['-extract', `persistent-apps.${at}`, 'xml1', '-o', '-', file]) !== null; at++) {
      const url = tryRun('/usr/bin/plutil', ['-extract', `persistent-apps.${at}.tile-data.file-data._CFURLString`, 'raw', '-o', '-', file]) ?? '';
      if (/\/imperfect\.app\/?$/.test(url.trim())) ours.push(at);
    }
    if (!ours.length) return false;
    for (const at of ours.reverse()) run('/usr/bin/plutil', ['-remove', `persistent-apps.${at}`, file]);
    run('/usr/bin/defaults', ['import', 'com.apple.dock', file]);
    tryRun('/usr/bin/killall', ['Dock']);
    return true;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// 5. What agents show, on the person's own devices.
const tailscaleCommand = () => ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale'].find(one => one.startsWith('/') ? existsSync(one) : tryRun('/usr/bin/which', [one]));
function tailscale() {
  const command = tailscaleCommand();
  if (!command) { note('Tailscale is not installed: imperfect works on this Mac, but your other computers and phone cannot reach it'); return; }
  const status = tryRun(command, ['status', '--json'], { timeout: 8000 });
  if (!status) { note('Tailscale is installed but not signed in'); return; }
  const serving = tryRun(command, ['serve', 'status', '--json'], { timeout: 8000 }) ?? '';
  if (serving.includes(`http://127.0.0.1:${port + 1}`)) return;
  if (tryRun(command, ['serve', '--bg', '--https=8443', `http://127.0.0.1:${port + 1}`], { timeout: 15_000 }) !== null) say('what agents show is published to your own devices, at :8443 (undo: tailscale serve --https=8443 off)');
  else note('what agents show plays on this Mac only; `tailscale serve --bg --https=8443 http://127.0.0.1:5068` publishes it to your devices');
}

function undo() {
  const target = appPath();
  quitApp();
  spawnSync(process.execPath, [join(root, 'desktop/mac/keeper.mjs'), 'stop'], { stdio: 'inherit' });
  rmSync(target, { recursive: true, force: true });
  if (leaveDock()) say('imperfect is out of the Dock');
  else if (tryRun('/usr/bin/defaults', ['read', 'com.apple.dock', 'persistent-apps'])?.includes('imperfect.app')) note('imperfect.app is gone; its icon leaves the Dock when you drag it out');
  // What agents show stops being published, as on Linux.
  const command = tailscaleCommand();
  if (command && (tryRun(command, ['serve', 'status', '--json'], { timeout: 8000 }) ?? '').includes(`http://127.0.0.1:${port + 1}`)
    && tryRun(command, ['serve', '--https=8443', 'off'], { timeout: 15_000 }) === null) note('run `tailscale serve --https=8443 off` to stop publishing what agents show');
  rmSync(join(prefix, 'mac.json'), { force: true });
  say(`undone. your files in ${prefix} and this checkout are untouched`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.platform !== 'darwin') { note('this is the Mac installer; on Linux run ./install.sh'); process.exit(1); }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) { note(`need Node 22.19 or newer (this is ${process.versions.node})`); process.exit(1); }
  try {
    if (process.argv[2] === 'undo') undo();
    else {
      packages();
      settings();
      const { target } = bundle();
      dock(target);
      tailscale();
      run('/usr/bin/open', [target]);
      say(`imperfect is open (${tryRun('/usr/bin/git', ['-C', root, 'log', '-1', '--format=%h, %cs'])?.trim() || 'unversioned'}); it is in the Dock from now on`);
      console.log(`\n  its log:      ${join(prefix, 'logs/imperfect.log')}\n  your files:   ${prefix}\n  undo:         node desktop/mac/install.mjs undo\n`);
    }
  } catch (error) { note(error.message); process.exit(1); }
}
