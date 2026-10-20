import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { localPage, localFile, splitLocal, pageLabel, setFileBase, windowOf, inBrowser, shownName } from '../public/js/pages.js';
import { runShow, provideShownTabs } from '../code-control.mjs';
import { FAKE_DESK, PNG, readBody, harnessFixture, settled } from './fixtures/harness-page.mjs';

// Scroll is not pointer selection. Reveal the column first, then move into it.
async function hoverBrowser(page) {
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Alt+ArrowRight');
  await settled(page);
  // Into the browser by its bar, which is imperfect's: a page in a frame
  // keeps the pointer to itself. Focus follows the pointer at once.
  await page.mouse.move(2, 2);
  await page.locator('.wm-browser .gui-window-bar').hover({ position: { x: 300, y: 8 } });
}

test('local addresses are found in prose and named localhost; others are left alone', () => {
  assert.equal(localPage('http://127.0.0.1:5173/app?x=1'), 'http://localhost:5173/app?x=1');
  assert.equal(localPage('http://0.0.0.0:3000'), 'http://localhost:3000/');
  assert.equal(localPage('https://example.com/'), '');
  assert.equal(localPage('file:///etc/passwd'), '');
  assert.deepEqual(splitLocal('up at http://localhost:5173/. look'), [
    { text: 'up at ' }, { text: 'http://localhost:5173/', url: 'http://localhost:5173/' }, { text: '. look' },
  ]);
  assert.deepEqual(splitLocal('see https://example.com'), [{ text: 'see https://example.com' }]);
  assert.equal(pageLabel('http://localhost:5173/about'), ':5173/about');
  assert.deepEqual(splitLocal('rendered to ~/out/intro.mp4, and http://localhost:5173/a.png is a page'), [
    { text: 'rendered to ' }, { text: '~/out/intro.mp4', file: '~/out/intro.mp4' }, { text: ', and ' },
    { text: 'http://localhost:5173/a.png', url: 'http://localhost:5173/a.png' }, { text: ' is a page' },
  ]);
  assert.equal(localFile('file:///home/me/My%20Poster.png'), '/home/me/My Poster.png');
  assert.equal(localFile('/etc/passwd'), '', 'only what a window can play');
  assert.equal(localFile('src/app.png'), '', 'a relative path is not known to be anywhere until the session folder is');
  setFileBase('/home/me/work/');
  assert.equal(localFile('bouncing-ball/index.html'), '/home/me/work/bouncing-ball/index.html', 'then it is in that folder');
  assert.equal(localFile('../out/a.png'), '/home/me/out/a.png');
  assert.deepEqual(splitLocal('a one-file game at bouncing-ball/index.html, have a go').map(part => part.file).filter(Boolean), ['/home/me/work/bouncing-ball/index.html']);
  assert.deepEqual(splitLocal('see https://example.com/a.png and imperfect.computer').filter(part => part.file), [], 'web addresses and domains are not files');
  setFileBase('');
});

test('the show tool answers in the line the conversation reads', async () => {
  assert.deepEqual(windowOf(await runShow({ path: 'http://127.0.0.1:5173/play', shape: 'portrait' })), { shape: 'landscape', target: 'http://localhost:5173/play', tab: true }, 'a page opens as a browser tab');
  assert.deepEqual(windowOf('Shown in the conversation, in a portrait window: /w/clip.mp4'), { shape: 'portrait', target: '/w/clip.mp4', tab: false });
  assert.deepEqual([inBrowser('http://localhost:5173/'), inBrowser('/w/city.html'), inBrowser('/w/menu.pdf'), inBrowser('/w/clip.mp4'), inBrowser('/w/a.png'), inBrowser('/w/song.mp3')], [true, true, true, false, false, false]);
  assert.deepEqual([shownName('/w/kids/city/index.html'), shownName('/w/kids/city.html'), shownName('http://localhost:5173/x'), shownName('https://news.example/a')], ['city', 'city.html', ':5173/x', 'news.example']);
  // The addresses show gives (system/shown.mjs), read back.
  const desk = 'https://desk.tail.ts.net:8443';
  assert.deepEqual([`${desk}/shown/w/city.html`, `${desk}/shown/w/menu.pdf`, `${desk}/shown/w/a.png`, `${desk}/shown/w/clip.mp4`, `${desk}/port/5173/`, 'https://demo-5173.imperfect.computer/'].map(inBrowser), [true, true, false, false, true, true]);
  assert.deepEqual([shownName(`${desk}/shown/w/kids/city/index.html`), shownName(`${desk}/port/5173/x?y=1`), shownName('http://127.0.0.1:5068/shown/w/My%20Poster.png')], ['city', ':5173/x?y=1', 'My Poster.png']);
  assert.deepEqual(splitLocal('at http://127.0.0.1:5068/shown/w/a.html.').map(part => part.url).filter(Boolean), ['http://127.0.0.1:5068/shown/w/a.html'], 'one on this computer alone is not renamed localhost: that is another origin');
  const raw = `${desk}/files/raw?path=${encodeURIComponent('/w/My Poster.png')}`;
  assert.equal(inBrowser(raw), false, 'raw image query remains an image, not a browser tab');
  assert.equal(shownName(raw), 'My Poster.png');
  assert.equal(inBrowser(`${desk}/files/raw?path=${encodeURIComponent('/w/clip.mp4')}`), false);
  assert.equal(inBrowser(`${desk}/files/raw?path=${encodeURIComponent('/w/menu.pdf')}`), true);
  assert.equal(windowOf('A landscape window is at work in the conversation'), null, 'no window stands in for one being made');
  assert.equal(windowOf('Opened a Pi session'), null);
});

// A conversation alone in its strip of windows, and pages mounted on it.
const STRIP = output => `<body class="imperfect"><link rel="stylesheet" href="/css/imperfect.css"><link rel="stylesheet" href="/css/gui-transcript.css"><style>.canvas-strip{position:relative;height:90vh}.wm-window{position:absolute;overflow:hidden}</style><div class="canvas-strip"><section class="code-face"><div id="entry-output">${output}</div></section></div>`;
const MOUNT_PAGES = async base => {
  const { mountPages } = await import('/js/pages.js');
  const { mountWindows } = await import('/js/windows.js');
  globalThis.wm = mountWindows({ conversation: document.querySelector('.code-face') });
  globalThis.pages = mountPages({ output: document.querySelector('#entry-output'), wm, base: () => base });
};

test('in the desktop window everything opens as a tab in one browser, one page at a time, and agents work in tabs behind', async () => {
  const root = new URL('../public/', import.meta.url);
  const added = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(STRIP('<p><a data-page="http://localhost:5173/app" href="#">local</a> <a data-file="/w/kids/menu.pdf">menu</a></p>')); return; }
    // This computer says where a thing named by its path or local address plays.
    if (path === '/shown/add' || path === '/shown/view') { const body = await readBody(req); const asked = body.target ?? body.path; if (!/^https:\/\//.test(asked)) added.push(asked); res.end(JSON.stringify({ ...(path === '/shown/view' ? { stream: false } : {}), url: asked.startsWith('http://localhost:') ? `https://desk.tail.ts.net:8443/port/5173${new URL(asked).pathname}` : asked.startsWith('http') ? asked : `https://desk.tail.ts.net:8443/shown${asked}` })); return; }
    try { res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(new URL(path.slice(1), root))); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/`);
    await page.evaluate(FAKE_DESK);
    await page.evaluate(MOUNT_PAGES, '');
    // The tabs as the browser holds them, in order: the one in front starred.
    const tabs = () => page.evaluate(() => pages.tabs().map(tab => `${tab.label}${tab.el.classList.contains('front') ? ' *' : ''}${tab.driving ? ' (driven)' : ''}`));
    const views = page.locator('.wm-browser .browser-page webview');
    const stripTabs = page.locator('.wm-browser .browser-tab');
    const listed = () => stripTabs.evaluateAll(entries => entries.map(e => `${e.querySelector('.browser-tab-title').textContent}${e.classList.contains('front') ? ' *' : ''}${e.classList.contains('driven') ? ' (driven)' : ''}`));

    // A website the window was asked for (a link anywhere in it).
    await page.evaluate(() => browseFromWindow({ url: 'https://example.com/a' }));
    const address = page.locator('.wm-browser .gui-window-address');
    assert.equal(await views.first().getAttribute('src'), 'https://example.com/a');
    assert.equal(await address.inputValue(), 'https://example.com/a');
    assert.deepEqual(await tabs(), ['example.com *']);
    assert.equal(await stripTabs.count(), 1, 'one tab still has a visible strip');
    assert.equal(await page.locator('.browser-tab-strip').isVisible(), true);
    assert.equal(await page.locator('.browser-count, .browser-list').count(), 0, 'the hover list is gone');
    assert.deepEqual(await page.locator('.browser-controls button').evaluateAll(buttons => buttons.map(b => [b.getAttribute('aria-label'), b.disabled])),
      [['Back', true], ['Forward', true], ['Reload', false]], 'navigation controls remain in the lower row');
    await page.waitForFunction(() => deskSaid.some(([what]) => what === 'front'));
    assert.deepEqual(await page.evaluate(() => deskSaid), [['front', 101]], 'the window is told which tab is in front');

    // Where the page goes, the address follows; its title names the tab.
    await views.first().evaluate(v => { v.back = 1; v.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://example.com/b' })); });
    assert.equal(await address.inputValue(), 'https://example.com/b');
    assert.equal(await page.locator('.gui-window-go[aria-label=Back]').isDisabled(), false);
    await views.first().evaluate(v => v.dispatchEvent(Object.assign(new Event('did-navigate-in-page'), { url: 'https://ads.example/frame', isMainFrame: false })));
    assert.equal(await address.inputValue(), 'https://example.com/b', 'a frame inside it is not where it is');
    await views.first().evaluate(v => v.dispatchEvent(Object.assign(new Event('page-title-updated'), { title: 'Example B' })));
    assert.equal(await address.getAttribute('title'), 'Example B');
    assert.deepEqual(await tabs(), ['Example B *']);
    await page.click('.gui-window-go[aria-label=Back]');
    await page.click('.gui-window-go[aria-label=Reload]');
    assert.deepEqual(await views.first().evaluate(v => [v.wentBack, v.reloaded]), [true, 1]);
    await address.fill('imperfect.computer');
    await address.press('Enter');
    assert.equal(await views.first().getAttribute('src'), 'https://imperfect.computer/');
    await page.locator('#entry-output').click();
    await views.first().evaluate(v => v.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://imperfect.computer/' })));

    // An agent's browser opens a visible tab behind the one in front.
    await page.evaluate(() => browseFromWindow({ url: 'http://127.0.0.1:9/x', behind: true }));
    assert.deepEqual(await tabs(), ['imperfect.computer *', ':9/x']);
    assert.equal(await views.nth(1).getAttribute('src'), 'http://127.0.0.1:9/x', 'not renamed localhost');
    assert.equal(await stripTabs.count(), 2);
    // The agent closes it when done.
    await page.evaluate(() => tabFromWindow({ id: 102, do: 'close' }));
    assert.equal(await stripTabs.count(), 1);
    await page.evaluate(() => browseFromWindow({ url: 'https://news.example/', behind: true }));
    assert.deepEqual(await tabs(), ['imperfect.computer *', 'news.example']);
    assert.equal(await address.inputValue(), 'https://imperfect.computer/', 'the bar stays with the tab in front');
    // Behind is still full size and drawn: stacked under the one in front, not hidden.
    const sizes = await page.locator('.wm-browser .browser-page').evaluateAll(pages => pages.map(p => { const r = p.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), getComputedStyle(p).display, getComputedStyle(p).visibility, Number(getComputedStyle(p).zIndex)]; }));
    assert.deepEqual(sizes[0].slice(0, 2), sizes[1].slice(0, 2));
    assert.ok(sizes[0][0] > 400 && sizes[0][1] > 400, JSON.stringify(sizes));
    assert.deepEqual(sizes.map(([, , display, visibility, z]) => [display, visibility, z]), [['block', 'visible', 1], ['block', 'visible', 0]]);
    // The agent's tab wears a driven state; brought to the front when asked.
    await page.evaluate(() => {
      tabFromWindow({ id: 103, do: 'driving' });
      // A working agent keeps sending activity; one pulse expires after 4s.
      // Slow fixture clicks must not accidentally model an agent going idle.
      window.drivingHeartbeat = setInterval(() => tabFromWindow({ id: 103, do: 'driving' }), 500);
    });
    assert.deepEqual(await tabs(), ['imperfect.computer *', 'news.example (driven)']);
    assert.equal(await stripTabs.nth(1).evaluate(n => n.classList.contains('driven')), true);
    assert.deepEqual(await listed(), ['imperfect.computer *', 'news.example (driven)']);
    await page.evaluate(() => tabFromWindow({ id: 103, do: 'front' }));
    assert.deepEqual(await tabs(), ['imperfect.computer', 'news.example * (driven)']);
    assert.equal(await address.inputValue(), 'https://news.example/');
    assert.deepEqual(await page.evaluate(() => deskSaid.at(-1)), ['front', 103]);
    // A tab is brought to the front directly, without a hover menu.
    await stripTabs.first().click();
    assert.deepEqual((await tabs()).map(t => t.includes('*')), [true, false]);

    // A local page and a file named in the conversation open as tabs of the
    // same browser, in front; again, the tab already open comes to the front.
    await page.click('a[data-page]');
    await views.nth(2).waitFor({ state: 'attached' });
    await page.click('a[data-file]');
    await views.nth(3).waitFor({ state: 'attached' });
    await page.click('a[data-page]');
    await page.waitForFunction(() => document.querySelector('.browser-page.front webview')?.getAttribute('src')?.includes('/port/5173/app'));
    assert.equal(await page.locator('.wm-browser').count(), 1, 'one browser');
    assert.deepEqual(await tabs(), ['imperfect.computer', 'news.example (driven)', ':5173/app *', 'menu.pdf']);
    assert.equal(await stripTabs.count(), 4);
    assert.equal(await views.nth(2).getAttribute('src'), 'https://desk.tail.ts.net:8443/port/5173/app');
    assert.equal(await views.nth(3).getAttribute('src'), 'https://desk.tail.ts.net:8443/shown/w/kids/menu.pdf', 'a webview is given the address its computer said');
    assert.deepEqual(added, ['http://localhost:5173/app', '/w/kids/menu.pdf']);
    await stripTabs.nth(3).click();
    assert.equal(await address.inputValue(), 'https://desk.tail.ts.net:8443/shown/w/kids/menu.pdf', 'the address bar holds its address, as it is');
    // A carried show address is resolved by its owner, behind the tab in
    // front; opened, the same tab comes to the front.
    await page.evaluate(() => pages.shown('https://laptop.tail.ts.net:8443/shown/w/kids/park/index.html'));
    assert.deepEqual((await tabs()).slice(-2), ['menu.pdf *', 'park']);
    await page.evaluate(() => pages.open('https://laptop.tail.ts.net:8443/shown/w/kids/park/index.html'));
    assert.deepEqual((await tabs()).at(-1), 'park *');
    assert.equal(await views.nth(4).getAttribute('src'), 'https://laptop.tail.ts.net:8443/shown/w/kids/park/index.html');
    assert.equal(added.length, 2);
    await page.evaluate(() => wm.closeAt(document.querySelector('.wm-browser .browser-page.front')));

    // Across a reload, the tabs come back.
    assert.deepEqual(await page.evaluate(() => pages.at(wm.list()[0])), ['https://imperfect.computer/', 'https://news.example/', 'https://desk.tail.ts.net:8443/port/5173/app', 'https://desk.tail.ts.net:8443/shown/w/kids/menu.pdf']);

    // Flicking (Alt+Left, Alt+Right) goes round and round.
    assert.equal(await page.evaluate(() => pages.flick(1)), true);
    assert.deepEqual(await tabs(), ['imperfect.computer *', 'news.example (driven)', ':5173/app', 'menu.pdf'], 'after the last, the first');
    await page.evaluate(() => pages.flick(-1));
    assert.deepEqual(await tabs(), ['imperfect.computer', 'news.example (driven)', ':5173/app', 'menu.pdf *'], 'before the first, the last');

    // Alt+W over the browser closes the tab in front, one at a time, then
    // the browser with the last.
    await page.locator('.wm-browser .browser-stack').hover();
    for (const left of [3, 2, 1]) {
      assert.equal(await page.evaluate(() => wm.closeHovered()), true);
      assert.equal((await tabs()).length, left);
    }
    assert.deepEqual(await tabs(), ['imperfect.computer *']);
    await page.evaluate(() => wm.closeHovered());
    assert.equal(await page.locator('.wm-browser:not(.wm-closing)').count(), 0);
    await page.locator('.wm-browser').waitFor({ state: 'detached', timeout: 1000 }); // after Omarchy's close (window-close.js)
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
});

test('what an agent shows opens as a tab in the browser, or plays in the conversation', async () => {
  const site = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<h1 id="built">built ${req.url}</h1>`); });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://localhost:${site.address().port}/`;
  const said = `It is up at ${pageUrl} — have a look. Again, in bold: **${pageUrl}**. The poster is at /w/posters/a.png, and \`/w/posters/b.png\` too.`;
  // Opened before this window was open: a link, not a tab.
  const before = { role: 'toolResult', toolName: 'show', content: [{ type: 'text', text: await runShow({ path: `${pageUrl}old`, session: 'thread-a' }) }] };
  const fixture = await harnessFixture({ messages: [{ role: 'user', content: 'hello' }, before, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] });
  const { page, push } = fixture;
  // The computer tells its windows what show opened as a tab, and for which
  // session (system/server.mjs).
  provideShownTabs(told => fixture.send({ type: 'shown', ...told }));
  const show = async () => ({ role: 'toolResult', toolName: 'show', content: [{ type: 'text', text: await runShow({ path: pageUrl, session: 'thread-a' }) }] });
  try {
    assert.equal(await page.locator('#entry-output .gui-opened a[data-page]').getAttribute('data-page'), `${pageUrl}old`);
    assert.equal(await page.locator('.wm-browser').count(), 0, 'what was opened before is not opened again by reading it');

    // A turn that only talks has no pixels at work.
    push({ ...fixture.tab, busy: true, messages: [...fixture.tab.messages, { role: 'user', content: 'what is 2+2' }] });
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#entry-output canvas').count(), 0, 'no animation while a plain reply is thought');

    // The dock has no Workbench, Apps or browser buttons: Workbench is always open, and things open by asking.
    assert.deepEqual(await page.locator('.session-actions > button[class^="entry-"]').evaluateAll(buttons => buttons.map(b => b.className.split(' ')[0])).then(names => names.filter(name => /files|apps|browser/.test(name))), ['entry-browser']);

    // Shown: the page opens as a tab in the browser beside the conversation,
    // and the conversation keeps a link to it.
    const asked = [...fixture.tab.messages.slice(0, 3), { role: 'user', content: 'make a game' }];
    const shown = await show();
    push({ ...fixture.tab, busy: true, messages: [...asked, shown] });
    const frame = page.frameLocator('.wm-browser .browser-page iframe');
    await frame.locator('#built').waitFor();
    assert.equal(await page.locator('#entry-output .gui-window').count(), 0, 'not in the conversation');
    assert.match(await page.locator('#entry-output .gui-opened').last().textContent(), /^Opened :\d+$/);
    assert.equal(await page.locator('#entry-output .gui-opened a[data-page]').last().getAttribute('data-page'), pageUrl);
    await frame.locator('#built').evaluate(() => { window.playing = 'still'; });

    // The agent's words stream in after it; the tab is not opened again.
    for (const words of ['It is', 'It is up', said]) push({ ...fixture.tab, busy: true, messages: [...asked, shown, { role: 'assistant', content: [{ type: 'text', text: words }] }] });
    const done = [...asked, shown, { role: 'assistant', content: [{ type: 'text', text: said }] }];
    push({ ...fixture.tab, busy: false, messages: done });
    await page.locator(`#entry-output .gui-assistant a[data-page="${pageUrl}"]`).first().waitFor();
    assert.equal(await page.locator('.wm-browser .browser-page').count(), 1);
    assert.equal(await frame.locator('#built').evaluate(() => window.playing), 'still', 'the same page, still playing');
    assert.equal(await page.locator('#entry-output canvas').count(), 0, 'no pixels once the turn is done');
    assert.deepEqual(await page.locator('#entry-output a[data-file]').evaluateAll(links => links.map(a => a.dataset.file)), ['/w/posters/a.png', '/w/posters/b.png'], 'a file it names is a link too, in prose or in code');

    // Changed and shown again: the same tab, still playing, its reload
    // wearing a dot until it is loaded again.
    const reload = page.locator('.wm-browser .gui-window-go[aria-label=Reload]');
    assert.equal(await reload.evaluate(n => n.classList.contains('stale')), false);
    push({ ...fixture.tab, busy: true, messages: [...done, { role: 'user', content: 'make it red' }, await show()] });
    await page.locator('.wm-browser .gui-window-go.stale').waitFor();
    assert.equal(await frame.locator('#built').evaluate(() => window.playing), 'still', 'not loaded again under the person');
    await page.keyboard.press('Alt+ArrowRight'); await page.keyboard.press('Alt+ArrowRight'); // the browser, on the right
    await reload.click();
    // Browser -> Files -> conversation. One step can leave Files focused and
    // covering the link; Playwright's auto-scroll then fights the fixed canvas.
    await page.keyboard.press('Alt+ArrowLeft'); await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForFunction(() => document.querySelector('.canvas-strip').scrollLeft === 0 && !document.querySelector('.wm-moving'));
    const playing = () => frame.locator('#built').evaluate(() => window.playing).catch(() => 'still');
    for (let i = 0; i < 50 && await playing() === 'still'; i++) await page.waitForTimeout(100);
    assert.equal(await playing(), undefined, 'loaded again');
    assert.equal(await reload.evaluate(n => n.classList.contains('stale')), false, 'and the dot is gone');
    assert.equal(await page.locator('.wm-browser .browser-page').count(), 1);

    // Files it names open as tabs of the same browser, the third full-height
    // column, after Files; Alt+W over it closes the tab in front, and with
    // the last the browser, leaving the two original column widths intact.
    await page.locator('#entry-output a[data-file="/w/posters/a.png"]').click();
    await page.locator('.wm-browser img').waitFor();
    const fileSource = src => { const url = new URL(src, 'http://fixture'); assert.match(url.searchParams.get('show') ?? '', /^[0-9a-f-]{36}$/); assert.deepEqual([...url.searchParams.keys()], ['show']); return url.pathname; };
    assert.equal(fileSource(await page.locator('.wm-browser img').getAttribute('src')), '/shown/w/posters/a.png');
    assert.deepEqual(fixture.added, [pageUrl, '/w/posters/a.png'], 'named by its path or local address, a thing is asked where it plays');
    const rect = async selector => (await page.waitForFunction(() => !document.querySelector('.wm-moving')), page.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); }));
    const [cx, cy, cw, ch] = await rect('.entry-screen'), [px, py, pw, ph] = await rect('.wm-browser'), [fx, ftop, fw0, fh0] = await rect('.wm-files');
    assert.ok(cx < fx && fx < px && cy === ftop && ftop === py && ch === fh0 && fh0 === ph && cw === fw0 && fw0 === pw && cw >= 640, 'three readable full-height columns, never stacked or subdivided');
    assert.ok(Math.abs(fx + fw0 - px - 1) <= 1, 'one shared hairline');
    assert.equal((await rect('#entry-input-zone'))[2], 1200, 'one composer beneath all three windows');
    await page.locator('#entry-output a[data-file="/w/posters/b.png"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.wm-browser img').length === 2);
    await page.locator('#entry-output a[data-file="/w/posters/a.png"]').click();
    // Click dispatch is not completion of asynchronous shown/view resolution.
    await page.waitForFunction(() => document.querySelector('.wm-browser .browser-page.front img')?.getAttribute('src')?.includes('/posters/a.png'));
    assert.equal(await page.locator('.wm-browser').count(), 1, 'one browser');
    // What each tab plays, in order, the one in front starred.
    const tabs = () => page.locator('.wm-browser .browser-page').evaluateAll(pages => pages.map(p => { const src = new URL(p.firstElementChild.getAttribute('src'), location.href); return `${src.pathname.split('/').pop() || src.port}${p.classList.contains('front') ? ' *' : ''}`; }));
    assert.deepEqual(await tabs(), [`${site.address().port}`, 'a.png *', 'b.png'], 'a file already open comes to the front, not opened again');
    assert.equal(await page.locator('.wm-browser .browser-tab').count(), 3);
    await page.locator('#entry-output').hover({ position: { x: 20, y: 20 } });
    await page.locator('#entry-input').focus();
    await page.keyboard.press('Alt+w');
    assert.equal((await tabs()).length, 3, 'over the conversation, with the keys there, Alt+W closes nothing');
    await hoverBrowser(page); // the pointer gives the browser its keys
    for (const left of [2, 1]) { await page.keyboard.press('Alt+w'); assert.equal((await tabs()).length, left); }
    await page.keyboard.press('Alt+w');
    assert.equal(await page.locator('.wm-browser:not(.wm-closing)').count(), 0);
    await page.locator('.wm-browser').waitFor({ state: 'detached', timeout: 1000 }); // after Omarchy's close (window-close.js)
    const [, ccy, ccw, cch] = await rect('.entry-screen'), [, fy, fw, fh] = await rect('.wm-files');
    assert.ok(ccy === fy && cch === fh && Math.abs(ccw - fw) < 2 && ccw === cw, 'closing overflow keeps the original column widths');
    // The link in the conversation opens it again.
    await page.locator('#entry-output .gui-opened a[data-page]').last().click();
    await frame.locator('#built').waitFor();

    // Pictures play in the conversation. Two actual show transcript entries
    // for one overwritten file must fetch and display different pixels.
    // no-store alone doesn't defeat Chromium's decoded image reuse while the
    // first window is still in this document.
    const showImage = { role: 'toolResult', toolName: 'show', content: [{ type: 'text', text: 'Shown in the conversation, in a portrait window: /w/posters/edited.png' }] };
    const pngFor = async color => Buffer.from(await page.evaluate(color => { const c = document.createElement('canvas'); c.width = c.height = 1; const ctx = c.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return c.toDataURL('image/png').split(',')[1]; }, color), 'base64');
    const pixel = image => image.evaluate(async img => { await img.decode(); const c = document.createElement('canvas'); c.width = c.height = 1; const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0); return [...ctx.getImageData(0, 0, 1, 1).data]; });
    fixture.poster = await pngFor('#ff0000');
    const firstMessages = [...fixture.tab.messages, showImage];
    push({ ...fixture.tab, busy: false, messages: firstMessages });
    const images = page.locator('#entry-output .gui-window img');
    await images.first().waitFor();
    const box = await page.locator('#entry-output .gui-window').boundingBox();
    assert.ok(Math.abs(box.width / box.height - 9 / 16) < 0.05, `portrait: ${box.width}x${box.height}`);
    assert.deepEqual(await pixel(images.first()), [255, 0, 0, 255]);
    const firstSrc = await images.first().getAttribute('src');
    assert.equal(fileSource(firstSrc), '/shown/w/posters/edited.png');
    await images.first().evaluate(img => { window.firstShownImage = img; });
    fixture.poster = await pngFor('#0000ff');
    push({ ...fixture.tab, messages: [...firstMessages, { role: 'user', content: 'change it' }, showImage] });
    await page.waitForFunction(() => document.querySelectorAll('#entry-output .gui-window img').length === 2);
    assert.deepEqual(await pixel(images.nth(1)), [0, 0, 255, 255]);
    assert.deepEqual(await pixel(images.first()), [255, 0, 0, 255], 'the retained first window keeps its pixels');
    const secondSrc = await images.nth(1).getAttribute('src');
    assert.equal(fileSource(secondSrc), '/shown/w/posters/edited.png');
    assert.notEqual(firstSrc, secondSrc);
    assert.deepEqual(fixture.imageRequests.filter(src => new URL(src, 'http://fixture').pathname.endsWith('/edited.png')), [firstSrc, secondSrc].map(src => { const url = new URL(src); return url.pathname + url.search; }), 'each show fetched exactly once');
    push({ ...fixture.tab, messages: [...fixture.tab.messages, { role: 'assistant', content: [{ type: 'text', text: 'edited' }] }] });
    await page.getByText('edited', { exact: true }).waitFor();
    assert.ok(await images.first().evaluate(img => img === window.firstShownImage), 'redraw retains the image node');
    assert.equal(await images.nth(1).getAttribute('src'), secondSrc, 'redraw does not version again');
    assert.deepEqual(fixture.errors, []);
  } finally {
    provideShownTabs(() => {});
    await fixture.close();
    await new Promise(r => site.close(r));
  }
});

test('in the desktop window Ctrl+T opens a browser tab, and the keys heard inside a website work', async () => {
  const fixture = await harnessFixture({ desk: true, messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] });
  const { page } = fixture;
  try {
    // Ctrl+T opens the browser, blank, its address waiting; again, another
    // tab, even if the previous one is blank. The pointer rests
    // away from the strip: a pointer moving into a window gives it the keys.
    await page.mouse.move(10, 850);
    await page.focus('#entry-input');
    await page.keyboard.press('Control+t');
    const address = page.locator('.wm-browser .gui-window-address');
    await address.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.className), 'gui-window-address');
    assert.equal(await page.locator('.wm-browser webview').getAttribute('src'), 'about:blank');
    await page.keyboard.type('example.com');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.wm-browser webview').getAttribute('src'), 'https://example.com/');
    await page.focus('#entry-input');
    await page.keyboard.press('Control+t');
    assert.equal(await page.locator('.wm-browser').count(), 1, 'one browser');
    assert.equal(await page.locator('.wm-browser .browser-page').count(), 2, 'a second tab');
    assert.deepEqual(await page.evaluate(() => [document.activeElement.className, document.activeElement.value]), ['gui-window-address', ''], 'its address waiting');
    await page.focus('#entry-input');
    await page.keyboard.press('Control+t');
    assert.equal(await page.locator('.wm-browser .browser-page').count(), 3, 'each new-tab command creates a tab');
    // Away from the strip, Alt+W closes the tab with the keys. Revealing an
    // offscreen conversation would deliberately blur the browser address.
    await page.keyboard.press('Alt+w');
    assert.equal(await page.locator('.wm-browser .browser-page').count(), 2);
    await page.keyboard.press('Alt+w');
    assert.equal(await page.locator('.wm-browser .browser-page').count(), 1);
    assert.equal(await page.locator('.wm-browser webview').getAttribute('src'), 'https://example.com/');
    // The desktop window hears the keys inside a website and sends them on
    // (desktop/electron/main.mjs): next/previous select panes, close closes.
    await page.evaluate(() => browseFromWindow({ url: 'https://news.example/', behind: true }));
    const front = () => page.locator('.wm-browser .browser-page.front webview').getAttribute('src');
    await hoverBrowser(page);
    // A pointer dwell intentionally preserves an address control that still
    // owns the browser's keys. Explicitly choose the website for this test.
    await page.locator('.wm-browser .browser-page.front webview').focus();
    await page.waitForFunction(() => document.activeElement?.localName === 'webview');
    // The browser opens on the right: next is its edge.
    await page.evaluate(() => keyFromWindow('next'));
    assert.equal(await front(), 'https://example.com/', 'pane navigation never flicks a tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('src')), 'https://example.com/', 'at the edge the page keeps the keys');
    await page.evaluate(() => keyFromWindow('previous'));
    assert.equal(await front(), 'https://example.com/', 'previous also keeps the tab');
    assert.equal(await page.locator('.wm-files.wm-focused').count(), 1, 'Files, partly out of sight, comes wholly into view');
    await page.evaluate(() => keyFromWindow('next'));
    await page.evaluate(() => keyFromWindow('close'));
    assert.equal(await front(), 'https://news.example/');
    await page.evaluate(() => keyFromWindow('close'));
    assert.equal(await page.locator('.wm-browser:not(.wm-closing)').count(), 0);
    await page.locator('.wm-browser').waitFor({ state: 'detached', timeout: 1000 }); // after Omarchy's close (window-close.js)
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

// Away from the page's computer: named only by its path or local address (an
// older conversation, or the agent's words), a thing is asked of the
// computer the session runs on, which says where it plays: its own page
// listener, loaded from here as it is.
test('a thing on another computer plays from the address that computer answers with', async () => {
  // The laptop's page listener.
  const site = createServer((req, res) => {
    if (req.url.startsWith('/shown/')) { res.setHeader('Content-Type', req.url.includes('.png') ? 'image/png' : 'video/mp4'); res.setHeader('Cache-Control', 'no-store'); res.end(PNG); return; }
    res.setHeader('Content-Type', 'text/html'); res.end(`<h1 id="where">${req.url}</h1>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const pages = `http://127.0.0.1:${site.address().port}`;
  const root = new URL('../public/', import.meta.url);
  const asked = [];
  let fail = true, older = false;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end(STRIP('<p><a data-page="http://localhost:5173/app?x=1" href="#">link</a></p>')); return; }
    if (path === '/peer/laptop/shown/w/posters/a.png') { res.setHeader('Content-Type', 'image/png'); res.end(PNG); return; }
    if (path === '/peer/laptop/shown/add' || path === '/peer/laptop/shown/view') {
      const body = await readBody(req); const thing = body.target ?? body.path;
      if (older) { res.end(JSON.stringify({ path: thing, kind: 'image' })); return; }
      asked.push(thing);
      if (fail) { fail = false; res.writeHead(500).end(JSON.stringify({ error: 'nothing an agent opened is running on port 5173 of that computer' })); return; }
      const local = thing.startsWith('http') ? new URL(thing) : null;
      res.end(JSON.stringify({ ...(path.endsWith('/view') ? { stream: false } : {}), url: local ? `${pages}/port/${local.port}${local.pathname}${local.search}` : `${pages}/shown${thing}` })); return;
    }
    try { res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css'); res.end(await readFile(new URL(path.slice(1), root))); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(MOUNT_PAGES, '/peer/laptop');
    await page.click('a[data-page]');
    await page.getByText('nothing an agent opened is running on port 5173').waitFor();
    assert.equal(await page.evaluate(() => wm.closeAt(document.querySelector('.gui-window-error'))), true);
    await page.click('a[data-page]');
    await page.frameLocator('.gui-window iframe').locator('#where').waitFor();
    assert.equal(await page.frameLocator('.gui-window iframe').locator('#where').textContent(), '/port/5173/app?x=1');
    const sources = await page.evaluate(async () => {
      const { windowNode } = await import('/js/pages.js');
      const picture = windowNode({ target: '/w/posters/a.png' }, { base: '/peer/laptop' });
      const video = windowNode({ target: '/w/clip.mp4' }, { base: '/peer/laptop' });
      document.body.append(picture, video);
      const until = Date.now() + 5000;
      while ((!picture.querySelector('img') || !video.querySelector('video')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      await picture.querySelector('img').decode();
      return [picture.querySelector('img').getAttribute('src'), video.querySelector('video').getAttribute('src')];
    });
    assert.deepEqual(asked, ['http://localhost:5173/app?x=1', 'http://localhost:5173/app?x=1', '/w/posters/a.png', '/w/clip.mp4']);
    const imageURL = new URL(sources[0]);
    assert.equal(`${imageURL.origin}${imageURL.pathname}`, `${pages}/shown/w/posters/a.png`, 'from its own computer');
    assert.match(imageURL.searchParams.get('show') ?? '', /^[0-9a-f-]{36}$/);
    assert.deepEqual([...imageURL.searchParams.keys()], ['show']);
    assert.equal(sources[1], `${pages}/shown/w/clip.mp4`, 'videos keep the address as it is');
    // A computer whose imperfect is older names no address: its files come
    // through it, as it serves them.
    older = true;
    const old = await page.evaluate(async () => {
      const { windowNode } = await import('/js/pages.js');
      const picture = windowNode({ target: '/w/posters/a.png' }, { base: '/peer/laptop' });
      document.body.append(picture);
      await new Promise(resolve => setTimeout(resolve, 200));
      return new URL(picture.querySelector('img').getAttribute('src'), location.href).pathname;
    });
    assert.equal(old, '/peer/laptop/shown/w/posters/a.png');
  } finally { await browser.close(); await new Promise(r => server.close(r)); await new Promise(r => site.close(r)); }
});
