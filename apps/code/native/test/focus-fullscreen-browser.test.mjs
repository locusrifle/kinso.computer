// Super+F in the desktop window's focus layout (public/js/windows.js,
// css/focus.css): whichever of the two has the keys fills the whole window,
// the conversation or the floating panel, and Super+F again (or Escape)
// puts the layout back as it was. The panel full, the input bar is a Mac's
// Dock: down out of sight until the pointer reaches the window's foot or the
// input takes the keys, and down again once the pointer leaves it. This is
// the panel's full screen: it has no expand button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

const messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'some words in the conversation' }] }];
const VIEW = { width: 1440, height: 875 };
const WHOLE = { x: 0, y: 0, w: VIEW.width, h: VIEW.height };
const box = (page, selector) => page.locator(selector).first().evaluate(n => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
// The window's full screen and the Dock, as the frame says them.
const marks = page => page.evaluate(() => ['focus-full-middle', 'focus-full-panel', 'dock-hidden', 'dock-shown'].filter(name => document.querySelector('#entry-terminal').classList.contains(name)));
// Everything placed, to see the layout come back as it was.
const layout = async page => {
  // Sidebar folding is observed, then measured on the following frame. Do
  // not save its old card geometry as the layout fullscreen must restore.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => Object.fromEntries(['#session-rail', '.entry-screen', '.wm-files', '.wm-panel-card', '#entry-input-zone', '.entry-status'].map(selector => {
  const n = document.querySelector(selector), r = n?.getBoundingClientRect();
  return [selector, r && [r.x, r.y, r.width, r.height].map(Math.round).join(' ')];
})));
};
// In sight: laid out, visible and opaque.
const shown = (page, selector) => page.locator(selector).first().evaluate(n => { const s = getComputedStyle(n); return n.offsetWidth > 0 && s.visibility === 'visible' && s.opacity === '1'; });
// Nothing moving any more: the Dock's slide is over.
const settled = page => page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
// Which window, or the input bar, has the keys.
const keysIn = page => page.evaluate(() => (document.activeElement.closest('.wm-files') ? 'files' : document.activeElement.closest('.wm-browser') ? 'browser' : document.activeElement.id || document.activeElement.localName));
// What a click at a point lands on.
const under = (page, x, y) => page.evaluate(([x, y]) => { const at = document.elementFromPoint(x, y)?.closest('#entry-input-zone, .entry-status, .focus-dock-reach, .wm-files, .wm-browser, .entry-screen'); return at?.id || at?.className.match(/entry-status|focus-dock-reach|wm-files|wm-browser|entry-screen/)?.[0] || null; }, [x, y]);

async function mac() {
  const f = await harnessFixture({ desk: { mac: true }, messages, viewport: VIEW });
  const { page } = f;
  // The window's own height: the fixture's shorter frame is for other tests.
  await page.evaluate(() => { for (const style of document.querySelectorAll('style')) if (style.textContent.includes('height:650px')) style.remove(); });
  await page.locator('.wm-files .workbench').waitFor();
  await page.waitForFunction(h => !document.querySelector('.wm-arriving') && document.querySelector('.canvas-strip').getBoundingClientRect().height === h, VIEW.height);
  await page.waitForFunction(() => document.querySelector('.wm-panel-card'));
  return f;
}
// The pointer really moving into a place, as a person's does.
async function point(page, x, y) {
  await page.mouse.move(x, y, { steps: 4 });
  await page.waitForTimeout(30);
}

test('Super+F in the conversation fills the window with it, the sidebar and the panel out of the way and the input bar as it was; again, or Escape, and the layout is back', { timeout: 120000 }, async () => {
  const f = await mac();
  const { page } = f;
  try {
    await page.locator('#entry-input').fill('a draft to keep');
    const before = await layout(page), field = await box(page, '#entry-input-zone');
    assert.equal(await page.locator('.wm-panel-grow, .wm-panel-head').count(), 0, 'the panel has no expand button, nor a head for one');

    await page.keyboard.press('Meta+f');
    assert.deepEqual(await marks(page), ['focus-full-middle']);
    assert.deepEqual(await box(page, '.entry-screen'), WHOLE, 'the conversation fills the window');
    assert.equal(await page.locator('#session-rail').evaluate(n => n.offsetWidth), 0, 'the sidebar out of the way');
    assert.equal(await page.locator('.wm-files').evaluate(n => getComputedStyle(n).visibility), 'hidden', 'and the panel');
    assert.equal(await page.locator('.wm-panel-card, .wm-panel-edge').count(), 0);
    await settled(page);
    assert.equal(await shown(page, '#entry-input-zone'), true, 'the input bar stays');
    assert.equal(await shown(page, '.entry-status'), true);
    const full = await box(page, '#entry-input-zone');
    assert.ok(Math.abs(full.x + full.w / 2 - VIEW.width / 2) <= 1 && Math.abs(full.y - field.y) <= 1 && full.w === field.w, `in the middle of the window, at its foot, as wide as it was: ${JSON.stringify({ field, full })}`);
    assert.equal(await under(page, full.x + full.w / 2, full.y + full.h / 2), 'entry-input-zone');
    assert.equal(await keysIn(page), 'entry-input', 'the keys stay where they were');
    assert.equal(await page.locator('#entry-input').inputValue(), 'a draft to keep');

    await page.keyboard.press('Meta+f');
    assert.deepEqual(await marks(page), []);
    assert.deepEqual(await layout(page), before, 'the layout as it was');

    // Escape too, the sidebar open or folded, when nothing else wants it.
    await page.keyboard.press('Meta+f');
    assert.deepEqual(await marks(page), ['focus-full-middle']);
    await page.keyboard.press('Escape');
    assert.deepEqual(await marks(page), []);
    assert.deepEqual(await layout(page), before);
    await page.locator('#session-rail .session-rail-fold').click();
    const folded = await layout(page);
    await page.locator('#entry-input').focus();
    await page.keyboard.press('Meta+f');
    assert.deepEqual(await box(page, '.entry-screen'), WHOLE);
    await page.keyboard.press('Escape');
    assert.deepEqual(await marks(page), []);
    assert.deepEqual(await layout(page), folded);
    // A menu open has Escape first.
    await page.keyboard.press('Meta+f');
    await page.evaluate(() => { const menu = document.createElement('div'); menu.id = 'held-menu'; menu.setAttribute('role', 'menu'); document.body.append(menu); });
    await page.keyboard.press('Escape');
    assert.deepEqual(await marks(page), ['focus-full-middle'], 'the menu\'s Escape');
    await page.evaluate(() => document.querySelector('#held-menu').remove());
    await page.keyboard.press('Escape');
    assert.deepEqual(await marks(page), []);
    assert.equal(await page.locator('#entry-input').inputValue(), 'a draft to keep');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Super+F with the keys in the panel fills the window with it, edge to edge, and the input bar hides like a Mac\'s Dock: the pointer at the foot brings it up, leaving lets it down, and the input with the keys keeps it', { timeout: 120000 }, async () => {
  const f = await mac();
  const { page } = f;
  try {
    const before = await layout(page), panel = await box(page, '.wm-files'), field = await box(page, '#entry-input-zone');
    // The pointer into the panel gives it the keys.
    await point(page, 2, 2);
    await point(page, panel.x + panel.w / 2, panel.y + panel.h / 2);
    assert.equal(await keysIn(page), 'files');

    await page.keyboard.press('Meta+f');
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-hidden']);
    assert.deepEqual(await box(page, '.wm-files'), WHOLE, 'the panel fills the window');
    assert.equal(await page.locator('.wm-files').evaluate(n => getComputedStyle(n).borderRadius), '0px', 'edge to edge, without the card\'s corners');
    assert.equal(await page.locator('.wm-panel-card, .wm-panel-edge').count(), 0, 'off the card');
    assert.equal(await page.locator('#session-rail').evaluate(n => n.offsetWidth), 0, 'over the sidebar');
    assert.equal(await page.locator('.entry-screen').evaluate(n => getComputedStyle(n).visibility), 'hidden', 'and the conversation');
    assert.equal(await keysIn(page), 'files', 'the keys stay in it');
    // The Dock down, out of sight and out of the way.
    await settled(page);
    assert.equal(await page.locator('#entry-input-zone').evaluate(n => getComputedStyle(n).opacity), '0');
    assert.ok((await box(page, '#entry-input-zone')).y >= VIEW.height, 'below the window\'s foot');
    assert.equal(await under(page, field.x + field.w / 2, field.y + field.h / 2), 'wm-files', 'a click where it was is the panel\'s');

    // The pointer at the foot: up it comes.
    await point(page, VIEW.width / 2, VIEW.height - 2);
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-shown']);
    await settled(page);
    assert.equal(await shown(page, '#entry-input-zone'), true);
    const up = await box(page, '#entry-input-zone');
    assert.ok(Math.abs(up.x + up.w / 2 - VIEW.width / 2) <= 1 && up.y + up.h < VIEW.height, `in the middle of the window's foot: ${JSON.stringify(up)}`);
    assert.equal(await under(page, up.x + up.w / 2, up.y + up.h / 2), 'entry-input-zone');
    // On to it, and about it, it stays.
    await point(page, up.x + up.w / 2, up.y + up.h / 2);
    await point(page, up.x - 8, up.y + up.h / 2);
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-shown']);
    // Away from it: down it goes, and the keys go back to the panel.
    await point(page, VIEW.width / 2, VIEW.height / 2);
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-hidden']);
    assert.equal(await keysIn(page), 'files');
    await settled(page);
    assert.equal(await page.locator('#entry-input-zone').evaluate(n => getComputedStyle(n).opacity), '0');

    // A picker opened from it (the model's) shows over the panel, though the
    // conversation it belongs to waits under it.
    const picker = await page.evaluate(() => {
      const dialog = document.querySelector('#entry-dialog');
      dialog.className = 'centre-box model-picker'; dialog.innerHTML = '<button type="button" class="entry-dialog-option">a model</button>'; dialog.hidden = false;
      const r = dialog.getBoundingClientRect(), at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const seen = getComputedStyle(dialog).visibility === 'visible' && dialog.contains(at);
      dialog.hidden = true; dialog.className = ''; dialog.replaceChildren();
      return seen;
    });
    assert.equal(picker, true);

    // Text chosen in it keeps it up, the pointer gone, until it is let go.
    await point(page, VIEW.width / 2, VIEW.height - 2);
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-shown']);
    await page.evaluate(() => { document.activeElement.blur(); getSelection().selectAllChildren(document.querySelector('#entry-pi-label')); });
    await point(page, VIEW.width / 2 + 40, VIEW.height / 2);
    assert.equal(await keysIn(page), 'files');
    await page.waitForTimeout(50);
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-shown'], 'kept by what is chosen');
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.waitForFunction(() => document.querySelector('#entry-terminal').classList.contains('dock-hidden'));

    // A key that gives the input the keys brings it up, and while the input
    // has them it stays, the pointer resting over the panel.
    await page.keyboard.press('Meta+ArrowLeft');
    assert.equal(await keysIn(page), 'entry-input');
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-shown']);
    await page.waitForTimeout(300);
    await page.keyboard.type('typed in full');
    assert.equal(await page.locator('#entry-input').inputValue(), 'typed in full');
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-shown'], 'kept by the input');
    await settled(page);
    assert.equal(await shown(page, '#entry-input-zone'), true);
    // The pointer moving on in the panel takes the keys back, and the Dock goes.
    await point(page, VIEW.width / 2, VIEW.height / 2);
    assert.equal(await keysIn(page), 'files');
    await page.waitForTimeout(50);
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-hidden']);

    // Super+F again: the layout as it was, the draft kept.
    await page.keyboard.press('Meta+f');
    assert.deepEqual(await marks(page), []);
    await settled(page);
    assert.deepEqual(await layout(page), before);
    assert.equal(await shown(page, '#entry-input-zone'), true);
    assert.equal(await page.locator('#entry-input').inputValue(), 'typed in full');
    // Escape leaves it too, when Files has nothing of its own to close.
    await page.keyboard.press('Meta+f');
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-hidden']);
    await page.keyboard.press('Escape');
    assert.deepEqual(await marks(page), []);
    assert.deepEqual(await layout(page), before);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a website full in the panel stays the same page, the draft stays, the row leaves room for a Mac\'s three buttons, closing it ends full screen, and Super+Shift+F and Super+Shift+Enter leave focus alone', { timeout: 120000 }, async () => {
  const f = await mac();
  const { page } = f;
  try {
    await page.evaluate(() => document.body.classList.add('mac-window'));
    await page.evaluate(() => browseFromWindow({ url: 'https://a.example/' }));
    await page.locator('.wm-browser webview').waitFor();
    await page.waitForFunction(() => !document.querySelector('.wm-arriving, .wm-moving'));
    await page.evaluate(() => { document.querySelector('.wm-browser webview').kept = true; });
    await page.locator('#entry-input').fill('a draft to keep');
    const before = await layout(page), panel = await box(page, '.wm-browser');
    // Neither of the other layouts' keys does anything here.
    await page.keyboard.press('Meta+Shift+F');
    await page.keyboard.press('Meta+Shift+Enter');
    assert.equal(await page.locator('.wm-full-window, .wm-over, .wm-full').count(), 0);
    assert.deepEqual(await marks(page), []);
    assert.deepEqual(await layout(page), before);
    const taught = await page.evaluate(async () => (await import('/js/pi-card.js')).activeKeyBindings().map(k => k.label));
    assert.ok(taught.includes('Super+F') && !taught.includes('Super+Shift+F') && !taught.includes('Super+Shift+Enter'), `the keys sheet teaches only Super+F for it: ${taught}`);

    // The keys in the input bar, though the website was the last shown: the
    // conversation is the one with them, and fills the window.
    assert.equal(await keysIn(page), 'entry-input');
    await page.keyboard.press('Meta+f');
    assert.deepEqual(await marks(page), ['focus-full-middle']);
    await page.keyboard.press('Meta+f');
    assert.deepEqual(await layout(page), before);
    // Super+F from inside the website, as the desktop window sends it.
    await point(page, 2, 2);
    await point(page, panel.x + panel.w / 2, panel.y + panel.h / 2);
    assert.equal(await keysIn(page), 'browser');
    await page.evaluate(() => keyFromWindow('full'));
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-hidden']);
    assert.deepEqual(await box(page, '.wm-browser'), WHOLE);
    assert.equal(await page.locator('.wm-files').evaluate(n => getComputedStyle(n).visibility), 'hidden', 'Files waits under it');
    assert.equal(await page.evaluate(() => document.querySelector('.wm-browser webview').kept), true, 'the same page, not loaded again');
    assert.equal(await page.locator('#entry-input').inputValue(), 'a draft to keep');
    const back = await box(page, '.wm-browser .gui-window-go');
    assert.ok(back.x >= 76, `after the window's three buttons: ${back.x}`);
    assert.equal(await page.locator('.wm-browser .browser-controls').evaluate(n => getComputedStyle(n).getPropertyValue('-webkit-app-region')), 'no-drag', 'the row is a row of controls, not the window\'s title bar');
    // The other layouts' keys, from inside a website, leave it so.
    await page.evaluate(() => { keyFromWindow('fullWindow'); keyFromWindow('over'); });
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-hidden']);
    assert.equal(await page.locator('.wm-full-window, .wm-over').count(), 0);
    // With less motion the Dock only fades, where it is.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await settled(page);
    assert.deepEqual(await page.locator('#entry-input-zone').evaluate(n => { const s = getComputedStyle(n); return [s.transform, s.opacity, s.pointerEvents]; }), ['none', '0', 'none']);
    await page.evaluate(() => keyFromWindow('full'));
    assert.deepEqual(await marks(page), []);
    await settled(page);
    assert.deepEqual(await layout(page), before);
    assert.equal(await page.evaluate(() => document.querySelector('.wm-browser webview').kept), true);
    // Closed while it fills the window, it takes full screen with it.
    await page.evaluate(() => keyFromWindow('full'));
    assert.deepEqual(await marks(page), ['focus-full-panel', 'dock-hidden']);
    await page.evaluate(() => keyFromWindow('close'));
    await page.locator('.wm-browser').waitFor({ state: 'detached' });
    assert.deepEqual(await marks(page), []);
    assert.deepEqual(await box(page, '.wm-files'), panel, 'Files in the panel, beside the conversation');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
