// Real Electron guests and project frames, in a hidden disposable host.
// No installed service, profile, phone or person's browser is used.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGueyServer } from '../system/server.mjs';
import { createTabHost } from '../apps/code/native/tabs.mjs';

const root = await mkdtemp(join(tmpdir(), 'imperfect-pane-keys-'));
const site = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Keyboard page</title><style>body{height:6000px}</style><input id="draft"><script>window.heard=[];addEventListener("keydown",e=>heard.push(e.code));</script>');
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${site.address().port}/`;
const runtime = await createTabHost({ cwd: root, stateDir: join(root, 'tabs'), listPiSessions: async () => [], listClaudeSessions: async () => [], createRuntime: async () => {
  const snap = { sessionId: 'test', sessionFile: 'test', cwd: root, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'test' }] }], busy: false, streaming: false, failed: null };
  return { events: new EventEmitter(), snapshot: () => snap, command: async () => ({ ok: true }), close: async () => {} };
} });
const machine = await createGueyServer({ host: '127.0.0.1', port: 0, stateDir: join(root, 'server'), runtime, machines: { self: async () => 'check', selfId: async () => 'check', origins: async () => [], list: async () => [], peer: async () => null } });
const port = (await machine.listen()).port;
const project = await globalThis[Symbol.for('imperfect.shown')](url);
// --sway: the window as under imperfect OS, where Super alone holds
// imperfect's keys and Alt is the website's; otherwise this desktop's own
// session (Hyprland on the PC), where Alt answers too (desktop/electron/keys.mjs).
const sway = process.argv.includes('--sway');
// --shown: the window shown, and so focused, as only a real one is (a
// website then has the keys a moment after it is given them). Only under a
// compositor of the check's own, never the person's desktop.
const shown = process.argv.includes('--shown');
const env = { ...process.env, IMPERFECT_PORT: String(port) };
if (sway) { delete env.HYPRLAND_INSTANCE_SIGNATURE; Object.assign(env, { SWAYSOCK: join(root, 'sway.sock'), XDG_CURRENT_DESKTOP: 'sway:wlroots' }); }
let app;
try {
  app = await _electron.launch({ executablePath: join(import.meta.dirname, '../node_modules/.bin/electron'), args: ['desktop/electron/main.mjs', ...(shown ? [] : ['--hidden']), ...(process.env.DISPLAY ? ['--ozone-platform=x11'] : []), `--user-data-dir=${join(root, 'profile')}`], cwd: join(import.meta.dirname, '..'), env });
  const shell = await app.firstWindow();
  shell.setDefaultTimeout(5000);
  // Nothing slides: the view moves in the same moment as the keys. Wide
  // enough for two windows side by side, as on the laptop.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1472, 900));
  await shell.waitForFunction(() => document.querySelector('.canvas-strip')?.clientWidth >= 1280);
  await shell.locator('.wm-files .workbench').waitFor();
  // A hidden Electron host does not advance its entrance animation reliably.
  await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.insertCSS('.code-face,.wm-arriving{animation:none!important}'));
  assert.equal(await shell.evaluate(() => imperfectDesk.altAlias), !sway, 'the page is told whether Alt answers');
  assert.equal(await shell.evaluate(() => imperfectDesk.isFocused()), await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), 'capture targeting asks the native host, not the guest focus');
  const chord = (id, code, modifiers = ['meta']) => app.evaluate(({ webContents }, { id, code, modifiers }) => {
    const page = webContents.fromId(id);
    page.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers });
    page.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers });
  }, { id, code, modifiers });
  const host = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.id);
  const left = () => shell.evaluate(() => document.querySelector('.canvas-strip').scrollLeft);
  const focused = () => shell.evaluate(() => document.querySelector('.wm-focused').className.match(/entry-screen|wm-files|wm-browser/)[0]);
  // Super+Right: Files takes the keys; Super+Left: the conversation again.
  await shell.locator('#entry-input').fill('retained composer draft');
  await chord(host, 'Right');
  await shell.locator('.wm-files.wm-focused').waitFor();
  assert.equal(await shell.evaluate(() => document.activeElement.classList.contains('workbench')), true);
  await chord(host, 'Left');
  await shell.locator('.entry-screen.wm-focused').waitFor();
  assert.equal(await shell.evaluate(() => document.activeElement.id), 'entry-input');
  // Alt alone, in the page: imperfect's only off sway.
  await chord(host, 'Right', ['alt']);
  await shell.waitForTimeout(150);
  assert.equal(await focused(), sway ? 'entry-screen' : 'wm-files', sway ? 'under sway Alt+Right is not imperfect\'s' : 'Alt answers too');
  if (!sway) await chord(host, 'Left', ['alt']);
  await shell.locator('.entry-screen.wm-focused').waitFor();
  await app.evaluate(({ webContents }, { host, url }) => {
    webContents.fromId(host).send('browse', { url, behind: true });
    webContents.fromId(host).send('browse', { url: `${url}?second`, behind: true });
  }, { host, url });
  await shell.waitForFunction(() => document.querySelectorAll('webview').length === 2 && [...document.querySelectorAll('webview')].every(n => { try { return n.getWebContentsId() > 0; } catch { return false; } }));
  assert.equal(await shell.locator('.entry-screen.wm-focused').count(), 1, 'agent opening preserves selection');
  assert.equal(await left(), 0, 'quiet openings go in the next place on the right and leave the view alone');
  // The conversation and Files in view, the browser out of sight: one
  // Super+Right shows it, past Files, with the keys.
  await chord(host, 'Right');
  await shell.locator('.wm-browser.wm-focused').waitFor();
  assert.ok(await left() > 0, 'the browser comes into view');
  await shell.waitForFunction(() => document.activeElement?.localName === 'webview');
  // Focus follows the pointer at once, into a website from the side too,
  // and the view never moves for it. Straight on, the pointer into Files:
  // the website's page has the keys a moment after it was given them, and
  // that late arrival must not take them back from Files.
  const viewed = await left();
  const filesBox = await shell.locator('.wm-files .workbench').boundingBox(), guestBox = await shell.locator('.browser-page.front webview').boundingBox();
  await shell.mouse.move(filesBox.x + filesBox.width / 2, filesBox.y + filesBox.height / 2);
  assert.equal(await focused(), 'wm-files');
  const browsing = await shell.evaluate(() => document.querySelector('.browser-page.front webview').getWebContentsId());
  await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('document.hasFocus()'), browsing);
  assert.equal(await shell.evaluate(() => Boolean(document.activeElement.closest('.wm-files'))), true, 'Files still has the keys');
  assert.equal(await focused(), 'wm-files');
  await shell.mouse.move(guestBox.x + guestBox.width / 2, guestBox.y + guestBox.height / 2, { steps: 8 });
  assert.equal(await focused(), 'wm-browser');
  assert.equal(await shell.evaluate(() => document.activeElement.localName), 'webview', 'the website has the keys');
  assert.equal(await left(), viewed);
  const guest = await shell.evaluate(() => document.querySelector('.browser-page.front webview').getWebContentsId());
  await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('draft.value="retained website draft";scrollTo(0,120)'), guest);
  const tiled = await shell.locator('.wm-browser').boundingBox();
  const originalLeft = await left();
  await chord(guest, 'F', ['meta', 'shift']);
  await shell.locator('.wm-full-window').waitFor();
  await shell.waitForTimeout(150);
  const expanded = await shell.locator('.wm-browser').boundingBox();
  const viewport = await shell.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.deepEqual(expanded, { x: 0, y: 0, ...viewport }, 'native guest chord covers the composer');
  // Flush a hidden host's compositor as the live watcher does for real frames.
  await app.evaluate(async ({ BrowserWindow }) => { await BrowserWindow.getAllWindows()[0].webContents.capturePage(); });
  await shell.waitForTimeout(200);
  const guestRect = await shell.locator('.browser-page.front webview').boundingBox();
  const nativeSize = await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('({width:innerWidth,height:innerHeight})'), guest);
  assert.equal(nativeSize.width, Math.round(guestRect.width));
  assert.equal(nativeSize.height, Math.round(guestRect.height));
  assert.equal(guestRect.y + guestRect.height, viewport.height, 'native bounds reach the bottom');
  await chord(guest, 'Escape', []);
  await shell.waitForFunction(() => !document.querySelector('.wm-full-window'));
  await shell.waitForTimeout(150);
  assert.deepEqual(await shell.locator('.wm-browser').boundingBox(), tiled);
  assert.equal(await left(), originalLeft);
  assert.deepEqual(await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('({draft:draft.value,scroll:scrollY})'), guest), { draft: 'retained website draft', scroll: 120 });
  assert.equal(await shell.locator('#entry-input').inputValue(), 'retained composer draft');
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('typeof imperfectDesk'), guest), 'undefined', 'websites receive no capture/focus bridge');
  const history = () => app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('JSON.stringify({url:location.href,length:history.length,heard:heard.filter(code=>code.startsWith("Arrow"))})'), guest);
  // Super and Alt together are not the chord: the website has that one.
  const was = await left();
  await chord(guest, 'Left', ['meta', 'alt']);
  await shell.waitForTimeout(100);
  assert.equal(await left(), was, 'Super and Alt together are not the chord');
  assert.equal(await focused(), 'wm-browser');
  assert.match(await history(), /"heard":\["ArrowLeft"\]/, 'the website hears Super+Alt+Left');
  await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('heard.length = 0'), guest);
  if (sway) {
    // Under sway Alt+Left is the website's.
    await chord(guest, 'Left', ['alt']);
    await shell.waitForTimeout(150);
    assert.equal(await focused(), 'wm-browser', 'Alt+Left stays in the website');
    assert.match(await history(), /"heard":\["ArrowLeft"\]/, 'and the website hears it');
    await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('heard.length = 0'), guest);
  }
  const before = await history();
  const edge = await left();
  await chord(guest, 'Right');
  await shell.waitForTimeout(100);
  assert.equal(await left(), edge, 'native right edge does not wrap');
  assert.equal(await focused(), 'wm-browser');
  // Out of the browser: the conversation, out of sight past Files, takes the keys.
  await chord(guest, 'Left', sway ? ['meta'] : ['alt']);
  await shell.locator('.entry-screen.wm-focused').waitFor();
  assert.equal(await left(), 0);
  assert.equal(await shell.evaluate(() => document.activeElement.id), 'entry-input');
  assert.equal(await history(), before, 'the website hears no pane arrow and changes no history');
  assert.equal(await shell.locator('.browser-page.front webview').getAttribute('src'), url, 'no tab change');
  // Super+L from inside the website: dwindle, every window in view, and the
  // website's own size follows its tile; again, the strip.
  await chord(host, 'Right');
  await shell.locator('.wm-browser.wm-focused').waitFor();
  await shell.waitForFunction(() => document.activeElement?.localName === 'webview');
  await chord(guest, 'L');
  await shell.locator('.canvas-strip.wm-dwindle').waitFor();
  await app.evaluate(async ({ BrowserWindow }) => { await BrowserWindow.getAllWindows()[0].webContents.capturePage(); });
  await shell.waitForTimeout(200);
  const tile = await shell.locator('.browser-page.front webview').boundingBox();
  const tileSize = await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('({width:innerWidth,height:innerHeight})'), guest);
  assert.deepEqual(tileSize, { width: Math.round(tile.width), height: Math.round(tile.height) }, 'the website is the size of its tile');
  assert.ok(tile.width < viewport.width * 0.6 && tile.height < viewport.height * 0.6, 'a quarter of the window: Files above it, the conversation beside');
  assert.equal(await focused(), 'wm-browser');
  assert.deepEqual(await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('({draft:draft.value,scroll:scrollY})'), guest), { draft: 'retained website draft', scroll: 120 });
  // Super going down and up inside the website lifts a cover over every
  // window, to carry one, and puts it away.
  const modifier = type => app.evaluate(({ webContents }, { id, type }) => webContents.fromId(id).sendInputEvent({ type, keyCode: 'Meta', modifiers: type === 'keyDown' ? ['meta'] : [] }), { id: guest, type });
  await modifier('keyDown');
  await shell.locator('.canvas-strip.wm-grab').waitFor();
  await modifier('keyUp');
  await shell.waitForFunction(() => !document.querySelector('.wm-grab'));
  // Held, the website itself is picked up by the pointer, never clicked: the
  // browser carried onto the conversation's tile, then back after Files.
  const order = () => shell.evaluate(() => [...document.querySelectorAll('.canvas-strip > .wm-window')].sort((a, b) => a.style.order - b.style.order).map(n => n.className.match(/entry-screen|wm-files|wm-browser/)[0]));
  await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('window.pressed=0;addEventListener("pointerdown",()=>pressed++,true)'), guest);
  const carry = async (from, to) => {
    const a = await shell.locator(from).boundingBox(), b = await shell.locator(to).boundingBox();
    // Super down where the keys are (a website: the desktop window says so),
    // and held for the pointer's own events.
    await shell.keyboard.down('Meta');
    await modifier('keyDown');
    await shell.locator('.canvas-strip.wm-grab').waitFor();
    // The cover drawn: until a frame shows it, the compositor still sends
    // the pointer into the website under it.
    await shell.evaluate(() => new Promise(drawn => requestAnimationFrame(() => requestAnimationFrame(drawn))));
    await shell.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
    await shell.mouse.up();
    await shell.keyboard.up('Meta');
    await modifier('keyUp');
  };
  await carry('.wm-browser', '.entry-screen');
  assert.deepEqual(await order(), ['wm-browser', 'entry-screen', 'wm-files']);
  await carry('.wm-browser', '.wm-files');
  assert.deepEqual(await order(), ['entry-screen', 'wm-files', 'wm-browser']);
  assert.equal(await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('pressed'), guest), 0, 'the website never felt the pointer');
  assert.equal(await focused(), 'wm-browser', 'the window carried has the keys');
  // Rotated along and back with Super+Shift+arrows: the same website, alive.
  await chord(host, 'Right', ['meta', 'shift']);
  await chord(host, 'Left', ['meta', 'shift']);
  assert.deepEqual(await order(), ['entry-screen', 'wm-files', 'wm-browser']);
  assert.equal(await shell.evaluate(() => document.querySelector('.browser-page.front webview').getWebContentsId()), guest, 'never loaded again');
  assert.deepEqual(await app.evaluate(async ({ webContents }, id) => webContents.fromId(id).executeJavaScript('({draft:draft.value,scroll:scrollY})'), guest), { draft: 'retained website draft', scroll: 120 });
  await chord(guest, 'L');
  await shell.waitForFunction(() => !document.querySelector('.wm-dwindle'));
  await shell.waitForFunction(() => document.activeElement?.localName === 'webview');
  // Full, Super+Left leaves it for the window before: Files.
  await chord(guest, 'F');
  await shell.locator('.wm-browser.wm-full').waitFor();
  await chord(guest, 'Left');
  await shell.waitForFunction(() => !document.querySelector('.wm-full'));
  await shell.locator('.wm-files.wm-focused').waitFor();
  const filesLeft = await left();
  // Electron intercepts the same chord when a project's iframe owns keys.
  await shell.evaluate(url => {
    const frame = document.createElement('iframe'); frame.id = 'key-project'; frame.src = url;
    document.querySelector('.wm-files').append(frame);
  }, project.url);
  await shell.frameLocator('#key-project').locator('#draft').fill('project draft');
  if (sway) {
    // Alt in the project is the project's: the page ignores what a frame says.
    await chord(host, 'Right', ['alt']);
    await shell.waitForTimeout(150);
    assert.equal(await shell.evaluate(() => document.activeElement.id), 'key-project', 'Alt+Right stays in the project');
    assert.equal(await left(), filesLeft);
  }
  await chord(host, 'Left');
  await shell.locator('.entry-screen.wm-focused').waitFor();
  await chord(host, 'Right');
  await shell.locator('.wm-browser.wm-focused').waitFor();
  assert.equal(await shell.locator('#entry-input').inputValue(), 'retained composer draft');
  assert.equal(await shell.frameLocator('#key-project').locator('#draft').inputValue(), 'project draft');
  await shell.locator('.wm-files .workbench').focus();
  await shell.locator('.wm-files.wm-focused').waitFor();
  await shell.frameLocator('#key-project').locator('#draft').focus();
  const menuLeft = await left();
  // A held shell menu also guards a chord arriving over native IPC.
  await shell.evaluate(() => { const menu = document.createElement('div'); menu.id = 'held-menu'; menu.setAttribute('role', 'menu'); document.body.append(menu); });
  await chord(guest, 'Right');
  await shell.waitForTimeout(100);
  assert.equal(await left(), menuLeft);
  assert.equal(await shell.evaluate(() => document.activeElement.id), 'key-project');
  await chord(guest, 'B', ['meta', 'shift']);
  await shell.waitForTimeout(100);
  assert.equal(await left(), menuLeft, 'held menu guards native browser launch');
  await shell.evaluate(() => document.querySelector('#held-menu').remove());
  const tabCount = await shell.locator('webview').count();
  await chord(host, 'B', ['meta', 'shift']);
  await shell.waitForFunction(() => {
    const pane = document.querySelector('.wm-browser').getBoundingClientRect(), strip = document.querySelector('.canvas-strip').getBoundingClientRect();
    return pane.left >= strip.left - 2 && pane.right <= strip.right + 2;
  });
  await chord(guest, 'B', ['meta', 'shift']);
  if (!sway) await chord(guest, 'B', ['alt', 'shift']);
  await chord(host, 'B', ['meta', 'shift']);
  assert.equal(await shell.locator('webview').count(), tabCount, 'native guest and project launch reuse current browser');
  assert.equal(await shell.locator('#entry-input').inputValue(), 'retained composer draft');
  assert.equal(await shell.frameLocator('#key-project').locator('#draft').inputValue(), 'project draft');
  // Authority lookup is asynchronous; let the last explicit launch settle
  // before simulating closure of every tab and a fresh launch.
  await shell.waitForTimeout(100);
  const ids = await shell.locator('webview').evaluateAll(nodes => nodes.map(n => n.getWebContentsId()));
  await app.evaluate(({ webContents }, { host, ids }) => { for (const id of ids) webContents.fromId(host).send('tab', { id, do: 'close' }); }, { host, ids });
  await shell.waitForFunction(() => !document.querySelector('webview'));
  await chord(host, 'B', ['meta', 'shift']);
  await shell.waitForFunction(() => { try { return document.querySelector('webview')?.getWebContentsId() > 0; } catch { return false; } });
  assert.equal(await shell.locator('webview').count(), 1);
  assert.equal(await shell.locator('webview').getAttribute('src'), 'about:blank');
  assert.equal(await shell.locator('.gui-window-address').evaluate(n => n === document.activeElement), true);
  await chord(host, 'B', ['meta', 'shift']);
  assert.equal(await shell.locator('webview').count(), 1);
  console.log(`PASS (${sway ? 'sway: Super only' : 'Alt answers too'}): real Electron pane keys by view, Super+L dwindle with native guest bounds, Super hold/release from a website, Super+drag and rotation over a real website that stays loaded, full-window native bounds/Escape, local browser reuse/menu guard, website/project/composer drafts, scroll and history`);
} finally {
  await app?.close();
  await machine.close();
  await new Promise(resolve => site.close(resolve));
  await rm(root, { recursive: true, force: true });
}
