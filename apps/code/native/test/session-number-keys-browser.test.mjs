import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { fixture, fixtureResponse, serve } from '../../tools/gui-preview.mjs';
import { altAlias, windowKey } from '../../../../desktop/electron/keys.mjs';

// imperfect's keys are held with one modifier (public/js/pi-card.js). In the
// desktop window (preload.cjs gives the page imperfectDesk) it is Super: under
// sway (imperfect OS) Super alone, Alt left to apps and text; under a window
// manager that keeps Super (Hyprland) Alt answers too, unannounced, as the
// window says (desktop/electron/keys.mjs). In a browser it is Alt alone, since
// Super there is the Windows key or Cmd.
const CONTEXTS = [
  { name: 'desktop window under sway', desk: true, altAlias: false, mod: 'Meta', label: 'Super', alias: null, refused: 'Alt', hidden: /\bAlt\b|\bOpt\b/ },
  { name: 'desktop window under Hyprland', desk: true, altAlias: true, mod: 'Meta', label: 'Super', alias: 'Alt', refused: 'Meta+Alt', hidden: /\bAlt\b|\bOpt\b/ },
  { name: 'browser', desk: false, mod: 'Alt', label: 'Alt', alias: null, refused: 'Meta', hidden: /\bSuper\b/ },
];

// The complete page (site.js and all) on a fake computer that answers as the
// real one does; calls are what the page asked of it.
async function open({ desk, altAlias }, t) {
  const { server, sockets, port } = await serve('');
  const calls = [];
  const data = fixture();
  // Blocked sorts first in the rail, ahead of the working tab the list starts with.
  data.tabs = [...data.tabs, { ...data.tabs[1], id: 'third', sessionId: 'third', status: 'blocked', name: 'Third task' }];
  // Focus answered as the computer answers it, with the snapshot of the tab
  // now in front: one that fails would drop a key pressed while it was asked.
  sockets.removeAllListeners('connection');
  sockets.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'snapshot', data }));
    socket.on('message', raw => {
      const c = JSON.parse(raw); calls.push(c);
      const answer = c.type === 'tab-focus' ? { snapshot: { ...data, sessionId: c.tabId, tabs: data.tabs.map(tab => ({ ...tab, focused: tab.id === c.tabId })) } } : c.type === 'snapshot' ? data : c.type === 'prompt' ? { accepted: true } : fixtureResponse(c);
      socket.send(JSON.stringify({ type: 'response', id: c.id, success: true, data: answer }));
    });
  });
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  t.after(async () => {
    await browser.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  // The desktop window's bridge, as preload.cjs gives it, before any script:
  // keys heard in a website come here.
  if (desk) await page.addInitScript(altAlias => { globalThis.imperfectDesk = { altAlias, onKey: fn => { globalThis.deskKey = fn; }, onBrowse() {}, onTab() {}, front() {}, onOpen() {} }; }, altAlias);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/?face=code`);
  await page.waitForSelector('[data-tab-id="third"] .session-rail-open');
  return { page, calls, errors };
}

for (const context of CONTEXTS) {
  const { name, desk, mod, label, alias, refused } = context;
  test(`${label}+1 to ${label}+5 enter the sessions in the order the rail shows them (${name})`, { timeout: 20000 }, async t => {
    const { page, calls, errors } = await open(context, t);
    const rail = await page.$$eval('.session-rail-item[data-tab-id]', rows => rows.map(row => row.dataset.tabId));
    assert.deepEqual(rail, ['third', 'mirror', 'other']);
    await page.waitForTimeout(300);
    const before = calls.length;
    const focused = () => calls.slice(before).filter(c => c.type === 'tab-focus').map(c => c.tabId);
    // A session asked for while another is coming is asked for once that
    // one is in (harness.js switchTab), and comes in with a view transition.
    const entered = async (id, asked) => {
      await page.waitForFunction(id => document.querySelector(`[data-tab-id="${id}"]`)?.classList.contains('active') && !document.documentElement.classList.contains('session-turn'), id);
      for (let i = 0; i < 40 && focused().length < asked.length; i++) await page.waitForTimeout(25);
      assert.deepEqual(focused(), asked);
    };
    await page.keyboard.press(`${mod}+3`);
    await entered('other', ['other']);
    await page.keyboard.press(`${mod}+1`);
    await entered('third', ['other', 'third']);
    assert.deepEqual(focused(), ['other', 'third']);
    // No fourth or fifth session: nothing happens.
    await page.keyboard.press(`${mod}+4`);
    await page.keyboard.press(`${mod}+5`);
    // Other modifiers are not these keys: in a browser Super is the
    // browser's (Cmd+2 is its second tab), and in the desktop window Super
    // and Alt together are neither.
    await page.keyboard.press(`${mod}+Shift+2`);
    await page.keyboard.press(`Control+${mod}+2`);
    await page.keyboard.press(`${refused}+2`);
    await page.waitForTimeout(150);
    assert.deepEqual(focused(), ['other', 'third']);
    if (desk) {
      // Under Hyprland Alt still answers in the desktop window; under sway
      // it is Alt, and nothing happens.
      await page.keyboard.press(`${alias ?? 'Alt'}+3`);
      if (alias) await entered('other', ['other', 'third', 'other']);
      else { await page.waitForTimeout(150); await page.keyboard.press(`${mod}+3`); await entered('other', ['other', 'third', 'other']); }
      // From a website in the browser, through Electron's bridge.
      await page.evaluate(() => globalThis.deskKey('session2'));
      await page.evaluate(() => globalThis.deskKey('session5'));
      await page.waitForTimeout(150);
      assert.deepEqual(focused(), ['other', 'third', 'other', 'mirror']);
    }
    assert.deepEqual(errors, []);
  });

  test(`${label}+K lists the keys by the name of the modifier held for them, ${label}+Enter sends (${name})`, { timeout: 20000 }, async t => {
    const { page, calls, errors } = await open(context, t);
    const sheet = page.locator('#keys-face');
    await page.locator('#entry-input').focus();
    await page.keyboard.press(`${refused}+K`);
    await page.waitForTimeout(100);
    assert.equal(await sheet.isVisible(), false, `${refused}+K is not the key`);
    await page.keyboard.press(`${mod}+K`);
    await sheet.waitFor();
    const keys = await sheet.locator('.keys-key').allTextContents();
    for (const key of [`${label}+K`, `${label}+1`, `${label}+Shift+B`, `${label}+←`, `${label}+↑`, `${label}+↓`, '↑', `${label}+Enter`, `${label}+Shift+T`]) assert.ok(keys.includes(key), `${key} in ${keys}`);
    assert.deepEqual(keys.filter(key => key === `${label}+Shift+↑` || key === `${label}+Shift+↓`), [], 'the sessions are the plain modifier\'s Up and Down now');
    assert.deepEqual(keys.filter(key => context.hidden.test(key)), [], 'only the modifier held here is named');
    assert.equal(await page.getByRole('button', { name: 'Open PC browser (Chromium)', exact: true }).getAttribute('title'), 'Browser (Chromium) · PC browser');
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    if (alias) {
      await page.waitForTimeout(150); // the sheet's key answers once per press (site.js onceCanvas)
      await page.keyboard.press(`${alias}+K`);
      await sheet.waitFor();
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'hidden' });
    }
    // Enter and the modifier's Enter both send; Super's in a browser does not.
    const prompts = () => calls.filter(c => c.type === 'prompt').map(c => c.text);
    const input = page.locator('#entry-input');
    for (const [key, text] of [[`${mod}+Enter`, 'held'], ...(alias ? [[`${alias}+Enter`, 'alias']] : [])]) {
      await input.fill(text); await input.focus();
      await page.keyboard.press(key);
      for (let i = 0; i < 80 && !prompts().includes(text); i++) await page.waitForTimeout(25);
      assert.ok(prompts().includes(text), `${key} sent ${text}`);
      assert.equal(await input.inputValue(), '');
      await page.waitForTimeout(150); // its acceptance comes back before the next is sent
    }
    await input.fill('not sent'); await input.focus();
    await page.keyboard.press(`${refused}+Enter`);
    await page.waitForTimeout(200);
    assert.deepEqual(prompts(), alias ? ['held', 'alias'] : ['held']);
    assert.deepEqual(errors, []);
  });
}

test('Electron sends Super (and the enabled Alt alias) +1 to +5 from websites to the canvas, and nothing else with them', () => {
  for (const alias of [true, false]) for (const held of [{ meta: true, alt: false }, { meta: false, alt: true }]) {
    const key = (code, more = {}) => windowKey({ type: 'keyDown', code, key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code, control: false, shift: false, ...held, ...more }, { alias });
    if (held.alt && !alias) {
      // Under sway Alt is Alt: every chord is the website's.
      for (const code of ['Digit1', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyW', 'KeyF', 'KeyV']) assert.equal(key(code), '', code);
      assert.equal(key('KeyB', { shift: true }), '');
      continue;
    }
    for (const n of [1, 2, 3, 4, 5]) assert.equal(key(`Digit${n}`), `session${n}`);
    assert.equal(key('ArrowLeft'), 'previous');
    assert.equal(key('ArrowRight', { shift: true }), 'along');
    assert.equal(key('ArrowUp'), 'up');
    assert.equal(key('ArrowDown'), 'down');
    assert.equal(key('ArrowUp', { shift: true }), '');
    assert.equal(key('KeyB', { shift: true }), 'browser');
    assert.equal(key('Enter', { shift: true }), 'over');
    assert.equal(key('KeyW'), 'close');
    assert.equal(key('KeyF'), 'full');
    assert.equal(key('KeyF', { shift: true }), 'fullWindow');
    assert.equal(key('KeyV'), '');
    assert.equal(key('KeyV', { shift: true }), 'clipboard');
    assert.equal(key('Digit6'), '');
    assert.equal(key('Digit1', { shift: true }), '');
    assert.equal(key('Digit1', { control: true }), '');
    assert.equal(key('Digit1', { meta: true, alt: true }), '', 'Super and Alt together are neither');
    assert.equal(key('Digit1', { meta: false, alt: false }), '');
    assert.equal(key('Digit1', { type: 'keyUp' }), '');
  }
});

test('Alt answers for Super only under Hyprland, never under sway; told by the session, not the name', () => {
  assert.equal(altAlias({ SWAYSOCK: '/run/user/1000/sway-ipc.1000.42.sock', XDG_CURRENT_DESKTOP: 'sway:wlroots' }), false, 'imperfect OS');
  assert.equal(altAlias({ XDG_CURRENT_DESKTOP: 'sway:wlroots' }), false);
  assert.equal(altAlias({ SWAYSOCK: '/run/user/1000/sway-ipc.1000.42.sock' }), false);
  assert.equal(altAlias({ HYPRLAND_INSTANCE_SIGNATURE: 'abc_123', XDG_CURRENT_DESKTOP: 'Hyprland' }), true, 'Omarchy');
  assert.equal(altAlias({ HYPRLAND_INSTANCE_SIGNATURE: 'abc_123', SWAYSOCK: '/tmp/stale' }), false, 'sway never aliases Alt');
  assert.equal(altAlias({ XDG_CURRENT_DESKTOP: 'Hyprland' }), true);
  assert.equal(altAlias({ XDG_CURRENT_DESKTOP: 'GNOME' }), false);
  assert.equal(altAlias({}), false, 'unknown hosts use Super only');
  assert.equal(altAlias({ HOSTNAME: 'laptop', XDG_CURRENT_DESKTOP: 'sway' }), false);
});
