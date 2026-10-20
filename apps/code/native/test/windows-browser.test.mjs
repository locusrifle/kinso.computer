// The windows on a desk (public/js/windows.js) in the complete production
// harness: focus following the pointer, keyboard and all, and the windows'
// keys. Only the backend is fake (fixtures/harness-page.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_DESK, harnessFixture, settled } from './fixtures/harness-page.mjs';

const MESSAGES = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi there, a few words to choose' }] }];

// What has the keys: the composer, a tab's page (its address), Workbench,
// the model box's search, or nothing.
const KEYS = () => {
  const a = document.activeElement;
  if (a.id === 'entry-input') return 'composer';
  if (a.localName === 'webview') return `page ${a.getAttribute('src')}`;
  if (a.classList.contains('workbench')) return 'files';
  if (a.closest('#entry-dialog')) return 'dialog';
  return a.localName;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function desk(options = {}) {
  const fixture = await harnessFixture({ desk: true, messages: MESSAGES, viewport: { width: 1536, height: 900 }, ...options });
  const { page } = fixture;
  // Three full-height columns: the conversation, Files, then the browser
  // out of sight on the right.
  await page.locator('.wm-files .workbench').waitFor();
  await page.evaluate(() => { browseFromWindow({ url: 'https://a.example/' }); browseFromWindow({ url: 'https://b.example/', behind: true }); browseFromWindow({ url: 'https://c.example/', behind: true }); });
  await page.waitForFunction(() => !document.querySelector('.wm-moving'));
  const keys = () => page.evaluate(KEYS);
  const box = async selector => { const b = await page.locator(selector).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  // The pointer moved into a window, which takes the keys at once. Out of
  // view, the keys bring it first (MOD+Left/Right).
  const into = async (selector, wait = 0) => {
    await page.locator(selector).evaluate(n => {
      const w = n.closest('.wm-window'), s = document.querySelector('.canvas-strip');
      if (!w || s.querySelector('.wm-full')) return;
      const away = () => { const left = Math.max(0, w.offsetLeft + 1), right = left + w.offsetWidth - 1; return left < s.scrollLeft ? -1 : right > s.scrollLeft + s.clientWidth ? 1 : 0; };
      for (let i = 0, d; i < 4 && (d = away()); i++) keyFromWindow(d < 0 ? 'previous' : 'next');
    });
    const { x, y } = await box(selector);
    // Even when two successive columns land under the same screen position,
    // this helper means an actual pointer choice, not a stationary pointer.
    await page.mouse.move(2, 2);
    await page.mouse.move(x, y, { steps: 4 }); await pause(wait);
  };
  const front = () => page.locator('.wm-browser .browser-page.front webview').getAttribute('src');
  const focused = () => page.evaluate(() => document.querySelector('.wm-focused').className.replace('entry-screen', 'code-face').match(/code-face|wm-browser|wm-files/)[0]);
  // Where each window is placed, by its kind.
  const slots = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.canvas-strip > .wm-window')].sort((a, b) => a.style.order - b.style.order).map(w => [w.className.replace('entry-screen', 'code-face').match(/code-face|wm-browser|wm-files/)[0], ['left', 'top', 'width', 'height'].map(k => k === 'left' && w.classList.contains('wm-full') ? '0px' : w.style[k]).join(' ')])));
  return { fixture, page, keys, into, front, focused, slots };
}

test('on a desk Workbench is always open: beside the conversation from the start, never closed, made full and back, focused by Show in Folder, and no button for it in the dock', async () => {
  const fixture = await harnessFixture({ desk: true, messages: MESSAGES, viewport: { width: 1536, height: 900 } });
  const { page } = fixture;
  try {
    await page.locator('.wm-files .workbench').waitFor();
    await page.waitForFunction(() => !document.querySelector('.wm-moving'));
    const slots = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.canvas-strip > .wm-window')].sort((a, b) => a.style.order - b.style.order).map(w => [w.className.replace('entry-screen', 'code-face').match(/code-face|wm-browser|wm-files/)[0], ['left', 'top', 'width', 'height'].map(k => parseFloat(w.style[k]))])));
    const KEYS_ = () => document.activeElement.classList.contains('workbench') ? 'files' : document.activeElement.id;
    // Side by side, the conversation first, each half the canvas.
    const tiled = await slots();
    assert.deepEqual(Object.keys(tiled), ['code-face', 'wm-files']);
    const [cx, cy, cw, ch] = tiled['code-face'], [fx, fy, fw, fh] = tiled['wm-files'];
    assert.ok(cx < fx && cy === fy && ch === fh && Math.abs(cw - fw) <= 1, JSON.stringify(tiled));
    // Hard against each other and the window's edges: one rule where they
    // meet, and the rules round the outside just past the edge, unseen.
    const [width, height] = await page.evaluate(() => [document.querySelector('.canvas-strip').clientWidth, document.querySelector('.canvas-strip').clientHeight]);
    assert.ok(cx === -1 && cy === -1 && ch === height + 2 && fx === cx + cw - 1 && fx + fw === width, JSON.stringify(tiled));
    assert.equal(await page.locator('.entry-files').count(), 0, 'no Workbench button in the dock');
    assert.equal(await page.evaluate(KEYS_), 'entry-input', 'the input bar keeps the keys');

    // Alt+W over it, or over the conversation: nothing closes. (Alt, which
    // the desktop window answers as it does Super.)
    await page.locator('.wm-files .workbench').hover();
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(KEYS_), 'files');
    await page.keyboard.press('Alt+w');
    await page.keyboard.press('Escape');
    assert.deepEqual(Object.keys(await slots()), ['code-face', 'wm-files']);
    assert.equal(await page.locator('.wm-files .workbench').isVisible(), true);

    // Alt+F: full, and back.
    await page.keyboard.press('Alt+f');
    await page.waitForFunction(() => !document.querySelector('.wm-moving'));
    assert.equal(await page.locator('.wm-files.wm-full').count(), 1);
    await page.keyboard.press('Alt+f');
    await page.waitForFunction(() => !document.querySelector('.wm-moving'));
    assert.deepEqual(await slots(), tiled);

    // Explicitly showing Files focuses it, where it is; a folder opened from
    // elsewhere (imperfect-open files, Show in Folder) brings it there.
    await page.locator('#entry-input').focus();
    await page.evaluate(() => harness.showFiles());
    assert.equal(await page.evaluate(KEYS_), 'files');
    assert.equal(await page.evaluate(() => document.querySelector('.wm-focused').classList.contains('wm-files')), true);
    await page.locator('#entry-input').focus();
    await page.evaluate(() => harness.openFiles('/fixture'));
    await page.waitForFunction(() => document.querySelector('.workbench-crumb[aria-current="page"]')?.textContent === 'fixture');
    assert.equal(await page.evaluate(KEYS_), 'files');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('on a desk focus follows the pointer at once, keys and all, only when it moves, and never moves the view', async () => {
  const { fixture, page, keys, into } = await desk();
  const left = () => page.locator('.canvas-strip').evaluate(n => n.scrollLeft);
  try {
    await page.locator('#entry-input').focus();
    const conversation = await page.locator('#entry-output').boundingBox();
    await page.mouse.move(conversation.x + 40, conversation.y + 40, { steps: 2 });
    assert.equal(await keys(), 'composer');
    // Bring the browser into view, then give the keys back to the composer.
    await page.evaluate(() => keyFromWindow('next'));
    await page.locator('#entry-input').focus();
    const view = await left();
    assert.ok(view > 0);
    // Into the browser: the page in front has the keys at once.
    const stack = await page.locator('.wm-browser .browser-stack').boundingBox();
    await page.mouse.move(stack.x + stack.width / 2, stack.y + stack.height / 2, { steps: 2 });
    assert.equal(await keys(), 'page https://a.example/', 'at once, no pause');
    // Files: its list. The conversation: the input bar, ready to type.
    const files = await page.locator('.wm-files .workbench').boundingBox();
    await page.mouse.move(files.x + files.width / 2, files.y + files.height / 2, { steps: 2 });
    assert.equal(await keys(), 'files');
    assert.equal(await left(), view, 'the pointer never moves the view');
    await into('#entry-output');
    assert.equal(await keys(), 'composer');

    // A window the keys bring under a still pointer does not take them from
    // the one they brought: the conversation and Files in view, the pointer
    // resting over the conversation, MOD+Right shows the browser, and Files
    // comes to where the pointer is.
    await page.evaluate(() => keyFromWindow('next'));
    assert.equal(await keys(), 'page https://a.example/');
    const under = await page.evaluate(([x, y]) => document.elementFromPoint(x, y).closest('.wm-window').className, [conversation.x + 40, conversation.y + 40]);
    assert.match(under, /wm-files/);
    await pause(50);
    assert.equal(await keys(), 'page https://a.example/', 'Files, come to the still pointer, did not take them');
    await page.evaluate(() => keyFromWindow('previous'));
    assert.equal(await keys(), 'composer');

    // A window coming to a pointer that is still moves nothing, and nor do
    // pointer events a script makes up.
    await into('.wm-browser .browser-stack');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Alt+w');
    assert.equal(await page.locator('.wm-browser:not(.wm-closing)').count(), 0);
    await page.locator('.wm-browser').waitFor({ state: 'detached', timeout: 1000 }); // after Omarchy's close (window-close.js)
    await page.waitForFunction(() => !document.querySelector('.wm-moving'));
    const face = await page.locator('.entry-screen').boundingBox();
    const resting = [face.x + face.width * 0.8, face.y + face.height * 0.8];
    await page.mouse.move(...resting, { steps: 4 });
    await pause(200);
    assert.equal(await keys(), 'composer');
    await page.evaluate(() => browseFromWindow({ url: 'https://d.example/', behind: true }));
    await pause(500);
    assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y).closest('.wm-window').classList.contains('entry-screen'), resting), true, 'a quiet opening never comes to the resting pointer');
    assert.equal(await keys(), 'composer', 'and the pointer did not move');
    await page.evaluate(() => {
      const target = document.querySelector('.wm-files .workbench');
      for (const type of ['pointerover', 'pointermove']) target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: 9, clientY: 9, pointerType: 'mouse' }));
    });
    await pause(250);
    assert.equal(await keys(), 'composer', 'made-up events move nothing');

    // Text chosen in the conversation stays chosen to copy: the input bar
    // does not take the keys, and the page that had them lets them go.
    await into('.wm-browser .browser-stack');
    assert.equal(await keys(), 'page https://d.example/');
    await page.evaluate(() => getSelection().selectAllChildren(document.querySelector('#entry-output .gui-assistant')));
    await into('#entry-output');
    assert.equal(await keys(), 'body', 'nobody has the keys but the page they are on, so a copy is of the chosen text');
    assert.match(await page.evaluate(() => getSelection().toString()), /a few words to choose/);
    await page.evaluate(() => getSelection().removeAllRanges());
    await into('.wm-browser .browser-stack');
    await into('#entry-output');
    assert.equal(await keys(), 'composer', 'nothing chosen, the input bar again');

    // A box open in the conversation (the model box) keeps the keys.
    fixture.answer = c => (c.type === 'models' ? [{ provider: 'fixture', id: 'fixture', name: 'Fixture', engine: 'pi' }] : undefined);
    await page.locator('#entry-pi-label').click();
    await page.locator('#entry-dialog .compact-search').waitFor();
    assert.equal(await keys(), 'dialog');
    await into('.wm-browser .browser-stack');
    assert.equal(await keys(), 'dialog', 'the model box keeps the keys');
    await page.keyboard.press('Escape');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('the windows\' keys, held with Super in the desktop window: Super+W, Super+Left and Super+Right, Super+F, Super+Shift+Left and Super+Shift+Right, and Alt for them too', async () => {
  const { fixture, page, keys, into, front, focused, slots } = await desk();
  try {
    // Tabs are always exposed, independently of pane-navigation keys.
    assert.equal(await page.locator('.wm-browser .browser-tabs').count(), 1);
    assert.equal(await page.locator('.wm-browser .browser-tab').count(), 3);

    // Super+Left and Super+Right: the next window out of sight on that side
    // comes wholly into view with the keys, at once; at either edge nothing
    // moves. The browser tab in front is never changed by it.
    const left = () => page.locator('.canvas-strip').evaluate(n => n.scrollLeft);
    await into('.wm-browser .browser-stack');
    assert.equal(await front(), 'https://a.example/');
    const max = await left();
    assert.ok(max > 0);
    // The browser opened in the last place: the right edge.
    await page.keyboard.press('Meta+ArrowRight');
    assert.equal(await focused(), 'wm-browser', 'right edge: no wrap');
    assert.equal(await keys(), 'page https://a.example/');
    // The conversation is out of sight, Files in view beside: one press.
    await page.keyboard.press('Meta+ArrowLeft');
    assert.equal(await focused(), 'code-face');
    assert.equal(await keys(), 'composer');
    assert.equal(await left(), 0, 'the conversation brought into view');
    await page.keyboard.press('Meta+ArrowLeft');
    assert.equal(await focused(), 'code-face', 'left edge: no wrap');
    await page.keyboard.press('Meta+ArrowRight');
    assert.equal(await focused(), 'wm-browser', 'past Files, already in view');
    assert.equal(await left(), max, 'the browser brought into view');
    // The native desktop forwards the same chord from inside a website.
    await page.evaluate(() => keyFromWindow('previous'));
    assert.equal(await focused(), 'code-face');
    await page.evaluate(() => keyFromWindow('next'));
    assert.equal(await focused(), 'wm-browser');
    assert.equal(await keys(), 'page https://a.example/');
    assert.equal(await front(), 'https://a.example/', 'no tab flick');

    // Super+F: the focused window fills the canvas, the others keep their
    // places beneath it; again, the layout is back. The conversation too.
    await into('#entry-output');
    const tiled = await slots();
    const canvas = await page.evaluate(() => { const s = document.querySelector('.canvas-strip'); return `0px 0px ${s.clientWidth}px ${s.clientHeight}px`; });
    await page.keyboard.press('Meta+f');
    assert.deepEqual(await slots(), { ...tiled, 'code-face': canvas });
    assert.equal(await page.locator('.entry-screen.wm-full').count(), 1);
    await page.keyboard.press('Meta+f');
    assert.deepEqual(await slots(), tiled);
    assert.equal(await page.locator('.wm-full').count(), 0);
    await into('.wm-browser .browser-stack');
    await page.evaluate(() => keyFromWindow('full'));
    assert.deepEqual(await slots(), { ...tiled, 'wm-browser': canvas });
    // An agent opening a tab behind leaves it so; a window shown ends it.
    await page.evaluate(() => browseFromWindow({ url: 'https://e.example/', behind: true }));
    assert.equal(await page.locator('.wm-browser.wm-full').count(), 1);
    await page.evaluate(() => harness.openFiles(''));
    assert.deepEqual(await slots(), tiled);

    // Super+Shift+Right: every column one slot along; focus stays with the
    // slot, so the window that came is focused,
    // with the keys. Super+Shift+Left: back.
    await into('.wm-files .workbench');
    assert.equal(await focused(), 'wm-files');
    await page.keyboard.press('Meta+Shift+ArrowRight');
    assert.deepEqual(await slots(), { 'code-face': tiled['wm-files'], 'wm-browser': tiled['code-face'], 'wm-files': tiled['wm-browser'] });
    assert.equal(await focused(), 'code-face', 'the slot Files was in is focused, and the conversation is in it');
    assert.equal(await keys(), 'composer');
    await page.keyboard.press('Meta+Shift+ArrowLeft');
    assert.deepEqual(await slots(), tiled);
    assert.equal(await focused(), 'wm-files');
    assert.equal(await keys(), 'files');
    // Alt answers too, unannounced (a window manager may keep Super), but
    // not with Super: together they are neither.
    await page.keyboard.press('Alt+Shift+ArrowRight');
    assert.equal(await focused(), 'code-face');
    await page.keyboard.press('Meta+Alt+Shift+ArrowLeft');
    assert.equal(await focused(), 'code-face');
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    assert.deepEqual(await slots(), tiled);
    assert.equal(await focused(), 'wm-files');
    // From inside a website, as the desktop window sends it.
    await page.evaluate(() => keyFromWindow('along'));
    assert.equal(await focused(), 'code-face');
    await page.evaluate(() => keyFromWindow('back'));
    assert.equal(await focused(), 'wm-files');

    // Super+W: over the browser, the tab in front, one at a time, then the
    // browser with the last; never Workbench or the conversation.
    await into('.wm-browser .browser-stack');
    for (const left of [3, 2, 1]) { await page.keyboard.press('Meta+w'); assert.equal(await page.locator('.wm-browser .browser-page').count(), left); }
    await page.keyboard.press('Meta+w');
    assert.equal(await page.locator('.wm-browser:not(.wm-closing)').count(), 0);
    await page.locator('.wm-browser').waitFor({ state: 'detached', timeout: 1000 }); // after Omarchy's close (window-close.js)
    await into('.wm-files .workbench');
    await page.keyboard.press('Meta+w');
    assert.equal(await page.locator('.wm-files').count(), 1);
    assert.equal(await keys(), 'files', 'and the keys stay with it');
    await into('#entry-output');
    await page.keyboard.press('Meta+w');
    assert.equal(await page.locator('.code-face').count(), 1);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('a window full screen: Super+Shift+Enter lays the agents and the input bar over it to prompt, and Escape takes them away', async () => {
  // Super+Shift+Enter is the scrolling and dwindle layouts' (focus has Super+F alone).
  const { fixture, page, keys, into, slots } = await desk({ layout: 'scrolling' });
  try {
    const prompts = [];
    fixture.answer = c => { if (c.type === 'prompt') { prompts.push(c.text); return { accepted: true }; } };
    const rect = async selector => (await page.waitForFunction(() => !document.querySelector('.wm-moving')), page.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); }));
    // What a click lands on, at the middle of a thing.
    const under = selector => page.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).closest('#session-rail, #entry-input-zone, .wm-browser, .entry-screen'); return at?.id || at?.className.match(/wm-browser|entry-screen/)?.[0]; });
    const over = () => page.locator('.code-face.wm-over').count();
    // Nothing full: there is nothing to lay the bars over.
    await into('.wm-browser .browser-stack');
    await page.keyboard.press('Meta+Shift+Enter');
    assert.equal(await over(), 0);
    // The browser full, its page with the keys.
    const canvas = await page.evaluate(() => { const s = document.querySelector('.canvas-strip'); return `0px 0px ${s.clientWidth}px ${s.clientHeight}px`; });
    await page.keyboard.press('Meta+f');
    assert.equal((await slots())['wm-browser'], canvas);
    assert.equal(await keys(), 'page https://a.example/');
    // Super+Shift+Enter: the agents' strip and the input bar over it, the input
    // bar with the keys, and the page still in sight (and in reach) between them.
    await page.keyboard.press('Meta+Shift+Enter');
    assert.equal(await over(), 1);
    assert.deepEqual(await rect('.entry-screen'), await rect('.wm-browser'), 'conversation middle overlays the full browser');
    assert.equal(await page.locator('#entry-input-zone').isVisible(), true, 'shared composer stays outside the tiled middle');
    assert.equal((await slots())['wm-browser'], canvas, 'still full');
    assert.equal(await under('#session-rail'), 'session-rail');
    assert.equal(await under('#entry-input-zone'), 'entry-input-zone');
    assert.equal(await under('.entry-screen'), 'wm-browser', 'between the bars, the page');
    assert.equal(await keys(), 'composer');
    await page.keyboard.type('make it red');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('entry-input').value === '');
    assert.deepEqual(prompts, ['make it red']);
    // Escape: away, the keys back with the page, still full.
    await page.keyboard.press('Escape');
    assert.equal(await over(), 0);
    assert.equal((await slots())['wm-browser'], canvas);
    assert.equal(await keys(), 'page https://a.example/');
    // From inside a website, as the desktop window sends it: there, and away.
    await page.evaluate(() => keyFromWindow('over'));
    assert.equal(await over(), 1);
    assert.equal(await keys(), 'composer');
    await page.evaluate(() => keyFromWindow('over'));
    assert.equal(await over(), 0);
    // Out of full screen they go with it.
    await page.keyboard.press('Meta+Shift+Enter');
    await page.keyboard.press('Meta+f');
    assert.equal(await over(), 0);
    assert.notEqual((await slots())['wm-browser'], canvas);
    assert.equal(await page.locator('.wm-full').count(), 0);

    // The keys sheet teaches it, by Super's name only.
    const taught = await page.evaluate(async () => (await import('/js/pi-card.js')).activeKeyBindings());
    assert.ok(taught.some(k => k.label === 'Super+Shift+Enter'));
    assert.deepEqual(taught.filter(k => /\bAlt\b/.test(k.label)), []);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('one layout for every session: switching changes only the conversation, what any session shows opens behind in the shared windows, closing a session closes only its conversation, and a reload brings the layout back', async () => {
  // A window full in the strip, as the scrolling layout has it.
  const { fixture, page, keys, into, front, slots } = await desk({ layout: 'scrolling' });
  try {
    const tab = (id, sessionId, focused) => ({ id, sessionId, focused, agent: 'pi', name: id, status: 'idle' });
    const view = (focused, tabs = [['tab-a', 'thread-a'], ['tab-b', 'thread-b']]) => fixture.push({ ...fixture.tab, sessionId: tabs.find(([id]) => id === focused)[1], tabs: tabs.map(([id, session]) => tab(id, session, id === focused)) });
    const settled = () => page.waitForFunction(() => !document.querySelector('.wm-moving'));
    const whole = await page.evaluate(() => { const s = document.querySelector('.canvas-strip'); return `0px 0px ${s.clientWidth}px ${s.clientHeight}px`; });

    // The first session: the browser full, Files beside it.
    view('tab-a');
    await into('.wm-browser .browser-stack');
    await page.keyboard.press('Alt+f');
    await settled();
    const layout = await slots();
    assert.equal(layout['wm-browser'], whole);
    assert.deepEqual(Object.keys(layout), ['code-face', 'wm-files', 'wm-browser']);

    // Another session: only the conversation changes. The windows are where
    // they were, the browser still full, its tabs the same.
    view('tab-b');
    await page.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-b');
    await settled();
    assert.deepEqual(await slots(), layout);
    assert.equal(await page.locator('.wm-browser webview').count(), 3);

    // The first session's agent opens a tab and shows a page: both in the
    // one browser, behind the tab in front; the person keeps their eyes and keys.
    await page.keyboard.press('Alt+f');
    await settled();
    await page.evaluate(() => harness.showFiles());
    assert.equal(await keys(), 'files');
    await page.evaluate(() => browseFromWindow({ url: 'https://f.example/', behind: true, session: 'thread-a' }));
    fixture.send({ type: 'shown', session: 'thread-a', target: '/fixture/game/guide.pdf' });
    await page.waitForFunction(() => document.querySelectorAll('.wm-browser webview').length === 5);
    assert.equal(await front(), 'https://a.example/', 'still the tab in front');
    assert.equal(await keys(), 'files', 'and the keys where they were');
    assert.equal(await page.locator('.wm-browser').count(), 1, 'one browser');
    // A folder it shows opens in the one Workbench, without taking the keys.
    fixture.send({ type: 'shown', session: 'thread-a', kind: 'folder', target: '/fixture' });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.wm-files').count(), 1);

    // The first session closed: its conversation goes, the windows stay.
    view('tab-b', [['tab-b', 'thread-b']]);
    await page.waitForTimeout(300);
    assert.deepEqual(Object.keys(await slots()), ['code-face', 'wm-files', 'wm-browser']);
    assert.equal(await page.locator('.wm-browser webview').count(), 5);

    // A reload brings the one layout back, Workbench at the folder it was.
    await page.evaluate(() => harness.openFiles('/fixture', { quiet: true }));
    await page.waitForFunction(() => document.querySelector('.workbench-crumb[aria-current="page"]')?.textContent === 'fixture');
    await page.evaluate(() => harness.prepareSurfaceReload());
    await page.reload();
    await page.evaluate(FAKE_DESK);
    await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
    await page.waitForFunction(() => document.querySelectorAll('.wm-browser webview').length === 5 && document.querySelector('.wm-files .workbench-crumb[aria-current="page"]')?.textContent === 'fixture');
    assert.deepEqual(Object.keys(await slots()), ['code-face', 'wm-files', 'wm-browser']);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('a delayed session reveal does not steal the keys after the person chooses Files', async () => {
  const fixture = await harnessFixture({ messages: MESSAGES });
  const { page } = fixture;
  try {
    await page.waitForFunction(() => !document.querySelector('.wm-moving'));
    await page.locator('#entry-input').focus();
    await page.evaluate(() => {
      window.realRAF = window.requestAnimationFrame;
      window.delayedFrames = [];
      window.requestAnimationFrame = callback => (delayedFrames.push(callback), delayedFrames.length);
    });
    fixture.push({ ...fixture.tab, sessionId: 'thread-b', tabs: [{ id: 'tab-b', sessionId: 'thread-b', focused: true, agent: 'pi', name: 'B' }] });
    await page.waitForFunction(() => harness.guiSnapshot().sessionId === 'thread-b', null, { polling: 20 });
    await page.locator('.wm-files .workbench').focus();
    assert.ok(await page.evaluate(() => delayedFrames.length > 0), 'the session reveal really is pending');
    await page.evaluate(() => {
      window.requestAnimationFrame = realRAF;
      for (const callback of delayedFrames) callback(performance.now());
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(KEYS), 'files');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('a project is held in Files, reopens by identity, and never adds a browser tab', async () => {
  const { fixture, page } = await desk();
  try {
    const last = () => fixture.holds.at(-1)?.names;
    const wait = () => page.waitForFunction(() => document.querySelector('.wm-files .workbench-view:not([hidden]) .workbench-view-line')?.textContent.includes('dacre'));
    await page.evaluate(() => harness.openProject('dacre'));
    await wait();
    assert.deepEqual(fixture.started, ['dacre']);
    assert.equal(await page.locator('.wm-browser webview').count(), 3);
    assert.deepEqual(last(), ['dacre']);
    await page.evaluate(() => harness.openProject('dacre'));
    assert.deepEqual(fixture.started, ['dacre']);
    const holds = fixture.holds.length;
    await page.evaluate(() => harness.prepareSurfaceReload());
    await page.reload();
    await page.evaluate(FAKE_DESK);
    await page.evaluate(async () => { const { mountGueyPi } = await import('/js/harness.js'); window.harness = mountGueyPi({ hooks: { canFocus: () => true } }); });
    await wait();
    assert.deepEqual(fixture.started, ['dacre', 'dacre']);
    assert.deepEqual(fixture.holds.slice(holds).map(hold => hold.names), [['dacre']]);
    // Files, brought into view whole, as a person asks for it.
    await page.evaluate(() => harness.showFiles());
    await settled(page);
    await page.locator('.wm-files .workbench-view-count').click();
    await page.locator('.wm-files .workbench-view-picker .workbench-tab-close').nth(1).click();
    await page.waitForTimeout(100);
    assert.deepEqual(last(), []);
    assert.equal(await page.locator('.wm-browser webview').count(), 3);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
