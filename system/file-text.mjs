// What Workbench edits: a text file, in place (public/js/workbench-edit.js),
// through files.mjs:
//
//   GET  /files/text?path=   the whole file, to edit, and its version
//   POST /files/text?path=   its new text (the body, UTF-8), over the version
//                            named in If-Match
//
// Only a file that is already there and is this user's own to change: a
// regular file named .md, .markdown or .txt, of plain UTF-8 text, at most
// EDIT_LIMIT, owned by this user and writable by them, with no other hard
// links, inside one of the roots (the home folder). That is where it really
// is: a link is followed, and one that leads out of the roots, or to a file
// of another kind, is refused.
//
// A version is the file's bytes, hashed. A save names the version it was
// edited from, and a file changed on disk since then is never overwritten:
// the refusal (412) carries the version on disk, for the person to choose to
// reload it or to save over it. The new text is written to a file beside it,
// which then takes its place with its mode, so whoever reads it sees the old
// text or the new, never part of either.
//
//   const text = createFileText({ roots: [homedir()] });
//   await text.read(path)                 -> { path, name, text, version, size, mtime }
//   await text.save(path, bytes, version) -> { path, version, size, mtime }
//   await text.editable(path)             -> whether read and save would take it
// A refusal is an error with a status, and a reason a person can read.

import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export const EDIT_LIMIT = 1 << 20;
export const EDITABLE = /\.(md|markdown|txt)$/i;

const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const refuse = (status, reason, extra = {}) => Object.assign(new Error(reason), { status, ...extra });
export const versionOf = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = bytes => {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return !bytes.includes(0); }
  catch { return false; }
};
const megabytes = bytes => `${Math.round(bytes / (1 << 20) * 10) / 10} MB`;
// The disk's reasons, as a person would say them.
const told = error => {
  if (error?.status) return error;
  const reason = {
    ENOENT: [404, "it isn't there any more"], ENOTDIR: [404, "it isn't there any more"],
    EACCES: [403, "you don't have permission to change it"], EPERM: [403, "you don't have permission to change it"],
    EROFS: [403, 'its drive is read only'], ENOSPC: [507, 'the disk is full'], EDQUOT: [507, 'the disk quota is used up'],
  }[error?.code];
  return reason ? refuse(...reason) : refuse(500, error?.message || 'it could not be saved');
};

export function createFileText({ roots = [homedir()], limit = EDIT_LIMIT, uid = process.getuid?.() } = {}) {
  // Where an asked path really is, once every check passes.
  async function place(path) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) throw refuse(400, 'it is not a path on this computer');
    const asked = resolve(path);
    if (!EDITABLE.test(basename(asked))) throw refuse(415, 'only .md, .markdown and .txt files are edited here');
    const full = await realpath(asked);
    if (!EDITABLE.test(basename(full))) throw refuse(415, 'only .md, .markdown and .txt files are edited here');
    const homes = await Promise.all(roots.map(root => realpath(root).catch(() => null)));
    if (!homes.some(root => root && inside(full, root))) throw refuse(403, 'only files in your home folder are edited here');
    const info = await lstat(full);
    if (!info.isFile()) throw refuse(404, "it isn't a file");
    if (uid !== undefined && info.uid !== uid) throw refuse(403, 'it belongs to another user');
    if (info.nlink > 1) throw refuse(403, 'it has other hard links, which saving would part from it');
    if (info.size > limit) throw refuse(413, `it is over ${megabytes(limit)}`);
    try { await access(full, constants.R_OK | constants.W_OK); await access(dirname(full), constants.W_OK); }
    catch { throw refuse(403, "you don't have permission to change it"); }
    return { asked, full, info };
  }

  async function read(path) {
    const { asked, full, info } = await place(path);
    const bytes = await readFile(full);
    if (bytes.length > limit) throw refuse(413, `it is over ${megabytes(limit)}`);
    if (!plain(bytes)) throw refuse(415, "it isn't plain UTF-8 text");
    return { path: asked, name: basename(asked), text: bytes.toString('utf8'), version: versionOf(bytes), size: bytes.length, mtime: info.mtimeMs };
  }

  // One save at a time to a file, so a check and its write are never split
  // by another save.
  const queues = new Map();
  async function save(path, bytes, version) {
    if (typeof version !== 'string' || !/^[0-9a-f]{64}$/.test(version)) throw refuse(428, 'a save names the version it was edited from');
    if (!Buffer.isBuffer(bytes)) throw refuse(400, 'nothing to save');
    if (bytes.length > limit) throw refuse(413, `it would be over ${megabytes(limit)}`);
    if (!plain(bytes)) throw refuse(415, 'only plain UTF-8 text is saved');
    const { asked, full } = await place(path);
    const run = (queues.get(full) ?? Promise.resolve()).catch(() => {}).then(() => replace(full, bytes, version));
    queues.set(full, run);
    try { return { path: asked, ...(await run) }; }
    finally { if (queues.get(full) === run) queues.delete(full); }
  }

  async function replace(full, bytes, version) {
    const info = await lstat(full);
    if (!info.isFile() || info.nlink > 1) throw refuse(409, 'it is no longer a file that can be saved');
    const current = versionOf(await readFile(full));
    if (current !== version) throw refuse(412, 'it changed on disk since it was opened', { current });
    const temp = join(dirname(full), `.${basename(full)}.${randomBytes(6).toString('hex')}.saving`);
    let handle = null;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(bytes);
      // Its group as well as its mode, where this user may give it that group.
      await handle.chown(info.uid, info.gid).catch(() => {});
      await handle.chmod(info.mode & 0o7777);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temp, full);
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
    // The folder too, so the new name outlasts a crash.
    const folder = await open(dirname(full), 'r').catch(() => null);
    if (folder) { await folder.sync().catch(() => {}); await folder.close().catch(() => {}); }
    const after = await stat(full);
    return { version: versionOf(bytes), size: after.size, mtime: after.mtimeMs };
  }

  return {
    limit,
    read: path => read(path).catch(error => { throw told(error); }),
    save: (path, bytes, version) => save(path, bytes, version).catch(error => { throw told(error); }),
    editable: path => place(path).then(() => true, () => false),
  };
}
