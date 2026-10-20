// A window closing on a desk (public/js/window-close.js, windows.js close())
// in the complete production harness: Omarchy's popin and fade, in place,
// the keys gone on at once, and the column taken away only once it is over.
// Only the backend is fake (fixtures/harness-page.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

const MESSAGES = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] }];

async function desk(options = {}) {
  const fixture = await harnessFixture({ desk: true, layout: 'scrolling', messages: MESSAGES, viewport: { width: 1536, height: 900 }, ...options });
  const { page } = fixture;
  await page.locator('.wm-files .workbench').waitFor();
  await page.evaluate(() => browseFromWindow({ url: 'https://a.example/' }));
  await page.locator('.wm-browser webview').waitFor();
  await page.waitForFunction(() => !document.querySelector('.wm-moving, .wm-arriving'));
  // Opened quietly on the right, out of sight past Files: one Super+Right
  // brings it whole into view with the keys in its page.
  await page.evaluate(() => keyFromWindow('next'));
  await page.waitForFunction(() => document.activeElement.localName === 'webview');
  await controlClose(page);
  return fixture;
}
// Which window has the keys: closed, the browser on the right gives them to
// Files beside it.
const KEYS = () => (document.activeElement.closest('.wm-files') ? 'files' : document.activeElement.id || document.activeElement.localName);
// Everything about the closing window, read in the same frame as the close.
const CLOSING = () => {
  const KEYS = () => (document.activeElement.closest('.wm-files') ? 'files' : document.activeElement.id || document.activeElement.localName);
  const el = document.querySelector('.wm-browser');
  return el && {
    closing: el.classList.contains('wm-closing'), inert: el.inert, hidden: el.getAttribute('aria-hidden'),
    full: el.classList.contains('wm-full'), focused: el.classList.contains('wm-focused'), guest: Boolean(el.querySelector('webview')),
    motion: el.getAnimations().map(a => { const t = a.effect.getTiming(); return [Object.keys(a.effect.getKeyframes()[1]).find(k => ['transform', 'opacity'].includes(k)), t.duration, t.easing]; }),
    keys: KEYS(),
    // Files, beside it, where it is on screen.
    neighbour: document.querySelector('.wm-files').getBoundingClientRect().left,
  };
};
// Only the close's 149 ms behaviour timer is controlled. Layout's 420 ms
// timers, animation frames and native keyboard delivery keep running. Pause
// the real closing animations too, so slow IPC cannot lose their keyframes.
const controlClose = page => page.evaluate(() => {
  const wait = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
  const animate = Element.prototype.animate;
  let now = 0;
  const timers = new Map(), scheduled = [];
  Element.prototype.animate = function (...args) {
    const animation = animate.apply(this, args);
    if (this.matches('.wm-browser.wm-closing')) animation.pause();
    return animation;
  };
  window.setTimeout = (fn, ms = 0, ...args) => {
    if (ms !== 149 || !document.querySelector('.wm-browser.wm-closing')) return wait(fn, ms, ...args);
    const id = {};
    timers.set(id, { at: now + ms, fn: () => fn(...args) });
    scheduled.push(ms);
    return id;
  };
  window.clearTimeout = id => { if (!timers.delete(id)) clear(id); };
  window.closeClock = {
    state: () => ({ now, scheduled: [...scheduled], deadlines: [...timers.values()].map(timer => timer.at) }),
    advance: ms => {
      now += ms;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
  };
});
const clock = page => page.evaluate(() => closeClock.state());
const gone = async page => {
  assert.deepEqual(await clock(page), { now: 0, scheduled: [149], deadlines: [149] }, 'completion is scheduled at the configured 149 ms');
  await page.evaluate(() => closeClock.advance(148));
  assert.equal(await page.locator('.wm-browser.wm-closing').count(), 1, 'not removed before the deadline, even when its animations are paused');
  await page.evaluate(() => closeClock.advance(1));
  assert.equal(await page.locator('.wm-browser').count(), 0, 'removed at 149 ms without waiting for animation completion');
  assert.deepEqual(await clock(page), { now: 149, scheduled: [149], deadlines: [] });
};

test('Super+W on the last tab: the browser shrinks to 87% and fades in place, the keys go on at once, and its column goes when it is over', async () => {
  const fixture = await desk();
  const { page } = fixture;
  try {
    const files = await page.locator('.wm-files').evaluate(n => n.getBoundingClientRect().left);
    await page.keyboard.press('Meta+w');
    // Native key delivery can finish after Playwright acknowledges dispatch;
    // the paused animation/clock below keeps the closing frame inspectable.
    await page.locator('.wm-browser.wm-closing').waitFor();
    const during = await page.evaluate(CLOSING);
    assert.ok(during, 'still drawn while it closes');
    const { motion, neighbour, ...state } = during;
    assert.deepEqual(state, { closing: true, inert: true, hidden: 'true', full: false, focused: false, guest: true, keys: 'files' });
    assert.deepEqual(motion, [['transform', 149, 'linear'], ['opacity', 146, 'cubic-bezier(0.5, 0.5, 0.75, 1)']]);
    assert.deepEqual(await page.locator('.wm-browser').evaluate(el => el.getAnimations().map(animation => {
      const frames = animation.effect.getKeyframes(), property = 'transform' in frames[0] ? 'transform' : 'opacity';
      return [frames.map(frame => frame[property]), animation.effect.getTiming().fill, animation.playState];
    })), [[['scale(1)', 'scale(0.87)'], 'forwards', 'paused'], [['1', '0'], 'forwards', 'paused']], 'real animations keep their exact endpoints and fill while the test holds them');
    assert.equal(neighbour, files, 'its neighbours keep their places until it is gone');
    assert.match(await page.locator('.wm-focused').evaluate(n => n.className), /wm-files/);
    await gone(page);
    assert.notEqual(await page.locator('.wm-files').evaluate(n => n.getBoundingClientRect().left), files, 'then the columns close up');
    assert.equal(await page.evaluate(KEYS), 'files');
    // Super+W again: the conversation is never closed, nothing errs.
    await page.keyboard.press('Meta+w');
    assert.equal(await page.locator('.entry-screen').count(), 1);
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('closed twice over, by the key and by the desktop window, it is cleaned up once', async () => {
  const fixture = await desk();
  const { page } = fixture;
  try {
    const result = await page.evaluate(() => {
      const id = document.querySelector('.wm-browser webview').getWebContentsId();
      let removed = 0;
      new MutationObserver(list => { for (const m of list) for (const n of m.removedNodes) if (n.classList?.contains('wm-browser')) removed++; })
        .observe(document.querySelector('.canvas-strip'), { childList: true });
      tabFromWindow({ id, do: 'close' });
      tabFromWindow({ id, do: 'close' });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', metaKey: true, bubbles: true }));
      window.removedCount = () => removed;
      return document.querySelectorAll('.wm-browser.wm-closing').length;
    });
    assert.equal(result, 1);
    await gone(page);
    await page.evaluate(() => closeClock.advance(250));
    assert.equal(await page.evaluate(() => removedCount()), 1);
    assert.equal(await page.locator('.wm-files').count(), 1, 'Files stays');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('a new browser, or the window resized, while one closes: it ends at once and the strip tiles without it', async () => {
  const fixture = await desk();
  const { page } = fixture;
  try {
    const opened = await page.evaluate(() => {
      tabFromWindow({ id: document.querySelector('.wm-browser webview').getWebContentsId(), do: 'close' });
      browseFromWindow({ url: 'https://b.example/' });
      return [...document.querySelectorAll('.wm-browser')].map(el => [el.classList.contains('wm-closing'), el.querySelector('webview')?.getAttribute('src')]);
    });
    assert.deepEqual(opened, [[false, 'https://b.example/']], 'superseded: the old one gone before the new one is laid out');
    assert.deepEqual(await clock(page), { now: 0, scheduled: [149], deadlines: [] }, 'opening forces completion and cancels its timer without advancing time');
    await page.waitForFunction(() => !document.querySelector('.wm-arriving, .wm-moving'));
    await page.evaluate(() => tabFromWindow({ id: document.querySelector('.wm-browser webview').getWebContentsId(), do: 'close' }));
    assert.equal(await page.locator('.wm-browser.wm-closing').count(), 1);
    assert.deepEqual(await clock(page), { now: 0, scheduled: [149, 149], deadlines: [149] });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() => !document.querySelector('.wm-browser'), null, { timeout: 15000 });
    assert.deepEqual(await clock(page), { now: 0, scheduled: [149, 149], deadlines: [] }, 'resize forces completion and cancels its timer without advancing time');
    // setViewportSize completes the viewport change, not the strip's
    // ResizeObserver; wait for that event, never for the controlled deadline.
    await page.waitForFunction(() => {
      const windows = [...document.querySelectorAll('.canvas-strip > .wm-window')];
      return innerWidth === 1280 && windows.length === 2 && windows.every(el => el.style.width === '641px');
    }, null, { timeout: 15000 });
    const widths = await page.evaluate(() => [...document.querySelectorAll('.canvas-strip > .wm-window')].map(el => el.style.width));
    assert.deepEqual(widths, ['641px', '641px'], 'conversation and Files share the new width');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('a full window closes full, then the layout comes back', async () => {
  const fixture = await desk();
  const { page } = fixture;
  try {
    await page.keyboard.press('Meta+f');
    assert.equal(await page.locator('.wm-browser.wm-full').count(), 1);
    await page.keyboard.press('Meta+w');
    const during = await page.evaluate(CLOSING);
    assert.equal(during.closing && during.full, true, 'it closes where it was, over the others');
    await gone(page);
    assert.equal(await page.locator('.wm-full').count(), 0);
    assert.equal(await page.locator('.canvas-strip').evaluate(n => n.classList.contains('wm-has-full')), false);
    assert.equal(await page.evaluate(KEYS), 'files');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('with reduced motion it closes at once', async () => {
  const fixture = await desk();
  const { page } = fixture;
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const left = await page.evaluate(() => {
      tabFromWindow({ id: document.querySelector('.wm-browser webview').getWebContentsId(), do: 'close' });
      return document.querySelectorAll('.wm-browser').length;
    });
    assert.equal(left, 0);
    assert.equal(await page.evaluate(KEYS), 'files');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('in dwindle it closes in its own tile, then the others take the space', async () => {
  const fixture = await desk();
  const { page } = fixture;
  const box = selector => page.locator(selector).evaluate(n => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
  try {
    await page.keyboard.press('Meta+l');
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 1);
    const [browser, files] = [await box('.wm-browser'), await box('.wm-files')];
    await page.keyboard.press('Meta+w');
    const during = await page.evaluate(() => {
      const el = document.querySelector('.wm-browser'), f = document.querySelector('.wm-files').getBoundingClientRect();
      return { closing: el.classList.contains('wm-closing'), place: [el.style.left, el.style.top, el.style.width, el.style.height], files: [f.left, f.top, f.width, f.height], motion: el.getAnimations().length };
    });
    assert.equal(during.closing, true);
    assert.equal(during.motion, 2, 'shrinking and fading');
    assert.deepEqual(during.files, files, 'Files keeps its tile while the browser closes');
    assert.ok(browser[2] > 0 && during.place.every(Boolean), 'the closing tile keeps its own place');
    await gone(page);
    assert.notDeepEqual(await box('.wm-files'), files, 'then Files takes the space');
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 1, 'still dwindle');
    assert.equal(await page.evaluate(KEYS), 'files');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('over the input bar (Super+Shift+F), it closes there, then the panes and input bar come back', async () => {
  // Super+Shift+F is the scrolling and dwindle layouts' (focus has Super+F alone).
  const fixture = await desk({ layout: 'scrolling' });
  const { page } = fixture;
  try {
    await page.keyboard.press('Meta+Shift+f');
    assert.equal(await page.locator('.wm-full-window').count(), 1);
    await page.keyboard.press('Meta+w');
    const during = await page.evaluate(() => {
      const el = document.querySelector('.wm-browser');
      return [el.classList.contains('wm-closing'), el.classList.contains('wm-full')];
    });
    assert.deepEqual(during, [true, true], 'it closes where it was, over everything');
    await gone(page);
    assert.equal(await page.locator('.wm-full-window, .wm-full').count(), 0);
    assert.equal(await page.evaluate(KEYS), 'files');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('Super+Left while one closes: the close ends at once and the keys move by the strip without it', async () => {
  const fixture = await desk();
  const { page } = fixture;
  try {
    const after = await page.evaluate(() => {
      tabFromWindow({ id: document.querySelector('.wm-browser webview').getWebContentsId(), do: 'close' });
      const files = document.activeElement.closest('.wm-files') !== null;
      keyFromWindow('previous');
      return { files, ghost: document.querySelectorAll('.wm-browser').length, keys: document.activeElement.id, view: document.querySelector('.canvas-strip').scrollLeft };
    });
    assert.deepEqual(after, { files: true, ghost: 0, keys: 'entry-input', view: 0 });
    assert.deepEqual(await clock(page), { now: 0, scheduled: [149], deadlines: [] }, 'navigation forces completion and cancels its timer without advancing time');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
