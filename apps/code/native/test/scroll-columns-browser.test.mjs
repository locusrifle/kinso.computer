import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { harnessFixture, settled } from './fixtures/harness-page.mjs';

const messages = [{ role: 'assistant', content: 'A readable conversation.' }];
const rect = (p, s) => p.locator(s).evaluate(n => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
const state = p => p.evaluate(() => {
  const s = document.querySelector('#canvas-strip');
  return { left: s.scrollLeft, width: s.clientWidth, extent: s.scrollWidth, body: document.documentElement.scrollWidth,
    focus: document.activeElement.id || document.activeElement.localName };
});

for (const width of [1280, 1536, 1920]) test(`scroll columns ${width}: stable widths, fixed frame, background opens, navigation, full and close`, async () => {
  const f = await harnessFixture({ desk: true, messages, viewport: { width, height: 900 } });
  const p = f.page;
  try {
    await p.waitForFunction(() => !document.querySelector('.wm-moving'));
    const before = await rect(p, '.entry-screen'), files = await rect(p, '.wm-files');
    const composer = await rect(p, '#entry-input-zone'), rail = await rect(p, '#session-rail');
    await p.locator('#entry-input').fill('a draft to keep');
    const start = await state(p);
    await p.evaluate(() => browseFromWindow({ url: 'https://background.example/', behind: true }));
    await p.waitForFunction(() => !document.querySelector('.wm-moving'));
    assert.deepEqual(await rect(p, '.entry-screen'), before, 'third does not shrink or stack conversation');
    assert.deepEqual(await rect(p, '.wm-files'), files, 'third does not shrink or stack Files');
    const browser = await rect(p, '.wm-browser');
    assert.equal(browser.y, files.y); assert.equal(browser.h, files.h); assert.equal(browser.w, files.w);
    // Opened in the next place along, on the right: nothing in view moves.
    assert.equal(browser.x, files.x + files.w - 1, 'one shared hairline, no gutter');
    const opened = await state(p);
    assert.equal(opened.left, start.left); assert.equal(opened.focus, 'entry-input');
    await p.evaluate(() => tabFromWindow({ do: 'front', id: document.querySelector('webview').getWebContentsId() }));
    assert.equal((await state(p)).left, opened.left, 'agent front/show does not reveal its column');
    assert.equal((await state(p)).focus, 'entry-input', 'agent front/show does not steal pane focus');
    assert.ok(opened.extent >= width * 1.5); assert.equal(opened.body, width);
    assert.deepEqual(await rect(p, '#entry-input-zone'), composer);
    assert.deepEqual(await rect(p, '#session-rail'), rail);
    // MOD+Right: the conversation and Files in view, the browser out of
    // sight; one press brings it whole into view with the keys, past Files,
    // at once. At the right edge nothing moves. The draft stays.
    await p.keyboard.press('Alt+ArrowRight');
    assert.equal(await p.locator('.wm-browser.wm-focused').count(), 1);
    const shift = (await state(p)).left;
    const revealed = await rect(p, '.wm-browser');
    assert.ok(revealed.x >= -1 && revealed.x + revealed.w <= width + 1, 'brought whole into view');
    assert.equal(await p.evaluate(() => document.activeElement.localName), 'webview', 'the page in front has the keys');
    assert.equal(await p.locator('#entry-input').inputValue(), 'a draft to keep');
    assert.ok(shift > opened.left);
    assert.equal(await settled(p), shift, 'nothing slides afterwards');
    assert.deepEqual(await rect(p, '#entry-input-zone'), composer, 'composer never scrolls with columns');
    const movedRail = await rect(p, '#session-rail');
    assert.equal(Math.round(movedRail.x), Math.round(rail.x + opened.left - shift), 'heading follows its column');
    await p.keyboard.press('Alt+ArrowRight');
    assert.equal(await p.locator('.wm-browser.wm-focused').count(), 1, 'the right edge: no wrap');
    assert.equal((await state(p)).left, shift);
    await p.locator('.browser-page.front webview').focus();
    await p.keyboard.press('Alt+f');
    const full = await rect(p, '.wm-browser');
    assert.equal(full.x, 0); assert.equal(full.w, width);
    assert.deepEqual(await rect(p, '#entry-input-zone'), composer);
    await p.keyboard.press('Alt+f');
    assert.equal((await state(p)).left, shift, 'unfull retains viewport');
    await p.keyboard.press('Alt+ArrowLeft');
    assert.equal(await p.locator('.entry-screen.wm-focused').count(), 1, 'back to the conversation, out of the website, past Files');
    assert.equal((await state(p)).focus, 'entry-input');
    assert.equal((await state(p)).left, opened.left, 'the conversation wholly in view');
    if (width === 1536) {
      for (const resized of [1280, 1920, 1536]) {
        await p.setViewportSize({ width: resized, height: 800 });
        await p.waitForTimeout(100);
        const a = await rect(p, '.entry-screen'), b = await rect(p, '.wm-files'), c = await rect(p, '.wm-browser');
        assert.ok(a.w >= 640 && a.w === b.w && b.w === c.w && a.h === b.h && b.h === c.h);
        assert.equal((await rect(p, '#entry-input-zone')).w, resized);
        assert.equal((await state(p)).body, resized);
      }
    }
    const anchored = await rect(p, '.wm-files');
    await p.locator('.workbench').focus();
    await p.keyboard.press('Alt+w'); // Files stays
    assert.equal(await p.locator('.wm-files').count(), 1);
    await p.evaluate(() => tabFromWindow({ do: 'close', id: document.querySelector('webview').getWebContentsId() }));
    // The browser's native closed notification closes its tab and column.
    await p.waitForFunction(() => !document.querySelector('.wm-browser'));
    const after = await rect(p, '.wm-files');
    // At the end of a shrinking strip the unavoidable clamp is at most one column.
    assert.ok(Math.abs(after.x - anchored.x) <= files.w);
    assert.equal((await state(p)).body, width);
    assert.equal(await p.locator('#entry-input').inputValue(), 'a draft to keep');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('phone: quiet agent live opening, real swipe above fixed composer, full/handle/back and draft', async () => {
  const f = await harnessFixture({ messages, viewport: { width: 390, height: 844 }, hasTouch: true });
  const p = f.page;
  try {
    await p.waitForTimeout(500);
    await p.locator('#entry-input').fill('phone draft');
    const footer = await rect(p, '#entry-input-zone');
    f.send({ type: 'browse', front: true });
    await p.locator('.wm-live').waitFor();
    assert.equal((await state(p)).left, 0, 'even agent front does not move phone viewport');
    assert.equal((await state(p)).focus, 'entry-input');
    await p.locator('#entry-input').evaluate(n => n.blur());
    const cdp = await p.context().newCDPSession(p);
    const swipe = async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 340, y: 250 }] });
      for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 340 - i * 35, y: 250 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await p.waitForTimeout(700);
    };
    await swipe(); await swipe();
    assert.equal((await state(p)).left, 780);
    assert.deepEqual(await rect(p, '#entry-input-zone'), footer);
    await p.locator('.wm-live button[title="Full screen"]').click();
    await p.locator('.wm-unfull').waitFor();
    assert.equal(await p.locator('#entry-input-zone').isVisible(), false);
    await p.locator('.wm-unfull').click();
    await p.locator('#entry-input-zone').waitFor();
    assert.deepEqual(await rect(p, '#entry-input-zone'), footer);
    assert.equal(await p.locator('#entry-input').inputValue(), 'phone draft');
    await p.locator('.wm-live button[title="Full screen"]').click();
    await p.locator('.wm-unfull').waitFor();
    await p.evaluate(() => history.back());
    await p.locator('#entry-input-zone').waitFor();
    assert.equal(await p.locator('.wm-live').count(), 1, 'back leaves full screen, not the live pane');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// A small standalone production WM fixture also exercises one pane and four
// panes, so deleting a column before the viewport can be checked without the
// singleton Files/browser restrictions. No installed service or agents.
async function stripFixture(run) {
  const root = new URL('../public/', import.meta.url);
  const html = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/imperfect.css"><style>body{margin:0}#strip{position:relative;height:700px;width:100vw}.wm-window{background:#111;color:#eee}</style><body class="imperfect"><div id="strip"><section id="home"><textarea id="draft"></textarea></section></div>';
  const server = createServer(async (req, res) => {
    try { res.setHeader('Content-Type', req.url === '/' ? 'text/html' : req.url.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(req.url === '/' ? html : await readFile(new URL(req.url.slice(1), root))); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const b = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const p = await b.newPage({ viewport: { width: 1536, height: 900 } });
    await p.goto(`http://127.0.0.1:${server.address().port}`);
    await p.evaluate(async () => {
      const { mountWindows } = await import('/js/windows.js');
      window.wm = mountWindows({ conversation: document.querySelector('#home'), keys: () => document.querySelector('#draft').focus({ preventScroll: true }) });
      window.add = kind => { const body = document.createElement('input'); body.value = kind; return wm.open({ kind, body, quiet: true, keys: () => body.focus({ preventScroll: true }) }); };
    });
    await run(p);
  } finally { await b.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
}

test('one pane fills; close before the viewport stays anchored; rotation keeps its slot; vertical wheel is not hijacked', () => stripFixture(async p => {
  assert.equal((await rect(p, '#home')).w, 1536);
  await p.evaluate(() => { window.a = add('a'); window.b = add('b'); window.c = add('c'); wm.bring(b); });
  await p.waitForTimeout(450);
  const before = await rect(p, '.wm-b');
  await p.evaluate(() => wm.close(a));
  assert.deepEqual(await rect(p, '.wm-b'), before, 'removing before the viewport keeps visible pane anchored');
  await p.evaluate(() => wm.rotate(1));
  assert.equal(await p.evaluate(() => wm.focused().kind), 'conversation');
  await p.evaluate(() => wm.rotate(-1));
  assert.equal(await p.evaluate(() => wm.focused().kind), 'b');
  await p.evaluate(() => { window.vertical = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 90 }); document.querySelector('.wm-b').dispatchEvent(vertical); });
  assert.equal(await p.evaluate(() => vertical.defaultPrevented), false);
  const left = await p.locator('#strip').evaluate(s => s.scrollLeft);
  await p.evaluate(() => document.querySelector('.wm-b').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, shiftKey: true, deltaY: 80 })));
  assert.equal(await p.locator('#strip').evaluate(s => s.scrollLeft), left, 'Shift+wheel does not move viewport');
  await p.evaluate(() => wm.home());
  await p.locator('#draft').focus();
  await p.evaluate(() => { wm.show(c); c.keys(); });
  assert.equal(await p.evaluate(() => document.activeElement.value), 'c', 'explicit choice transfers keyboard off hidden pane');
}));

test('MOD arrows bring the next column out of sight wholly into view with the keys, at once, and stop at the edges', () => stripFixture(async p => {
  await p.evaluate(() => { window.a = add('a'); add('b'); add('c'); add('d'); });
  // Read at once: nothing slides.
  const at = () => p.evaluate(() => [wm.focused().kind, document.activeElement.id || document.activeElement.value, document.querySelector('#strip').scrollLeft]);
  // Two columns in view at a time; past the one in view beside, each press
  // brings the next out of sight.
  for (const expected of [['b', 'b', 768], ['c', 'c', 1536], ['d', 'd', 2304], ['d', 'd', 2304]]) {
    await p.evaluate(() => wm.navigate(1));
    assert.deepEqual(await at(), expected);
  }
  await p.evaluate(() => wm.navigate(-1));
  assert.deepEqual(await at(), ['b', 'b', 1536], 'past c, in view already');
  await p.evaluate(() => wm.navigate(-1));
  assert.deepEqual(await at(), ['a', 'a', 768]);
  await p.evaluate(() => wm.navigate(-1));
  assert.deepEqual(await at(), ['conversation', 'draft', 0]);
  await p.evaluate(() => wm.navigate(-1));
  assert.deepEqual(await at(), ['conversation', 'draft', 0], 'stops at the first');
  // Everything on that side in view: the one beside takes the keys.
  await p.evaluate(() => { wm.show(a); a.keys(); });
  await p.evaluate(() => wm.navigate(-1));
  assert.deepEqual(await at(), ['conversation', 'draft', 0]);
}));

test('live browser clips to columns and maps taps/wheel using the scrolled picture bounds', () => stripFixture(async p => {
  await p.evaluate(async () => {
    const { mountLive, pagePoint } = await import('/js/live.js');
    window.point = pagePoint;
    window.sent = [];
    add('files'); add('browser');
    const view = window.liveView = mountLive({ connect: () => {
      const socket = { readyState: 1, send: raw => {
        const said = JSON.parse(raw); sent.push(said);
        if (said.do === 'watch') setTimeout(() => socket.onmessage({ data: JSON.stringify({ frame: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', width: 800, height: 600, tab: 17 }) }), 0);
      }, close() {} };
      setTimeout(() => socket.onopen(), 0);
      return socket;
    } });
    const body = document.createElement('div'); body.className = 'gui-window filling'; body.append(view.bar, view.body);
    window.liveWin = wm.open({ kind: 'live', body, bar: view.bar, quiet: true });
  });
  await p.waitForTimeout(450);
  assert.equal(await p.evaluate(() => sent.length), 0, 'offscreen view does not watch or take focus');
  // The live pane opens in the last place, on the right; bring it.
  await p.evaluate(() => wm.bring(liveWin));
  await settled(p, '#strip');
  await p.waitForFunction(() => document.querySelector('.browser-live-frame').hasAttribute('src'));
  await p.waitForTimeout(150);
  const picture = await p.locator('.browser-live-frame').boundingBox();
  const x = picture.x + picture.width / 2, y = picture.y + picture.height / 2;
  const expected = await p.evaluate(({ x, y }) => point({ x, y }, document.querySelector('.browser-live-frame').getBoundingClientRect(), { width: 800, height: 600 }), { x, y });
  assert.ok(expected);
  await p.mouse.click(x, y);
  await p.waitForFunction(() => sent.some(s => s.do === 'tap'));
  const tapped = await p.evaluate(() => sent.find(s => s.do === 'tap'));
  assert.deepEqual(tapped, { do: 'tap', ...expected, tab: 17 });
  const live = await p.locator('.wm-live').boundingBox();
  assert.ok(live.x > 100, 'a neighbouring column is in view');
  assert.equal(await p.evaluate(x => document.elementFromPoint(x, 300).closest('.wm-window').classList.contains('wm-live'), live.x - 100), false, 'clipped live view cannot cover adjacent columns');
  const left = await p.locator('#strip').evaluate(s => s.scrollLeft);
  await p.locator('.browser-live-view').evaluate(n => n.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 70, deltaY: 0 })));
  assert.equal(await p.locator('#strip').evaluate(s => s.scrollLeft), left);
  assert.equal(await p.evaluate(() => sent.filter(s => s.do === 'scroll').length), 0, 'horizontal wheel never scrolls remote website vertically');
  await p.locator('.browser-live-view').evaluate((n, x) => n.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 50, clientX: x, clientY: 300 })), x);
  await p.waitForFunction(() => sent.some(s => s.do === 'scroll'));
  assert.ok(await p.evaluate(() => sent.some(s => s.do === 'scroll' && s.tab === 17 && s.dy > 0)));
  await p.evaluate(() => liveView.stop());
}));
