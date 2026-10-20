import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { launchChromium } from '../../../../tools/test-browser.mjs';

for (const hasTouch of [true, false]) test(`hosted launcher reveals one live pane on the execution computer, with usable address control (${hasTouch ? 'phone' : 'desktop'})`, async () => {
  const root = new URL('../public/', import.meta.url);
  const server = createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<link rel="stylesheet" href="/css/gui-transcript.css"><style>.canvas-strip{position:relative;height:800px}.wm-window{position:absolute}</style><div class="canvas-strip"><section class="code-face"><div id="output"></div></section></div>'); return; }
    try { res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(new URL(req.url.slice(1), root))); } catch { res.statusCode = 404; res.end(); }
  });
  const wss = new WebSocketServer({ server });
  const commands = [], paths = [];
  wss.on('connection', (ws, req) => {
    paths.push(req.url);
    ws.on('message', raw => {
      const said = JSON.parse(raw); commands.push(said);
      if (said.do === 'watch' || said.do === 'launch') ws.send(JSON.stringify({ tabs: said.do === 'watch' ? [] : [{ tab: 1, front: true, url: 'about:blank' }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: hasTouch ? 390 : 1536, height: 844 }, hasTouch });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      const { mountPages } = await import('/js/pages.js');
      const { mountWindows } = await import('/js/windows.js');
      window.pages = mountPages({ output: document.querySelector('#output'), wm: mountWindows({ conversation: document.querySelector('.code-face') }), base: () => '/peer/pc' });
      pages.launch();
    });
    await page.waitForFunction(() => document.querySelector('.browser-tab'));
    await page.evaluate(() => { pages.launch(); pages.launch(); });
    assert.equal(await page.locator('.wm-live').count(), 1);
    assert.deepEqual(await page.locator('.canvas-strip > .wm-window').evaluateAll(els => els.sort((a, b) => a.style.order - b.style.order).map(el => el.classList.contains('wm-live') ? 'live' : 'conversation')), ['conversation', 'live'], 'the live browser opens in the next place on the right, desk and phone alike');
    assert.equal(await page.locator('iframe').count(), 0);
    await page.getByRole('textbox', { name: 'Address', exact: true }).fill('example.com');
    await page.getByRole('textbox', { name: 'Address', exact: true }).press('Enter');
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(paths, ['/peer/pc/browser/live']);
    assert.deepEqual(commands.find(s => s.do === 'navigate'), { do: 'navigate', url: 'https://example.com/', tab: 1 });
  } finally {
    await browser.close(); for (const ws of wss.clients) ws.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});
