// Workbench at ~/projects (workbench-view.js, projects.js): each project a
// tile with a preview of its page as it last looked, or a placeholder
// before it has run; the preview clicked opens the project, and anywhere
// else on the tile is the folder as ever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { readdir } from 'node:fs/promises';
import { createFiles } from '../../../../system/files.mjs';
import { createFileActions } from '../../../../system/file-actions.mjs';
import { realDisk } from './fixtures/real-disk.mjs';
import { PNG } from './fixtures/harness-page.mjs';

const publicRoot = new URL('../public/', import.meta.url);

test('in ~/projects each project wears a preview, which opens it; elsewhere folders are folders', async () => {
  // On a real disk, with a trash of its own: gio has no trash for tmpfs.
  const disk = await realDisk('tiles-');
  const home = disk.files;
  const root = join(home, 'projects');
  for (const name of ['dacre', 'new-one', 'old-one']) await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, 'dacre', 'index.html'), 'games');
  // Selection assertions use name order; equal dates make that deterministic.
  for (const name of ['dacre', 'new-one', 'old-one']) await utimes(join(root, name), 1000, 1000);
  // Its own trash and thumbnails, never the person's.
  const files = createFiles({
    thumbnailDir: join(disk.root, 'cache'), pictureMakers: [],
    actions: createFileActions({ run: disk.run }),
  });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/machines.json') return json({ machines: [] });
      if (url.pathname === '/projects.json') return json({ root, projects: [{ name: 'dacre', running: false, picture: 1234 }, { name: 'new-one', running: false, picture: 0 }, { name: 'old-one', running: false, picture: 0 }] });
      if (url.pathname === '/projects/dacre/picture') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return; }
      if (await files(req, res, url.pathname, url.search)) return;
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><style>#host{position:relative;height:100vh}</style><main id="host"></main>'); return; }
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(url.pathname.slice(1), publicRoot)));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      const { mountWorkbench } = await import('/js/workbench-view.js');
      window.opened = [];
      window.workbench = mountWorkbench({ host: document.getElementById('host'), onProject: (name, base) => opened.push([name, base]) });
    });
    await page.evaluate(path => workbench.open(path), root);
    await page.locator('.workbench-preview').first().waitFor();
    assert.equal(await page.locator('.workbench-preview img').getAttribute('src'), '/projects/dacre/picture?at=1234');
    assert.equal(await page.locator('.workbench-preview-none').first().textContent(), 'not run yet');
    await page.locator('.workbench-preview').first().click();
    assert.deepEqual(await page.evaluate(() => opened), [['dacre', '']]);
    assert.match(await page.locator('.workbench-path').textContent(), /projects$/, 'the preview opened the project, not the folder');
    // A project's tile is selected like any other; the preview stays its own, not a thumbnail.
    const tile = name => page.locator('.workbench-item').filter({ has: page.locator('.workbench-name', { hasText: new RegExp(`^${name}$`) }) });
    const selected = () => page.locator('.workbench-item[aria-selected="true"] .workbench-name').allTextContents();
    await tile('new-one').locator('.workbench-name').click();
    assert.deepEqual(await selected(), ['new-one']);
    await tile('old-one').locator('.workbench-preview').click({ modifiers: ['Control'] });
    assert.deepEqual(await selected(), ['new-one', 'old-one'], 'Ctrl+click on a preview selects, and opens nothing');
    await tile('dacre').locator('.workbench-preview').click({ modifiers: ['Shift'] });
    assert.deepEqual(await selected(), ['dacre', 'new-one', 'old-one']);
    assert.deepEqual(await page.evaluate(() => opened), [['dacre', '']]);
    assert.equal(await page.locator('.workbench-picture').count(), 0);
    assert.equal(await page.locator('.workbench-preview img').getAttribute('src'), '/projects/dacre/picture?at=1234');
    // Delete moves selected projects to the Trash like any folder.
    await tile('old-one').locator('.workbench-name').click();
    await page.keyboard.press('Delete');
    await page.locator('.workbench-status', { hasText: 'Moved old-one to Trash' }).waitFor();
    await tile('old-one').waitFor({ state: 'detached' });
    assert.deepEqual(await readdir(disk.trash), ['old-one']);
    assert.equal(await page.locator('.workbench-preview').count(), 2, 'the others keep their previews');
    // Its name, twice, is the folder.
    await page.locator('.workbench-item', { hasText: 'dacre' }).locator('.workbench-name').dblclick();
    // paintPath precedes the directory fetch. The breadcrumb alone can
    // still describe dacre while the old project tiles are on screen.
    await page.waitForFunction(() => document.querySelector('.workbench-path').textContent.endsWith('dacre') &&
      [...document.querySelectorAll('.workbench-name')].some(n => n.textContent === 'index.html'), null, { timeout: 60000 });
    assert.equal(await page.locator('.workbench-preview').count(), 0);
    // Any other folder: icons.
    await page.evaluate(path => workbench.open(path), home);
    await page.locator('.workbench-item').first().waitFor();
    assert.equal(await page.locator('.workbench-preview').count(), 0);
    assert.equal(await page.locator('.workbench-icon-folder').count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
    await disk.remove();
  }
});
