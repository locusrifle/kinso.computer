// Where the person is, from the window's side (harness.js): a window says it
// was used to every computer it is connected to, its own and the others'
// through /peer/, only on real use and at most every few seconds; on the
// phone, an agent browsing prepares that computer's browser behind the
// conversation; the person swipes to watch it live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { launchChromium } from '../../../../tools/test-browser.mjs';

test('a window says where the person is when they use it, and on the phone the person swipes to watch an agent\'s computer browser live', async t => {
  const root = new URL('../public/', import.meta.url);
  const html = (await readFile(new URL('index.html', root), 'utf8')).replace(/<script[^>]*src="\/js\/site.js"[^>]*><\/script>/, '');
  const calls = [], clients = [], lives = [];
  const snapshot = { agent: 'pi', sessionId: 's', cwd: '/fixture', model: { provider: 'fixture', id: 'm' }, messages: [], stats: {}, ui: {}, tabs: [{ id: 't', sessionId: 's', focused: true, agent: 'pi', name: 's' }] };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    try {
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
      if (path.endsWith('.json')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ machines: [{ id: 'laptop', name: 'laptop', self: true, reachable: true }, { id: 'pc', name: 'pc', reachable: true, home: true }] }));
        return;
      }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), root)));
    } catch { res.statusCode = 404; res.end(); }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const live = /^(?:\/peer\/([^/]+))?\/browser\/live$/.exec(req.url);
    if (live) { lives.push(live[1] || 'laptop'); return; }
    const owner = /^\/peer\/([^/]+)\/pi$/.exec(req.url)?.[1] || 'laptop';
    clients.push({ owner, ws });
    ws.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
    ws.on('message', raw => {
      const c = JSON.parse(raw); calls.push({ owner, ...c });
      ws.send(JSON.stringify({ type: 'response', id: c.id, success: true, data: c.type === 'snapshot' ? snapshot : {} }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await launchChromium({ args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); wss.close(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/?face=code`;
  const open = async (bridge, device = { viewport: { width: 1200, height: 900 } }) => {
    const page = await browser.newPage(device);
    await page.addInitScript(bridge);
    await page.goto(url);
    await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi(); });
    return page;
  };
  const told = () => calls.filter(c => c.type === 'here');
  const toldTo = () => [...new Set(told().map(c => c.owner))].sort();
  const connected = () => until(() => calls.filter(c => c.type === 'hello').length === 2);
  const until = async (check, ms = 3000) => {
    for (const end = Date.now() + ms; !check(); await new Promise(resolve => setTimeout(resolve, 20))) if (Date.now() > end) return false;
    return true;
  };

  // The desktop window on the laptop, connected to the laptop and, through
  // /peer/, to the PC. Being connected is not being used.
  const desk = await open(() => { window.imperfectDesk = { onKey() {}, onBrowse() {}, onTab() {}, front() {} }; });
  assert.ok(await connected());
  await desk.waitForTimeout(300);
  assert.deepEqual(told(), []);
  await desk.keyboard.press('Shift');
  assert.ok(await until(() => told().length >= 2), 'told to both computers');
  assert.deepEqual(told().map(({ owner, machine, kind }) => [owner, machine, kind]).sort(), [['laptop', 'laptop', 'desktop'], ['pc', 'laptop', 'desktop']]);
  assert.ok(told().every(c => c.ago >= 0 && c.ago < 1000));
  // Used again at once: said once more, a few seconds on, with how long ago.
  await desk.mouse.click(600, 450);
  await desk.waitForTimeout(1000);
  assert.equal(told().length, 2, 'not every key and click');
  assert.ok(await until(() => told().length === 4, 6000), 'and then once more');
  assert.ok(told().slice(2).every(c => c.ago >= 1000 && c.ago < 6000), told().map(c => c.ago).join());
  // A website opened for an agent is the desktop window's own: nothing here.
  for (const { ws } of clients) ws.send(JSON.stringify({ type: 'browse', front: true }));
  await desk.waitForTimeout(300);
  assert.equal(new URL(desk.url()).hostname, '127.0.0.1');
  assert.equal(await desk.locator(".wm-live").count(), 0);
  await desk.close();

  // The phone app: even a front request from an agent on the PC leaves the
  // conversation in sight. The person swipes to the live browser, watched
  // through /peer/; the page never leaves for a browser of the phone's.
  calls.length = 0; clients.length = 0;
  const phone = await open(() => { window.imperfectNative = { tick() {} }; }, { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  assert.ok(await connected());
  await phone.keyboard.press('Shift');
  assert.ok(await until(() => toldTo().length === 2));
  assert.ok(told().every(c => c.kind === 'phone'));
  clients.find(c => c.owner === 'pc').ws.send(JSON.stringify({ type: 'browse', front: true }));
  await phone.locator('.wm-live .browser-live').waitFor();
  const panel = () => phone.evaluate(() => {
    const strip = document.querySelector('.canvas-strip');
    return Math.round(strip.scrollLeft / strip.clientWidth);
  });
  await phone.waitForTimeout(300);
  assert.equal(await panel(), 0, 'an agent front request leaves the conversation in sight');
  assert.deepEqual(lives, [], 'out of sight, no computer browser is watched');
  const cdp = await phone.context().newCDPSession(phone);
  // Real horizontal touch navigation, through Files and then the live panel.
  for (let step = 0; step < 2; step++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 330, y: 400 }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 330 - 280 * i / 8, y: 400 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await phone.waitForTimeout(700);
  }
  assert.equal(await panel(), 2, 'the person revealed the live browser');
  assert.ok(await until(() => lives.includes('pc')), 'the PC\'s browser watched');
  assert.deepEqual([...new Set(lives)], ['pc'], 'only the agent\'s PC is watched, through /peer/');
  assert.equal(new URL(phone.url()).hostname, '127.0.0.1');
});
