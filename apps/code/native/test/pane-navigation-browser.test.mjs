import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture, settled } from './fixtures/harness-page.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShown } from '../../../../system/shown.mjs';

const messages = [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }];
const key = (page, direction) => page.keyboard.press(`Alt+Arrow${direction}`);
const left = page => page.locator('.canvas-strip').evaluate(n => n.scrollLeft);
const state = page => page.evaluate(() => ({
  focused: document.querySelector('.wm-focused')?.className,
  active: document.activeElement.id || document.activeElement.className,
  draft: document.querySelector('#entry-input').value,
  tabs: [...document.querySelectorAll('.browser-page')].map(n => [n.className, n.querySelector('webview')?.getAttribute('src')]),
  sessions: [...document.querySelectorAll('.tab.selected')].map(n => n.textContent),
}));

// MOD+Left and MOD+Right (Super in the desktop window) move by what is in
// view: the next window out of sight on that side comes wholly into view at
// once and takes the keys, past any already in view; nothing else changes:
// drafts, sessions, the browser's tabs.
for (const width of [1280, 1536]) test(`Super arrows bring the next window out of sight into view with the keys, at once, at ${width}`, async () => {
  const f = await harnessFixture({ desk: true, messages, viewport: { width, height: 864 } });
  const { page } = f;
  const step = direction => page.keyboard.press(`Meta+Arrow${direction}`);
  try {
    await page.locator('.wm-files .workbench').waitFor();
    await page.evaluate(() => { browseFromWindow({ url: 'https://one.example/', behind: true }); browseFromWindow({ url: 'https://two.example/', behind: true }); });
    await page.locator('.wm-browser webview').first().waitFor();
    await page.locator('#entry-input').fill('unsent draft');
    await page.locator('#entry-input').focus();
    const original = await state(page);
    const order = await page.evaluate(() => [...document.querySelectorAll('.canvas-strip > .wm-window')].sort((a, b) => a.style.order - b.style.order).map(n => n.classList.contains('entry-screen') ? 'conversation' : n.classList.contains('wm-files') ? 'files' : 'browser'));
    assert.deepEqual(order, ['conversation', 'files', 'browser'], 'the browser opened in the next place along, on the right');
    assert.equal(await left(page), 0, 'quiet openings leave the view alone');
    const max = await page.locator('.canvas-strip').evaluate(n => n.scrollWidth - n.clientWidth);
    // Two in view, the third out of sight: one press from the conversation
    // shows the browser, past Files, and gives it the keys; no slide.
    await step('Right');
    assert.equal(await left(page), max, 'the browser is wholly in view at once');
    let now = await state(page);
    assert.match(now.focused, /wm-browser/);
    assert.equal(await page.evaluate(() => document.activeElement.localName), 'webview', 'the page in front has the keys');
    await step('Right');
    assert.match((await state(page)).focused, /wm-browser/, 'the right edge: no wrap');
    assert.equal(await left(page), max);
    await step('Left');
    assert.equal(await left(page), 0, 'the conversation, out of sight, is wholly in view at once');
    assert.deepEqual(await state(page), original, 'the draft, tabs and sessions as they were');
    await step('Left');
    assert.deepEqual(await state(page), original, 'the left edge: no wrap');
    assert.equal(await left(page), 0);
    // From inside a website, as the desktop window sends it (desktop/electron/keys.mjs).
    await step('Right');
    await page.evaluate(() => keyFromWindow('previous'));
    assert.match((await state(page)).focused, /entry-screen/);
    await page.evaluate(() => keyFromWindow('next'));
    assert.match((await state(page)).focused, /wm-browser/);
    assert.deepEqual((await state(page)).tabs, original.tabs, 'no tab changed');
    const css = await page.locator('.canvas-strip').evaluate(n => ({ overflow: getComputedStyle(n).overflowX, scrollbar: getComputedStyle(n).scrollbarWidth }));
    assert.deepEqual(css, { overflow: 'hidden', scrollbar: 'none' });
    await page.setViewportSize({ width: 1920, height: 864 });
    await page.waitForTimeout(100);
    assert.ok(await left(page) <= await page.locator('.canvas-strip').evaluate(n => n.scrollWidth - n.clientWidth));
    await page.evaluate(() => keyFromWindow('close'));
    await page.waitForTimeout(100);
    assert.ok(await left(page) <= await page.locator('.canvas-strip').evaluate(n => n.scrollWidth - n.clientWidth));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Super+Up and Super+Down step through the sessions, and the conversation comes into view with the keys', async () => {
  // Narrow enough that Files in view leaves the conversation cut off.
  const f = await harnessFixture({ desk: true, messages, viewport: { width: 1000, height: 864 } });
  const { page } = f;
  try {
    const tab = (id, focused) => ({ id, sessionId: `thread-${id}`, focused, agent: 'pi', name: id, prompt: id, status: 'idle' });
    const view = id => ({ ...f.tab, sessionId: `thread-${id}`, tabs: ['a', 'b', 'c'].map(other => tab(other, other === id)) });
    const asked = [];
    f.answer = c => { if (c.type === 'tab-focus') { asked.push(c.tabId); return { snapshot: view(c.tabId) }; } };
    f.push(view('a'));
    await page.locator('.session-rail-item[data-tab-id="c"]').waitFor();
    await page.evaluate(() => { browseFromWindow({ url: 'https://one.example/', behind: true }); });
    await page.locator('.wm-browser webview').waitFor();
    // From Files, the conversation partly out of sight.
    const whole = () => page.locator('.entry-screen').evaluate(n => { const r = n.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; });
    await page.keyboard.press('Meta+ArrowRight');
    assert.ok(await settled(page) > 0);
    assert.equal(await whole(), false);
    // Shown as the one asked for at once, and come once the view is current.
    const session = id => page.waitForFunction(id => document.querySelector(`[data-tab-id="${id}"]`)?.classList.contains('active') && !document.documentElement.classList.contains('session-turn') && document.querySelector('#entry-output').dataset.fresh === 'fresh', id);
    await page.keyboard.press('Meta+ArrowDown');
    await session('b');
    await page.waitForFunction(() => document.activeElement.id === 'entry-input');
    assert.equal(await settled(page), 0);
    assert.equal(await whole(), true, 'the view follows');
    assert.match((await state(page)).focused, /entry-screen/);
    // Shift is not these keys any more.
    await page.keyboard.press('Meta+Shift+ArrowDown');
    await page.waitForTimeout(150);
    assert.deepEqual(asked, ['b']);
    await page.keyboard.press('Meta+ArrowUp');
    await session('a');
    // Up from the first is the last, as before; from inside a website too.
    await page.evaluate(() => keyFromWindow('up'));
    await session('c');
    await page.evaluate(() => keyFromWindow('down'));
    await session('a');
    assert.deepEqual(asked, ['b', 'a', 'c', 'a']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Super+Down twice before the first session has come: the second steps on from the first', async () => {
  const f = await harnessFixture({ desk: true, messages, viewport: { width: 1000, height: 864 } });
  const { page } = f;
  try {
    const tab = (id, focused) => ({ id, sessionId: `thread-${id}`, focused, agent: 'pi', name: id, prompt: id, status: 'idle' });
    const view = id => ({ ...f.tab, sessionId: `thread-${id}`, tabs: ['a', 'b', 'c'].map(other => tab(other, other === id)) });
    const asked = [];
    f.answer = c => { if (c.type === 'tab-focus') { asked.push(c.tabId); return { snapshot: view(c.tabId) }; } };
    f.push(view('a'));
    await page.locator('.session-rail-item[data-tab-id="c"]').waitFor();
    // Neither b nor c seen before: nothing of theirs to show while they come.
    await page.evaluate(() => { keyFromWindow('down'); keyFromWindow('down'); });
    await page.waitForFunction(() => document.querySelector('[data-tab-id="c"]').classList.contains('active') && document.querySelector('#entry-output').dataset.fresh === 'fresh');
    assert.deepEqual(asked, ['b', 'c']);
    assert.equal(await page.locator('.session-rail-item.active').getAttribute('data-tab-id'), 'c');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('outer strip rejects wheel/trackpad while inner vertical and horizontal content still scroll', async () => {
  const f = await harnessFixture({ desk: true, messages, viewport: { width: 1280, height: 900 } });
  const { page } = f;
  try {
    await page.locator('.workbench').waitFor();
    await page.evaluate(() => browseFromWindow({ url: 'https://one.example/', behind: true }));
    await page.locator('.wm-browser webview').waitFor();
    const anchored = await left(page);
    await page.evaluate(() => {
      const inner = document.createElement('div'); inner.id = 'wheel-content';
      inner.style.cssText = 'position:absolute;left:40px;top:40px;width:240px;height:180px;overflow:auto';
      inner.innerHTML = '<div style="width:1200px;height:2000px">inner content</div>';
      document.querySelector('.entry-screen').append(inner);
    });
    await page.locator('#wheel-content').hover();
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(100);
    assert.ok(await page.locator('#wheel-content').evaluate(n => n.scrollTop) > 0);
    await page.mouse.wheel(150, 0);
    await page.waitForTimeout(100);
    assert.ok(await page.locator('#wheel-content').evaluate(n => n.scrollLeft) > 0, 'legitimate inner horizontal scrolling retained');
    assert.equal(await left(page), anchored);
    await page.locator('.workbench').hover();
    await page.mouse.wheel(150, 0);
    await page.keyboard.down('Shift'); await page.mouse.wheel(0, 150); await page.keyboard.up('Shift');
    await page.waitForTimeout(100);
    assert.equal(await left(page), anchored, 'horizontal and Shift-wheel cannot move outer strip');
    // Whether the pointer resting in Files gave it the keys or the
    // conversation kept them, one step right reaches the browser.
    await key(page, 'Right');
    await page.waitForFunction(() => document.querySelector('.wm-browser.wm-focused'));
    const shifted = await settled(page);
    assert.ok(shifted > anchored, 'the browser came into view');
    await page.mouse.wheel(-150, 0);
    await page.waitForTimeout(100);
    assert.equal(await left(page), shifted);
  } finally { await f.close(); }
});

test('dialogs and menus hold viewport chords', async () => {
  const f = await harnessFixture({ desk: true, messages });
  const { page } = f;
  try {
    await page.locator('.workbench').waitFor();
    await page.evaluate(() => browseFromWindow({ url: 'https://one.example/', behind: true }));
    const anchored = await left(page);
    for (const role of ['menu', 'dialog']) {
      await page.evaluate(role => { const n = document.createElement('div'); n.id = 'hold'; n.setAttribute('role', role); n.innerHTML = '<input>'; document.body.append(n); n.firstChild.focus(); }, role);
      await key(page, 'Right'); await page.evaluate(() => keyFromWindow('next'));
      assert.equal(await settled(page), anchored);
      await page.evaluate(() => document.querySelector('#hold').remove());
    }
    await page.locator('#entry-input').focus();
    await key(page, 'Right');
    assert.ok(await settled(page) > anchored);
  } finally { await f.close(); }
});

test('an owned project frame hands Alt arrows back: the keys move on, the frame keeps its typing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viewport-frame-'));
  const shownKey = Symbol.for('imperfect.shown'); const previous = globalThis[shownKey];
  const shown = createShown({ stateDir: join(dir, 'state'), servers: () => ({ list: () => [] }) });
  await shown.listen();
  const file = join(dir, 'index.html'); await writeFile(file, '<!doctype html><input id="typing">');
  const { url } = await globalThis[shownKey](file);
  // In a browser: in the desktop window Electron hears the chord before the
  // frame does, and the page ignores what a frame says (harness.js).
  const f = await harnessFixture({ messages, viewport: { width: 1280, height: 900 } }); const { page } = f;
  try {
    await page.locator('.workbench').waitFor();
    f.send({ type: 'shown', kind: 'page', target: 'https://one.example/' });
    await page.locator('.wm-browser').waitFor();
    await page.evaluate(url => { const frame = document.createElement('iframe'); frame.src = url; frame.id = 'project-test'; document.querySelector('.wm-files').append(frame); }, url);
    const frame = page.frameLocator('#project-test');
    await frame.locator('#typing').fill('project draft');
    const anchored = await left(page);
    // The conversation and Files in view; the browser opened beyond them.
    await key(page, 'Left');
    await page.waitForFunction(() => document.querySelector('.entry-screen.wm-focused'));
    assert.equal(await frame.locator('#typing').inputValue(), 'project draft');
    // Chromium hands keyboard routing back from the frame a moment after the
    // page's focus moves; a chord pressed in between would still reach it.
    await page.frames().find(n => n.url() === url).waitForFunction(() => !document.hasFocus());
    await key(page, 'Right');
    await page.waitForFunction(() => document.querySelector('.wm-browser.wm-focused'));
    assert.ok(await settled(page) > anchored, 'the browser comes into view, past Files');
    assert.equal(await frame.locator('#typing').inputValue(), 'project draft');
    // A website of another origin cannot hand the chord back: brought by the
    // keys in a web browser, it leaves them on the browser's bar.
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('gui-window-bar')), true);
    await key(page, 'Left');
    await page.waitForFunction(() => document.querySelector('.entry-screen.wm-focused'));
    assert.equal(await settled(page), anchored, 'the conversation, out of sight, comes back past Files');
    assert.equal(await frame.locator('#typing').inputValue(), 'project draft');
    await page.evaluate(() => dispatchEvent(new MessageEvent('message', { data: { type: 'imperfect-pane-step', step: 1 }, source: window })));
    assert.match((await state(page)).focused, /entry-screen/, 'forged source refused');
    await page.locator('#entry-input').focus();
    await page.frames().find(n => n.url() === url).evaluate(() => parent.postMessage({ type: 'imperfect-pane-step', step: 1 }, '*'));
    await page.waitForTimeout(50);
    assert.match((await state(page)).focused, /entry-screen/, 'background frame refused');
  } finally { await f.close(); await shown.close(); globalThis[shownKey] = previous; await rm(dir, { recursive: true, force: true }); }
});

test('in the desktop window a frame\'s word is not taken: Electron hears the chord first, and under sway Alt is Alt', async () => {
  const f = await harnessFixture({ desk: true, messages }); const { page } = f;
  try {
    await page.locator('.workbench').waitFor();
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.srcdoc = '<input id="typing">'; frame.id = 'frame-test'; document.querySelector('.wm-files').append(frame); });
    await page.frameLocator('#frame-test').locator('#typing').focus();
    const before = await state(page);
    assert.equal(before.active, 'frame-test');
    for (const step of [-1, 1]) await page.frames().find(n => n.url() === 'about:srcdoc').evaluate(step => parent.postMessage({ type: 'imperfect-pane-step', step }, '*'), step);
    await page.waitForTimeout(100);
    assert.deepEqual(await state(page), before, 'the frame keeps the keys');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the home computer\'s live browser takes the keys by Alt arrows and lets them go, without a browser action or losing its typing', async () => {
  const f = await harnessFixture({ messages, viewport: { width: 1280, height: 900 } }); const { page } = f;
  try {
    await page.locator('#entry-input').fill('conversation draft');
    await page.evaluate(() => { window.liveActions = []; const send = WebSocket.prototype.send; WebSocket.prototype.send = function(raw) { const said = JSON.parse(raw); if (said.do) liveActions.push(said.do); return send.call(this, raw); }; });
    f.send({ type: 'browse', front: false });
    await page.locator('.wm-live').waitFor();
    const anchored = await left(page);
    // The conversation and Files in view: one press shows the live browser.
    await key(page, 'Right');
    await page.waitForFunction(() => document.querySelector('.wm-live.wm-focused'));
    assert.ok(await settled(page) > anchored, 'the live browser, on the right, comes into view');
    assert.equal(await page.locator('.browser-live-type').count(), 0);
    await page.locator('.wm-live .gui-window-address').focus();
    await page.locator('.wm-live .gui-window-address').fill('address draft');
    const actions = await page.evaluate(() => liveActions.filter(n => n !== 'watch'));
    await key(page, 'Left');
    assert.match((await state(page)).focused, /entry-screen/);
    assert.equal(await settled(page), anchored);
    assert.equal(await page.locator('#entry-input').inputValue(), 'conversation draft');
    await key(page, 'Right');
    await page.waitForFunction(() => document.querySelector('.wm-live.wm-focused'));
    assert.deepEqual(await page.evaluate(() => liveActions.filter(n => n !== 'watch')), actions);
    assert.equal(await page.locator('.wm-live .gui-window-address').inputValue(), 'address draft');
  } finally { await f.close(); }
});

test('phone hardware navigation remains bounded; direct swipe is unchanged', async () => {
  const f = await harnessFixture({ messages, viewport: { width: 390, height: 844 }, hasTouch: true }); const { page } = f;
  try {
    await page.locator('#entry-input').fill('phone draft');
    await key(page, 'Right');
    assert.equal(await page.locator('.wm-files.wm-focused').count(), 1);
    await key(page, 'Right');
    assert.equal(await page.locator('.wm-files.wm-focused').count(), 1);
    await key(page, 'Left');
    assert.equal(await page.locator('.entry-screen.wm-focused').count(), 1);
    assert.equal(await page.locator('#entry-input').inputValue(), 'phone draft');
  } finally { await f.close(); }
});
