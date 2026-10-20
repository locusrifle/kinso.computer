import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

// Workbench on a Mac: a file of this computer's opened in the app the Mac
// opens it with, as a double-click in Finder would, or shown in Finder
// (workbench-mac.js asks, through preload.cjs). Only imperfect's own page may
// ask, and only for a path that is there.
const OPENER = `function run([path]) {
  ObjC.import('AppKit');
  const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.fileURLWithPath(path));
  return app.isNil() ? '' : ObjC.unwrap(app.path);
}`;
// The name of the app a file opens in ('Preview'), or '' when none does.
export function defaultApp(path, run = execFile) {
  return new Promise(resolve => run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', OPENER, path], { timeout: 5000 }, (error, out) => {
    const found = error ? '' : String(out).trim();
    resolve(found ? basename(found).replace(/\.app$/i, '') : '');
  }));
}
export function answerFiles(fromCanvas, { open, reveal, handle, opener = defaultApp }) {
  const asked = (event, path) => fromCanvas(event) && typeof path === 'string' && isAbsolute(path) && existsSync(path) ? path : null;
  const named = new Map();
  handle('mac-open', async (event, path) => { const file = asked(event, path); return file ? open(file) : "It isn't on this Mac"; });
  handle('mac-reveal', async (event, path) => { const file = asked(event, path); if (!file) return "It isn't on this Mac"; reveal(file); return ''; });
  // Asked again for every file, so kept by kind (a folder, an extension).
  handle('mac-opener', async (event, path) => {
    const file = asked(event, path);
    if (!file) return '';
    const kind = statSync(file).isDirectory() ? (/\.(app|bundle)$/i.test(file) ? file : '/') : (/\.[^./]{1,12}$/.exec(file)?.[0].toLowerCase() ?? file);
    if (!named.has(kind)) named.set(kind, opener(file).catch(() => ''));
    return named.get(kind);
  });
}
