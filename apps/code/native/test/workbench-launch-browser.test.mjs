import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createFiles } from '../../../../system/files.mjs';
import { createProjects } from '../../../../system/projects.mjs';
import { PNG } from './fixtures/harness-page.mjs';

const publicRoot = new URL('../public/', import.meta.url);

test('launch markers distinguish HTML and real projects from source, folders and media in lists on either computer', { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'workbench-launch-'));
  const root = join(home, 'projects');
  for (const folder of ['App', 'Unrun', 'Folder', 'Support']) await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, 'App', 'index.html'), '<h1>App</h1>');
  await writeFile(join(root, 'Unrun', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  await writeFile(join(root, 'Support', 'package.json'), JSON.stringify({ scripts: { dev: true } }));
  for (const name of ['Page.html', 'Other.HTM', 'source.js', 'styles.css', 'data.json', 'movie.mp4', 'music.mp3', 'document.pdf']) await writeFile(join(root, name), 'fixture');
  await writeFile(join(root, 'picture.png'), PNG);
  const stateDir = join(home, 'state');
  await mkdir(join(stateDir, 'projects'), { recursive: true });
  await writeFile(join(stateDir, 'projects.json'), JSON.stringify({ App: { picture: 1 } }));
  await writeFile(join(stateDir, 'projects', 'App.png'), PNG);
  const projects = createProjects({ root, stateDir, every: 0, systemd: { running: async () => [] } });
  const files = createFiles({ thumbnailDir: join(home, 'cache'), pictureMakers: [] });
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      requests.push(url.pathname);
      const path = url.pathname.replace(/^\/peer\/desktop/, '');
      if (path === '/machines.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ machines: [] })); return; }
      if (await projects.handle(req, res, path)) return;
      if (await files(req, res, path, url.search)) return;
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><style>:root{--theme-bg:#201527;--theme-bar-bg:#201527;--theme-ink:#f8e8f2;--theme-muted:#b89faf;--theme-rule:#715367;--theme-accent:#ef9ccc;--paper:#201527;--ink:#f8e8f2;--muted:#b89faf;--pi-accent:#ef9ccc}body{margin:0;font-family:system-ui}#host{position:relative;height:100vh}</style><main id="host"></main>'); return;
      }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), publicRoot)));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 480 }, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    // A small synthetic media fixture, not a capture of anyone's files/page.
    const art = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#614270'; ctx.fillRect(0, 0, 240, 160);
      ctx.fillStyle = '#f6caaa'; ctx.beginPath(); ctx.arc(172, 40, 19, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#b387ac'; ctx.beginPath(); ctx.moveTo(0, 160); ctx.lineTo(90, 52); ctx.lineTo(180, 160); ctx.fill();
      ctx.fillStyle = '#e2abc9'; ctx.beginPath(); ctx.moveTo(95, 160); ctx.lineTo(178, 78); ctx.lineTo(240, 160); ctx.fill();
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    await writeFile(join(root, 'picture.png'), art);
    await writeFile(join(stateDir, 'projects', 'App.png'), art);
    await page.evaluate(async () => {
      const { mountWorkbench } = await import('/js/workbench-view.js');
      window.opened = [];
      window.workbench = mountWorkbench({ host: document.querySelector('#host'), onOpen: (path, base) => opened.push(['file', path, base]), onProject: (name, base) => opened.push(['project', name, base]) });
    });
    // Exact names, not label text: the list's Launch label is CSS, not a control.
    const row = name => page.locator('.workbench-item').filter({ has: page.getByText(name, { exact: true }) });
    for (const base of ['', '/peer/desktop']) {
      await page.evaluate(({ root, base }) => workbench.open(root, { base }), { root, base });
      await row('Page.html').waitFor();
      for (const view of ['list']) {
        assert.equal(await page.locator(`.workbench-${view}`).count(), 1);
        assert.equal(await page.locator('[data-view], .workbench-grid').count(), 0);
        for (const name of ['Page.html', 'Other.HTM', 'App', 'Unrun']) {
          const badge = row(name).locator('.workbench-launch');
          assert.equal(await badge.count(), 1, name);
          assert.ok(await badge.isVisible());
          const bounds = await badge.boundingBox();
          assert.ok(bounds.width >= 20 && bounds.height >= 20, `${view}: visible play at 24px`);
          assert.equal(await badge.locator('svg').isVisible(), true);
          if (view === 'list') assert.equal(await row(name).locator('.workbench-name').evaluate(el => getComputedStyle(el, '::after').content), '"Launch"');
        }
        for (const name of ['source.js', 'styles.css', 'data.json', 'Folder', 'Support', 'picture.png', 'movie.mp4', 'music.mp3', 'document.pdf']) assert.equal(await row(name).locator('.workbench-launch, .workbench-preview').count(), 0, name);
        for (const [name, kind] of [['picture.png', 'image'], ['movie.mp4', 'video'], ['music.mp3', 'audio'], ['document.pdf', 'pdf']]) assert.equal(await row(name).locator(`.workbench-icon-${kind}`).count(), 1);
        await row('Page.html').locator('.workbench-name').click();
        assert.equal(await row('Page.html').getAttribute('aria-selected'), 'true');
        // A finger's tap opens it too, in Workbench's tab; back is the folder.
        await page.waitForFunction(path => workbench.where().file === path, join(root, 'Page.html'));
        await page.evaluate(() => workbench.back());
        const before = await page.evaluate(() => opened.length);
        await row('App').locator('.workbench-preview').click({ modifiers: ['Control'] });
        assert.equal(await row('App').getAttribute('aria-selected'), 'true');
        assert.equal(await page.evaluate(() => opened.length), before);
        await row('App').locator('.workbench-preview').click();
        assert.deepEqual(await page.evaluate(() => opened.at(-1)), ['project', 'App', base]);
        // A finger is the pointer here: HTML plays in Workbench's own tab,
        // not in the browser beside it.
        const launched = await page.evaluate(() => opened.filter(([kind]) => kind === 'file').length);
        await row('Other.HTM').dblclick();
        await page.waitForFunction(path => workbench.where().file === path, join(root, 'Other.HTM'));
        await page.locator('.workbench-view-page').waitFor({ state: 'attached' });
        assert.equal(await page.evaluate(() => opened.filter(([kind]) => kind === 'file').length), launched);
        assert.equal(await page.evaluate(() => workbench.back()), true);
        await row('Other.HTM').waitFor();
        if (!base && view === 'grid' && process.env.WORKBENCH_MARKER_SCREENSHOTS) {
          await page.locator('.workbench-picture img').first().waitFor();
          await mkdir(process.env.WORKBENCH_MARKER_SCREENSHOTS, { recursive: true });
          await page.locator('.workbench').focus();
          await page.mouse.click(940, 440); // empty grid space clears fixture selection
          await page.screenshot({ path: join(process.env.WORKBENCH_MARKER_SCREENSHOTS, 'grid.png') });
        }
      }
    }
    // Holding the existing preview (including its badge) must still copy,
    // not launch on release, even on a phone-sized surface.
    await page.setViewportSize({ width: 390, height: 700 });
    await page.evaluate(root => workbench.open(root, { base: '/peer/desktop' }), root);
    await row('App').waitFor();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } });
    });
    await page.locator('.workbench').focus();
    await page.keyboard.press('Escape');
    const beforeHold = await page.evaluate(() => opened.length);
    const box = await row('App').locator('.workbench-preview').boundingBox();
    await page.mouse.move(box.x + 12, box.y + 12);
    await page.mouse.down();
    await page.waitForFunction(() => window.copied);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => copied), join(root, 'App'));
    assert.equal(await page.evaluate(() => opened.length), beforeHold);
    await row('Page.html').click();
    await page.waitForFunction(path => workbench.where().file === path, join(root, 'Page.html'));
    assert.equal(await page.evaluate(() => workbench.where().base), '/peer/desktop');
    assert.ok(!(await page.evaluate(() => opened.some(([kind]) => kind === 'file'))), 'on a phone HTML never leaves for the browser');
    assert.ok(requests.includes('/peer/desktop/projects.json'));
    assert.ok(requests.includes('/peer/desktop/projects/App/picture'));
    assert.deepEqual(errors, []);
    await assert.rejects(projects.start('Folder'), /no index.html or dev script/);
    await assert.rejects(projects.start('Support'), /no index.html or dev script/);
    assert.deepEqual((await projects.list()).projects.map(p => p.name), ['App', 'Unrun']);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    projects.close();
    await rm(home, { recursive: true, force: true });
  }
});
