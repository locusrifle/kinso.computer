import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFiles } from '../../../../system/files.mjs';
import { createFileActions } from '../../../../system/file-actions.mjs';

const exec = promisify(execFile);
// A one-pixel PNG.
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

// The production Workbench, served beside the real folder backend. /peer/desktop
// stands in for another computer (the same backend, reached through it), and
// /denied for a folder this user cannot open. Nothing talks to the installed service.
const publicRoot = new URL('../public/', import.meta.url);

async function withWorkbench(narrow, run) {
  // Backspace visits dirname(dir). Keep that parent ours too: listing the
  // machine's /tmp races thousands of other tests' files and serial stats.
  const parent = await mkdtemp(join(tmpdir(), 'imperfect-workbench-browser-'));
  const dir = join(parent, 'folder');
  await mkdir(join(dir, 'making', 'Companion'), { recursive: true });
  const home = join(parent, 'home');
  await mkdir(home);
  await writeFile(join(dir, 'notes.md'), 'hello files');
  await writeFile(join(dir, 'pixel.png'), PIXEL);
  await mkdir(join(dir, '.hidden', '.deeper'), { recursive: true });
  await writeFile(join(dir, '.hidden', 'inside.txt'), 'found');
  await writeFile(join(dir, '.dotfile'), 'unseen');
  // Equal dates leave the navigation/keyboard fixtures in natural name order.
  for (const name of ['making', 'notes.md', 'pixel.png']) await utimes(join(dir, name), 100, 100);
  // Its own cache and its own trash, never the person's.
  const files = createFiles({
    thumbnailDir: join(dir, '.cache'), pictureMakers: [],
    actions: createFileActions({ run: (bin, args) => exec(bin, args, { env: { ...process.env, XDG_DATA_HOME: join(dir, '.data') } }) }),
  });
  // A test can hold the pictures back, to see the folder come without them.
  const pictures = { held: null };
  const requests = [], failures = [], inventory = { machines: null };
  const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      requests.push(url.pathname + url.search);
      if (url.pathname.startsWith('/peer/old/')) return json(res, { error: 'Computer not responding' }, 503);
      const path = url.pathname.startsWith('/peer/desktop/') ? url.pathname.slice('/peer/desktop'.length) : url.pathname;
      if (path === '/machines.json') return json(res, { machines: inventory.machines || [
        { id: 'laptop', name: 'Laptop', self: true, reachable: true, capabilities: ['code', 'files'] },
        { id: 'desktop', name: 'PC', reachable: true, capabilities: ['code', 'files'] },
        { id: 'old', name: 'Away', reachable: false, capabilities: ['code', 'files'] },
        { id: 'phone', name: 'Phone', reachable: true, capabilities: ['code'] },
      ] });
      if (path === '/files/thumbnail') await pictures.held;
      if (path === '/files/list' && url.searchParams.get('path') === '/denied') return json(res, { error: "Can't open this folder: you don't have permission" }, 403);
      if (await files(req, res, path, url.search)) return;
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
          :root{--paper:#201c26;--ink:#eee4ed;--muted:#9f8eab;--pi-accent:#e9a7ce;--theme-bg:var(--paper);--theme-ink:var(--ink);--theme-accent:var(--pi-accent)}
          *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px sans-serif}#host{position:relative;height:100dvh}
          </style><main id="host"></main>`);
        return;
      }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'application/octet-stream');
      res.end(await readFile(new URL(path.slice(1), publicRoot)));
    } catch (error) { failures.push(error.message); res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  // Initial open and closing the last view both return to home. Own that
  // directory too, instead of listing the person's changing files/cache.
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage(narrow
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 860 } });
    // Native touch dispatch can wait behind software compositor work on a
    // busy PC. This is a bounded transport deadline, not Files' switching
    // speed: the compact-view check below still forbids every transition.
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      const { mountWorkbench } = await import('/js/workbench-view.js');
      window.workbench = mountWorkbench({ host: document.querySelector('#host') });
      await workbench.open();
    });
    // open() starts asynchronous navigation; an empty owned home makes it
    // especially easy to observe the placeholder before its listing arrives.
    await page.waitForFunction(home => workbench.where().path === home, home);
    await run({ page, dir, requests, narrow, pictures, inventory });
    assert.deepEqual(errors, [], 'no browser exceptions');
    assert.deepEqual(failures.filter(error => !error.includes('favicon.ico')), [], 'no unexpected fixture failures');
  } finally {
    try { await browser?.close(); }
    finally {
      server.closeAllConnections();
      try { await new Promise(resolve => server.close(resolve)); }
      finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        await rm(parent, { recursive: true, force: true });
      }
    }
  }
}

for (const narrow of [false, true]) test(`Workbench is a bar and a folder, from home (${narrow ? 'mobile emulation' : 'desktop'})`, { timeout: 60000 }, () => withWorkbench(narrow, async ({ page, dir, requests }) => {
  const bar = page.locator('.workbench-bar');
  const crumbs = () => page.locator('.workbench-crumb').allTextContents();
  const item = name => page.getByRole('option').filter({ has: page.locator('.workbench-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
  const activate = async name => narrow ? item(name).tap() : item(name).dblclick();
  const at = async path => page.waitForFunction(path => document.querySelector('.workbench-crumb[aria-current="page"]') && workbench.where().path === path, path);

  // Only its tabs, the bar and the folder: one tab and +; computer, address,
  // view, space (and full screen, for a page playing; Edit, for a text file of
  // the person's own). Files has no downloads.
  assert.equal(await page.locator('.workbench-tabs, [data-view], .workbench-computer').count(), 0);
  assert.equal(await page.locator('.workbench-view-count').textContent(), '+');
  assert.deepEqual(await bar.locator(':scope > *').evaluateAll(nodes => nodes.map(node => node.className || node.dataset && Object.keys(node.dataset)[0])), ['space', 'workbench-address', 'workbench-status', 'edit', 'workbench-view-count', 'full']);
  assert.equal(await page.locator('[data-edit]').isVisible(), false);
  const header = await bar.boundingBox(), body = await page.locator('.workbench-main').boundingBox();
  assert.equal(header.y, 0); assert.equal(body.y, header.height);
  assert.equal(await page.locator('[data-full]').isVisible(), false);
  const home = homedir();
  await at(home);
  assert.ok(requests.includes('/files/list?path='), 'opens at home, asking with no path');
  assert.ok(!requests.includes(`/files/list?path=${encodeURIComponent('/')}`), 'not at /');
  assert.deepEqual(await crumbs(), ['Laptop', ...home.split('/').filter(Boolean)]);

  // The address: typed (a click past the parts of the path), then each part
  // a way back up.
  const address = await page.locator('.workbench-address').boundingBox();
  await page.locator('.workbench-address').click({ position: { x: address.width - 2, y: address.height / 2 } });
  const typed = page.locator('.workbench-type');
  assert.equal(await typed.inputValue(), home);
  await typed.fill(dir);
  await typed.press('Enter');
  await at(dir);
  assert.deepEqual(await crumbs(), ['Laptop', ...dir.split('/').filter(Boolean)]);
  assert.equal(await typed.isVisible(), false);
  assert.deepEqual(await page.locator('.workbench-name').allTextContents(), ['making', 'notes.md', 'pixel.png'], 'names starting with a dot are not listed');
  await activate('making');
  await at(join(dir, 'making'));
  await activate('Companion');
  await at(join(dir, 'making', 'Companion'));
  assert.equal(await page.locator('.workbench-note').textContent(), 'Folder is empty');
  await page.locator('.workbench-crumb').filter({ hasText: new RegExp(`^${dir.split('/').at(-1)}$`) }).click();
  await at(dir);
  await activate('notes.md');
  await page.waitForFunction(dir => workbench.where().file === `${dir}/notes.md`, dir);
  // where().file is assigned before peek/text finish. Close a rendered
  // preview, not an in-flight open, before checking folder keyboard handling.
  await page.locator('.workbench-page').filter({ hasText: 'hello files' }).waitFor();
  assert.equal(await page.evaluate(() => workbench.where().path), dir, 'a file opens in its folder (workbench-open-browser.test.mjs)');
  assert.equal(await page.evaluate(() => workbench.back()), true, 'and the back gesture leaves it');
  assert.equal(await page.evaluate(() => workbench.where().file), null, 'the back gesture has closed the file');

  // Keys: Backspace for the folder above, Ctrl+L and Escape, arrows and Enter.
  await page.locator('.workbench').focus();
  await page.keyboard.press('Backspace');
  await at(dirname(dir));
  await page.keyboard.press('Control+l');
  assert.equal(await typed.isVisible(), true);
  await typed.fill('nowhere');
  await page.keyboard.press('Escape');
  assert.equal(await typed.isVisible(), false);
  assert.equal(await page.evaluate(() => workbench.where().path), dirname(dir), 'Escape goes nowhere');
  await page.locator('.workbench').focus();
  await page.keyboard.press('Control+l');
  await typed.fill(dir.split('/').at(-1));
  await typed.press('Enter');
  await at(dir);
  // A hidden folder, typed, opens, and lists all but its own dot names.
  await page.keyboard.press('Control+l');
  await typed.fill('.hidden');
  await typed.press('Enter');
  await at(join(dir, '.hidden'));
  assert.deepEqual(await page.locator('.workbench-name').allTextContents(), ['inside.txt']);
  await page.keyboard.press('Backspace');
  await at(dir);
  await page.locator('.workbench').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await item('making').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Enter');
  await at(join(dir, 'making'));
  await page.keyboard.press('Backspace');
  await at(dir);

  // A folder that cannot be opened says so, and the bar still works.
  await page.evaluate(() => workbench.open('/denied'));
  await page.locator('.workbench-note').filter({ hasText: "Can't open this folder" }).waitFor();
  assert.equal(await page.locator('.workbench-item').count(), 0);
  assert.deepEqual(await crumbs(), ['Laptop', 'denied']);
  await page.getByRole('button', { name: 'Laptop filesystem root', exact: true }).click();
  await item('etc').waitFor();
  await page.evaluate(dir => workbench.open(dir), dir);
  await at(dir);

  // The view: a grid of icons, or a list with sizes and dates, remembered.
  assert.equal(await page.locator('[data-view], .workbench-grid').count(), 0);
  assert.equal(await page.locator('.workbench-list').count(), 1);
  assert.equal(await item('notes.md').locator('.workbench-size').textContent(), '11 bytes');
  assert.notEqual(await item('notes.md').locator('.workbench-date').textContent(), '');
  assert.equal(await page.evaluate(() => localStorage.getItem('imperfect.workbench.view')), null);

  // Disk usage maps the folder in view, and goes again.
  await page.locator('[data-space]').click();
  await page.locator(`.space-where[data-path="${dir}"]`).waitFor();
  assert.equal(await page.locator('.space-where').textContent(), `Space in ${dir.split('/').pop()}`);
  assert.equal(await page.locator('.workbench-items').isVisible(), true, 'the map opens under the list, which stays');
  assert.ok(requests.includes(`/files/space?path=${encodeURIComponent(dir)}`));
  await page.locator('[data-space]').click();
  assert.equal(await page.locator('.files-space').isVisible(), false);
  assert.equal(await item('making').isVisible(), true);

  // The computer: those with files, the unreachable ones not to be chosen;
  // another one opens at its home.
  await page.getByRole('button', { name: 'Laptop filesystem root', exact: true }).click();
  await item('etc').waitFor();
  assert.deepEqual(await crumbs(), ['Laptop'], 'no Files heading at the filesystem root');
  const beforeRoot = requests.length;
  const choose = page.getByRole('button', { name: 'Choose a computer', exact: true });
  assert.equal(await choose.textContent(), 'Laptop', 'the existing computer name is the chooser');
  await choose.focus();
  await choose.press('Enter');
  await page.locator('.workbench-device').first().waitFor();
  assert.deepEqual(await page.locator('.workbench-name').allTextContents(), ['Laptop', 'PC', 'Away']);
  assert.ok(requests.slice(beforeRoot).filter(path => path.includes('/files/')).every(path => {
    const url = new URL(path, 'http://fixture'), target = url.searchParams.get('path');
    return !url.pathname.startsWith('/peer/') && target === '/';
  }), 'only already-started refreshes of the previous folder may cross navigation; no synthetic/default-owner read');
  assert.deepEqual(await crumbs(), [], 'computer list needs no Files heading');
  const atRoot = requests.filter(path => path.includes('/files/')).length;
  assert.equal(await page.locator('[data-space]').isDisabled(), true);
  await page.getByRole('button', { name: 'Away Offline · retry' }).click();
  await page.locator('.workbench-note').filter({ hasText: 'Away unavailable' }).waitFor();
  assert.equal(requests.filter(path => path.includes('/files/')).length, atRoot, 'offline never falls back');
  await page.getByRole('button', { name: 'PC Reachable' }).click();
  await page.waitForFunction(home => workbench.where().base === '/peer/desktop' && workbench.where().path === home, home);
  assert.ok(requests.includes('/peer/desktop/files/list?path='));
  await page.evaluate(() => workbench.open('', { base: '' }));
  await page.waitForFunction(() => workbench.where().base === '');

  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
  assert.ok(await page.locator('.workbench-bar').locator(':scope > button:not([hidden])').evaluateAll(controls => controls.every(control => {
    const r = control.getBoundingClientRect();
    return r.width > 0 && r.left >= 0 && r.right <= innerWidth && getComputedStyle(control).borderRadius === '0px';
  })), 'every control in the tabs and the bar fits, with hard edges');
  if (process.env.WORKBENCH_SCREENSHOT_DIR) {
    await mkdir(process.env.WORKBENCH_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.WORKBENCH_SCREENSHOT_DIR, `workbench-${narrow ? 'mobile' : 'desktop'}.png`) });
  }
  await page.locator('.workbench').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('region', { name: 'Workbench' }).isVisible(), true, 'Escape never closes it: it is always open');
}));

test('320px and 390px: root, compact views, instant switching and restored provenance in Black and Chalk', { timeout: 180000 }, () => withWorkbench(true, async ({ page, dir, requests, inventory }) => {
  const count = page.locator('.workbench-view-count');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const light of [false, true]) {
      await page.evaluate(light => {
        document.documentElement.style.setProperty('--theme-bg', light ? '#eee9de' : '#000');
        document.documentElement.style.setProperty('--theme-ink', light ? '#333' : '#ddd');
        window.filesTransitions = 0;
        document.startViewTransition = () => { window.filesTransitions++; throw new Error('Files must switch instantly'); };
      }, light);
      await page.evaluate(dir => workbench.open(dir, { base: '/peer/desktop' }), dir);
      const header = await page.locator('.workbench-bar').boundingBox();
      assert.equal(header.height, 45);
      assert.equal((await page.locator('.workbench-main').boundingBox()).y, header.height);
      await page.locator('.workbench-picture img').waitFor();
      await page.getByRole('button', { name: 'PC filesystem root', exact: true }).click();
      await page.getByRole('option').filter({ has: page.locator('.workbench-name', { hasText: /^etc$/ }) }).waitFor();
      const before = requests.length;
      await page.getByRole('button', { name: 'Choose a computer', exact: true }).click();
      await page.locator('.workbench-device').first().waitFor();
      assert.ok(requests.slice(before).filter(path => path.includes('/files/')).every(path => {
        const url = new URL(path, 'http://fixture');
        return url.pathname.startsWith('/peer/desktop/') && url.searchParams.get('path') === '/';
      }), 'only already-started filesystem-root refreshes may cross navigation; no synthetic-root read');
      assert.equal(await page.locator('[data-space]').isDisabled(), true);
      await count.tap();
      await page.waitForFunction(() => document.querySelector('.workbench-view-count').textContent === '2/2');
      await page.getByRole('button', { name: 'Laptop Reachable' }).tap();
      await page.waitForFunction(() => workbench.where().base === '' && workbench.where().path.startsWith('/'));
      await count.tap();
      assert.equal(await page.locator('.workbench-view-picker .workbench-tab').count(), 2);
      await page.getByRole('button', { name: 'New view', exact: true }).tap();
      assert.equal(await count.textContent(), '3/3');
      await count.tap();
      await page.getByRole('button', { name: 'Close view 3', exact: true }).tap();
      assert.equal(await count.textContent(), '2/2');
      const rootView = page.locator('.workbench-tab-name', { hasText: 'Computers' }).locator('..');
      await rootView.focus(); await rootView.press('Enter');
      assert.equal(await page.evaluate(() => workbench.where().base), '/peer/desktop', 'root retains its view provenance');
      assert.equal(await page.locator('.workbench-device').count(), 3);
      assert.equal(await page.evaluate(() => filesTransitions), 0);
      assert.equal(await page.locator('.workbench').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
      const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('imperfect.workbench.tabs')));
      assert.equal(kept.tabs[kept.active].path, 'imperfect:computers');
      assert.equal(kept.tabs[kept.active].owner, 'desktop');
      await count.tap();
      await page.getByRole('button', { name: 'Close view 2', exact: true }).tap();
      assert.equal(await count.textContent(), '+');
      // Picker stays open after closing down to one; the last can be closed normally.
      await page.getByRole('button', { name: 'Close view 1', exact: true }).tap();
      await page.waitForFunction(home => workbench.where().path === home, homedir());
      assert.equal(await count.textContent(), '+');
      assert.equal(await page.locator('.workbench-grid, [data-view], .workbench-tabs').count(), 0);
      assert.ok(await page.locator('.workbench-bar > button:not([hidden])').evaluateAll(controls => controls.every(node => { const r = node.getBoundingClientRect(); return r.width === 45 && r.height === 44 && r.right <= innerWidth && getComputedStyle(node).webkitTapHighlightColor === 'rgba(0, 0, 0, 0)'; })));
    }
  }
  await page.getByRole('button', { name: 'Laptop filesystem root', exact: true }).click();
  await page.getByRole('button', { name: 'Choose a computer', exact: true }).click();
  await page.locator('.workbench-device').first().waitFor();
  await page.reload();
  await page.evaluate(async () => { const { mountWorkbench } = await import('/js/workbench-view.js'); window.workbench = mountWorkbench({ host: document.querySelector('#host') }); await workbench.open(); });
  assert.equal(await page.locator('.workbench-device').count(), 3, 'synthetic root restored without listing it as a filesystem path');
  await count.focus(); await count.press('ArrowDown');
  assert.equal(await page.getByRole('dialog', { name: 'Files views' }).count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: 'Files views' }).count(), 0);
  await page.getByRole('button', { name: 'Away Offline · retry' }).tap();
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  inventory.machines = [{ id: 'old', name: 'Away', reachable: true, capabilities: ['files'] }];
  await page.getByRole('button', { name: 'Retry', exact: true }).tap();
  // This fixture doesn't proxy old: the honest failure still preserves its owner.
  await page.waitForFunction(() => workbench.where().base === '/peer/old');
  await page.locator('.workbench-note').filter({ hasText: 'Computer not responding' }).waitFor();
  assert.ok(requests.some(path => path.startsWith('/peer/old/files/list')), 'retry targets the peer, never local');
  inventory.machines = [{ id: 'hosted', name: 'Hosted computer', self: true, reachable: true, capabilities: ['files'] }];
  await page.getByRole('button', { name: 'Choose a computer', exact: true }).tap();
  await page.getByRole('button', { name: 'Hosted computer Reachable' }).waitFor();
  assert.equal(await page.locator('.workbench-device').count(), 1);
  assert.deepEqual(await page.locator('.workbench-name').allTextContents(), ['Hosted computer'], 'hosted root contains only the authorized computer');
}));

test('Workbench shows pictures small, and / as a folder like any other, on this computer and another', { timeout: 60000 }, () => withWorkbench(false, async ({ page, dir, requests, pictures }) => {
  const item = name => page.getByRole('option').filter({ has: page.locator('.workbench-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

  // At / only the folder: how full the disk is lives in where the space went.
  await page.evaluate(() => workbench.open('/'));
  await item('etc').waitFor();
  assert.equal(await page.locator('.workbench-drive, .workbench-drives').count(), 0, 'no drives above /');
  assert.ok(!requests.some(path => path.includes('/files/drives')));

  // The icon first, and the folder never waits for its pictures.
  let release;
  pictures.held = new Promise(go => { release = go; });
  await page.evaluate(dir => workbench.open(dir), dir);
  await item('pixel.png').waitFor();
  assert.equal(await item('pixel.png').locator('.workbench-icon svg').count(), 1, 'the file icon, while the picture comes');
  release();
  await item('pixel.png').locator('.workbench-picture img').waitFor();
  assert.ok(await item('pixel.png').locator('img').evaluate(img => img.complete && img.naturalWidth === 1));
  assert.equal(await item('notes.md').locator('img').count(), 0, 'only pictures');
  assert.ok(requests.some(path => path.startsWith(`/files/thumbnail?path=${encodeURIComponent(join(dir, 'pixel.png'))}&v=`)));

  // In the list, small beside the name.
  assert.equal(await page.locator('.workbench-list').count(), 1);
  await item('pixel.png').locator('.workbench-picture img').waitFor();
  const box = await item('pixel.png').locator('img').boundingBox();
  assert.ok(box.width === 24 && box.height === 24, `a small picture in the list, not ${box.width}x${box.height}`);

  // Another computer's pictures and folders are the same requests through it.
  await page.evaluate(dir => workbench.open(dir, { base: '/peer/desktop' }), dir);
  await item('pixel.png').locator('.workbench-picture img').waitFor();
  assert.ok(requests.some(path => path.startsWith(`/peer/desktop/files/thumbnail?path=${encodeURIComponent(join(dir, 'pixel.png'))}`)));
  await page.evaluate(() => workbench.open('/', { base: '/peer/desktop' }));
  await item('etc').waitFor();
  assert.ok(requests.includes('/peer/desktop/files/list?path=%2F'));
  await item('etc').dblclick();
  await page.waitForFunction(() => workbench.where().path === '/etc');
  assert.equal(await page.evaluate(() => workbench.where().base), '/peer/desktop', 'a folder opens on its own computer');
}));

for (const narrow of [false, true]) test(`Workbench keeps newest-first order across files, folders, views and peers (${narrow ? 'mobile emulation' : 'desktop'})`, { timeout: 60000 }, () => withWorkbench(narrow, async ({ page, dir }) => {
  await mkdir(join(dir, 'new-folder'));
  await utimes(join(dir, 'notes.md'), 400, 400);
  await utimes(join(dir, 'new-folder'), 300, 300);
  await utimes(join(dir, 'pixel.png'), 200, 200);
  await utimes(join(dir, 'making'), 100, 100);
  const expected = ['notes.md', 'new-folder', 'pixel.png', 'making'];
  for (const base of ['', '/peer/desktop']) {
    await page.evaluate(({ dir, base }) => workbench.open(dir, { base }), { dir, base });
    await page.locator('.workbench-name', { hasText: 'new-folder' }).waitFor();
    assert.deepEqual(await page.locator('.workbench-name').allTextContents(), expected, 'newest edited file above older folders; newest folder above old files');
    assert.equal(await page.locator('.workbench-list').count(), 1, 'all folders are lists');
    assert.equal(await page.locator('[data-view], .workbench-grid').count(), 0);
  }
}));

// A long path used to fill the whole address with crumbs, leaving a phone
// no blank target for editing. Crumb navigation must still work independently.
test('overflowing paths keep native touch editing and breadcrumb navigation', { timeout: 180000 }, () => withWorkbench(true, async ({ page, dir }) => {
  const deep = join(dir, ...Array.from({ length: 19 }, (_, i) => `segment-${i}`));
  await mkdir(deep, { recursive: true });
  const parent = dirname(deep);
  const typed = page.locator('.workbench-type');
  for (const width of [320, 390]) for (const light of [false, true]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(light => {
      document.documentElement.style.setProperty('--theme-bg', light ? '#eee9de' : '#000');
      document.documentElement.style.setProperty('--theme-ink', light ? '#333' : '#ddd');
      window.filesTransitions = 0;
      document.startViewTransition = () => { window.filesTransitions++; throw new Error('Files must switch instantly'); };
    }, light);
    await page.evaluate(deep => workbench.open(deep), deep);
    await page.waitForFunction(deep => workbench.where().path === deep, deep);
    const r = await page.locator('.workbench-address').boundingBox();
    const hit = await page.evaluate(() => {
      const r = document.querySelector('.workbench-address').getBoundingClientRect();
      const nav = document.querySelector('.workbench-path');
      return { class: document.elementFromPoint(r.right - 2, r.top + r.height / 2).className,
        navWidth: nav.clientWidth, scrollWidth: nav.scrollWidth };
    });
    assert.equal(hit.class, 'workbench-address', 'blank edit target exists outside the scrolling crumbs');
    assert.ok(hit.scrollWidth > hit.navWidth, 'the fixture really overflows');
    assert.equal((await page.locator('.workbench-bar').boundingBox()).height, 45);
    await page.locator('.workbench-crumb[aria-current="page"]').tap();
    assert.equal(await typed.isVisible(), false, 'current crumb retains navigation, not editing');
    await page.locator('.workbench-address').tap({ position: { x: r.width - 2, y: r.height / 2 } });
    assert.equal(await typed.isVisible(), true, 'native touch reaches the blank editing target');
    assert.equal(await typed.inputValue(), deep);
    assert.equal((await typed.boundingBox()).width, r.width, 'typed address still fills its old width');
    await page.keyboard.press('Escape');
    assert.equal(await typed.isVisible(), false);
    await page.locator('.workbench-crumb').filter({ hasText: /^segment-17$/ }).tap();
    await page.waitForFunction(parent => workbench.where().path === parent, parent);
    assert.equal(await page.evaluate(() => filesTransitions), 0);
    assert.equal(await page.locator('.workbench').evaluate(node => node.getAnimations({ subtree: true }).length), 0);
  }
}));
