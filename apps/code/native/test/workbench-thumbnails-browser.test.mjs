import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createFiles } from '../../../../system/files.mjs';

const publicRoot = new URL('../public/', import.meta.url);

test('raster thumbnails survive hidden attachment and peer navigation; failed pictures release the four-at-once queue', { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'workbench-thumbnails-'));
  const folder = join(home, 'pictures'), empty = join(home, 'empty');
  await mkdir(folder); await mkdir(empty);
  // Use the real makers, not pictureMakers: []: a raster goes through the
  // installed converter when available, and the original-image fallback otherwise.
  const files = createFiles({ thumbnailDir: join(home, '.cache') });
  const requests = [], pending = new Set();
  let hold = true, active = 0, maximum = 0;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      const path = url.pathname.replace(/^\/peer\/desktop/, '');
      if (path === '/machines.json') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ machines: [{ self: true, name: 'Laptop' }, { id: 'desktop', name: 'PC', reachable: true, capabilities: ['files'] }] })); return;
      }
      if (path === '/files/thumbnail') {
        requests.push({ base: url.pathname.startsWith('/peer/') ? '/peer/desktop' : '', path: url.searchParams.get('path'), version: url.searchParams.get('v') });
        active++; maximum = Math.max(maximum, active);
        let ended = false;
        const finished = () => { if (!ended) { ended = true; active--; } };
        // A completed response is no longer active even if its close event
        // trails the browser's decode error and next queued request.
        res.once('finish', finished); res.once('close', finished);
        if (hold) await new Promise(resolve => {
          const release = () => { pending.delete(release); resolve(); };
          pending.add(release); res.once('close', release);
        });
        if (res.destroyed) return;
      }
      if (await files(req, res, path, url.search)) return;
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><style>:root{--theme-bg:#201527;--theme-bar-bg:#201527;--theme-ink:#f8e8f2;--theme-muted:#b89faf;--theme-rule:#715367;--theme-accent:#ef9ccc}body{margin:0;font:14px system-ui}#host{position:relative;height:100vh}#host[hidden]{display:none}</style><main id="host" hidden></main>'); return;
      }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), publicRoot)));
    } catch { if (!res.destroyed) { res.statusCode = 404; res.end(); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  const release = () => { hold = false; for (const done of [...pending]) done(); };
  try {
    browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    page.setDefaultTimeout(5000);
    const network = await page.context().newCDPSession(page);
    await network.send('Network.enable');
    await network.send('Network.setCacheDisabled', { cacheDisabled: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    // A browser-encoded PNG with pixels we can actually decode, rather than
    // testing just an icon class or a possibly malformed one-pixel fixture.
    const png = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ef9ccc'; ctx.fillRect(0, 0, 96, 64);
      ctx.fillStyle = '#715367'; ctx.fillRect(0, 32, 48, 32);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    for (let n = 0; n < 8; n++) {
      const path = join(folder, `${n}.png`);
      await writeFile(path, n < 4 ? 'not a PNG' : png);
      await utimes(path, 100 - n, 100 - n); // failures occupy the first four slots
    }
    await page.evaluate(async folder => {
      const { mountWorkbench } = await import('/js/workbench-view.js');
      // Like harness.js: mount detached, then move the section into its window.
      const staging = document.createElement('div');
      window.workbench = mountWorkbench({ host: staging });
      document.querySelector('#host').append(staging.firstElementChild);
      await workbench.open(folder, { quiet: true });
    }, folder);
    assert.equal(await page.locator('.workbench-icon').count(), 8);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(requests.length, 0, 'no requests while the window is hidden');
    const revalidated = page.waitForResponse(response => response.url().includes('/files/list?') && response.status() === 200);
    await page.evaluate(() => { document.querySelector('#host').hidden = false; });
    await page.waitForFunction(() => document.querySelector('.workbench-icon')?.getBoundingClientRect().width > 0);
    // Observe the server queue, without relying on a short sleep or filesystem speed.
    // Poll a server-owned counter via Node, not a timing guess.
    const until = async predicate => {
      const end = Date.now() + 5000;
      while (!predicate()) { assert.ok(Date.now() < end, 'thumbnail queue settled'); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    await until(() => requests.length === 4);
    assert.equal(active, 4);
    assert.equal(await page.locator('.workbench-picture').count(), 0);
    release();
    await page.waitForFunction(() => document.querySelectorAll('.workbench-picture img').length === 4);
    assert.equal(requests.length, 8, 'decode errors free slots for the later valid PNGs');
    assert.equal(maximum, 4, 'only four requests at once');
    assert.equal(await page.locator('.workbench-icon-image:not(.workbench-picture) svg').count(), 4, 'errors keep their media fallback');
    assert.ok(await page.locator('.workbench-picture img').evaluateAll(images => images.every(img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0 && img.naturalWidth / img.naturalHeight === 1.5)));
    assert.equal(await page.locator('.workbench-list').count(), 1);
    assert.equal(await page.locator('[data-view], .workbench-grid').count(), 0);
    assert.ok(await page.locator('.workbench-picture img').evaluateAll(images => images.every(img => img.getBoundingClientRect().height === 24)));
    await revalidated;
    const changedPath = join(folder, '4.png');
    const beforeVersion = requests.find(request => request.path === changedPath).version;
    await page.evaluate(path => {
      window.pictureRow = [...document.querySelectorAll('.workbench-item')].find(row => row.dataset.path === path);
      window.pictureSource = pictureRow.querySelector('img').src;
    }, changedPath);
    const square = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 80;
      canvas.getContext('2d').fillRect(0, 0, 80, 80);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    await writeFile(changedPath, square);
    await page.waitForFunction(() => {
      const image = pictureRow.querySelector('img');
      return image?.src !== pictureSource && image?.complete && image.naturalWidth > 0 && image.naturalWidth === image.naturalHeight;
    });
    assert.equal(await page.evaluate(() => pictureRow.isConnected && pictureRow === document.querySelector(`[data-path="${pictureRow.dataset.path}"]`)), true,
      'modified picture fetches new pixels without replacing its row');
    assert.notEqual(requests.filter(request => request.path === changedPath).at(-1).version, beforeVersion,
      'live refresh changes the thumbnail cache revision');
    // Drop four held local requests, then load from another computer. Old
    // completions must not fill the new folder or leave its queue occupied.
    hold = true;
    await page.evaluate(folder => workbench.open(folder), folder);
    await until(() => active === 4);
    await page.evaluate(empty => workbench.open(empty), empty);
    assert.equal(await page.locator('.workbench-item').count(), 0);
    release();
    await page.evaluate(folder => workbench.open(folder, { base: '/peer/desktop' }), folder);
    await page.waitForFunction(() => document.querySelectorAll('.workbench-picture img').length === 4);
    assert.ok(requests.filter(r => r.base === '/peer/desktop').every(r => r.path.startsWith(folder + '/')));
    assert.equal(requests.filter(r => r.base === '/peer/desktop').length, 8);
    assert.deepEqual(errors, []);
  } finally {
    release();
    await browser?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
