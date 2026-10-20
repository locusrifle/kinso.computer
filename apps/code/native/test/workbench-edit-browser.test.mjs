// Editing a Markdown file in Workbench (workbench-edit.js), in Chromium
// against the real file backend (system/file-text.mjs): Edit, type, Mod+S,
// and after a reload the page is the new text; a change on disk is never
// saved over unasked, and nothing takes the editor's place while it holds
// what is not saved; on a phone, the keyboard waits for a tap and the page
// keeps its scale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createFiles } from '../../../../system/files.mjs';
import { createFileText } from '../../../../system/file-text.mjs';

const publicRoot = new URL('../public/', import.meta.url);
const SCRIPT = '# Launch\n\nThe first shot: the window opens.\n\n<script>window.ran = true</script>\n';

async function withFolder(narrow, run) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'imperfect-edit-browser-')));
  const docs = join(dir, 'docs');
  await mkdir(docs);
  await writeFile(join(docs, 'script.md'), SCRIPT);
  await writeFile(join(docs, 'notes.txt'), 'plain notes\n');
  await writeFile(join(docs, 'windows.txt'), '\uFEFFone\r\ntwo\r\n');
  await writeFile(join(docs, 'data.json'), '{ "a": 1 }');
  const files = createFiles({ thumbnailDir: join(dir, '.cache'), pictureMakers: [], edits: createFileText({ roots: [dir] }) });
  const saves = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      if (url.pathname === '/files/text' && req.method === 'POST') saves.push(url.searchParams.get('path'));
      if (url.pathname === '/machines.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ machines: [{ id: 'laptop', name: 'Laptop', self: true, reachable: true, capabilities: ['files'] }] })); }
      if (await files(req, res, url.pathname, url.search)) return;
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,interactive-widget=resizes-content"><style>:root{--paper:#000;--ink:#e8e8e8;--muted:#8a8a8a;--pi-accent:#d4d4d4}body{margin:0;background:var(--paper);color:var(--ink);font:14px monospace}#host{position:relative;height:100dvh}</style><main id="host"></main>'); }
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(url.pathname.slice(1), publicRoot)));
    } catch { res.statusCode = 404; res.end(); }
  });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage(narrow ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const mount = async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.evaluate(async () => {
        localStorage.clear();
        const { mountWorkbench } = await import('/js/workbench-view.js');
        window.workbench = mountWorkbench({ host: document.querySelector('#host') });
      });
    };
    await mount();
    const item = name => page.getByRole('option').filter({ has: page.locator('.workbench-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
    const line = page.locator('.workbench-view-line');
    await run({ page, dir, docs, item, line, mount, saves });
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => window.ran), undefined, 'nothing in the file ever ran');
  } finally {
    try { await browser?.close(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  }
}

test('a Markdown file is edited in place, saved with Mod+S, and is the new text after a reload', { timeout: 90000 }, () => withFolder(false, async ({ page, docs, item, line, mount, saves }) => {
  const path = join(docs, 'script.md');
  await page.evaluate(path => workbench.open(path), docs);
  await item('script.md').dblclick();
  await page.locator('.workbench-page h1', { hasText: 'Launch' }).waitFor();
  const edit = page.locator('.workbench-bar [data-edit]');
  assert.equal(await edit.textContent(), 'Edit', 'an Edit in the bar');

  await edit.click();
  const area = page.locator('textarea.workbench-editor');
  await area.waitFor();
  assert.equal(await area.inputValue(), SCRIPT, 'the whole file, as written');
  assert.equal(await edit.textContent(), 'Done');
  assert.equal(await area.evaluate(node => document.activeElement === node), true, 'ready to type');
  assert.match(await area.evaluate(node => getComputedStyle(node).fontFamily), /mono/i);
  assert.equal(await area.evaluate(node => getComputedStyle(node).whiteSpace), 'pre-wrap', 'soft wrapped');
  await line.filter({ hasText: 'script.md · Editing' }).waitFor();

  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nThe second shot: Files, and a script in it.\n');
  await line.filter({ hasText: /· Unsaved/ }).waitFor();
  await page.keyboard.press('Alt+KeyS');
  // At once, not after the pause it would save after by itself.
  assert.match(await line.textContent(), /Saving…|Saved/, 'Mod+S (Alt in a browser) saves');
  await line.filter({ hasText: /· Saved/ }).waitFor();
  assert.equal(await readFile(path, 'utf8'), `${SCRIPT}\nThe second shot: Files, and a script in it.\n`);
  assert.equal(saves.length, 1, 'saved once');

  // Escape: Done, and the page again, as saved.
  await page.keyboard.press('Escape');
  await page.locator('.workbench-page p', { hasText: 'The second shot' }).waitFor();
  assert.equal(await area.count(), 0);
  assert.equal(await edit.textContent(), 'Edit');
  assert.equal(await page.evaluate(() => workbench.where().file), path, 'still the file, not the folder');

  // Typed and left at once: saved before the page comes back.
  await edit.click();
  await area.waitFor();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Third.');
  await page.keyboard.press('Escape');
  await page.locator('.workbench-page p', { hasText: 'Third.' }).waitFor();
  assert.match(await readFile(path, 'utf8'), /Third\.$/);

  // A reload, and the file opened again: the new text.
  await mount();
  await page.evaluate(path => workbench.open(path), docs);
  await item('script.md').dblclick();
  await page.locator('.workbench-page p', { hasText: 'The second shot: Files, and a script in it.' }).waitFor();
  await page.locator('.workbench-page p', { hasText: 'Third.' }).waitFor();

  // Only the person's own text files: not JSON.
  await page.keyboard.press('Escape');
  await item('data.json').dblclick();
  await page.locator('.workbench-view-text pre').waitFor();
  assert.equal(await edit.isVisible(), false, 'no Edit for a file it does not take');
  await page.keyboard.press('Escape');
  await item('notes.txt').dblclick();
  await page.locator('.workbench-view-text pre', { hasText: 'plain notes' }).waitFor();
  assert.equal(await edit.isVisible(), true, 'a .txt file too');

  // A file written with \r\n and a byte-order mark is saved as it was written.
  await page.keyboard.press('Escape');
  await item('windows.txt').dblclick();
  await page.locator('.workbench-view-text pre', { hasText: 'two' }).waitFor();
  await edit.click();
  await area.waitFor();
  assert.equal(await area.inputValue(), 'one\ntwo\n');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('three');
  await page.keyboard.press('Escape');
  await page.locator('.workbench-view-text pre', { hasText: 'three' }).waitFor();
  assert.equal(await readFile(join(docs, 'windows.txt'), 'utf8'), '\uFEFFone\r\ntwo\r\nthree');
}));

test('a change on disk is never saved over unasked, and the editor is not left with what is unsaved', { timeout: 90000 }, () => withFolder(false, async ({ page, docs, item, line }) => {
  const path = join(docs, 'script.md');
  await page.evaluate(path => workbench.open(path), docs);
  await item('script.md').dblclick();
  await page.locator('.workbench-page h1', { hasText: 'Launch' }).waitFor();
  const edit = page.locator('.workbench-bar [data-edit]'), area = page.locator('textarea.workbench-editor');
  await edit.click();
  await area.waitFor();

  await writeFile(path, '# Launch\n\nChanged in another editor.\n');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Mine.');
  // Saved by itself after a pause: refused, and said so.
  await line.filter({ hasText: 'Changed on disk since you opened it' }).waitFor();
  assert.equal(await readFile(path, 'utf8'), '# Launch\n\nChanged in another editor.\n');

  // Nothing takes its place meanwhile: not the folder, nor the back gesture.
  await page.locator('.workbench-crumb', { hasText: 'docs' }).click();
  await page.locator('.workbench-status', { hasText: 'Not saved yet: it changed on disk since you opened it' }).waitFor();
  assert.equal(await area.isVisible(), true, 'still editing');
  assert.equal(await page.evaluate(() => workbench.unsaved()), true);

  await line.getByRole('button', { name: 'Overwrite' }).click();
  await line.filter({ hasText: /· Saved/ }).waitFor();
  assert.equal(await readFile(path, 'utf8'), `${SCRIPT}Mine.`);
  assert.equal(await page.evaluate(() => workbench.unsaved()), false);

  // Changed on disk again: Reload is the file as it is there, this text let go.
  await writeFile(path, '# Launch\n\nTheirs again.\n');
  await area.focus();
  await page.keyboard.type(' More of mine.');
  await page.keyboard.press('Alt+KeyS');
  await line.filter({ hasText: 'Changed on disk since you opened it' }).waitFor();
  await line.getByRole('button', { name: 'Reload' }).click();
  await line.filter({ hasText: /· Editing/ }).waitFor();
  assert.equal(await area.inputValue(), '# Launch\n\nTheirs again.\n');
  assert.equal(await readFile(path, 'utf8'), '# Launch\n\nTheirs again.\n');

  // Done: back to the page; then the folder, with nothing held.
  await page.evaluate(() => workbench.back());
  await page.locator('.workbench-page p', { hasText: 'Theirs again.' }).waitFor();
  await page.evaluate(() => workbench.back());
  await item('script.md').waitFor();
}));

test('on a phone: Edit, a tap where the words go, saved after a pause, at the same scale', { timeout: 90000 }, () => withFolder(true, async ({ page, docs, item, line }) => {
  const path = join(docs, 'script.md');
  await page.evaluate(path => workbench.open(path), docs);
  await item('script.md').tap();
  await page.locator('.workbench-page h1', { hasText: 'Launch' }).waitFor();
  const edit = page.locator('.workbench-bar [data-edit]'), area = page.locator('textarea.workbench-editor');
  const box = await edit.boundingBox();
  assert.ok(box.height >= 44, 'Edit at a thumb\'s size');
  await edit.tap();
  await area.waitFor();
  assert.equal(await area.evaluate(node => document.activeElement === node), false, 'the keyboard waits for a tap in the text');
  assert.equal(await area.evaluate(node => getComputedStyle(node).fontSize), '16px', 'no zoom as the keyboard comes up');
  await area.tap();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Typed on the phone.');
  await line.filter({ hasText: /· Saved/ }).waitFor({ timeout: 10000 });
  assert.equal(await readFile(path, 'utf8'), `${SCRIPT}Typed on the phone.`);
  assert.equal(await page.evaluate(() => visualViewport.scale), 1);
  await page.evaluate(() => workbench.back());
  await page.locator('.workbench-page p', { hasText: 'Typed on the phone.' }).waitFor();
}));
