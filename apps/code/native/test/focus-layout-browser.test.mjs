// The desktop window (public/js/windows.js focus, css/focus.css), a Mac's and
// the laptop's alike: the agents a
// sidebar on the left that folds away, the conversation in the middle with
// its composer floating over its foot, and Files or the browser a floating panel on the
// right the size of a phone, the sidebar's Files and Sites choosing which;
// nothing is moved in the page for it, so a website is not loaded again and a
// draft stays. Super+F fills the window with either
// (focus-fullscreen-browser.test.mjs). Browser pages share the same layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

const messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: 'some words in the conversation' }] }];
const box = async (page, selector) => {
  // Folding/resizing schedules its card measurement through ResizeObserver.
  // Read the settled frame, not the transient old width at its new x position.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.locator(selector).first().evaluate(n => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });
};
// The sidebar's rows marked as what the panel shows.
const marked = page => page.evaluate(() => [...document.querySelectorAll('#session-rail .sidebar-row.active .session-rail-asked')].map(n => n.textContent));
const choose = (page, name) => page.locator('#session-rail .sidebar-row .session-rail-open', { hasText: name }).first().click();
const inside = (a, b) => a.x >= b.x - 1 && a.x + a.w <= b.x + b.w + 1;

async function mac(desk = { mac: true }) {
  const f = await harnessFixture({ desk, messages, viewport: { width: 1440, height: 875 } });
  await f.page.locator('.wm-files .workbench').waitFor();
  await f.page.waitForFunction(() => !document.querySelector('.wm-arriving'));
  return f;
}

test('a Mac\'s window starts in focus: the agents on the left, the conversation in the middle, Files floating on the right', { timeout: 120000 }, async () => {
  const f = await mac();
  const { page } = f;
  try {
    assert.equal(await page.locator('#entry-terminal.focus-layout').count(), 1);
    const rail = await box(page, '#session-rail'), conversation = await box(page, '.entry-screen');
    const files = await box(page, '.wm-files'), field = await box(page, '#entry-input-zone');
    assert.ok(rail.x === 0 && rail.w > 200 && rail.w < 300, `the agents a sidebar: ${JSON.stringify(rail)}`);
    assert.ok(await page.locator('#session-rail .session-rail-item:not(.session-rail-new)').count() >= 1, 'listing the sessions');
    assert.ok(conversation.x >= rail.x + rail.w - 1, 'the conversation beside it');
    assert.ok(files.x >= conversation.x + conversation.w, 'Files on the right');
    assert.ok(files.w >= 340 && files.w <= 430, `the width of a phone: ${files.w}`);
    // The conversation is the middle's whole height, up under the band and
    // down under the field, which floats over its foot, as far from the
    // sidebar as from the panel.
    assert.equal(conversation.y, 0, 'up to the window\'s top');
    assert.ok(inside(field, conversation) && field.y + field.h <= conversation.y + conversation.h, `the composer over the conversation's foot: ${JSON.stringify([field, conversation])}`);
    assert.ok(Math.abs((field.x - (rail.x + rail.w)) - (files.x - (field.x + field.w))) <= 1, `the field centred between the sidebar and the panel: ${JSON.stringify({ rail, field, files })}`);
    const last = await page.locator('#entry-output').evaluate(n => { n.scrollTop = n.scrollHeight; return n.lastElementChild.getBoundingClientRect().bottom; });
    assert.ok(last <= field.y, `the last words stay above the field: ${last} ${field.y}`);
    assert.equal(await page.locator('.wm-panel-head, .wm-panel-grow').count(), 0, 'the panel has no head nor expand button: the sidebar chooses what it shows, and Super+F fills the window with it');
    assert.deepEqual(await marked(page), ['Home'], 'Files\' Home marked in the sidebar');
    const foot = await box(page, '.entry-status');
    assert.equal(files.y + files.h, foot.y + foot.h, 'the panel ends level with the field');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the sidebar switches the panel between Files and the browser, keeping the draft and the page', { timeout: 120000 }, async () => {
  const f = await mac();
  const { page } = f;
  try {
    await page.evaluate(() => browseFromWindow({ url: 'https://a.example/' }));
    await page.locator('.wm-browser webview').waitFor();
    await page.waitForFunction(() => !document.querySelector('.wm-arriving'));
    await page.waitForFunction(() => document.querySelector('#session-rail .sidebar-row.active')?.textContent.includes('a.example'));
    assert.deepEqual(await marked(page), ['a.example'], 'a website opened is what the panel shows');
    assert.equal(await page.locator('.wm-files.wm-tucked').count(), 1, 'Files waits under it');
    const panel = await box(page, '.wm-browser');
    await choose(page, 'Home');
    assert.equal(await page.locator('.wm-browser.wm-tucked').count(), 1);
    assert.deepEqual(await box(page, '.wm-files'), panel, 'in the same place');
    await choose(page, 'a.example');
    assert.equal(await page.locator('.wm-files.wm-tucked').count(), 1, 'the site brings the browser back');
    await page.evaluate(() => { document.querySelector('.wm-browser webview').kept = true; });
    await page.locator('#entry-input').fill('a draft to keep');
    const middle = await box(page, '.entry-screen');
    await choose(page, 'Home');
    await choose(page, 'a.example');
    assert.deepEqual(await box(page, '.wm-browser'), panel);
    assert.deepEqual(await box(page, '.entry-screen'), middle, 'the conversation stays in the middle');
    assert.equal(await page.locator('#entry-input').inputValue(), 'a draft to keep');
    assert.equal(await page.evaluate(() => document.querySelector('.wm-browser webview').kept), true, 'the same page, not loaded again');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the sidebar folds and stays folded; Super+L goes focus, scrolling, dwindle and round', { timeout: 120000 }, async () => {
  const f = await mac();
  const { page } = f;
  try {
    const open = await box(page, '.entry-screen');
    await page.locator('#session-rail .session-rail-fold').click();
    assert.equal(await page.locator('#session-rail.collapsed').count(), 1);
    const folded = await box(page, '.entry-screen');
    assert.ok(folded.x < open.x && folded.w > open.w, 'the conversation takes the room');
    assert.equal(await page.evaluate(() => localStorage.getItem('imperfect.sidebar')), 'folded');

    await page.keyboard.press('Meta+l');
    assert.equal(await page.locator('#entry-terminal.focus-layout').count(), 0);
    assert.equal(await page.locator('.wm-panel-card, .wm-panel-edge, .wm-tucked, .wm-in-panel').count(), 0, 'nothing of the panel left');
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 0, 'scrolling');
    await page.keyboard.press('Meta+l');
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 1);
    await page.keyboard.press('Meta+l');
    assert.equal(await page.locator('#entry-terminal.focus-layout').count(), 1, 'and focus again');
    assert.equal(await page.locator('#session-rail.collapsed').count(), 1, 'the sidebar as it was left');
    await page.locator('#session-rail .session-rail-fold').click();
    assert.deepEqual(await box(page, '.entry-screen'), open);
    assert.equal(await page.evaluate(() => localStorage.getItem('imperfect.sidebar')), 'open');
    // The narrowest a Mac's window goes: the sidebar floats over the middle,
    // and the conversation keeps more than half.
    await page.setViewportSize({ width: 640, height: 875 });
    await page.waitForFunction(() => document.querySelector('.entry-screen').getBoundingClientRect().x < 10);
    const narrow = await box(page, '.entry-screen');
    assert.ok(narrow.w > 320, `room for the conversation: ${narrow.w}`);
    assert.equal(await page.locator('#session-rail').evaluate(n => getComputedStyle(n).width), '248px', 'the sidebar over it');
    await page.setViewportSize({ width: 1440, height: 875 });
    await page.waitForFunction(() => document.querySelector('.entry-screen').getBoundingClientRect().x > 200);
    assert.deepEqual(await box(page, '.entry-screen'), open);
    // Choosing a session in the sidebar leaves it open.
    await page.locator('#session-rail .session-rail-item:not(.session-rail-new)').first().click();
    assert.equal(await page.locator('#session-rail.collapsed').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a laptop\'s window (a desk that is not a Mac) starts in focus too, as a Mac\'s does', { timeout: 120000 }, async () => {
  const f = await mac(true);
  const { page } = f;
  try {
    assert.equal(await page.locator('#entry-terminal.focus-layout').count(), 1);
    assert.equal(await page.locator('.wm-panel-card').count(), 1);
    assert.deepEqual(await marked(page), ['Home']);
    await page.keyboard.press('Meta+l');
    assert.equal(await page.locator('#entry-terminal.focus-layout').count(), 0);
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 0, 'scrolling');
    await page.keyboard.press('Meta+l');
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 1);
    await page.keyboard.press('Meta+l');
    assert.equal(await page.locator('#entry-terminal.focus-layout').count(), 1, 'round to focus');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a browser page starts in focus too: Alt+L cycles through scrolling and dwindle back to focus', { timeout: 120000 }, async () => {
  const f = await mac(false);
  const { page } = f;
  try {
    assert.equal(await page.locator('#entry-terminal.focus-layout').count(), 1);
    assert.equal(await page.locator('.wm-panel-card').count(), 1);
    await page.keyboard.press('Alt+l');
    assert.equal(await page.locator('#entry-terminal.focus-layout').count(), 0);
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 0);
    await page.keyboard.press('Alt+l');
    assert.equal(await page.locator('.canvas-strip.wm-dwindle').count(), 1);
    await page.keyboard.press('Alt+l');
    assert.equal(await page.locator('#entry-terminal.focus-layout').count(), 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a native window retains an explicitly saved scrolling or focus choice', { timeout: 120000 }, async () => {
  const saved = async layout => {
    const f = await harnessFixture({ desk: { mac: true }, messages, viewport: { width: 1440, height: 875 }, layout });
    try { return await f.page.locator('#entry-terminal.focus-layout').count(); } finally { await f.close(); }
  };
  assert.equal(await saved('scrolling'), 0, 'a saved scrolling layout is kept');
  assert.equal(await saved('focus'), 1);
});

test('the panel is one row over its page: the arrows from its edge, then the address to its other', { timeout: 120000 }, async () => {
  const f = await mac();
  const { page } = f;
  const middle = b => b.y + b.h / 2;
  try {
    await page.evaluate(() => browseFromWindow({ url: 'https://a.example/' }));
    await page.locator('.wm-browser webview').waitFor();
    await page.waitForFunction(() => !document.querySelector('.wm-arriving'));
    const [card, back, address] = await Promise.all(['.wm-panel-card', '.wm-browser .gui-window-go', '.wm-browser .gui-window-address'].map(s => box(page, s)));
    assert.ok(Math.abs(middle(back) - middle(address)) <= 1, `one line: ${JSON.stringify({ back, address })}`);
    assert.ok(back.x - card.x <= 14 && card.x + card.w - (address.x + address.w) <= 14, `the arrows from the panel's edge, the address to its other: ${JSON.stringify({ card, back, address })}`);
    assert.ok(address.y - card.y < 20, 'at the panel\'s top');
    assert.deepEqual(await box(page, '.wm-browser'), card, 'the window lies exactly on the card');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the sidebar chooses what the panel shows: New page opens the browser in it, and Home brings Files back', { timeout: 120000 }, async () => {
  const f = await mac();
  const { page } = f;
  try {
    assert.equal(await page.locator('.wm-browser').count(), 0, 'no browser yet');
    assert.deepEqual(await marked(page), ['Home']);
    await choose(page, 'New page');
    await page.locator('.wm-browser').waitFor();
    await page.waitForFunction(() => !document.querySelector('.wm-arriving'));
    assert.equal(await page.locator('.wm-files.wm-tucked').count(), 1, 'the browser is the panel');
    await choose(page, 'Home');
    assert.equal(await page.locator('.wm-browser.wm-tucked').count(), 1, 'and Files again');
    assert.deepEqual(await marked(page), ['Home']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('in focus the dock keeps the mic and + beside each other, with usage and the browser button out of it, and the input zone holds no buttons', { timeout: 120000 }, async () => {
  const f = await mac();
  const { page } = f;
  try {
    const visible = selector => page.locator(selector).first().evaluate(n => n.offsetWidth > 0 && n.offsetHeight > 0);
    assert.equal(await page.locator('#entry-input-zone button').count(), 0, 'the input zone is only the words');
    assert.equal(await visible('.session-actions .entry-voice:not(.entry-usage)'), true, 'the mic');
    assert.equal(await visible('.session-actions .entry-plus'), true, 'the +');
    assert.equal(await visible('.session-actions .entry-usage'), false, 'usage is the sidebar\'s foot');
    assert.equal(await visible('.session-actions .entry-browser'), false, 'the browser is the sidebar\'s Sites');
    const order = await page.evaluate(() => [...document.querySelectorAll('.session-actions > *')].filter(n => n.offsetWidth).map(n => n.className.split(' ')[0]));
    assert.deepEqual(order, ['entry-voice', 'entry-plus'], 'the mic, then +');
    // Leaving focus gives the selectable scrolling layout its full dock back.
    await page.keyboard.press('Meta+l');
    assert.equal(await visible('.session-actions .entry-usage'), true);
    assert.equal(await visible('.session-actions .entry-browser'), true);
    assert.equal(await page.locator('#entry-input-zone button').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the sidebar has Sessions with History, Files, Sites and Messages, and at its foot Settings over the limits while the dock\'s gauge is out of the way', { timeout: 120000 }, async () => {
  const f = await mac();
  const { page } = f;
  try {
    const heads = await page.locator('#session-rail .sidebar-head-title').allTextContents();
    assert.deepEqual(heads, ['Sessions', 'Files', 'Sites', 'Messages']);
    assert.equal(await page.locator('#session-rail .sidebar-history').count(), 1, 'past sessions are folded under History');
    // In the list's order: New session, History straight under it, then
    // Files, Sites and Messages; the foot is Settings, then the limits under its line.
    const order = await page.locator('#session-rail .session-rail-list').evaluate(list => [...list.querySelectorAll('.sidebar-head-title, .sidebar-history, .sidebar-row .session-rail-asked')].map(n => n.textContent));
    assert.equal(order[order.indexOf('History') - 1], 'New session', `History under New session: ${order}`);
    assert.equal(order[order.indexOf('History') + 1], 'Files', `History in Sessions, Files beside them: ${order}`);
    assert.ok(!order.includes('Settings'), `Settings is not in the list: ${order}`);
    assert.deepEqual(await page.locator('#session-rail > .session-rail-foot > *').evaluateAll(all => all.map(n => ['session-rail-settings', 'session-rail-usage'].find(name => n.classList.contains(name)))), ['session-rail-settings', 'session-rail-usage'], 'Settings over the limits at the foot');
    // Every row's highlight runs the sidebar's width, and every row's words start on one line.
    const rail = await page.locator('#session-rail').evaluate(n => n.getBoundingClientRect().width);
    const rows = await page.locator('#session-rail .session-rail-list .session-rail-open').evaluateAll(all => all.filter(n => n.offsetWidth).map(n => { const r = n.getBoundingClientRect(), icon = n.querySelector('.session-rail-agent, .sidebar-icon')?.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width), icon && Math.round(icon.left)]; }));
    assert.ok(rows.length >= 4, JSON.stringify(rows));
    for (const [left, width, icon] of rows) { assert.equal(left, 0); assert.ok(Math.abs(width - rail) <= 1, `${width} of ${rail}`); if (icon != null) assert.equal(icon, rows[0][2], JSON.stringify(rows)); }
    assert.equal(await page.locator('#session-rail .sidebar-computer').count(), 0, 'no computers\' pills');
    assert.equal(await page.locator('#session-rail .session-rail-usage').count(), 1, 'usage at the foot');
    assert.equal(await page.locator('.entry-usage').first().evaluate(n => n.offsetWidth), 0, 'the dock\'s gauge hidden while the sidebar is open');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
