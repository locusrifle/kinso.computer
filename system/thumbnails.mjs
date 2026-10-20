// Small pictures of bigger ones, for Workbench's grid and list
// (system/files.mjs, /files/thumbnail). Each is made the first time it is
// asked for, a few at a time, each once, by the first maker this computer
// has, and kept in dir by the file's path, time and size, so a changed file
// is made again. A maker is (from, to) => [command, arguments]; one that is
// not installed is not tried again. None at all: null, and the caller sends
// the picture itself.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const AT_ONCE = 3;
const SIDE = 480;
export const PICTURE_MAKERS = [
  (from, to) => ['vipsthumbnail', [from, '-s', `${SIDE}x${SIDE}`, '-o', `${to}[Q=75]`]],
  (from, to) => ['magick', [`${from}[0]`, '-thumbnail', `${SIDE}x${SIDE}>`, '-quality', '75', to]],
  // ImageMagick 6, which many distributions still ship.
  (from, to) => ['convert', [`${from}[0]`, '-thumbnail', `${SIDE}x${SIDE}>`, '-quality', '75', to]],
];
// A Mac's own, which every Mac has: sips, writing JPEG (it writes no WebP).
export const MAC_PICTURE_MAKERS = [
  (from, to) => ['/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', String(SIDE), from, '--out', to]],
];
// This computer's makers, and the kind of file they make.
export const pictureMaking = (platform = process.platform) => (platform === 'darwin'
  ? { makers: MAC_PICTURE_MAKERS, extension: '.jpg' }
  : { makers: PICTURE_MAKERS, extension: '.webp' });

const run = ([command, args]) => new Promise((done, fail) => {
  execFile(command, args, { timeout: 30_000 }, error => (error ? fail(error) : done()));
});

export function createThumbnails({ dir, makers, extension = '.webp' }) {
  const making = new Map();
  const missing = new Set();
  let running = 0;
  const queue = [];
  const turn = () => (running < AT_ONCE ? (running++, Promise.resolve()) : new Promise(go => queue.push(go)));
  const done = () => { const next = queue.shift(); if (next) next(); else running--; };
  async function make(from, to) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await turn();
    try {
      for (const maker of makers) {
        if (missing.has(maker)) continue;
        const temporary = `${to.slice(0, -extension.length)}.${process.pid}.tmp${extension}`;
        try {
          await run(maker(from, temporary));
          if (!(await stat(temporary)).size) throw new Error('empty thumbnail');
          await rename(temporary, to);
          return to;
        } catch (error) {
          await unlink(temporary).catch(() => {});
          // Not installed, as against failing on this one file.
          if (error.code === 'ENOENT' && String(error.syscall ?? '').startsWith('spawn')) missing.add(maker);
        }
      }
      return null;
    } finally { done(); }
  }
  // file's small picture (its path), made if need be; info is its stat.
  return async function thumbnail(file, info) {
    if (makers.every(maker => missing.has(maker))) return null;
    const key = createHash('sha256').update(`${file}\0${info.mtimeMs}\0${info.size}`).digest('hex').slice(0, 32);
    const to = join(dir, `${key}${extension}`);
    if ((await stat(to).catch(() => null))?.size) return to;
    if (!making.has(to)) making.set(to, make(file, to).finally(() => making.delete(to)));
    return making.get(to);
  };
}
