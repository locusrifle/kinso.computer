// How the windows tile and move on a desk (public/js/windows.js), in the
// complete production harness: MOD+L between scrolling and dwindle, MOD+arrows
// by what is in view, and a window carried by the pointer with MOD held.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { modifierKey, windowKey } from '../../../../desktop/electron/keys.mjs';

const messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'some words to choose in the conversation' }] }];
const kinds = page => page.evaluate(() => [...document.querySelectorAll('.canvas-strip > .wm-window')].sort((a, b) => a.style.order - b.style.order).map(n => n.classList.contains('entry-screen') ? 'conversation' : n.classList.contains('wm-files') ? 'files' : 'browser'));
const box = (page, selector) => page.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
const strip = page => box(page, '.canvas-strip');
const focused = page => page.evaluate(() => document.querySelector('.wm-focused').className.match(/entry-screen|wm-files|wm-browser/)[0]);
const left = page => page.evaluate(() => document.querySelector('.canvas-strip').scrollLeft);

async function three(viewport = { width: 1536, height: 900 }) {
  const f = await harnessFixture({ desk: true, messages, viewport });
  await f.page.locator('.wm-files .workbench').waitFor();
  await f.page.evaluate(() => browseFromWindow({ url: 'https://a.example/', behind: true }));
  await f.page.locator('.wm-browser webview').waitFor();
  await f.page.waitForFunction(() => !document.querySelector('.wm-arriving'));
  await f.page.locator('#entry-input').fill('a draft to keep');
  await f.page.locator('#entry-input').focus();
  return f;
}

test('the desktop window sends Super+L as the layout key, never Ctrl+Alt+L, and Super itself going down and up', () => {
  const key = (code, more = {}) => windowKey({ type: 'keyDown', code, alt: false, control: false, meta: true, shift: false, ...more }, { alias: false });
  assert.equal(key('KeyL'), 'layout');
  assert.equal(key('KeyL', { meta: false, alt: true, control: true }), '', 'Ctrl+Alt+L is the screen lock, not imperfect\'s');
  assert.equal(key('KeyL', { shift: true }), '');
  assert.equal(windowKey({ type: 'keyDown', code: 'KeyL', alt: true, control: false, meta: false, shift: false }, { alias: true }), 'layout', 'Alt answers for Super where the window manager keeps Super');
  assert.equal(modifierKey({ type: 'keyDown', code: 'MetaLeft' }, { alias: false }), 'hold');
  assert.equal(modifierKey({ type: 'keyUp', code: 'MetaRight' }, { alias: false }), 'release');
  assert.equal(modifierKey({ type: 'keyDown', code: 'AltLeft' }, { alias: false }), '', 'under sway Alt is Alt');
  assert.equal(modifierKey({ type: 'keyDown', code: 'AltLeft' }, { alias: true }), 'hold');
  assert.equal(modifierKey({ type: 'keyDown', code: 'KeyA' }, { alias: true }), '');
});

test('Super+L: dwindle halves the space window by window, keeps drafts, keys and full window, and goes back to scrolling', async () => {
  const f = await three();
  const { page } = f;
  try {
    assert.deepEqual(await kinds(page), ['conversation', 'files', 'browser']);
    const scrolling = await box(page, '.entry-screen');
    await page.keyboard.press('Meta+l');
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 1);
    const { w, h } = await page.evaluate(() => { const n = document.querySelector('.canvas-strip'); return { w: n.clientWidth, h: n.clientHeight }; });
    assert.equal(await left(page), 0, 'everything in view: nothing to scroll');
    // The conversation the left half, Files above the browser in the right.
    const half = Math.floor(w / 2), top = (await strip(page)).y;
    const [c, fi, b] = [await box(page, '.entry-screen'), await box(page, '.wm-files'), await box(page, '.wm-browser')];
    assert.deepEqual([c.x, c.w, c.h], [-1, half + 1, h + 2]);
    assert.deepEqual([fi.x, fi.y - top, fi.w], [half - 1, -1, w - half + 2]);
    assert.equal(b.x, fi.x); assert.equal(b.w, fi.w);
    assert.equal(b.y, fi.y + fi.h - 1, 'one shared rule between them');
    assert.equal(b.y + b.h, top + h + 1, 'the last reaches the bottom edge');
    const webview = await box(page, '.wm-browser .browser-page.front webview');
    assert.ok(webview.w <= b.w && webview.h < b.h && webview.w > b.w - 4, 'the page fills its tile');
    assert.equal(await page.locator('#entry-input').inputValue(), 'a draft to keep');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'entry-input', 'the keys stay where they were');
    // MOD+arrows go to the window beside.
    await page.keyboard.press('Meta+ArrowRight');
    assert.equal(await focused(page), 'wm-files');
    await page.keyboard.press('Meta+ArrowRight');
    assert.equal(await focused(page), 'wm-browser', 'nothing beyond: the next in order');
    await page.keyboard.press('Meta+ArrowLeft');
    assert.equal(await focused(page), 'entry-screen');
    assert.equal(await left(page), 0);
    // Resized, the tiles follow.
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForFunction(() => document.querySelector('.entry-screen').getBoundingClientRect().width === 601);
    // Narrow, the second split stays side by side only while it can: below
    // the minimum width it stacks, and the minimum height turns it back.
    await page.setViewportSize({ width: 1100, height: 400 });
    await page.waitForTimeout(100);
    const narrow = [await box(page, '.wm-files'), await box(page, '.wm-browser')];
    assert.equal(narrow[0].x, narrow[1].x, 'cut across rather than too thin');
    await page.setViewportSize({ width: 1536, height: 900 });
    await page.waitForTimeout(100);
    // Super+Shift+F over dwindle covers the window; Escape gives dwindle back.
    await page.keyboard.press('Meta+ArrowRight');
    await page.keyboard.press('Meta+Shift+f');
    await page.locator('.wm-full-window').waitFor();
    assert.deepEqual(await box(page, '.wm-files'), { x: 0, y: 0, w: 1536, h: 900 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.wm-full-window'));
    assert.deepEqual(await box(page, '.wm-files'), fi, 'the same tile again');
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 1);
    // Back to scrolling, the one with the keys in view.
    await page.keyboard.press('Meta+ArrowRight');
    assert.equal(await focused(page), 'wm-browser');
    await page.keyboard.press('Meta+l');
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 0);
    assert.equal(await page.locator('.wm-browser').evaluate(n => { const r = n.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; }), true);
    await page.keyboard.press('Meta+ArrowLeft');
    assert.deepEqual(await box(page, '.entry-screen'), scrolling);
    assert.equal(await page.locator('#entry-input').inputValue(), 'a draft to keep');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Super held, a window is carried by the pointer to another\'s place; Escape puts it back; without Super a drag is the page\'s', async () => {
  const f = await three();
  const { page } = f;
  try {
    const centre = async selector => { const r = await box(page, selector); return [r.x + r.w / 2, r.y + r.h / 2]; };
    // Without Super: an ordinary drag is left to the page (choosing text,
    // say), untouched: nothing covers, carries or prevents it.
    await page.evaluate(() => { window.downs = []; document.addEventListener('pointerdown', event => downs.push(event.defaultPrevented)); });
    const words = await page.locator('#entry-output .gui-assistant').boundingBox();
    await page.mouse.move(words.x + 2, words.y + words.height / 2);
    await page.mouse.down();
    assert.equal(await page.locator('.wm-grab, .wm-dragging').count(), 0);
    await page.mouse.move(words.x + words.width - 2, words.y + words.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => downs), [false]);
    assert.deepEqual(await kinds(page), ['conversation', 'files', 'browser']);

    // Super down: a cover over every window, the website's too.
    await page.keyboard.down('Meta');
    assert.equal(await page.locator('.canvas-strip.wm-grab').count(), 1);
    const over = await centre('.wm-files');
    assert.match(await page.evaluate(([x, y]) => document.elementFromPoint(x, y).className, over), /wm-files/, 'the window, not what is in it');
    // The conversation carried onto Files' place: they swap places.
    await page.mouse.move(...await centre('.entry-screen'));
    await page.mouse.down();
    assert.equal(await page.locator('.entry-screen.wm-dragged').count(), 1);
    await page.mouse.move(...over, { steps: 4 });
    assert.equal(await page.locator('.wm-files.wm-drop').count(), 1, 'where it would go is ruled');
    await page.mouse.up();
    assert.deepEqual(await kinds(page), ['files', 'conversation', 'browser']);
    assert.equal(await focused(page), 'entry-screen', 'the window carried has the keys');
    assert.equal(await page.locator('.wm-dragged, .wm-drop').count(), 0);
    // Escape mid-carry: nothing moves.
    await page.mouse.down();
    await page.mouse.move(...await centre('.wm-files'), { steps: 4 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.deepEqual(await kinds(page), ['files', 'conversation', 'browser']);
    await page.keyboard.up('Meta');
    assert.equal(await page.locator('.wm-grab').count(), 0, 'Super let go: the cover goes');
    // Inside a website the desktop window says when Super goes down and up.
    await page.evaluate(() => keyFromWindow('hold'));
    assert.equal(await page.locator('.wm-grab').count(), 1);
    await page.evaluate(() => keyFromWindow('release'));
    assert.equal(await page.locator('.wm-grab').count(), 0);
    // And a pointer moving without it takes the cover away, should the
    // release never come.
    await page.evaluate(() => keyFromWindow('hold'));
    await page.mouse.move(400, 400);
    await page.mouse.move(410, 410);
    assert.equal(await page.locator('.wm-grab').count(), 0);
    // Dwindle: dropped on a tile, it takes that tile.
    await page.keyboard.press('Meta+l');
    const browserTile = await box(page, '.wm-browser');
    await page.keyboard.down('Meta');
    await page.mouse.move(...await centre('.wm-files'));
    await page.mouse.down();
    await page.mouse.move(browserTile.x + browserTile.w / 2, browserTile.y + browserTile.h / 2, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Meta');
    assert.deepEqual(await kinds(page), ['conversation', 'browser', 'files']);
    assert.deepEqual(await box(page, '.wm-files'), browserTile);
    assert.equal(await page.locator('#entry-input').inputValue(), 'a draft to keep');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the human\'s case: the session focused, two windows in view and the browser third out of sight, one Super+Right shows it', async () => {
  const f = await harnessFixture({ desk: true, messages, viewport: { width: 1472, height: 920 } });
  const { page } = f;
  try {
    await page.locator('.wm-files .workbench').waitFor();
    await page.evaluate(() => browseFromWindow({ url: 'https://a.example/', behind: true }));
    await page.locator('.wm-browser webview').waitFor();
    await page.locator('#entry-input').focus();
    const whole = selector => page.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; });
    assert.deepEqual([await whole('.entry-screen'), await whole('.wm-files'), await whole('.wm-browser')], [true, true, false]);
    // Pressed once, read in the same moment: no second press, no slide.
    const after = await page.evaluate(() => {
      dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', key: 'ArrowRight', metaKey: true, bubbles: true, cancelable: true }));
      const b = document.querySelector('.wm-browser').getBoundingClientRect();
      return { whole: b.left >= -1 && b.right <= innerWidth + 1, focused: document.querySelector('.wm-focused').classList.contains('wm-browser') };
    });
    assert.deepEqual(after, { whole: true, focused: true });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a website given the keys arrives late: the pointer having moved into Files meanwhile, the keys stay in Files; a click in it keeps them there', async () => {
  // In the desktop window a <webview> has the keys a moment after it is
  // given them: Electron moves the canvas's focus into it, with no focusin,
  // and the canvas window blurs. Here that arrival is played as it comes.
  const arrive = page => page.evaluate(() => {
    const site = document.querySelector('.wm-browser .browser-page.front webview');
    addEventListener('focusin', event => event.stopImmediatePropagation(), { capture: true, once: true });
    site.focus();
    dispatchEvent(new FocusEvent('blur'));
    return { active: document.activeElement.closest('.wm-files') ? 'files' : document.activeElement.localName, focused: document.querySelector('.wm-focused').className.match(/entry-screen|wm-files|wm-browser/)[0] };
  });
  const f = await three({ width: 1472, height: 920 });
  const { page } = f;
  try {
    await page.keyboard.press('Meta+ArrowRight');
    assert.equal(await focused(page), 'wm-browser');
    assert.equal(await page.evaluate(() => document.activeElement.localName), 'webview');
    // Straight on, with nothing waited for, the pointer into Files.
    const files = await box(page, '.wm-files .workbench');
    await page.mouse.move(files.x + files.w / 2, files.y + files.h / 2);
    assert.equal(await focused(page), 'wm-files');
    const viewed = await left(page);
    assert.deepEqual(await arrive(page), { active: 'files', focused: 'wm-files' }, 'the late arrival gives the keys straight back to Files');
    assert.equal(await left(page), viewed, 'and the view stays');
    // The pointer brought into the website with a button down (so it was not
    // handed the keys on the way), a click there is the website's own.
    const site = await box(page, '.wm-browser .browser-page.front webview');
    await page.mouse.down();
    await page.mouse.move(site.x + 100, site.y + 100, { steps: 4 });
    await page.mouse.up();
    assert.equal(await focused(page), 'wm-files');
    assert.deepEqual(await arrive(page), { active: 'webview', focused: 'wm-browser' }, 'the website keeps what it was clicked for');
    assert.equal(await page.locator('#entry-input').inputValue(), 'a draft to keep');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
