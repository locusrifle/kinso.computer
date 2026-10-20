// Opening files in Workbench (workbench-open.js), in Chromium against the
// real file backend: each kind, the pictures before and after, back to the
// folder with its selection as it was, a Markdown page's links and pictures,
// and the same through /peer/desktop. Delete on an open picture is in
// tools/check-files-ui.mjs, where the Trash is on a real disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createFiles } from '../../../../system/files.mjs';
import { createShown } from '../../../../system/shown.mjs';

const publicRoot = new URL('../public/', import.meta.url);
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

async function withFolder(narrow, run) {
  const dir = await mkdtemp(join(tmpdir(), 'imperfect-open-browser-'));
  await mkdir(join(dir, 'pics'));
  await mkdir(join(dir, 'docs'));
  // Equal explicit dates keep viewer/clipboard tests about navigation, not creation timing.
  for (const name of ['a.png', 'b.png', 'c.png']) {
    await writeFile(join(dir, 'pics', name), PIXEL);
    await utimes(join(dir, 'pics', name), 100, 100);
  }
  await writeFile(join(dir, 'pics', 'list.txt'), 'not a picture');
  await writeFile(join(dir, 'docs', 'README.md'), '# Notes\n\nSee [the other page](other.md), [the end](#the-end) or [pics](../pics/).\n\n![one](../pics/a.png)\n\n<script>window.ran = true</script>\n\n' + 'filler\n\n'.repeat(80) + '## The end\n');
  await writeFile(join(dir, 'docs', 'other.md'), '# Other\n\n- back to [the notes](README.md)\n');
  await writeFile(join(dir, 'docs', 'data.json'), '{ "a": 1 }');
  await writeFile(join(dir, 'docs', 'page.html'), '<button onclick="this.textContent = \'Played\'">Play</button><script src="game.js"></script>');
  await writeFile(join(dir, 'docs', 'game.js'), 'document.body.dataset.ready = "yes";');
  await writeFile(join(dir, 'docs', 'NOTES'), 'plain words');
  await writeFile(join(dir, 'docs', 'big.log'), 'x'.repeat((1 << 20) + 10));
  await writeFile(join(dir, 'docs', 'clip.webm'), 'film');
  await writeFile(join(dir, 'docs', 'beep.wav'), 'sound');
  await writeFile(join(dir, 'docs', 'paper.pdf'), '%PDF-1.4');
  await writeFile(join(dir, 'docs', 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]));
  const files = createFiles({ thumbnailDir: join(dir, '.cache'), pictureMakers: [] });
  const requests = [];
  const shownKey = Symbol.for('imperfect.shown'), beforeShown = globalThis[shownKey];
  const shown = createShown({ stateDir: join(dir, '.shown'), servers: () => ({ list: () => [] }) });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      requests.push(url.pathname + url.search);
      const path = url.pathname.startsWith('/peer/desktop/') ? url.pathname.slice('/peer/desktop'.length) : url.pathname;
      if (path === '/machines.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ machines: [{ id: 'laptop', name: 'Laptop', self: true, reachable: true, capabilities: ['files'] }, { id: 'desktop', name: 'PC', reachable: true, capabilities: ['files'] }] })); }
      if (await shown.handle(req, res, path)) return;
      if (await files(req, res, path, url.search)) return;
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--paper:#201c26;--ink:#eee4ed;--muted:#9f8eab;--pi-accent:#e9a7ce}body{margin:0;background:var(--paper);color:var(--ink);font:14px sans-serif}#host{position:relative;height:100dvh}</style><main id="host"></main>'); }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), publicRoot)));
    } catch { res.statusCode = 404; res.end(); }
  });
  let browser;
  try {
    await shown.listen(0);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage(narrow ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } });
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      const { mountWorkbench } = await import('/js/workbench-view.js');
      window.backs = 0;
      window.opened = [];
      window.workbench = mountWorkbench({ host: document.querySelector('#host'), onOpen: async (path, base) => {
        opened.push({ path, base });
        if (!window.pages) {
          const { mountPages } = await import('/js/pages.js');
          const { mountWindows } = await import('/js/windows.js');
          const strip = document.createElement('div');
          strip.style.cssText = 'position:relative;height:600px';
          strip.innerHTML = '<section class="code-face"><div id="output"></div></section>';
          document.body.append(strip);
          const wm = mountWindows({ conversation: strip.firstElementChild });
          // Deliberately different from Workbench's peer: explicit ownership wins.
          window.pages = mountPages({ output: document.querySelector('#output'), wm, base: () => '/peer/wrong' });
        }
        await pages.open(path, { base });
      } });
    });
    const item = name => page.getByRole('option').filter({ has: page.locator('.workbench-name', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
    const where = () => page.evaluate(() => workbench.where());
    const line = () => page.locator('.workbench-view-line').textContent();
    await run({ page, dir, requests, item, where, line });
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => window.ran), undefined, 'nothing in a page ever ran');
  } finally {
    try { await browser?.close(); }
    finally {
      try {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      } finally {
        try { await shown.close(); }
        finally {
          globalThis[shownKey] = beforeShown;
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
  }
}

test('pictures open whole, go before and after, and Escape is the folder as it was', { timeout: 60000 }, () => withFolder(false, async ({ page, dir, item, where, line }) => {
  const pics = join(dir, 'pics');
  await page.evaluate(path => workbench.open(path), pics);
  await item('a.png').click();
  await item('b.png').click({ modifiers: ['Control'] });
  await page.keyboard.press('Enter');
  await page.locator('.workbench-view-image img').waitFor();
  assert.deepEqual(await where(), { path: pics, base: '', file: join(pics, 'b.png') });
  assert.equal(await page.locator('.workbench-crumb[aria-current="page"]').textContent(), 'b.png', 'the address is the file');
  await page.locator('.workbench-view-line', { hasText: 'b.png · 70 bytes · 2 of 3' }).waitFor();
  assert.equal(await page.locator('.workbench-items').isVisible(), false);
  assert.match(await page.locator('.workbench-view-image img').getAttribute('src'), /^\/files\/raw\?path=/);
  const box = await page.locator('.workbench-view-image img').boundingBox();
  assert.ok(box.width > 1000 && box.height > 700, 'fitted to the space, not its own size');

  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => workbench.where().file.endsWith('c.png'));
  assert.equal(await page.locator('.workbench-crumb[aria-current="page"]').textContent(), 'c.png');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => workbench.where().file.endsWith('a.png'));
  await page.locator('.workbench-view-line', { hasText: 'a.png · 70 bytes · 1 of 3' }).waitFor();
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => workbench.where().file.endsWith('c.png'));

  await page.keyboard.press('Escape');
  await item('a.png').waitFor();
  assert.equal((await where()).file, null);
  assert.deepEqual(await page.locator('.workbench-item[aria-selected="true"] .workbench-name').allTextContents(), ['a.png', 'b.png'], 'the selection as it was');
  assert.equal(await page.evaluate(() => backs), 0, 'Escape left the file, not Workbench');
  await item('a.png').dblclick();
  await page.locator('.workbench-view-image img').waitFor();
  await page.keyboard.press('Backspace');
  await item('a.png').waitFor();
  assert.equal((await where()).path, pics, 'Backspace leaves the file, not the folder');
  await item('list.txt').dblclick();
  await page.waitForFunction(() => workbench.where().file?.endsWith('list.txt'));
  assert.equal(await page.locator('.workbench-view-text pre').textContent(), 'not a picture');
  assert.equal(await page.evaluate(() => workbench.back()), true, 'the back gesture leaves the file');
  assert.equal((await where()).file, null);
}));

test('each kind opens as what it is', { timeout: 60000 }, () => withFolder(false, async ({ page, dir, item, where, line }) => {
  const docs = join(dir, 'docs');
  await page.evaluate(path => workbench.open(path), docs);
  const open = async name => { await item(name).dblclick(); await page.waitForFunction(name => workbench.where().file?.endsWith(`/${name}`), name); };
  const back = async () => { await page.keyboard.press('Escape'); await item('README.md').waitFor(); };

  await open('README.md');
  const md = page.locator('.workbench-page');
  await md.locator('h1', { hasText: 'Notes' }).waitFor();
  assert.equal(await md.locator('img').getAttribute('src'), `/files/raw?path=${encodeURIComponent(join(dir, 'pics', 'a.png'))}`, 'a picture beside the page is shown from its folder');
  await page.waitForFunction(() => document.querySelector('.workbench-page img').naturalWidth === 1);
  assert.match(await md.textContent(), /<script>window.ran = true<\/script>/, 'HTML in it is shown, not run');
  await md.getByRole('link', { name: 'the end' }).click();
  await page.waitForFunction(() => document.querySelector('.workbench-view-body').scrollTop > 0);
  assert.equal((await where()).file, join(docs, 'README.md'), 'a place in the page is still the page');
  await md.getByRole('link', { name: 'the other page' }).click();
  await page.waitForFunction(() => workbench.where().file?.endsWith('/other.md'));
  await page.locator('.workbench-page h1', { hasText: 'Other' }).waitFor();
  await page.locator('.workbench-page').getByRole('link', { name: 'the notes' }).click();
  await page.waitForFunction(() => workbench.where().file?.endsWith('/README.md'));
  await page.locator('.workbench-page').getByRole('link', { name: 'pics' }).click();
  await page.waitForFunction(dir => workbench.where().path === `${dir}/pics` && !workbench.where().file, dir);
  await page.evaluate(path => workbench.open(path), docs);

  await open('data.json');
  assert.equal(await page.locator('.workbench-view-text pre').textContent(), '{ "a": 1 }');
  assert.match(await page.locator('.workbench-view-text pre').evaluate(pre => getComputedStyle(pre).fontFamily), /mono/i);
  await back();
  await open('NOTES');
  assert.equal(await page.locator('.workbench-view-text pre').textContent(), 'plain words', 'a small UTF-8 file with no known name is text');
  await back();
  await open('big.log');
  assert.equal((await page.locator('.workbench-view-text pre').textContent()).length, 1 << 20, 'only the first 1 MB');
  assert.match(await line(), /showing the first 1\.0 MB/);
  await back();
  await open('clip.webm');
  assert.equal(await page.locator('.workbench-view-video video').getAttribute('src'), `/files/raw?path=${encodeURIComponent(join(docs, 'clip.webm'))}`);
  assert.equal(await page.locator('video').evaluate(video => video.controls && video.preload), 'metadata', "the browser's own player, which asks for what it plays");
  await back();
  assert.equal(await page.locator('video').count(), 0, 'and stops when left');
  await open('beep.wav');
  await page.locator('.workbench-view-audio audio[controls]').waitFor();
  await back();
  await open('paper.pdf');
  assert.equal(await page.locator('.workbench-view-pdf iframe').getAttribute('src'), `/files/raw?path=${encodeURIComponent(join(docs, 'paper.pdf'))}`);
  await back();
  await open('blob.bin');
  await page.locator('.workbench-view-message').waitFor();
  assert.deepEqual(await page.locator('.workbench-view-message p').allTextContents(), ['No preview for this file', '5 bytes · BIN file']);
  await back();

  // A typed path to a file opens it, in its folder.
  await page.locator('.workbench-address').click();
  await page.locator('.workbench-type').fill(join(docs, 'other.md'));
  await page.locator('.workbench-type').press('Enter');
  await page.locator('.workbench-page h1', { hasText: 'Other' }).waitFor();
  assert.deepEqual(await where(), { path: docs, base: '', file: join(docs, 'other.md') });
}));

// On a desk HTML plays inside Files, with assets served by its owner.
for (const base of ['', '/peer/desktop']) {
  test(`HTML launches a playable tab with local assets: desktop activation, ${base || 'this computer'}`, { timeout: 30000 }, () => withFolder(false, async ({ page, dir, requests, item, where }) => {
    const path = join(dir, 'docs', 'page.html');
    await page.evaluate(({ path, base }) => workbench.open(path, { base }), { path: join(dir, 'docs'), base });
    await item('page.html').dblclick();
    const player = page.frameLocator('.workbench-view-page iframe');
    await player.locator('body[data-ready="yes"]').waitFor({ state: 'attached' });
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await player.getByRole('button', { name: 'Played', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => opened), []);
    assert.equal(await page.locator('.wm-browser').count(), 0, 'no separate browser panel');
    assert.deepEqual(await where(), { path: join(dir, 'docs'), base, file: path });
    assert.ok(requests.includes(`${base}/shown/view`), 'the file-owning computer chooses the page preview');
    assert.ok(!requests.includes('/peer/wrong/shown/view'), 'the conversation owner does not own this file');
    assert.ok(!requests.some(url => url.includes('/files/raw?')), 'HTML is never fetched as text');
    // A subsequent open preserves the active app and uses another Files tab.
    await page.evaluate(({ path, base }) => workbench.open(path, { base }), { path: join(dir, 'docs', 'other.md'), base });
    await page.locator('.workbench-page h1', { hasText: 'Other' }).waitFor();
    assert.equal(await page.locator('.workbench-view-count').textContent(), '2/2');
    await page.locator('.workbench-view-count').click();
    await page.locator('.workbench-tab-name', { hasText: 'page.html' }).click();
    await player.getByRole('button', { name: 'Played', exact: true }).waitFor();
    await page.evaluate(({ path, base }) => workbench.open(path, { base }), { path, base });
    assert.equal(await page.locator('.workbench-view-count').textContent(), '1/2', 'opening the same HTML reuses its view');
  }));
}

// On a phone it plays in Workbench's own tab, where the finger is: no other
// panel to swipe to.
for (const base of ['', '/peer/desktop']) {
  test(`on a phone HTML plays in its tab, with local assets: ${base || 'this computer'}`, { timeout: 30000 }, () => withFolder(true, async ({ page, dir, requests, item, where }) => {
    const path = join(dir, 'docs', 'page.html');
    await page.evaluate(({ path, base }) => workbench.open(path, { base }), { path: join(dir, 'docs'), base });
    await item('page.html').tap();
    const player = page.frameLocator('.workbench-view-page iframe');
    await player.locator('body[data-ready="yes"]').waitFor({ state: 'attached' });
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await player.getByRole('button', { name: 'Played', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => opened), [], 'not sent to the browser');
    assert.equal(await page.locator('.wm-browser').count(), 0);
    assert.deepEqual(await where(), { path: join(dir, 'docs'), base, file: path });
    assert.equal(await page.locator('.workbench-crumb[aria-current="page"]').textContent(), 'page.html', 'its path up top');
    assert.equal(await page.locator('.workbench-view-count').textContent(), '+');
    assert.ok(requests.includes(`${base}/shown/view`), 'the file-owning computer chooses the page preview');
    assert.ok(!requests.some(url => url.includes('/files/raw?')), 'HTML is never fetched as text');
    assert.equal(await page.evaluate(() => workbench.back()), true, 'back is the folder');
    await item('page.html').waitFor();
    assert.equal((await where()).file, null);
    assert.equal(await page.locator('.workbench-view-page iframe').count(), 0, 'and the page is let go');
  }));
}

test('on a phone, tabs as a browser has them: a page in one, a picture in another, each as it was when switched back, closed with ×, and kept across a reload', { timeout: 60000 }, () => withFolder(true, async ({ page, dir, item, where }) => {
  const docs = join(dir, 'docs'), pics = join(dir, 'pics');
  const tabs = () => page.evaluate(() => { const kept = JSON.parse(localStorage.getItem('imperfect.workbench.tabs')); return kept.tabs.map((tab, i) => `${(tab.file || tab.path).split('/').filter(Boolean).at(-1)}${i === kept.active ? ' *' : ''}`); });
  const tab = name => ({ tap: async () => {
    await page.locator('.workbench-view-count').tap();
    await page.locator('.workbench-tab-name').filter({ hasText: new RegExp(`^${name.replace('.', '\\.')}$`) }).tap();
  } });
  await page.evaluate(path => workbench.open(path), docs);
  assert.deepEqual(await tabs(), ['docs *']);
  assert.equal(await page.locator('.workbench-tabs').count(), 0, 'no separate view strip');
  const [bar, body] = await Promise.all(['.workbench-bar', '.workbench-main'].map(q => page.locator(q).boundingBox()));
  assert.equal(bar.y, 0);
  assert.equal(body.y, bar.height, 'the folder starts directly under the one row');
  const plus = await page.locator('.workbench-view-count').boundingBox();
  assert.ok(plus.width >= 44 && plus.height >= 32, 'a thumb-sized +');
  // The page plays in the first tab.
  await item('page.html').tap();
  const player = page.frameLocator('.workbench-view-page iframe');
  await player.getByRole('button', { name: 'Play', exact: true }).click();
  await player.getByRole('button', { name: 'Played', exact: true }).waitFor();
  assert.deepEqual(await tabs(), ['page.html *']);
  // + : a second tab, at the same folder, in front; the page behind still playing.
  await page.locator('.workbench-view-count').tap();
  assert.deepEqual(await tabs(), ['page.html', 'docs *']);
  await item('README.md').waitFor();
  assert.deepEqual(await where(), { path: docs, base: '', file: null });
  assert.equal(await page.locator('.workbench-view-page').isVisible(), false);
  // There, to the pictures, and one opened.
  await page.evaluate(path => workbench.open(path), pics);
  await item('b.png').tap();
  await page.locator('.workbench-view-image img').waitFor();
  assert.deepEqual(await tabs(), ['page.html', 'b.png *']);
  assert.equal(await page.locator('.workbench-crumb[aria-current="page"]').textContent(), 'b.png');
  // Back to the page: as it was, not loaded again; the picture's tab keeps its picture.
  await tab('page.html').tap();
  assert.deepEqual(await tabs(), ['page.html *', 'b.png']);
  await player.getByRole('button', { name: 'Played', exact: true }).waitFor();
  assert.equal(await page.locator('.workbench-crumb[aria-current="page"]').textContent(), 'page.html', 'its own path up top');
  assert.equal(await page.locator('.workbench-view-image img').isVisible(), false);
  await tab('b.png').tap();
  await page.locator('.workbench-view-image img').waitFor();
  assert.deepEqual(await where(), { path: pics, base: '', file: join(pics, 'b.png') });
  // A swipe across the picture still goes to the next one, in this tab.
  await page.locator('.workbench-view:not([hidden]) .workbench-view-body').evaluate(body => {
    const at = x => ({ pointerId: 1, pointerType: 'touch', clientX: x, clientY: 300, bubbles: true });
    body.dispatchEvent(new PointerEvent('pointerdown', at(300)));
    body.dispatchEvent(new PointerEvent('pointerup', at(80)));
  });
  await page.waitForFunction(() => workbench.where().file.endsWith('c.png'));
  assert.deepEqual(await tabs(), ['page.html', 'c.png *']);
  // Held, an item is offered in a new tab (its path copied as ever).
  await page.evaluate(() => workbench.back());
  await item('a.png').waitFor();
  // The path bar settled (any scroll abandons a hold, as a finger's would).
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.evaluate(() => { window.copies = []; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => copies.push(text) } }); });
  await item('list.txt').dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 50, clientY: 100 });
  await page.locator('.workbench-menu').waitFor();
  await item('list.txt').evaluate(row => {
    row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'touch' }));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForFunction(() => copies.length);
  assert.ok((await page.evaluate(() => copies.at(-1))).split('\n').includes(join(pics, 'list.txt')), 'its path copied, with the rest selected');
  await page.getByRole('menuitem', { name: 'Open in new view' }).tap();
  await page.locator('.workbench-view-text pre', { hasText: 'not a picture' }).waitFor();
  assert.deepEqual(await tabs(), ['page.html', 'pics', 'list.txt *']);
  assert.equal(await page.locator('.workbench-menu').count(), 0);
  // × closes the one in front, the next in its place.
  await page.locator('.workbench-view-count').tap();
  await page.getByRole('button', { name: 'Close view 3', exact: true }).tap();
  assert.deepEqual(await tabs(), ['page.html', 'pics *']);
  await item('a.png').waitFor();
  // A reload: the tabs as they were, the one in front showing its folder,
  // and the page's tab playing it again when it comes to the front.
  await tab('page.html').tap();
  assert.deepEqual(await tabs(), ['page.html *', 'pics']);
  await page.reload();
  await page.evaluate(async () => {
    const { mountWorkbench } = await import('/js/workbench-view.js');
    window.workbench = mountWorkbench({ host: document.querySelector('#host') });
    await workbench.open();
  });
  assert.deepEqual(await tabs(), ['page.html *', 'pics']);
  await player.locator('body[data-ready="yes"]').waitFor({ state: 'attached' });
  assert.deepEqual(await where(), { path: docs, base: '', file: join(docs, 'page.html') });
  await tab('pics').tap();
  await item('a.png').waitFor();
  assert.deepEqual(await where(), { path: pics, base: '', file: null });
  // A folder asked for from elsewhere (an agent shows one) goes where the tab
  // in front is, unless that tab has a file open: then the tab already at
  // that folder, or one of its own, the page playing on behind.
  await tab('page.html').tap();
  await page.evaluate(path => workbench.open(path, { quiet: true }), pics);
  assert.deepEqual(await tabs(), ['page.html', 'pics *']);
  await tab('page.html').tap();
  await page.evaluate(path => workbench.open(path, { quiet: true }), docs);
  await item('README.md').waitFor();
  assert.deepEqual(await tabs(), ['page.html', 'docs *', 'pics']);
  await tab('page.html').tap();
  await player.locator('body[data-ready="yes"]').waitFor({ state: 'attached' });
  assert.deepEqual(await where(), { path: docs, base: '', file: join(docs, 'page.html') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
}));

test('closing the only Files tab returns to the default folder layer', { timeout: 30000 }, () => withFolder(true, async ({ page, dir, item, where }) => {
  await page.evaluate(path => workbench.open(path), join(dir, 'docs'));
  await item('page.html').tap();
  await page.frameLocator('.workbench-view-page iframe').locator('body[data-ready="yes"]').waitFor();
  assert.equal(await page.locator('.workbench-view-count').textContent(), '+');
  await page.locator('.workbench-view-count').dispatchEvent('contextmenu');
  await page.getByRole('button', { name: 'Close view 1', exact: true }).tap();
  await page.waitForFunction(() => !document.querySelector('.workbench-view-page iframe') && !window.workbench.where().file);
  assert.equal(await page.locator('.workbench-view-count').textContent(), '+');
  assert.equal((await where()).file, null);
  await page.waitForFunction(home => workbench.where().path === home, homedir());
  assert.equal((await where()).path, homedir());
}));

test("another computer's files open the same way, through it", { timeout: 60000 }, () => withFolder(false, async ({ page, dir, requests, item, where }) => {
  await page.evaluate(path => workbench.open(path, { base: '/peer/desktop' }), join(dir, 'docs'));
  await item('README.md').dblclick();
  await page.locator('.workbench-page h1', { hasText: 'Notes' }).waitFor();
  assert.equal((await where()).base, '/peer/desktop');
  assert.ok(requests.includes(`/peer/desktop/files/peek?path=${encodeURIComponent(join(dir, 'docs', 'README.md'))}`));
  assert.ok(requests.includes(`/peer/desktop/files/raw?path=${encodeURIComponent(join(dir, 'docs', 'README.md'))}`));
  assert.equal(await page.locator('.workbench-page img').getAttribute('src'), `/peer/desktop/files/raw?path=${encodeURIComponent(join(dir, 'pics', 'a.png'))}`);
  await page.keyboard.press('Escape');
  await item('data.json').dblclick();
  assert.equal(await page.locator('.workbench-view-text pre').textContent(), '{ "a": 1 }');
  assert.ok(!requests.some(path => path.startsWith('/files/peek') || path.startsWith('/files/raw')), 'nothing was read from this computer');
}));

test('on a phone a tap opens, a swipe goes to the next picture, and back is the folder', { timeout: 60000 }, () => withFolder(true, async ({ page, dir, item, where }) => {
  const pics = join(dir, 'pics');
  await page.evaluate(path => workbench.open(path), pics);
  await item('a.png').tap();
  await page.locator('.workbench-view-image img').waitFor();
  assert.equal((await where()).file, join(pics, 'a.png'));
  const swipe = (from, to) => page.locator('.workbench-view-body').evaluate((body, [from, to]) => {
    const at = x => ({ pointerId: 1, pointerType: 'touch', clientX: x, clientY: 300, bubbles: true });
    body.dispatchEvent(new PointerEvent('pointerdown', at(from)));
    body.dispatchEvent(new PointerEvent('pointerup', at(to)));
  }, [from, to]);
  await swipe(300, 80);
  await page.waitForFunction(() => workbench.where().file.endsWith('b.png'));
  await swipe(80, 300);
  await page.waitForFunction(() => workbench.where().file.endsWith('a.png'));
  await swipe(200, 180);
  assert.equal((await where()).file, join(pics, 'a.png'), 'a small move is not a swipe');
  assert.equal(await page.evaluate(() => workbench.back()), true);
  await item('b.png').waitFor();
  assert.equal((await where()).file, null);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
}));


test('hold copies literal paths, adds and removes in folder order, without opening on release', { timeout: 60000 }, () => withFolder(true, async ({ page, dir, item, where }) => {
  const pics = join(dir, 'pics');
  await writeFile(join(pics, 'with spaces.png'), PIXEL);
  await utimes(join(pics, 'with spaces.png'), 100, 100);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(async path => {
    const { copyPaths } = await import('/js/workbench-copy.js');
    await copyPaths([path]);
    if (await navigator.clipboard.readText() !== path) throw new Error('OS clipboard did not receive the literal path');
  }, join(pics, 'with spaces.png'));
  await page.evaluate(() => {
    window.copies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => copies.push(text) } });
  });
  await page.evaluate(path => workbench.open(path, { base: '/peer/desktop' }), pics);
  const hold = async name => {
    const before = await page.evaluate(() => copies.length);
    // Finish navigation's scroll before holding (scroll deliberately cancels
    // a hold). Observe the copy, not a Node-side sleep racing the browser timer.
    await item(name).evaluate(async row => {
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch', button: 0, clientX: 50, clientY: 100 }));
    });
    await page.waitForFunction(before => copies.length === before + 1, before);
    // These are one release gesture. Separate protocol round trips can exceed
    // the real one-second post-release suppression window on a busy machine.
    await item(name).evaluate(row => {
      row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'touch' }));
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    assert.equal((await where()).file, null);
  };
  await hold('with spaces.png');
  await hold('a.png');
  assert.deepEqual(await page.evaluate(() => copies), [join(pics, 'with spaces.png'), [join(pics, 'a.png'), join(pics, 'with spaces.png')].join('\n')]);
  await hold('with spaces.png');
  assert.deepEqual(await page.locator('.workbench-item[aria-selected="true"] .workbench-name').allTextContents(), ['a.png']);
  assert.equal(await page.evaluate(() => copies.at(-1)), join(pics, 'a.png'));
  assert.match(await page.locator('.workbench-status').textContent(), /Copied 1 paths · PC/);
  assert.equal(await page.locator('.workbench-list').count(), 1);
  await hold('b.png');
  assert.equal(await page.evaluate(() => copies.at(-1)), [join(pics, 'a.png'), join(pics, 'b.png')].join('\n'));
  await page.evaluate(() => { document.querySelector('.workbench').focus(); });
  await page.keyboard.press('Control+c');
  assert.equal(await page.evaluate(() => copies.length), 5);
  await page.evaluate(path => workbench.open(path), join(dir, 'docs'));
  assert.equal(await page.locator('.workbench-item[aria-selected="true"]').count(), 0);
  assert.equal(await page.evaluate(() => copies.length), 5, 'navigation leaves OS clipboard untouched');
}));

test('motion, scroll, cancellation, second touch and navigation abandon a hold; fallback is honest', { timeout: 60000 }, () => withFolder(true, async ({ page, dir, item, where }) => {
  const pics = join(dir, 'pics');
  await page.evaluate(() => {
    window.copies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = command => {
      if (!document.activeElement.readOnly) throw new Error('Clipboard fallback must not summon the phone keyboard');
      copies.push(document.activeElement.value); return true;
    };
  });
  await page.evaluate(path => workbench.open(path), pics);
  for (const cancel of ['pointermove', 'pointercancel', 'scroll', 'second', 'navigation']) {
    await item('a.png').dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', button: 0, clientX: 50, clientY: 100 });
    if (cancel === 'second') {
      await item('b.png').dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch', button: 0 });
      await item('b.png').dispatchEvent('pointerup', { pointerId: 2 });
    } else if (cancel === 'navigation') await page.evaluate(path => workbench.open(path), pics);
    else await item('a.png').dispatchEvent(cancel, { pointerId: 1, clientX: 80, clientY: 100 });
    await page.waitForTimeout(550);
    await item('a.png').dispatchEvent('pointerup', { pointerId: 1 });
    assert.equal(await page.evaluate(() => copies.length), 0, cancel);
  }
  const hold = async expected => {
    await item('a.png').evaluate(async row => {
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch', button: 0 }));
    });
    await page.waitForFunction(expected => document.querySelector('.workbench-status').textContent.startsWith(expected), expected);
    await item('a.png').dispatchEvent('pointerup', { pointerId: 1 });
  };
  await hold('Copied 1 paths');
  assert.equal(await page.evaluate(() => copies.at(-1)), join(pics, 'a.png'));
  assert.match(await page.locator('.workbench-status').textContent(), /^Copied 1 paths/);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
    document.execCommand = () => false;
  });
  await hold("Couldn't copy paths");
  assert.match(await page.locator('.workbench-status').textContent(), /Couldn't copy paths/);
  assert.equal(await page.locator('textarea').count(), 0);
  await item('b.png').tap();
  await page.waitForFunction(() => workbench.where().file?.endsWith('b.png'));
}));
