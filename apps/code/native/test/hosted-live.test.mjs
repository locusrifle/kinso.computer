// A hosted computer's page on a laptop (the demo's, at its website): no
// window of imperfect's is on that screen, so an agent browsing brings up the
// computer's browser, live, as on a phone (system/server.mjs tells the page;
// pages.js, live.js), tiled like any window; a click is a click on the
// page, the wheel scrolls it, and typing goes to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { launchChromium } from '../../../../tools/test-browser.mjs';

test('a hosted computer\'s page at a laptop\'s size shows the agent\'s browser live, tiled like any window, and a click, the wheel and typing reach the page', async t => {
  const root = new URL('../public/', import.meta.url);
  const html = (await readFile(new URL('index.html', root), 'utf8')).replace(/<script[^>]*src="\/js\/site.js"[^>]*><\/script>/, '');
  const clients = [], lives = [];
  const snapshot = { agent: 'pi', sessionId: 's', cwd: '/fixture', model: { provider: 'fixture', id: 'm' }, messages: [], stats: {}, ui: {}, tabs: [{ id: 't', sessionId: 's', focused: true, agent: 'pi', name: 's' }] };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    try {
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
      if (path.endsWith('.json')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ machines: [{ id: 'box', name: 'box', self: true, reachable: true }] }));
        return;
      }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), root)));
    } catch { res.statusCode = 404; res.end(); }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    if (req.url === '/browser/live') {
      const live = { ws, heard: [], send: said => ws.send(JSON.stringify(said)) };
      ws.on('message', raw => live.heard.push(JSON.parse(raw)));
      lives.push(live);
      return;
    }
    clients.push(ws);
    ws.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
    ws.on('message', raw => {
      const c = JSON.parse(raw);
      ws.send(JSON.stringify({ type: 'response', id: c.id, success: true, data: c.type === 'snapshot' ? snapshot : {} }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await launchChromium({ args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); wss.close(); await new Promise(resolve => server.close(resolve)); });
  const until = async (check, what, ms = 3000) => {
    for (const end = Date.now() + ms; !check(); await new Promise(resolve => setTimeout(resolve, 20))) if (Date.now() > end) throw new Error(`${what} did not happen`);
  };

  // A plain web page, no desktop window or phone app round it.
  const page = await browser.newPage({ viewport: { width: 1536, height: 864 } });
  // This regression exercises the scrolling layout's offscreen-column watch
  // and full-width composer, not the focus layout now used by default.
  await page.addInitScript(() => localStorage.setItem('imperfect.layout-choice.v2', 'scrolling'));
  await page.goto(`http://127.0.0.1:${server.address().port}/?face=code`);
  await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi(); });
  await until(() => clients.length > 0, 'connecting');
  await page.waitForTimeout(300);

  // Agent presentation does not choose the person's pane or viewport: the
  // live column opens in the next place on the right; the conversation stays
  // where it was.
  const conversation = () => page.locator('.entry-screen').boundingBox();
  const seen = await conversation();
  for (const ws of clients) ws.send(JSON.stringify({ type: 'browse', front: true, machine: 'box' }));
  await page.locator('.wm-live .browser-live').waitFor();
  await page.waitForTimeout(500);
  assert.deepEqual(await conversation(), seen);
  assert.equal(lives.length, 0, 'offscreen browser is not watched');
  // The visitor explicitly selects the column before looking/controlling it.
  await page.keyboard.press('Alt+ArrowRight');
  await until(() => lives.length === 1 && lives[0].heard.length, 'watching');
  const live = lives[0];
  assert.equal(live.heard[0].do, 'watch');
  // A readable, full-height column in the scrolled middle.
  await page.waitForTimeout(800);
  const view = await page.locator('.wm-live').boundingBox();
  const middle = await page.locator('#canvas-strip').boundingBox();
  assert.ok(view.width > 600 && view.height > 350 && view.y + view.height <= middle.y + middle.height + 2, JSON.stringify(view));
  const composer = await page.locator('#entry-input-zone').boundingBox();
  assert.equal(composer.width, 1536, 'the shared session composer extends beneath the hosted live view');

  const frame = (await page.screenshot({ type: 'jpeg', clip: { x: 0, y: 0, width: 128, height: 80 } })).toString('base64');
  live.send({ tabs: [{ tab: 5, title: 'Example Domain', url: 'https://example.com/', front: true }] });
  live.send({ frame, tab: 5, width: 1280, height: 800 });
  await page.waitForFunction(() => document.querySelector('.browser-live-frame')?.getAttribute('src')?.startsWith('data:image/jpeg'));
  assert.deepEqual(await page.locator('.wm-live .browser-tab-title').allTextContents(), ['Example Domain']);
  assert.equal(await page.locator('.wm-live .browser-tab[role="tab"]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.wm-live .browser-controls .gui-window-go').count(), 4);
  await page.locator('.wm-live .browser-tab').focus();
  live.send({ tabs: [
    { tab: 5, title: 'Example Domain', url: 'https://example.com/', front: true, loading: true },
    { tab: 6, title: 'Background', url: 'https://example.org/', front: false, driving: true, favicon: 'https://example.org/icon.png' },
  ] });
  await page.locator('.wm-live .browser-tab.loading').waitFor();
  assert.equal(await page.locator('.wm-live .browser-tab[data-tab="5"]').evaluate(el => el === document.activeElement), true, 'metadata does not replace the focused tab');
  assert.equal(await page.locator('.wm-live .browser-tab[data-tab="6"]').getAttribute('aria-label'), 'Background, agent is using this tab, updated');
  assert.equal(await page.locator('.wm-live .browser-tab[data-tab="6"]').evaluate(el => el.classList.contains('unread')), true);
  await page.locator('.wm-live .browser-tab-close').nth(1).click();
  await until(() => live.heard.some(said => said.do === 'close'), 'closing the background tab');
  assert.deepEqual(live.heard.find(said => said.do === 'close'), { do: 'close', tab: 6 });
  await page.locator('.wm-live .browser-new').click();
  await until(() => live.heard.some(said => said.do === 'new'), 'creating a new tab');
  assert.deepEqual(live.heard.find(said => said.do === 'new'), { do: 'new' });
  await page.locator('.wm-live .browser-tab[data-tab="6"]').click();
  await until(() => live.heard.some(said => said.do === 'front'), 'selecting the background tab');
  assert.deepEqual(live.heard.find(said => said.do === 'front'), { do: 'front', tab: 6 });

  // A click in the middle of the picture is a click in the middle of the page.
  const box = await page.locator('.wm-live .browser-live-frame').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until(() => live.heard.some(said => said.do === 'tap'), 'the click');
  assert.deepEqual(live.heard.find(said => said.do === 'tap'), { do: 'tap', x: 640, y: 400, tab: 5, gesture: 1 });
  // The wheel scrolls it, down for down, in the page's pixels.
  await page.mouse.wheel(0, 120);
  await until(() => live.heard.some(said => said.do === 'scroll'), 'the wheel');
  const scroll = live.heard.find(said => said.do === 'scroll');
  assert.equal(scroll.tab, 5);
  assert.ok(scroll.dy >= 120, JSON.stringify(scroll));
  // Only a matching human tap reply opens the hidden native bridge.
  assert.equal(await page.locator('.browser-live-type').count(), 0);
  live.send({ field: { editable: true, kind: 'text', token: 'visitor', mirror: true, value: '', start: 0, end: 0 }, gesture: 1 });
  await page.waitForFunction(() => document.activeElement.matches('.browser-live-keyboard'));
  await page.keyboard.insertText('hello from the visitor');
  await page.keyboard.press('Enter');
  await until(() => live.heard.some(said => said.do === 'edit' && said.key === 'Enter'), 'typing');
  assert.deepEqual(live.heard.find(said => said.do === 'edit' && said.text), { do: 'edit', field: 'visitor', start: 0, end: 0, text: 'hello from the visitor', tab: 5 });
});
