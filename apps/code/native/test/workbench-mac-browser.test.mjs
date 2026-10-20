// Workbench in imperfect's window on a Mac (workbench-mac.js, through
// desktop/electron/preload.cjs): a file there opens in the app the Mac opens
// it with, or is shown in Finder, from its right-click menu and from the
// page of a file with no preview here; another computer's files, and any
// screen but a Mac's window, have none of it. And the window's side
// (desktop/electron/mac-files.mjs) answers only imperfect's own page, for a
// path that is there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { answerFiles, defaultApp } from '../../../../desktop/electron/mac-files.mjs';

const publicRoot = new URL('../public/', import.meta.url);

test('the window opens and reveals only for its own page, only what is there, and names the app once a kind', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'imperfect-mac-files-')));
  try {
    await writeFile(join(dir, 'a.pdf'), '%PDF');
    await writeFile(join(dir, 'b.PDF'), '%PDF');
    const handlers = new Map(), opened = [], revealed = [], asked = [];
    answerFiles(event => event.own, {
      open: async path => { opened.push(path); return ''; },
      reveal: path => { revealed.push(path); },
      opener: async path => { asked.push(path); return 'Preview'; },
      handle: (name, fn) => handlers.set(name, fn),
    });
    const own = { own: true }, website = { own: false };
    assert.equal(await handlers.get('mac-open')(own, join(dir, 'a.pdf')), '');
    assert.deepEqual(opened, [join(dir, 'a.pdf')]);
    assert.equal(await handlers.get('mac-open')(website, join(dir, 'a.pdf')), "It isn't on this Mac");
    assert.equal(await handlers.get('mac-open')(own, 'a.pdf'), "It isn't on this Mac", 'a path in full');
    assert.equal(await handlers.get('mac-open')(own, join(dir, 'gone.pdf')), "It isn't on this Mac");
    assert.equal(await handlers.get('mac-open')(own, { toString: () => dir }), "It isn't on this Mac");
    assert.equal(opened.length, 1);
    assert.equal(await handlers.get('mac-reveal')(own, dir), '');
    assert.deepEqual(revealed, [dir]);
    assert.equal(await handlers.get('mac-reveal')(website, dir), "It isn't on this Mac");
    assert.equal(await handlers.get('mac-opener')(own, join(dir, 'a.pdf')), 'Preview');
    assert.equal(await handlers.get('mac-opener')(own, join(dir, 'b.PDF')), 'Preview');
    assert.equal(await handlers.get('mac-opener')(website, join(dir, 'a.pdf')), '');
    assert.deepEqual(asked, [join(dir, 'a.pdf')], 'asked once for a kind of file');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the app a file opens in is named as the Mac names it, and none when it has none', async () => {
  const runs = [];
  const run = answer => (file, args, options, done) => { runs.push([file, args]); queueMicrotask(() => done(...answer)); };
  assert.equal(await defaultApp('/Users/n/a.pdf', run([null, '/System/Applications/Preview.app\n'])), 'Preview');
  assert.equal(await defaultApp('/Users/n/x.zz', run([null, '\n'])), '');
  assert.equal(await defaultApp('/Users/n/x.zz', run([new Error('no')])), '');
  assert.equal(runs[0][0], '/usr/bin/osascript');
  assert.deepEqual([runs[0][1][0], runs[0][1][1], runs[0][1].at(-1)], ['-l', 'JavaScript', '/Users/n/a.pdf'], 'the path an argument, never in the script');
});

async function withWorkbench(desk, run) {
  const { launchChromium } = await import('../../../../tools/test-browser.mjs');
  const { createFiles } = await import('../../../../system/files.mjs');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'imperfect-mac-browser-')));
  const docs = join(dir, 'docs');
  await mkdir(docs);
  await writeFile(join(docs, 'blob.bin'), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(docs, 'notes.txt'), 'notes');
  const files = createFiles({ thumbnailDir: join(dir, '.cache'), pictureMakers: [] });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      const path = url.pathname.startsWith('/peer/desktop/') ? url.pathname.slice('/peer/desktop'.length) : url.pathname;
      if (path === '/machines.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ machines: [{ id: 'mac', name: 'MacBook', self: true, reachable: true, capabilities: ['files'] }, { id: 'desktop', name: 'PC', reachable: true, capabilities: ['files'] }] })); }
      if (await files(req, res, path, url.search)) return;
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><style>:root{--paper:#000;--ink:#e8e8e8;--muted:#8a8a8a}body{margin:0;background:var(--paper);color:var(--ink);font:14px sans-serif}#host{position:relative;height:100dvh}</style><main id="host"></main>'); }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), publicRoot)));
    } catch { if (!res.headersSent) { res.statusCode = 404; res.end(); } }
  });
  let browser;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async mac => {
      localStorage.clear();
      window.asked = [];
      // As preload.cjs hands it on a Mac (mac-files.mjs answers).
      window.imperfectDesk = mac ? {
        mac: true,
        macOpen: async path => { asked.push(['open', path]); return path.endsWith('.txt') ? 'no app opens it' : ''; },
        macReveal: async path => { asked.push(['reveal', path]); return ''; },
        macOpener: async path => (path.endsWith('.bin') ? 'Hex Fiend' : ''),
      } : {};
      const { mountWorkbench } = await import('/js/workbench-view.js');
      window.workbench = mountWorkbench({ host: document.querySelector('#host') });
    }, desk);
    const item = name => page.getByRole('option').filter({ has: page.locator('.workbench-name', { hasText: name }) });
    await run({ page, docs, item });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test('on a Mac, a file\'s right-click menu opens it in its app or shows it in Finder', { timeout: 120000 }, () => withWorkbench(true, async ({ page, docs, item }) => {
  await page.evaluate(path => workbench.open(path), docs);
  await item('blob.bin').click({ button: 'right' });
  const menu = page.locator('.workbench-menu');
  await menu.getByRole('menuitem', { name: 'Open with Hex Fiend' }).waitFor();
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Open with Hex Fiend', 'Show in Finder', 'Copy Path', 'Move to Trash']);
  assert.equal(await item('blob.bin').getAttribute('aria-selected'), 'true', 'what was clicked is what the menu is for');
  await menu.getByRole('menuitem', { name: 'Open with Hex Fiend' }).click();
  await page.waitForFunction(() => asked.length === 1);
  assert.deepEqual(await page.evaluate(() => asked), [['open', join(docs, 'blob.bin')]]);
  assert.equal(await menu.count(), 0, 'the menu goes once it is used');

  // A file no app is named for: Open; one that could not be opened says why.
  await item('notes.txt').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Show in Finder' }).click();
  await item('notes.txt').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Open', exact: true }).click();
  await page.waitForFunction(() => asked.length === 3);
  assert.deepEqual((await page.evaluate(() => asked)).slice(1).map(([what, path]) => [what, path.split('/').at(-1)]), [['reveal', 'notes.txt'], ['open', 'notes.txt']]);
  await page.locator('.workbench-status', { hasText: "Couldn't open it: no app opens it" }).waitFor();

  // A file with no preview here: its page offers both.
  await item('blob.bin').dblclick();
  await page.locator('.workbench-view-actions button', { hasText: 'Open with Hex Fiend' }).waitFor();
  await page.locator('.workbench-view-actions button', { hasText: 'Show in Finder' }).click();
  await page.waitForFunction(() => asked.length === 4);
  assert.deepEqual((await page.evaluate(() => asked.at(-1)))[0], 'reveal');

  // Another computer's files open there, not on this Mac.
  await page.evaluate(path => workbench.open(path, { base: '/peer/desktop' }), docs);
  await item('blob.bin').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Copy Path' }).waitFor();
  assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['Copy Path', 'Move to Trash']);
}));

test('anywhere but a Mac\'s window, right-click is the browser\'s and a file with no preview offers nothing more', { timeout: 120000 }, () => withWorkbench(false, async ({ page, docs, item }) => {
  await page.evaluate(path => workbench.open(path), docs);
  await item('blob.bin').click({ button: 'right' });
  assert.equal(await page.locator('.workbench-menu').count(), 0);
  await item('blob.bin').dblclick();
  await page.locator('.workbench-view-message', { hasText: 'No preview for this file' }).waitFor();
  assert.equal(await page.locator('.workbench-view-actions').count(), 0);
}));
