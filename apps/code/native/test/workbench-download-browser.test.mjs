// Downloading from Workbench, in Chromium against the real file backend
// (system/files.mjs, /files/raw?download=1): Download in the bar of any file
// open, here and through /peer/desktop, the browser saving it whole under
// its own name; not while the file is being edited; on a phone, held, a file
// offers it too; and imperfect's own window (desktop/electron/downloads.mjs)
// saying where it went, with the way to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createFiles } from '../../../../system/files.mjs';
import { createFileText } from '../../../../system/file-text.mjs';

const publicRoot = new URL('../public/', import.meta.url);
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const FILES = {
  'photo.png': PIXEL, 'photo2.png': PIXEL, 'clip.webm': 'film', 'beep.wav': 'sound', 'paper.pdf': '%PDF-1.4', 'notes.md': '# Notes\n\nmine\n',
  'blob.bin': Buffer.from([0, 1, 2, 3, 255]), 'Ünïcode café (1).txt': 'accents', 'page.html': '<script>window.ran = true</script>',
  "notes; filename*=UTF-8''setup.apk; x.txt": 'not an app',
};

async function withFolder(narrow, run) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'imperfect-download-browser-')));
  const docs = join(dir, 'docs');
  await mkdir(docs);
  await mkdir(join(docs, 'inner'));
  for (const [name, body] of Object.entries(FILES)) await writeFile(join(docs, name), body);
  // 48 MB, mostly holes: a film to the server and the browser, not the disk.
  const film = await open(join(docs, 'big.mp4'), 'w');
  await film.truncate(48 << 20);
  await film.write(Buffer.from('the end'), 0, 7, (48 << 20) - 7);
  await film.close();
  const files = createFiles({ thumbnailDir: join(dir, '.cache'), pictureMakers: [], edits: createFileText({ roots: [dir] }) });
  const downloads = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      const path = url.pathname.startsWith('/peer/desktop/') ? url.pathname.slice('/peer/desktop'.length) : url.pathname;
      if (url.searchParams.get('download') === '1') downloads.push(url.pathname + url.search);
      if (path === '/machines.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ machines: [{ id: 'laptop', name: 'Laptop', self: true, reachable: true, capabilities: ['files'] }, { id: 'desktop', name: 'PC', reachable: true, capabilities: ['files'] }] })); }
      if (await files(req, res, path, url.search)) return;
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--paper:#000;--ink:#e8e8e8;--muted:#8a8a8a;--pi-accent:#d4d4d4}body{margin:0;background:var(--paper);color:var(--ink);font:14px sans-serif}#host{position:relative;height:100dvh}</style><main id="host"></main>'); }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), publicRoot)));
    } catch { if (!res.headersSent) { res.statusCode = 404; res.end(); } }
  });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ acceptDownloads: true, ...(narrow ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } }) });
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      localStorage.clear();
      // imperfect's own window, as its preload hands the page (desktop/electron/preload.cjs).
      window.imperfectDesk = { onDownload: fn => { window.saved = fn; } };
      const { mountWorkbench } = await import('/js/workbench-view.js');
      window.workbench = mountWorkbench({ host: document.querySelector('#host') });
    });
    const item = name => page.getByRole('option').filter({ has: page.locator('.workbench-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
    const button = page.locator('.workbench-bar [data-download]');
    // A download asked for, as the browser saves it: its name, and its bytes.
    // (Headless Chromium has no PDF viewer: a PDF shown is a download of its
    // own, which is not one asked for.)
    const saved = async start => {
      const [download] = await Promise.all([page.waitForEvent('download', { predicate: one => one.url().includes('download=1') }), start()]);
      const to = join(dir, 'saved', `${downloads.length}-${download.suggestedFilename()}`);
      await download.saveAs(to);
      assert.equal(await download.failure(), null);
      return { name: download.suggestedFilename(), to, url: download.url() };
    };
    await run({ page, dir, docs, item, button, saved, downloads });
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => window.ran), undefined, 'nothing downloaded ever ran');
  } finally {
    try { await browser?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  }
}

test('any file open has Download in the bar, and the browser saves it whole, under its own name', { timeout: 120000 }, () => withFolder(false, async ({ page, docs, item, button, saved, downloads }) => {
  await page.evaluate(path => workbench.open(path), docs);
  await item('photo.png').waitFor();
  assert.equal(await button.isVisible(), false, 'a folder has no Download');

  for (const name of Object.keys(FILES)) {
    await page.evaluate(() => { if (workbench.where().file) workbench.back(); });
    await item(name).dblclick();
    await page.waitForFunction(name => workbench.where().file?.endsWith(`/${name}`), name);
    await button.waitFor();
    assert.equal(await button.textContent(), 'Download', name);
    const got = await saved(() => button.click());
    // Chromium itself saves a * as _, as it is not allowed everywhere.
    assert.equal(got.name, name.replaceAll('*', '_'), 'saved under its own name');
    assert.deepEqual(await readFile(got.to), Buffer.from(FILES[name]), `${name}: every byte`);
  }
  // The next picture and the one before, stepped to: each offers its own.
  await page.evaluate(() => workbench.back());
  await item('photo.png').dblclick();
  await page.locator('.workbench-view-image img').waitFor();
  for (const [key, name] of [['ArrowRight', 'photo2.png'], ['ArrowLeft', 'photo.png'], ['ArrowLeft', 'photo2.png']]) {
    await page.locator('.workbench').press(key);
    await page.waitForFunction(name => workbench.where().file?.endsWith(`/${name}`), name);
    await button.waitFor();
    assert.equal((await saved(() => button.click())).name, name, `${key}: Download is the picture shown`);
  }

  // The film: streamed to the browser's file, never held in the page.
  await page.evaluate(() => workbench.back());
  await item('big.mp4').dblclick();
  await page.locator('.workbench-view-video video').waitFor();
  const film = await saved(() => button.click());
  assert.equal(film.name, 'big.mp4');
  assert.equal((await stat(film.to)).size, 48 << 20);
  const end = await open(film.to);
  const tail = Buffer.alloc(7);
  await end.read(tail, 0, 7, (48 << 20) - 7);
  await end.close();
  assert.equal(tail.toString(), 'the end');
  assert.ok(downloads.every(url => url.startsWith('/files/raw?path=')), 'from this computer');
  assert.equal(await page.locator('.workbench-view:not([hidden]) video').evaluate(video => video.paused), true, 'the film did not start playing');

  // Not while it is being changed: the file as it is on disk is what is saved.
  await page.evaluate(() => workbench.back());
  await item('notes.md').dblclick();
  await page.locator('.workbench-page h1', { hasText: 'Notes' }).waitFor();
  await button.waitFor();
  await page.locator('.workbench-bar [data-edit]').click();
  await page.locator('textarea.workbench-editor').waitFor();
  assert.equal(await button.isVisible(), false, 'no Download while editing');
  await page.locator('.workbench-bar [data-edit]').click();
  await page.locator('.workbench-page h1', { hasText: 'Notes' }).waitFor();
  await button.waitFor();

  // Back to the folder: gone again.
  await page.evaluate(() => workbench.back());
  await item('inner').waitFor();
  assert.equal(await button.isVisible(), false);
}));

test('a file on another computer downloads through it, and imperfect\'s window says where it went', { timeout: 120000 }, () => withFolder(false, async ({ page, docs, item, button, saved, downloads }) => {
  await page.evaluate(path => workbench.open(path, { base: '/peer/desktop' }), docs);
  await item('Ünïcode café (1).txt').dblclick();
  await page.locator('.workbench-view-text pre', { hasText: 'accents' }).waitFor();
  const got = await saved(() => button.click());
  assert.equal(got.name, 'Ünïcode café (1).txt');
  assert.equal(await readFile(got.to, 'utf8'), 'accents');
  assert.match(downloads.at(-1), /^\/peer\/desktop\/files\/raw\?path=.*&download=1$/);

  // imperfect's window saved it to ~/Downloads and tells the page so.
  const status = page.locator('.workbench-status');
  await page.evaluate(url => saved({ url, path: '/home/someone/Downloads/Ünïcode café (1).txt', state: 'completed' }), got.url);
  await status.filter({ hasText: 'Saved to /home/someone/Downloads/Ünïcode café (1).txt' }).waitFor();
  const show = status.getByRole('button', { name: 'Show' });
  assert.equal(await show.isVisible(), true, 'the way to it, beside where it went');
  // A download that failed says so; one from anywhere else is not Files' to tell.
  await page.evaluate(url => saved({ url, path: '', state: 'interrupted' }), got.url);
  await status.filter({ hasText: "Couldn't download Ünïcode café (1).txt" }).waitFor();
  await page.evaluate(() => saved({ url: 'https://example.com/files/raw?path=/x&download=1', path: '/home/someone/Downloads/x', state: 'completed' }));
  await page.evaluate(() => saved({ url: `${location.origin}/somewhere/else.zip`, path: '/home/someone/Downloads/else.zip', state: 'completed' }));
  assert.equal(await status.textContent(), "Couldn't download Ünïcode café (1).txt", 'unchanged');

  // Show: the saved file, open in a view of its own on this computer.
  const where = join(docs, 'blob.bin');
  await page.evaluate(([url, path]) => saved({ url, path, state: 'completed' }), [got.url, where]);
  await status.getByRole('button', { name: 'Show' }).click();
  await page.waitForFunction(path => workbench.where().file === path, where);
  assert.equal((await page.evaluate(() => workbench.where())).base, '', 'this computer, where the window saved it');
  await page.locator('.workbench-view:not([hidden]) .workbench-view-message', { hasText: 'No preview for this file' }).waitFor();
  assert.equal(await button.isVisible(), true);
}));

test('on a phone, Download sits in the bar beside the path, and a file held offers it too', { timeout: 120000 }, () => withFolder(true, async ({ page, docs, item, button, saved }) => {
  await page.evaluate(path => workbench.open(path), docs);
  await item('photo.png').tap();
  await page.locator('.workbench-view-image img').waitFor();
  await button.waitFor();
  const bar = await page.locator('.workbench-bar').boundingBox(), box = await button.boundingBox();
  assert.ok(box.x >= bar.x && box.x + box.width <= bar.x + bar.width, 'within the bar');
  assert.ok(box.height >= 34, `a thumb's height: ${box.height}`);
  assert.ok((await page.locator('.workbench-address').boundingBox()).width > 120, 'the path keeps room');
  const got = await saved(() => button.tap());
  assert.equal(got.name, 'photo.png');

  await page.evaluate(() => workbench.back());
  await item('blob.bin').waitFor();
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } }); });
  const hold = async name => {
    await item(name).dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 50, clientY: 100 });
    await page.locator('.workbench-menu').waitFor();
    await item(name).evaluate(row => {
      row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'touch' }));
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };
  await hold('blob.bin');
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Open in new view', 'Download']);
  const held = await saved(() => page.getByRole('menuitem', { name: 'Download' }).tap());
  assert.equal(held.name, 'blob.bin');
  assert.deepEqual(await readFile(held.to), Buffer.from(FILES['blob.bin']));
  assert.equal(await page.locator('.workbench-menu').count(), 0, 'the menu goes');
  assert.equal(await page.evaluate(() => workbench.where().file), null, 'and the folder stays');

  await page.evaluate(() => document.querySelector('.workbench-menu')?.remove());
  await hold('inner');
  assert.deepEqual(await page.getByRole('menuitem').allTextContents(), ['Open in new view'], 'a folder is not downloaded');
}));
