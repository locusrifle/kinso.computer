import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFiles } from '../../../../system/files.mjs';
import { createShown } from '../../../../system/shown.mjs';
import { WebSocketServer } from 'ws';
import { launchChromium } from '../../../../tools/test-browser.mjs';

// Native touch scroll/snap and the window manager's 120ms scroll debounce
// must both finish. Sample stable geometry, not a presumed 700ms frame budget.
const settlePhone = page => page.evaluate(() => new Promise((resolve, reject) => {
  const end = performance.now() + 60000;
  let last, since = performance.now(), frames = 0;
  const sample = () => {
    const strip = document.querySelector('.canvas-strip');
    const current = JSON.stringify([strip.scrollLeft, history.state,
      [...strip.children, document.querySelector('#session-rail'), document.querySelector('#entry-input-zone')].filter(Boolean).map(n => {
        const r = n.getBoundingClientRect(); return [n.className, r.x, r.y, r.width, r.height];
      })]);
    const at = Math.round(strip.scrollLeft / strip.clientWidth);
    const snapped = Math.abs(strip.scrollLeft - at * strip.clientWidth) < 1;
    const historyReady = document.querySelector('.wm-full') ? history.state?.full : at === 0 ? history.state === null : history.state?.window;
    const moving = strip.classList.contains('wm-moving') || !snapped || !historyReady ||
      document.getAnimations().some(a => Number.isFinite(a.effect?.getComputedTiming().endTime) && a.playState !== 'finished');
    if (current !== last || moving) { last = current; since = performance.now(); frames = 0; }
    else frames++;
    if (frames >= 5 && performance.now() - since >= 150) resolve();
    else if (performance.now() > end) reject(new Error('phone geometry did not settle: ' + current));
    else requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}));

// Loads the complete production harness and its imports. Only HTTP/WS backend data is fake.
// Ephemeral loopback server; no running service, credentials, runtime or agent is touched.
// Real temporary Files and sandboxed shown-page backends serve local creations
// (pages: { name: html }); only the agent transport is fake. A
// computer's browser, watched live at /browser/live (through /peer/<id>/ for
// another), is the test's: lives holds each connection and what it heard.
async function onAPhone(run, { pages = {} } = {}) {
  const root = new URL('../public/', import.meta.url);
  const index = (await readFile(new URL('index.html', root), 'utf8')).replace(/<script[^>]*src="\/js\/site.js"[^>]*><\/script>/, '');
  const dir = await mkdtemp(join(tmpdir(), 'phone-swipe-'));
  for (const [name, html] of Object.entries(pages)) await writeFile(join(dir, name), html);
  const files = createFiles({ thumbnailDir: join(dir, '.cache'), pictureMakers: [] });
  const shownKey = Symbol.for('imperfect.shown'), previousShown = globalThis[shownKey];
  const shown = createShown({ stateDir: join(dir, '.shown'), servers: () => ({ list: () => [] }) });
  await shown.listen(0);
  const calls = [], prompts = [];
  let socket;
  let snap = { agent: 'pi', sessionId: 'thread-a', cwd: '/fixture', messages: Array.from({length:60}, (_, i) => ({role:'user', content:`message ${i}`})),
    model: {provider:'fixture',id:'fixture'}, queue:{items:[{id:'image-q',lane:'steering',text:'image draft',images:[{type:'image',mimeType:'image/png',data:'aW1hZ2U='}]}]},
    stats:{}, ui:{}, tabs:[{id:'tab-a',sessionId:'thread-a',focused:true,agent:'pi',name:'A'}] };
  const send = data => socket.send(JSON.stringify(data));
  const snapshot = () => send({type:'snapshot',data:snap});
  const reply = (c, data, error) => send({type:'response',id:c.id,success:!error,data,error});
  const server = createServer(async (req,res) => {
    try {
      const path = new URL(req.url, 'http://fixture').pathname;
      if (path === '/') { res.setHeader('Content-Type','text/html'); res.end(index + '<style>#entry-output[hidden]{display:none}</style>'); return; }
      if (await shown.handle(req, res, path)) return;
      if (await files(req, res, path, new URL(req.url, 'http://fixture').search)) return;
      if (path.endsWith('.json')) { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({machines:[]})); return; }
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(await readFile(new URL(path.slice(1), root)));
    } catch { res.statusCode=404; res.end(); }
  });
  const wss = new WebSocketServer({server});
  const lives = [];
  wss.on('connection', (ws, req) => {
    const watched = /^(?:\/peer\/([^/]+))?\/browser\/live$/.exec(req.url);
    if (watched) {
      const live = { ws, computer: watched[1] ?? '', heard: [], open: true, send: said => ws.send(JSON.stringify(said)) };
      ws.on('message', raw => live.heard.push(JSON.parse(raw)));
      ws.on('close', () => { live.open = false; });
      lives.push(live);
      return;
    }
    socket=ws; snapshot(); ws.on('message', raw => {
    const c=JSON.parse(raw); calls.push(c);
    if(c.type==='prompt') { prompts.push(c); reply(c, {accepted:true}); }
    else if(c.type==='queue-take') { reply(c,{item:snap.queue.items[0]}); snap={...snap,queue:{items:[]}}; snapshot(); }
    else if(c.type==='snapshot') reply(c,snap);
    else reply(c, {});
  }); });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await launchChromium({headless:true,args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:390,height:800},hasTouch:true,isMobile:true});
    for (const [name, html] of Object.entries(pages)) await page.route(`https://games.example.test/${name}`, route => route.fulfill({ contentType: 'text/html', body: html }));
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const mount = async()=>{
      const {mountGueyPi}=await import('/js/harness.js');
      window.harness=mountGueyPi({hooks:{canFocus:()=>true}});
      window.composer=document.getElementById('entry-input');
    };
    await page.evaluate(mount);
    await page.waitForFunction(()=>harness.guiSnapshot().sessionId==='thread-a');
    const cdp = await page.context().newCDPSession(page);
    // A finger drawn sideways across the screen, as the phone sends it.
    const swipe = async (from, to, y = 400) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] });
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + (to - from) * i / 8, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settlePhone(page);
    };
    // A finger drawn up or down.
    const drag = async (x, from, to) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + (to - from) * i / 8 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settlePhone(page);
    };
    // And a finger put down and lifted where it was.
    const tap = async (x, y) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settlePhone(page);
    };
    // The strip the finger swipes along: the canvas in view's windows.
    const strip = () => page.evaluate(() => { const s = document.querySelector('.canvas-strip'); return { phone: s.classList.contains('wm-phone'), at: Math.round(s.scrollLeft / s.clientWidth), windows: [...s.children].filter(w => !w.classList.contains('wm-away')).map(w => w.className.match(/entry-screen|wm-files|wm-browser|wm-live/)?.[0]) }; });
    // Where the input bar and its status line are: on a phone they never
    // move, whatever the panel above them shows.
    const bars = () => page.evaluate(() => ['#entry-input-zone', '.entry-status'].map(q => { const b = document.querySelector(q).getBoundingClientRect(); return [q, Math.round(b.top), Math.round(b.height)]; }));
    // The agents' strip: in sight over the conversation, gone upwards with
    // any other window in view.
    const rail = () => page.evaluate(() => { const r = document.querySelector('#session-rail'), b = r.getBoundingClientRect(); return { top: Math.round(b.top), height: Math.round(b.height), shown: getComputedStyle(r).visibility !== 'hidden' && b.bottom > 0 }; });
    const box = selector => page.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); });
    // What an agent says, as the conversation's next messages.
    const say = (...messages) => { snap = { ...snap, messages: [...snap.messages, ...messages] }; snapshot(); };
    const shownAt = name => join(dir, name);
    // Another session in view, as the tabs say (a new one, the first time).
    const view = sessionId => {
      const tabs = snap.tabs.some(tab => tab.sessionId === sessionId) ? snap.tabs : [...snap.tabs, { id: `tab-${sessionId}`, sessionId, agent: 'pi', name: sessionId }];
      snap = { ...snap, sessionId, tabs: tabs.map(tab => ({ ...tab, focused: tab.sessionId === sessionId })) };
      snapshot();
    };
    // A session closed: its tab gone.
    const drop = sessionId => { snap = { ...snap, tabs: snap.tabs.filter(tab => tab.sessionId !== sessionId) }; snapshot(); };
    // A picture of a page the size of a window, as the computer sends it.
    const picture = () => page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1280; c.height = 800; const g = c.getContext('2d'); g.fillStyle = '#9ad8ff'; g.fillRect(0, 0, 1280, 800); return c.toDataURL('image/jpeg').split(',')[1]; });
    await run({ page, swipe, drag, tap, strip, bars, rail, box, say, send, view, drop, prompts, calls, shownAt, lives, picture });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const ws of wss.clients) ws.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await shown.close();
    globalThis[shownKey] = previousShown;
    await rm(dir, { recursive: true, force: true });
  }
}

test('phone: the input bar stays put, the windows are the panel above it, and the agents\' strip is the conversation\'s: Workbench always to the right of the conversation, a finger swipes between them and the strip leaves with the conversation, back closes the browser\'s tabs and shows the conversation, and the browser names its tabs', () => onAPhone(async ({ page, swipe, tap, strip, bars, rail, box }) => {
  await settlePhone(page); // the window opening as it does on the desktop
  const before = await bars();
  // Workbench is there from the start, to the right of the conversation in view.
  assert.deepEqual(await strip(), { phone: true, at: 0, windows: ['entry-screen', 'wm-files'] });
  assert.equal(await page.evaluate(() => history.state), null, 'with the conversation in view, back leaves the app');
  // The panel above the input bar, from the top; the agents' strip lies over
  // the conversation's own, which starts under it.
  const inputTop = Math.min(...before.map(([, top]) => top));
  const panel = await box('.canvas-strip');
  assert.deepEqual(panel, [0, 0, 390, inputTop]);
  assert.deepEqual(await rail(), { top: 0, height: 52, shown: true });
  // Each session its agent's mark, as the Mac's sidebar has it.
  assert.equal(await page.locator('#session-rail .session-rail-item .session-rail-logo').count(), 1);
  assert.equal(await page.locator('.session-rail-number').count(), 0);
  assert.equal(await page.locator('.wm-phone > .entry-screen').evaluate(n => getComputedStyle(n).paddingTop), '52px');
  // Half way along, the agents' strip is half gone: it leaves with the conversation.
  const half = await page.locator('.canvas-strip').evaluate(async s => {
    s.style.scrollSnapType = 'none';
    s.scrollLeft = s.clientWidth / 2;
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const top = Math.round(document.querySelector('#session-rail').getBoundingClientRect().top);
    s.scrollLeft = 0;
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    s.style.scrollSnapType = '';
    return top;
  });
  assert.ok(half <= -25 && half >= -27, `half gone: ${half}`);
  await settlePhone(page);
  assert.deepEqual(await rail(), { top: 0, height: 52, shown: true });
  // Swiping right to left shows Workbench, the whole panel, its own tabs and
  // path at the top where the agents' strip was; back again, the
  // conversation and its strip; the input bar never moves.
  await swipe(330, 50);
  assert.equal((await strip()).at, 1);
  assert.deepEqual(await box('.wm-files'), panel, 'the whole panel');
  assert.deepEqual(await rail(), { top: -52, height: 52, shown: false }, 'the agents\' strip gone with the conversation');
  assert.deepEqual(await box('.wm-files .workbench-bar'), [0, 0, 390, 52], 'Files has one header row matching the strip');
  assert.equal(await page.locator('.wm-files .workbench-view-count').isVisible(), false, 'views are the sidebar\'s, not the bar\'s');
  assert.equal(await page.locator('.wm-files .workbench-tabs').count(), 0);
  assert.deepEqual(await bars(), before, 'the input bar where it was');
  assert.equal(await page.locator('#entry-input').isVisible(), true, 'to type with Workbench in sight');
  assert.deepEqual(await page.evaluate(() => history.state), { window: true });
  await swipe(60, 340);
  assert.equal((await strip()).at, 0);
  assert.deepEqual(await bars(), before);
  assert.deepEqual(await rail(), { top: 0, height: 52, shown: true }, 'and back with the conversation');
  assert.equal(await page.evaluate(() => history.state), null);
  // From Files's computer root, back shows the conversation; Files stays.
  await swipe(330, 50);
  await page.getByRole('button', { name: 'This computer filesystem root', exact: true }).click();
  await page.getByRole('button', { name: 'Choose a computer', exact: true }).click();
  await page.goBack();
  await settlePhone(page);
  assert.deepEqual(await strip(), { phone: true, at: 0, windows: ['entry-screen', 'wm-files'] });
  assert.equal(await page.evaluate(() => history.state), null);
  // Showing Files brings it into view.
  await page.evaluate(() => harness.showFiles());
  await settlePhone(page);
  assert.equal((await strip()).at, 1);
  // A link opens the browser to the right of Workbench, never between it and
  // the conversation: one panel, the page filling it under its bar, which
  // names every tab.
  await swipe(60, 340);
  await page.locator('#entry-output').evaluate(output => {
    for (const [id, port] of [['a-page', 5173], ['b-page', 5174]]) { const a = document.createElement('a'); a.dataset.page = `https://desktop.tail.ts.net:8443/port/${port}/`; a.href = '#'; a.textContent = id; a.id = id; output.prepend(a); }
  });
  await page.locator('#a-page').evaluate(a => a.click());
  await settlePhone(page);
  assert.deepEqual(await strip(), { phone: true, at: 2, windows: ['entry-screen', 'wm-files', 'wm-browser'] });
  assert.deepEqual(await box('.wm-browser'), panel, 'the whole panel');
  assert.equal(await page.locator('.wm-browser .browser-count').count(), 0, 'no old hover count');
  assert.equal(await page.locator('.wm-browser .browser-tab').count(), 1, 'one visible tab on a phone too');
  assert.equal(await page.locator('.wm-browser iframe').getAttribute('src'), 'https://desktop.tail.ts.net:8443/port/5173/');
  // Another opens in the same panel, in front, and has a tab of its own.
  await swipe(60, 340);
  await page.locator('#b-page').evaluate(a => a.click());
  await settlePhone(page);
  assert.deepEqual(await strip(), { phone: true, at: 2, windows: ['entry-screen', 'wm-files', 'wm-browser'] });
  const tabs = () => page.locator('.wm-browser .browser-tab').evaluateAll(tabs => tabs.map(t => `${t.querySelector('.browser-tab-title').textContent}${t.classList.contains('front') ? ' *' : ''}`));
  const fronts = () => page.locator('.wm-browser .browser-page').evaluateAll(pages => pages.map(p => [p.querySelector('iframe').getAttribute('src'), p.classList.contains('front')]));
  assert.deepEqual(await tabs(), [':5173', ':5174 *']);
  assert.deepEqual(await fronts(), [['https://desktop.tail.ts.net:8443/port/5173/', false], ['https://desktop.tail.ts.net:8443/port/5174/', true]]);
  // A tap on a tab brings it to the front.
  const first = await page.locator('.wm-browser .browser-tab').first().boundingBox();
  await tap(first.x + first.width / 2, first.y + first.height / 2);
  assert.deepEqual(await tabs(), [':5173 *', ':5174']);
  assert.deepEqual(await fronts(), [['https://desktop.tail.ts.net:8443/port/5173/', true], ['https://desktop.tail.ts.net:8443/port/5174/', false]]);
  assert.equal((await strip()).at, 2, 'and the strip stays');
  // The phone's back gesture closes what is in view: the page in front,
  // then the browser with the last one, Workbench coming into view; then
  // the conversation, Workbench staying.
  await page.goBack();
  await settlePhone(page);
  assert.deepEqual(await strip(), { phone: true, at: 2, windows: ['entry-screen', 'wm-files', 'wm-browser'] });
  assert.deepEqual(await tabs(), [':5174 *']);
  await page.goBack();
  await settlePhone(page);
  assert.deepEqual(await strip(), { phone: true, at: 1, windows: ['entry-screen', 'wm-files'] });
  await page.goBack();
  await settlePhone(page);
  assert.deepEqual(await strip(), { phone: true, at: 0, windows: ['entry-screen', 'wm-files'] });
  assert.deepEqual(await bars(), before);
  // Files stays beside the conversation; the explicit PC-browser portal is in the dock.
  assert.equal(await page.locator('.entry-files, .entry-apps').count(), 0);
  assert.equal(await page.locator('.entry-browser').count(), 1);
}));

// A game that keeps every touch for itself, as Spunky City does for its stick
// and its look-drag: nothing a finger does on it moves the strip.
const GAME = `<!doctype html><title>City</title><style>html,body{margin:0;height:100%;touch-action:none;background:#9ad8ff}</style>
<p id="taps">0</p><script>
window.born = Math.random(); window.taps = 0;
for (const type of ['touchstart', 'touchmove']) addEventListener(type, event => event.preventDefault(), { passive: false });
addEventListener('touchstart', () => { document.getElementById('taps').textContent = ++window.taps; });
</script>`;

test('phone: a page that keeps the touch beside the conversation: prompted with it in sight, played full screen and back, loaded again when shown again, and it lets go of the keys when left', () => onAPhone(async ({ page, swipe, tap, strip, bars, rail, box, say, send, prompts, shownAt }) => {
  await settlePhone(page);
  const before = await bars();
  // External websites still belong to Browser; local creations are exercised in Files below.
  const url = 'https://games.example.test/city.html';
  await page.locator('#entry-output').evaluate((output, url) => { const a = document.createElement('a'); a.dataset.page = url; a.href = '#'; a.id = 'game'; a.textContent = 'game'; output.prepend(a); }, url);
  await page.locator('#game').evaluate(a => a.click());
  await settlePhone(page);
  assert.deepEqual(await strip(), { phone: true, at: 2, windows: ['entry-screen', 'wm-files', 'wm-browser'] });
  await page.frameLocator('.wm-browser iframe').locator('#taps').waitFor();
  const frame = () => page.frames().find(f => f.url() === url);
  const life = () => frame().evaluate(() => [window.born, window.taps]);
  assert.deepEqual(await bars(), before, 'the input bar in sight beside it');
  assert.equal((await rail()).shown, false, 'the agents\' strip gone with the conversation: one bar at the top, the browser\'s');

  // The game has the touch: a swipe across it is the game's.
  await swipe(60, 340);
  assert.equal((await strip()).at, 2, 'the page keeps a swipe across it');
  const [born, taps] = await life();
  assert.ok(taps > 0, 'the game felt it');
  // Its bar is imperfect's: the page's name, reload and full screen.
  assert.equal(await page.locator('.wm-browser .browser-tab-title').textContent(), 'games.example.test', 'cross-origin pages retain their useful URL label');
  assert.deepEqual(await page.locator('.wm-browser .browser-controls').evaluate(row => [...row.querySelectorAll('button')].map(b => b.getAttribute('aria-label') ?? b.textContent)), ['Reload', 'Full screen']);
  const bar = await page.locator('.wm-browser .gui-window-bar').boundingBox();
  const barY = bar.y + bar.height / 2;
  // With the page holding the keys, a swipe that starts on the bar takes
  // the strip back a panel, to Workbench, and the page lets go of the keys.
  await page.locator('.wm-browser iframe').focus();
  assert.equal(await frame().evaluate(() => document.hasFocus()), true);
  await swipe(60, 340, barY);
  assert.equal((await strip()).at, 1, 'a swipe from the bar is the strip\'s');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BODY', 'the page out of view has let go');
  assert.equal(await frame().evaluate(() => document.hasFocus()), false);
  // Swiped back to it, the game is as it was: not loaded again.
  await swipe(330, 50);
  assert.equal((await strip()).at, 2);
  assert.deepEqual(await life(), [born, taps], 'the same page, its count kept');
  // The lower row now has an address instead of an empty name area. A
  // tap gives it the keys, never navigates away from the current panel.
  const addressBox = await page.locator('.wm-browser .gui-window-address').boundingBox();
  await tap(addressBox.x + addressBox.width / 2, addressBox.y + addressBox.height / 2);
  assert.equal((await strip()).at, 2, 'the address keeps the browser in view');
  assert.equal(await page.locator('.wm-browser .gui-window-address').evaluate(n => n === document.activeElement), true);
  await page.locator('.wm-browser .gui-window-address').evaluate(n => n.blur());
  await swipe(60, 340, barY);
  await swipe(60, 340, barY);
  assert.equal((await strip()).at, 0, 'swiping the bar returns to the conversation');
  assert.equal(await page.evaluate(() => history.state), null, 'back from the conversation leaves the app, as before');
  assert.deepEqual(await life(), [born, taps], 'and the page plays on behind it');
  await swipe(330, 50);
  await swipe(330, 50);

  // A prompt typed with the page in sight goes to the session, the page staying.
  await page.locator('#entry-input').focus();
  await page.keyboard.type('make the sky pink');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('entry-input').value === '');
  assert.deepEqual(prompts.map(c => c.text), ['make the sky pink']);
  assert.equal((await strip()).at, 2, 'the page still in sight');
  assert.deepEqual(await life(), [born, taps]);
  await page.locator('#entry-input').evaluate(n => n.blur());

  // Full screen: the page covers the bars too, the strip holds still, and a
  // tab hanging from the top edge, imperfect's, brings them back.
  const full = await page.locator('.wm-browser .gui-window-go[aria-label="Full screen"]').boundingBox();
  await tap(full.x + full.width / 2, full.y + full.height / 2);
  assert.deepEqual(await box('.wm-browser iframe'), [0, 0, 390, 800], 'the whole screen');
  assert.equal(await page.locator('#session-rail').isVisible(), false);
  assert.equal(await page.locator('#entry-input-zone').isVisible(), false);
  assert.equal(await page.locator('.wm-browser .gui-window-bar').isVisible(), false);
  await swipe(60, 340);
  await swipe(60, 340, 5);
  assert.equal((await strip()).at, 2, 'nothing a finger does on the page moves the strip');
  const [, played] = await life();
  assert.ok(played > taps, 'the game is played');
  const handle = await page.locator('.wm-unfull').boundingBox();
  assert.ok(handle.y === 0 && handle.x > 100 && handle.x + handle.width < 290, 'away from the edges the back gesture uses');
  await tap(handle.x + handle.width / 2, 8);
  assert.deepEqual(await bars(), before, 'the bars back where they were');
  assert.equal(await page.locator('.wm-unfull').count(), 0);
  assert.equal((await strip()).at, 2);
  assert.deepEqual(await life(), [born, played], 'the same page, still playing');
  assert.deepEqual(await page.evaluate(() => history.state), { window: true }, 'the full screen\'s step taken back');
  // Back from full screen leaves full screen, the page staying.
  await tap(full.x + full.width / 2, full.y + full.height / 2);
  assert.equal(await page.locator('#session-rail').isVisible(), false);
  await page.goBack();
  await settlePhone(page);
  assert.deepEqual(await bars(), before);
  assert.deepEqual(await strip(), { phone: true, at: 2, windows: ['entry-screen', 'wm-files', 'wm-browser'] }, 'back left full screen, not the page');
  assert.deepEqual(await life(), [born, played]);

  // Shown again (the agent changed it): the page plays on, and reload wears
  // a dot; a tap on reload loads it afresh, and the dot goes.
  const reload = page.locator('.wm-browser .gui-window-go[aria-label=Reload]');
  assert.equal(await reload.evaluate(n => n.classList.contains('stale')), false);
  say({ role: 'user', content: 'make the sky pink' }, { role: 'toolResult', toolName: 'show', content: [{ type: 'text', text: `Opened in the browser beside the conversation, as a tab: ${url}` }] });
  send({ type: 'shown', session: 'thread-a', target: url });
  await page.locator('.wm-browser .gui-window-go.stale').waitFor();
  assert.deepEqual(await life(), [born, played], 'not loaded again under the player');
  const at = await reload.boundingBox();
  await tap(at.x + at.width / 2, at.y + at.height / 2);
  await page.waitForFunction(url => [...document.querySelectorAll('.wm-browser iframe')].length === 1, url);
  await page.frameLocator('.wm-browser iframe').locator('#taps').waitFor();
  const [again, fresh] = await life();
  assert.ok(again !== born && fresh === 0, 'loaded afresh');
  assert.equal(await reload.evaluate(n => n.classList.contains('stale')), false, 'and the dot is gone');
  // Loading it again was no step in the history: back still closes it,
  // and Workbench, beside it, comes into view.
  await page.goBack();
  await settlePhone(page);
  assert.deepEqual(await strip(), { phone: true, at: 1, windows: ['entry-screen', 'wm-files'] });
  assert.deepEqual(await bars(), before);
}, { pages: { 'city.html': GAME } }));

test('phone: local HTML plays inside Files: touch, composer, full screen, back and views from the sidebar', () => onAPhone(async ({ page, swipe, tap, strip, bars, rail, box, send, prompts, shownAt }) => {
  await settlePhone(page);
  const before = await bars();
  send({ type: 'shown', session: 'thread-a', kind: 'page', target: shownAt('city.html') });
  const player = page.frameLocator('.wm-files iframe');
  await player.locator('#taps').waitFor({ state: 'attached' });
  assert.deepEqual(await strip(), { phone: true, at: 0, windows: ['entry-screen', 'wm-files'] });
  assert.equal(await page.locator('.wm-browser').count(), 0, 'no extra swipe panel for a local creation');
  await swipe(330, 50);
  assert.equal((await strip()).at, 1);
  assert.equal((await rail()).shown, false);
  assert.deepEqual(await bars(), before);
  const frame = () => page.frames().find(f => f.url().endsWith('/city.html'));
  const born = await frame().evaluate(() => window.born);
  await swipe(60, 340);
  assert.equal((await strip()).at, 1, 'the game keeps the touch');
  const taps = await frame().evaluate(() => window.taps);
  assert.ok(taps > 0);
  await page.locator('.wm-files iframe').focus();
  assert.equal(await frame().evaluate(() => document.hasFocus()), true);
  // The Files header, its path too, lets a finger swipe back: on a phone
  // the path never scrolls under a thumb.
  const header = await page.locator('.wm-files .workbench-bar').boundingBox();
  await swipe(60, 340, header.y + header.height / 2);
  assert.equal((await strip()).at, 0, 'the Files header lets the person swipe back');
  assert.equal(await frame().evaluate(() => document.hasFocus()), false, 'a hidden game releases keys');
  await swipe(330, 50);
  assert.deepEqual(await frame().evaluate(() => [window.born, window.taps]), [born, taps]);
  await page.locator('#entry-input').fill('make the sky pink');
  await page.locator('#entry-input').press('Enter');
  await page.waitForFunction(() => document.getElementById('entry-input').value === '');
  assert.deepEqual(prompts.map(c => c.text), ['make the sky pink']);
  assert.equal((await strip()).at, 1, 'sending leaves Files in sight');
  await page.locator('#entry-input').evaluate(n => n.blur());
  await page.locator('.wm-files [data-full]').click();
  assert.deepEqual(await box('.wm-files iframe'), [0, 0, 390, 800]);
  assert.equal(await page.locator('#entry-input-zone').isVisible(), false);
  await swipe(60, 340);
  assert.equal((await strip()).at, 1);
  const handle = await page.locator('.wm-unfull').boundingBox();
  await tap(handle.x + handle.width / 2, 8);
  assert.deepEqual(await bars(), before);
  assert.equal(await frame().evaluate(() => window.born), born);
  await page.locator('.wm-files [data-full]').click();
  await page.goBack();
  await settlePhone(page);
  assert.deepEqual(await bars(), before);
  assert.equal(await frame().evaluate(() => window.born), born, 'back leaves fullscreen, not the file');
  // Views are the sidebar's, as on the Mac: another one, then back.
  const files = () => page.evaluate(() => {
    const rail = document.querySelector('#session-rail');
    if (rail.classList.contains('collapsed')) rail.querySelector('.session-rail-fold').click();
    const head = [...rail.querySelectorAll('.sidebar-head')].find(node => node.textContent.trim() === 'Files');
    const rows = [];
    for (let node = head.nextElementSibling; node?.classList.contains('sidebar-row'); node = node.nextElementSibling) rows.push(node.querySelector('.session-rail-open').textContent.trim());
    return rows;
  });
  const choose = index => page.evaluate(index => {
    const head = [...document.querySelectorAll('#session-rail .sidebar-head')].find(node => node.textContent.trim() === 'Files');
    let node = head.nextElementSibling;
    for (let at = 0; at < index; at++) node = node.nextElementSibling;
    node.querySelector('.session-rail-open').click();
  }, index);
  const first = await files();
  assert.equal(first.length, 2, JSON.stringify(first));
  assert.equal(first.at(-1), 'New view');
  await choose(1);
  assert.equal(await page.evaluate(() => document.querySelector('#session-rail').classList.contains('collapsed')), true, 'choosing puts the sheet away');
  let second = [];
  for (let tries = 0; tries < 40 && second.length < 3; tries++) { second = await files(); if (second.length < 3) await page.waitForTimeout(100); }
  assert.equal(second.length, 3, JSON.stringify(second));
  assert.equal(second[0], first[0]);
  await choose(0);
  assert.equal(await page.evaluate(() => document.querySelector('#session-rail').classList.contains('collapsed')), true, 'choosing puts the sheet away');
  assert.equal(await frame().evaluate(() => window.born), born, 'switching views retains the game');
  assert.equal(await page.locator('.workbench-tabs').count(), 0);
}, { pages: { 'city.html': GAME } }));

test('phone: one strip for every session; another comes into view at its conversation with the windows beside it as they were, what any agent shows opens behind, and a session closed leaves the windows', () => onAPhone(async ({ page, swipe, strip, bars, view, drop, send, shownAt }) => {
  await settlePhone(page);
  const before = await bars();
  // Workbench, in view.
  await swipe(330, 50);
  assert.deepEqual(await strip(), { phone: true, at: 1, windows: ['entry-screen', 'wm-files'] });
  assert.deepEqual(await page.evaluate(() => history.state), { window: true });
  // Another session: its conversation in view, Workbench still beside it.
  view('thread-b');
  await page.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-b', null, { timeout: 60000 });
  await settlePhone(page);
  assert.deepEqual(await strip(), { phone: true, at: 0, windows: ['entry-screen', 'wm-files'] });
  assert.equal(await page.evaluate(() => history.state), null, 'the step of the window left behind taken back');
  assert.deepEqual(await bars(), before);
  // Local HTML shown by another session opens inside Files, behind the conversation.
  send({ type: 'shown', session: 'thread-a', kind: 'page', target: shownAt('city.html') });
  await page.frameLocator('.wm-files iframe').locator('#taps').waitFor({ state: 'attached' });
  await settlePhone(page);
  const gameFrame = () => page.frames().find(f => f.url().endsWith('/city.html'));
  const born = await gameFrame().evaluate(() => window.born);
  assert.deepEqual(await strip(), { phone: true, at: 0, windows: ['entry-screen', 'wm-files'] });
  assert.equal(await page.locator('.wm-browser').count(), 0);
  // Back to the first: the same strip and the same running file.
  view('thread-a');
  await page.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-a', null, { timeout: 60000 });
  await settlePhone(page);
  assert.deepEqual(await strip(), { phone: true, at: 0, windows: ['entry-screen', 'wm-files'] });
  await swipe(330, 50);
  assert.equal((await strip()).at, 1);
  assert.equal(await gameFrame().evaluate(() => window.born), born, 'the page it opened, not loaded again');
  // The first session closed: only its conversation goes.
  view('thread-b');
  await page.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-b', null, { timeout: 60000 });
  await settlePhone(page);
  drop('thread-a');
  await page.waitForFunction(() => !harness.guiSnapshot().tabs.some(t => t.sessionId === 'thread-a'), null, { timeout: 60000 });
  await settlePhone(page);
  assert.deepEqual(await strip(), { phone: true, at: 0, windows: ['entry-screen', 'wm-files'] });
  assert.equal(await gameFrame().evaluate(() => window.born), born, 'closing its session leaves Files playing');
}, { pages: { 'city.html': GAME } }));

test('phone: the agents\' browser on the computer, live, in a panel of its own beside the phone\'s pages: watched only in sight, a tap where the picture shows it, a drag scrolls, typing goes to the page and never the conversation', () => onAPhone(async ({ page, swipe, drag, tap, strip, send, prompts, calls, shownAt, lives, picture }) => {
  await settlePhone(page);
  const until = async (ok, what) => { for (const end = Date.now() + 60000; !ok(); await page.waitForTimeout(20)) if (Date.now() > end) throw new Error(`${what} did not happen`); };
  const watching = () => lives.filter(live => live.open);
  // A local creation plays in Files, not a third panel, and opens behind.
  send({ type: 'shown', target: shownAt('game.html'), kind: 'page' });
  await page.waitForSelector('.wm-files iframe', { state: 'attached' });
  // An agent's browser, opened behind on the PC: the live panel comes, not in view.
  send({ type: 'browse', front: false, machine: '' });
  await page.waitForSelector('.wm-live .browser-live');
  assert.equal((await strip()).at, 0, 'behind: the conversation stays in view');
  await settlePhone(page);
  assert.equal(watching().length, 0, 'out of sight, nothing is watched');
  // Even an agent's front request must not navigate; the person swipes to watch.
  send({ type: 'browse', front: true, machine: '' });
  await settlePhone(page);
  assert.equal((await strip()).at, 0, 'front requests do not move the viewport');
  assert.equal(watching().length, 0);
  await swipe(330, 50);
  await swipe(330, 50);
  const at = await strip();
  assert.deepEqual(at.windows, ['entry-screen', 'wm-files', 'wm-live']);
  assert.equal(at.windows[at.at], 'wm-live');
  await until(() => watching().length === 1, 'watching');
  const live = watching()[0];
  assert.equal(live.computer, '', 'this computer\'s browser');
  const [watch] = live.heard;
  assert.equal(watch.do, 'watch');
  assert.ok(watch.width > 0 && watch.height > 0, 'the size of the view, in device pixels');
  // The tabs along the bar, the tab in front as a picture, acked once drawn.
  live.send({ tabs: [{ tab: 3, title: 'OpenAI Platform', url: 'https://platform.openai.com/login', front: true }, { tab: 4, title: 'Docs', url: 'https://pi.dev/', front: false }] });
  live.send({ frame: await picture(), tab: 3, width: 1280, height: 800 });
  await page.waitForFunction(() => document.querySelector('.browser-live-frame')?.getAttribute('src')?.startsWith('data:image/jpeg'));
  await until(() => live.heard.some(said => said.ack), 'the ack');
  assert.deepEqual(live.heard.filter(said => said.ack), [{ ack: true }]);
  const tabs = () => page.locator('.wm-live .browser-tab').evaluateAll(all => all.map(t => `${t.querySelector('.browser-tab-title').textContent}${t.classList.contains('front') ? ' *' : ''}`));
  assert.deepEqual(await tabs(), ['OpenAI Platform *', 'Docs']);
  // A tap on the picture is a click at the same place on the page, on the tab it shows.
  const { x, y, width, height } = await page.locator('.wm-live .browser-live-frame').boundingBox();
  await tap(x + width / 2, y + height / 2);
  assert.deepEqual(live.heard.at(-1), { do: 'tap', x: 640, y: 400, tab: 3, gesture: 1 });
  const scale = width / 1280, top = y + (height - 800 * scale) / 2;
  await tap(x + 2, top + 2);
  assert.deepEqual(live.heard.at(-1), { do: 'tap', x: Math.round(2 / scale), y: Math.round(2 / scale), tab: 3, gesture: 2 });
  const above = live.heard.length;
  await tap(x + width / 2, top - 5);
  assert.equal(live.heard.length, above, 'beside the picture is not the page');
  // A finger drawn up scrolls the page down, and is not a tap; the strip stays.
  const before = live.heard.length;
  await drag(195, y + height * 0.7, y + height * 0.3);
  const moved = live.heard.slice(before);
  assert.ok(moved.length > 0 && moved.every(said => said.do === 'scroll' && said.dy > 0 && said.tab === 3), JSON.stringify(moved));
  assert.equal((await strip()).windows[(await strip()).at], 'wm-live');
  // Unsolicited snapshots cannot open the keyboard; a matching tap can.
  assert.equal(await page.locator('.browser-live-type').count(), 0);
  live.send({ field: { editable: true, kind: 'password', token: 'private', mirror: false } });
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.browser-live-keyboard').evaluate(n => n === document.activeElement), false);
  await tap(x + width / 2, y + height / 2);
  await until(() => live.heard.at(-1)?.do === 'tap', 'field tap');
  live.send({ field: { editable: true, kind: 'password', token: 'private', mirror: false }, gesture: live.heard.at(-1).gesture });
  await page.waitForFunction(() => document.activeElement.matches('.browser-live-keyboard'));
  const asked = calls.length;
  await page.keyboard.insertText('hunter2-not-real');
  await page.keyboard.press('Enter');
  await until(() => live.heard.at(-1)?.key === 'Enter', 'typing');
  assert.deepEqual(live.heard.findLast(s => s.do === 'edit' && s.text), { do: 'edit', field: 'private', text: 'hunter2-not-real', tab: 3 });
  assert.equal(await page.locator('.browser-live-keyboard').inputValue(), '\u200b', 'only a sentinel remains locally');
  await page.waitForTimeout(300);
  assert.deepEqual(prompts, [], 'no prompt');
  assert.ok(!JSON.stringify(calls.slice(asked)).includes('hunter2'), 'nothing of it on the conversation\'s connection');
  assert.ok(!(await page.locator('#entry-input').evaluate(n => n.value ?? n.textContent)).includes('hunter2'), 'nor in its input');
  await tap(x + width / 2, y + height / 2);
  await until(() => live.heard.at(-1)?.do === 'tap', 'text field tap');
  live.send({ field: { editable: true, kind: 'text', token: 'plain', mirror: true, value: '', start: 0, end: 0 }, gesture: live.heard.at(-1).gesture });
  await page.waitForFunction(() => document.activeElement.matches('.browser-live-keyboard'));
  await page.keyboard.insertText('noah');
  await until(() => live.heard.at(-1)?.do === 'edit' && live.heard.at(-1)?.text === 'noah', 'typing without Enter');
  assert.deepEqual(live.heard.at(-1), { do: 'edit', field: 'plain', start: 0, end: 0, text: 'noah', tab: 3 });
  await page.locator('.wm-live .gui-window-go[aria-label=Back]').evaluate(n => n.click());
  await until(() => live.heard.at(-1)?.do === 'back', 'back reaching the browser');
  assert.deepEqual(live.heard.at(-1), { do: 'back', tab: 3 });
  // A tab chosen from the list.
  await page.locator('.wm-live .browser-tab').nth(1).evaluate(n => n.click());
  await until(() => live.heard.at(-1)?.do === 'front', 'choosing the live tab');
  assert.deepEqual(live.heard.at(-1), { do: 'front', tab: 4 });
  await page.locator('.browser-live-keyboard').evaluate(n => n.blur());
  // Swiped out of sight: the connection closes, and opens again in sight.
  await swipe(60, 340);
  await until(() => !live.open, 'closing out of sight');
  for (let step = 0; step < 4; step++) {
    const now = await strip();
    if (now.windows[now.at] === 'wm-live') break;
    await (now.at < now.windows.indexOf('wm-live') ? swipe(330, 50) : swipe(60, 340));
  }
  assert.equal((await strip()).windows[(await strip()).at], 'wm-live', JSON.stringify(await strip()));
  await until(() => watching().length === 1 && watching()[0] !== live, 'watching again');
  // The screen off: closed too.
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await until(() => watching().length === 0, 'closing with the screen off');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await until(() => watching().length === 1, 'watching with the screen on');
  // Another computer's browser: through /peer/, nothing of the last one's acted on.
  const pc = watching()[0];
  send({ type: 'browse', front: true, machine: 'laptop-id' });
  await until(() => watching().length === 1 && watching()[0].computer === 'laptop-id', 'watching the laptop');
  assert.equal(pc.open, false);
  const laptop = watching()[0];
  await tap(x + width / 2, y + height / 2);
  assert.ok(!laptop.heard.some(said => said.do === 'tap'), 'no picture of it yet, so no tap');
  // The phone's own page still plays in its panel.
  assert.ok((await page.locator('.wm-files iframe').getAttribute('src')).endsWith('/game.html'));
}, { pages: { 'game.html': '<!doctype html><title>game</title><p>game</p>' } }));
