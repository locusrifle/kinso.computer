// What Workbench changes on a disk: for now, only moving things to the trash.
// The trash is the desktop's own (freedesktop), through `gio trash`, so the
// file manager, the desktop and Workbench all see the same one and anything
// can be restored. On a Mac it is the Trash in the Dock, through the system's
// own file manager API (NSFileManager, from osascript), so Finder sees it
// there. Nothing here deletes.
//
//   const actions = createFileActions();
//   await actions.trash(['/home/me/a.txt', ...])
//     -> { trashed: [path, ...], refused: [{ path, name, reason }, ...] }

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const exec = promisify(execFile);

// A Mac's Trash, asked of Foundation itself: the path is the script's one
// argument, never part of the script.
export const MAC_TRASH = `ObjC.import('Foundation');
function run(argv) {
  const error = Ref();
  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, error)) throw new Error(ObjC.unwrap(error[0].localizedDescription));
  return '';
}`;
export const trashCommand = (path, platform = process.platform) => (platform === 'darwin'
  ? ['/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_TRASH, path]]
  : ['gio', ['trash', '--', path]]);

// gio's reasons (or Foundation's, on a Mac), as a person would say them.
export function trashRefusal(error) {
  const text = String(error?.stderr || error?.message || '').replace(/^.*execution error:\s*(Error:\s*)?/s, '').replace(/\s*\(-?\d+\)\s*$/, '');
  if (error?.code === 'ENOENT' && String(error?.syscall ?? '').startsWith('spawn')) return 'this computer has no gio to move things to the Trash';
  if (/permission denied|not permitted|read-only|don.t have permission/i.test(text)) return "you don't have permission";
  if (/no such file/i.test(text)) return "it isn't there any more";
  // "Trashing on system internal mounts is not supported": tmpfs, /boot and the like.
  if (/system internal mounts|not supported|unable to find or create trash|trash directory|filesystem boundar|across/i.test(text)) return 'this drive has no Trash';
  return text.replace(/^gio:\s*/, '').replace(/^\S+:\s*/, '').trim().split('\n')[0] || 'it could not be moved';
}

export function createFileActions({ run = (bin, args) => exec(bin, args, { maxBuffer: 4e6, timeout: 60_000 }) } = {}) {
  let queue = Promise.resolve();
  // The thing itself, never what a link points at.
  async function itself(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw Object.assign(new Error('not a path'), { reason: 'it is not a path on this computer' });
    const lexical = resolve(path);
    if (lexical === '/') throw Object.assign(new Error('the top'), { reason: 'the top of the computer cannot be moved' });
    const full = join(await realpath(dirname(lexical)), basename(lexical));
    await lstat(full);
    return full;
  }
  async function trash(paths) {
    const trashed = [], refused = [];
    for (const path of [...new Set(Array.isArray(paths) ? paths : [])]) {
      try {
        await run(...trashCommand(await itself(path)));
        trashed.push(path);
      } catch (error) {
        refused.push({ path, name: basename(String(path)) || String(path), reason: error.reason ?? trashRefusal(error) });
      }
    }
    return { trashed, refused };
  }
  return {
    // One change at a time, in the order asked.
    trash(paths) { const next = queue.then(() => trash(paths)); queue = next.catch(() => {}); return next; },
  };
}
