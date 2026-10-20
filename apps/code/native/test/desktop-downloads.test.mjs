// Downloads in imperfect's own window (desktop/electron/downloads.mjs): into
// Downloads, never over a file already there or one still coming in under
// the same name; the path on the clipboard as before; and the page told
// where each went.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDownloads, freePath } from '../../../../desktop/electron/downloads.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
function item(name, url = `http://127.0.0.1:5067/files/raw?path=%2Fhome%2Fme%2F${encodeURIComponent(name)}&download=1`) {
  const one = new EventEmitter();
  one.getFilename = () => name;
  one.getURL = () => url;
  one.setSavePath = path => { one.path = path; };
  one.getSavePath = () => one.path;
  return one;
}

test('a download takes its own name, or the next free one, never a file already there', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-downloads-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(freePath(dir, 'film.mp4'), join(dir, 'film.mp4'));
  await writeFile(join(dir, 'film.mp4'), 'mine');
  await writeFile(join(dir, 'film (1).mp4'), 'mine too');
  assert.equal(freePath(dir, 'film.mp4'), join(dir, 'film (2).mp4'));
  await writeFile(join(dir, 'Makefile'), '');
  assert.equal(freePath(dir, 'Makefile'), join(dir, 'Makefile (1)'));
  await writeFile(join(dir, '.bashrc'), '');
  assert.equal(freePath(dir, '.bashrc'), join(dir, '.bashrc (1)'), 'a dot name has no extension to keep');
  assert.equal(freePath(dir, 'archive.tar.gz', path => path === join(dir, 'archive.tar.gz')), join(dir, 'archive.tar (1).gz'));
  // Never out of Downloads, whatever it is called.
  for (const name of ['../../etc/passwd', '/etc/passwd', '..', '', null]) assert.equal(freePath(dir, name).startsWith(`${dir}/`), true, String(name));
  assert.equal(freePath(dir, '..'), join(dir, 'download'));
});

test('two downloads of one name at once go to two files, the clipboard and the page told as each ends', async () => {
  const told = [], copied = [];
  let clipboard = 'before';
  const clip = { read: async () => clipboard, write: text => { copied.push(text); clipboard = text; } };
  const downloads = createDownloads({ dir: '/home/me/Downloads', clip, tell: done => told.push(done), exists: path => path === '/home/me/Downloads/notes.txt' });
  const first = item('notes.txt'), second = item('notes.txt');
  downloads(first);
  downloads(second);
  assert.equal(first.path, '/home/me/Downloads/notes (1).txt', 'notes.txt is already there');
  assert.equal(second.path, '/home/me/Downloads/notes (2).txt', 'and (1) is still coming in');

  first.emit('done', {}, 'completed');
  await turn(); await turn();
  assert.deepEqual(told, [{ url: first.getURL(), path: '/home/me/Downloads/notes (1).txt', state: 'completed' }]);
  assert.deepEqual(copied, ['/home/me/Downloads/notes (1).txt']);

  // One that failed is told so, with nowhere; the clipboard is left alone.
  second.emit('done', {}, 'interrupted');
  await turn(); await turn();
  assert.deepEqual(told.at(-1), { url: second.getURL(), path: '', state: 'interrupted' });
  assert.equal(copied.length, 1);

  // Its name is free again once it has gone.
  const third = item('notes.txt');
  downloads(third);
  assert.equal(third.path, '/home/me/Downloads/notes (1).txt');
});

test('the person copied something meanwhile: it stays on the clipboard', async () => {
  let clipboard = 'before';
  const copied = [];
  const clip = { read: async () => clipboard, write: text => copied.push(text) };
  const downloads = createDownloads({ dir: '/d', clip, exists: () => false });
  const one = item('a.bin');
  downloads(one);
  await turn();
  clipboard = 'their own words';
  one.emit('done', {}, 'completed');
  await turn(); await turn();
  assert.deepEqual(copied, []);
});

test('the window hands the page each download as it ends', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../../../../desktop/electron/main.mjs', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../../../../desktop/electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(main, /session\.defaultSession\.on\('will-download', \(_, item\) => downloads\(item\)\)/);
  assert.match(main, /createDownloads\(\{ dir: app\.getPath\('downloads'\)[^\n]*win\.webContents\.send\('download', done\)/);
  assert.match(preload, /onDownload: fn => ipcRenderer\.on\('download', \(_, done\) => fn\(done\)\)/);
  const workbench = await readFile(new URL('../public/js/workbench-view.js', import.meta.url), 'utf8');
  assert.match(workbench, /imperfectDesk\?\.onDownload\?\.\(/, 'Files listens for them');
});
