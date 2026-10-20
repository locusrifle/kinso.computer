// Exercise Workbench in Chromium against an isolated real filesystem, with its
// own trash: gio trash, as the desktop does it, into a folder of its own. It
// is all on a real disk under ~/.cache (fixtures/real-disk.mjs): gio has no
// trash for tmpfs, which the temporary folder is on many desktops.
import { launchChromium } from './test-browser.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile, readdir, utimes } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createFiles } from '../system/files.mjs';
import { createFileActions } from '../system/file-actions.mjs';
import { realDisk } from '../apps/code/native/test/fixtures/real-disk.mjs';

const disk = await realDisk('files-ui-');
const folder = join(disk.files, 'folder');
const trash = disk.trash;
await mkdir(join(folder, 'Downloads'), { recursive: true });
await writeFile(join(folder, 'clip.mp3'), 'test');
await writeFile(join(folder, 'notes.txt'), 'hello');
for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'stuck.txt']) await writeFile(join(folder, name), name);
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
for (const name of ['pixel.png', 'pixel2.png', 'pixel3.png']) await writeFile(join(folder, name), PIXEL);
await writeFile(join(folder, 'notes.md'), '# Notes\n\n- one\n- two\n\n![the pixel](pixel.png)\n');
await writeFile(join(folder, '.hidden'), 'not listed');
// Selection ranges below use alphabetical ties, not incidental write timing.
for (const name of await readdir(folder)) await utimes(join(folder, name), 100, 100);
// stuck.txt stands for a file on a drive with no trash, such as tmpfs: gio's
// own refusal, word for word.
const run = (bin, args) => (args.at(-1).endsWith('stuck.txt')
  ? Promise.reject(Object.assign(new Error('Command failed'), { stderr: `gio: file://${args.at(-1)}: Trashing on system internal mounts is not supported\n` }))
  : disk.run(bin, args));
const files = createFiles({ thumbnailDir: join(disk.root, 'cache'), actions: createFileActions({ run }) });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://files.test');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<style>:root{--paper:#181818;--ink:#e8e5df;--muted:#666;--pi-accent:#e9a7ce}body{margin:0;font-family:sans-serif}#host{position:relative;height:100vh}</style><main id="host"></main><script type="module">import {mountWorkbench} from '/js/workbench-view.js';window.workbench=mountWorkbench({host:document.querySelector('#host')});await workbench.open();</script>`); }
  if (url.pathname === '/machines.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"machines":[{"id":"fixture","name":"This computer","self":true,"home":true,"reachable":true,"capabilities":["files"]}]}'); }
  if (await files(req, res, url.pathname, url.search)) return;
  const path = join('apps/code/native/public', url.pathname);
  const body = await readFile(path).catch(() => null);
  if (!body) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': extname(path) === '.css' ? 'text/css' : 'text/javascript' });
  res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await launchChromium({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const item = name => page.locator('.workbench-item').filter({ has: page.locator('.workbench-name', { hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }) });
  const at = path => page.waitForFunction(path => workbench.where().path === path, path);
  const selected = async () => page.locator('.workbench-item[aria-selected="true"] .workbench-name').allTextContents();

  await at(homedir());
  assert.deepEqual(await page.locator('.workbench-crumb').allTextContents(), ['This computer', ...homedir().split('/').filter(Boolean)], 'Workbench opens at home');
  assert.equal(await page.locator('.workbench-drive').count(), 0, 'no drives above /: the disk is in where the space went');
  await page.locator('.workbench').focus();
  await page.keyboard.press('Control+l');
  await page.keyboard.type(folder);
  await page.keyboard.press('Enter');
  await item('notes.txt').waitFor();
  assert.equal(await item('.hidden').count(), 0, 'a name starting with a dot is not listed');
  await item('pixel.png').locator('.workbench-picture img').waitFor();
  await item('Downloads').dblclick();
  await at(join(folder, 'Downloads'));
  await page.keyboard.press('Backspace');
  await at(folder);

  // Selecting: a click, Shift+click, Ctrl+click, Shift+arrows, Ctrl+A, and empty space.
  await item('a.txt').click();
  assert.deepEqual(await selected(), ['a.txt']);
  await item('c.txt').click({ modifiers: ['Shift'] });
  assert.deepEqual(await selected(), ['a.txt', 'b.txt', 'c.txt']);
  await item('b.txt').click({ modifiers: ['Control'] });
  assert.deepEqual(await selected(), ['a.txt', 'c.txt']);
  await item('notes.txt').click({ modifiers: ['Control'] });
  assert.deepEqual(await selected(), ['a.txt', 'c.txt', 'notes.txt']);
  await item('a.txt').click();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  assert.deepEqual(await selected(), ['a.txt', 'b.txt', 'c.txt']);
  await page.keyboard.press('Shift+ArrowLeft');
  assert.deepEqual(await selected(), ['a.txt', 'b.txt']);
  await page.keyboard.press('Control+a');
  assert.equal((await selected()).length, await page.locator('.workbench-item').count());
  const picked = await item('a.txt').evaluate(row => getComputedStyle(row));
  assert.notEqual(picked.backgroundColor, 'rgba(0, 0, 0, 0)', 'selected items are highlighted');
  assert.equal(picked.borderRadius, '0px');
  await page.locator('.workbench-items').click({ position: { x: 700, y: 800 } });
  assert.deepEqual(await selected(), [], 'clicking empty space clears it');

  // Delete: to the Trash, no question; the folder shows it, the bar says it,
  // and what could not go stays, selected.
  await item('a.txt').click();
  await item('b.txt').click({ modifiers: ['Control'] });
  await page.keyboard.press('Delete');
  await page.locator('.workbench-status', { hasText: 'Moved 2 items to Trash' }).waitFor();
  await item('a.txt').waitFor({ state: 'detached' });
  assert.equal(await item('b.txt').count(), 0);
  assert.deepEqual((await readdir(trash)).sort(), ['a.txt', 'b.txt']);
  await item('c.txt').click();
  await item('stuck.txt').click({ modifiers: ['Control'] });
  await page.keyboard.press('Delete');
  await page.locator('.workbench-status', { hasText: "Moved c.txt to Trash. Couldn't move stuck.txt: this drive has no Trash" }).waitFor();
  await item('c.txt').waitFor({ state: 'detached' });
  assert.deepEqual(await selected(), ['stuck.txt'], 'what could not go is left, selected');
  assert.equal(await readFile(join(folder, 'stuck.txt'), 'utf8'), 'stuck.txt');
  assert.deepEqual((await readdir(trash)).sort(), ['a.txt', 'b.txt', 'c.txt'], 'nothing was deleted, only moved');

  // Opening: a picture whole, the next with Right, Delete moves the one in
  // view to the Trash and shows the next; Escape is the folder again.
  await item('pixel.png').dblclick();
  await page.locator('.workbench-view-line', { hasText: 'pixel.png · 70 bytes · 1 of 3' }).waitFor();
  assert.equal(await page.locator('.workbench-crumb[aria-current="page"]').textContent(), 'pixel.png');
  await page.keyboard.press('ArrowRight');
  await page.locator('.workbench-view-line', { hasText: 'pixel2.png · 70 bytes · 2 of 3' }).waitFor();
  await page.keyboard.press('Delete');
  await page.locator('.workbench-status', { hasText: 'Moved pixel2.png to Trash' }).waitFor();
  await page.locator('.workbench-view-line', { hasText: 'pixel3.png · 70 bytes · 2 of 2' }).waitFor();
  assert.deepEqual((await readdir(trash)).sort(), ['a.txt', 'b.txt', 'c.txt', 'pixel2.png']);
  await page.keyboard.press('Escape');
  await item('pixel3.png').waitFor();
  assert.equal(await item('pixel2.png').count(), 0, 'the folder shows it gone');
  assert.deepEqual(await selected(), ['pixel.png'], 'and the selection as it was (the double-click picked pixel.png)');
  // Markdown, as a page, with its picture from beside it.
  await item('notes.md').dblclick();
  await page.locator('.workbench-page h1', { hasText: 'Notes' }).waitFor();
  await page.waitForFunction(() => document.querySelector('.workbench-page img')?.naturalWidth === 1);
  assert.equal(await page.locator('.workbench-page li').count(), 2);
  await page.keyboard.press('Escape');
  await item('notes.md').waitFor();

  await page.screenshot({ path: process.env.FILES_SCREENSHOT || join(tmpdir(), 'imperfect-files-list.png') });
  assert.equal(await page.locator('.workbench-list').count(), 1);
  assert.equal(await page.locator('[data-view], .workbench-grid').count(), 0);
  assert.equal(await item('notes.txt').locator('.workbench-size').textContent(), '5 bytes');
  await item('pixel.png').locator('.workbench-picture img').waitFor();
  await page.getByRole('button', { name: 'Disk usage', exact: true }).click();
  await page.locator('.space-where').filter({ hasText: folder }).waitFor();
  await page.locator('.space-big').first().waitFor();
  await page.getByRole('button', { name: 'Disk usage', exact: true }).click();
  await page.getByRole('button', { name: 'This computer filesystem root', exact: true }).click();
  await at('/');
  await item('etc').waitFor();
  assert.deepEqual(errors, []);
  console.log('Workbench UI: opens at home (no drives: the disk is in disk usage), dot names hidden, typed address, folders, Backspace, pictures, selecting, Delete to the Trash (and a refusal), opening pictures (Right, Delete) and Markdown, list only, disk usage and the path passed');
} finally {
  await browser.close();
  server.close();
  await disk.remove();
}
