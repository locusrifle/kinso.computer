import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnOwnedChild } from './fixtures/owned-child.mjs';
import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { createGueyServer } from '../../../../system/server.mjs';
import { createTabHost } from '../tabs.mjs';
import { askWindow, windowSockets } from '../browser.mjs';

const until = async (check, label) => {
  for (const end = Date.now() + 12000; !await check(); await new Promise(r => setTimeout(r, 40))) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
  }
};

test('real headed guests: remote viewport, native input, IME and scoped ownership', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-viewport-'));
  await mkdir(join(root, '.imperfect'));
  let child, compositor, machine, runtime, browser, stopChild, stopCompositor;
  const site = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Viewport fixture</title>
      <style>body{margin:0;background:#234}input,textarea,[contenteditable]{position:absolute;left:20px;top:30px;width:250px;height:40px;font:16px sans-serif}#password{top:100px}#multi{top:170px}#rich{top:260px}#edge{position:fixed;right:0;bottom:0;width:24px;height:24px;background:#ff0}</style>
      <form onsubmit="event.preventDefault();window.submitted=(window.submitted||0)+1"><input id="plain" value="hello world"><input id="password" type="password" value="fixture-private"><textarea id="multi">one\ntwo</textarea><button type="submit" hidden>Submit</button></form>
      <div id="rich" contenteditable>rich</div><button id="edge" onclick="window.edgeClicked=true"></button><div style="height:1800px"></div>`);
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      try { await stopChild?.(); }
      finally {
        try { await stopCompositor?.(); }
        finally {
          try { await machine?.close(); }
          finally {
            try { await runtime?.close(); }
            finally {
              try { await new Promise(r => site.close(r)); }
              finally { await rm(root, { recursive: true, force: true }); }
            }
          }
        }
      }
    }
  });
  const fake = () => {
    const snap = { sessionId: 'viewport-test', sessionFile: 'fixture', cwd: root, messages: [], busy: false, streaming: false, failed: null };
    return { events: new EventEmitter(), snapshot: () => snap, command: async () => ({ ok: true }), close: async () => {} };
  };
  runtime = await createTabHost({ cwd: root, stateDir: join(root, 'tabs'), createRuntime: fake, listPiSessions: async () => [], listClaudeSessions: async () => [] });
  let port;
  const sockets = () => windowSockets(port, join(root, '.imperfect'));
  machine = await createGueyServer({ host: '127.0.0.1', port: 0, stateDir: join(root, 'server'), sessionToken: 'viewport-fixture-only', runtime,
    browser: { sockets, open: () => assert.fail('fixture browser already launched') },
    machines: { self: async () => 'fixture', selfId: async () => 'fixture', origins: async () => [], list: async () => [], peer: async () => null } });
  port = (await machine.listen()).port;
  // Ozone's headless backend does not composite headed <webview> guests.
  // Use a private software Wayland display, never the person's desktop/GPU.
  const xdg = join(root, 'xdg'); await mkdir(xdg, { mode: 0o700 });
  const config = join(root, 'sway.conf'); await writeFile(config, 'output HEADLESS-1 resolution 1400x900\n');
  ({ child: compositor, stop: stopCompositor } = spawnOwnedChild('sway', ['--unsupported-gpu', '-c', config], { env: { PATH: process.env.PATH, HOME: root, XDG_RUNTIME_DIR: xdg, WLR_BACKENDS: 'headless', WLR_LIBINPUT_NO_DEVICES: '1', WLR_RENDERER: 'pixman', LANG: 'C.UTF-8' }, stdio: 'ignore' }));
  let display;
  await until(async () => { if (compositor.exitCode != null || compositor.signalCode != null) throw new Error('Private compositor exited'); display = (await readdir(xdg)).find(n => /^wayland-\d+$/.test(n)); return display; }, 'private software display');
  const env = { ...process.env, HOME: root, IMPERFECT_PORT: String(port), XDG_RUNTIME_DIR: xdg, WAYLAND_DISPLAY: display };
  for (const key of ['DISPLAY', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  ({ child, stop: stopChild } = spawnOwnedChild(createRequire(import.meta.url)('electron'), ['desktop/electron/main.mjs', '--remote-debugging-port=0', '--ozone-platform=wayland', '--disable-gpu', `--user-data-dir=${join(root, 'profile')}`], { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] }));
  let errors = '';
  child.stderr.on('data', data => { errors = (errors + data).slice(-2000); });
  await until(async () => { if (child.exitCode != null || child.signalCode != null) throw new Error(`Fixture exited: ${errors}`); return (await sockets()).length; }, 'headed socket');
  const ask = said => askWindow(said, { sockets, open: () => assert.fail('fixture missing') });
  const url = `http://127.0.0.1:${site.address().port}/`;
  const first = (await ask({ do: 'open', url })).tab;
  const second = (await ask({ do: 'open', url })).tab;
  const run = async (code, tab = first) => (await ask({ do: 'run', tab, code, page: true })).value;
  let debugPort;
  await until(async () => { try { debugPort = Number((await readFile(join(root, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return debugPort; } catch { return false; } }, 'fixture debugger');
  const native = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const canvas = native.contexts()[0].pages().find(page => page.url().startsWith(`http://127.0.0.1:${port}`));
  await canvas.keyboard.press('Meta+Shift+b');
  await canvas.waitForFunction(() => { const b = document.querySelector('webview').getBoundingClientRect(); return b.x < innerWidth && b.right > 0; });
  const originalViewport = await run('[innerWidth,innerHeight]');
  browser = await launchChromium({ headless: true, args: ['--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const remote = await context.newPage();
  await remote.goto(`http://127.0.0.1:${port}`);
  await remote.waitForFunction(() => typeof ImperfectPhone === 'undefined' && document.querySelector('.entry-screen'));
  await remote.evaluate(async ({ first, port }) => {
    const { mountLive } = await import('/js/live.js');
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/css/gui-transcript.css';
    await new Promise((resolve, reject) => { css.onload = resolve; css.onerror = reject; document.head.append(css); });
    const host = document.createElement('div'); host.className = 'gui-window browser full viewport-fixture';
    window.framesSeen = []; window.fieldsSeen = []; window.commands = []; window.notesSeen = []; window.replies = [];
    window.fixtureView = mountLive({ tab: first, browser: true, connect: () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/browser/live`);
      ws.addEventListener('message', event => { const said = JSON.parse(event.data); replies.push({ ...said, frame: said.frame ? '[frame]' : undefined }); if (said.frame) framesSeen.push({ width: said.width, height: said.height, tab: said.tab, size: said.size }); if (said.field) fieldsSeen.push(said); if (said.error) notesSeen.push(said.error); });
      const send = ws.send.bind(ws); ws.send = value => { const said = JSON.parse(value); commands.push({ ...said, text: said.text ? '[redacted]' : said.text }); send(value); };
      window.fixtureSocket = ws; return ws;
    } });
    host.append(fixtureView.bar, fixtureView.body); document.body.append(host); fixtureView.watch('');
  }, { first, port });
  const view = remote.locator('.viewport-fixture .browser-live-view');
  const bridge = remote.locator('.viewport-fixture .browser-live-keyboard');
  await remote.waitForFunction(() => framesSeen.some(f => f.size), null, { timeout: 12000 }).catch(async error => {
    console.log(JSON.stringify(await remote.evaluate(() => ({ notes: notesSeen, commands, frames: framesSeen, replies, socket: fixtureSocket.readyState, note: document.querySelector('.viewport-fixture .browser-live-note')?.textContent, bounds: document.querySelector('.viewport-fixture .browser-live-view')?.getBoundingClientRect().toJSON() }))));
    console.log('Guest viewport:', await run('[innerWidth, innerHeight, devicePixelRatio]'));
    console.log('Electron diagnostics:', errors);
    throw error;
  });
  const fitted = async () => {
    const bounds = await view.boundingBox();
    await until(async () => { const v = await run('[innerWidth,innerHeight]'); return Math.abs(v[0] - bounds.width) <= 1 && Math.abs(v[1] - bounds.height) <= 1; }, 'actual website CSS viewport');
    await until(async () => {
      const frame = await remote.evaluate(() => framesSeen.at(-1));
      return frame && Math.abs(frame.width / frame.height - bounds.width / bounds.height) < .005;
    }, 'newly fitted real frame');
    const frame = await remote.evaluate(() => framesSeen.at(-1));
    assert.ok(Math.abs(frame.width / frame.height - bounds.width / bounds.height) < .005, 'actual frame aspect fills the panel without cropping');
    await remote.waitForFunction(ratio => { const img = document.querySelector('.viewport-fixture .browser-live-frame'); return img.complete && Math.abs(img.naturalWidth / img.naturalHeight - ratio) < .005; }, bounds.width / bounds.height);
    return bounds;
  };
  let bounds = await fitted();
  assert.equal(await remote.locator('.browser-live-type').count(), 0);
  assert.equal(await remote.evaluate(() => document.activeElement.classList.contains('browser-live-keyboard')), false, 'snapshots do not focus');
  const tap = async (x, y) => { bounds = await view.boundingBox(); await remote.touchscreen.tap(bounds.x + x, bounds.y + y); };
  await run('window.fixtureEvents=[]; for(const type of ["mousedown","mouseup","click"]) document.addEventListener(type,e=>fixtureEvents.push({type,x:e.clientX,y:e.clientY,target:e.target.id}));');
  await tap(40, 40);
  await bridge.waitFor();
  await remote.waitForFunction(() => document.activeElement.classList.contains('browser-live-keyboard'), null, { timeout: 12000 }).catch(async error => {
    console.log('Focus diagnostics:', JSON.stringify(await remote.evaluate(() => ({ fields: fieldsSeen.map(s => ({ ...s, field: { ...s.field, value: '[redacted]' } })), commands, active: document.activeElement.tagName, notes: notesSeen }))));
    console.log('Native focus:', await run('({id:document.activeElement.id,zoom:devicePixelRatio,hit:document.elementFromPoint(40,40)?.id,events:fixtureEvents})'));
    throw error;
  });
  const caret = await run('document.querySelector("#plain").selectionStart');
  await remote.keyboard.insertText('X');
  await until(async () => await run('document.querySelector("#plain").value') === `hello world`.slice(0, caret) + 'X' + `hello world`.slice(caret), 'native insertion at clicked caret');
  await remote.keyboard.press('Backspace');
  await until(async () => await run('document.querySelector("#plain").value') === 'hello world', 'native deletion');
  await bridge.evaluate(node => { node.setSelectionRange(0, 5); });
  await remote.keyboard.insertText('paste');
  await until(async () => await run('document.querySelector("#plain").value') === 'paste world', 'selection replacement');
  // A repeated-character edit must use the native caret, not an ambiguous
  // whole-buffer prefix diff that silently moves insertion to the end.
  await run('document.querySelector("#plain").value = "aaaa"');
  await tap(40, 40);
  await remote.waitForFunction(() => document.activeElement.classList.contains('browser-live-keyboard'));
  await bridge.evaluate(node => node.setSelectionRange(2, 2));
  await remote.keyboard.insertText('a');
  await until(async () => await run('document.querySelector("#plain").selectionStart') === 3, 'repeated text preserves exact caret');
  assert.equal(await run('document.querySelector("#plain").value'), 'aaaaa');
  await bridge.evaluate(node => node.setSelectionRange(0, 5));
  await remote.keyboard.insertText('paste world');
  await until(async () => await run('document.querySelector("#plain").value') === 'paste world', 'native replacement after repeated text');
  await remote.keyboard.press('Enter');
  await until(async () => await run('window.submitted') === 1, 'native Enter submits').catch(async error => {
    console.log('Enter diagnostics:', JSON.stringify(await remote.evaluate(() => ({ commands, notes: notesSeen }))));
    console.log('Guest Enter:', await run('({active:document.activeElement.id,submitted:window.submitted,url:location.href})'));
    throw error;
  });
  await remote.evaluate(() => { fixtureView.conceal(true); fixtureView.keys(); });
  assert.equal(await bridge.inputValue(), '', 'concealing the pane clears its ordinary field context');
  assert.equal(await remote.evaluate(() => document.activeElement.classList.contains('browser-live-keyboard')), false, 'hidden panes cannot refocus a stale field');
  await remote.evaluate(() => fixtureView.conceal(false));
  await fitted();
  // Large fields remain editable, but cannot become an unbounded bridge/relay payload.
  await run('document.querySelector("#plain").value = "x".repeat(65537)');
  await tap(40, 40);
  await remote.waitForFunction(() => fieldsSeen.at(-1)?.field.editable && !fieldsSeen.at(-1).field.mirror && document.activeElement.classList.contains('browser-live-keyboard'));
  assert.equal(await remote.evaluate(() => 'value' in fieldsSeen.at(-1).field), false, 'large existing values stay on the website');
  assert.equal((await bridge.inputValue()).length, 1, 'only the incremental sentinel is retained');
  const largeCaret = await run('document.querySelector("#plain").selectionStart');
  await remote.keyboard.insertText('B');
  await until(async () => await run('document.querySelector("#plain").value.indexOf("B")') === largeCaret, 'large-field native insertion at the actual caret');
  await remote.keyboard.press('Backspace');
  await until(async () => await run('document.querySelector("#plain").value.length') === 65537, 'large-field native deletion');
  await run('document.querySelector("#plain").value = "paste world"');
  // A software keyboard can leave a panel below 240 CSS pixels. Fit that
  // actual space instead of stretching a minimum-height desktop image.
  await remote.setViewportSize({ width: 390, height: 200 });
  bounds = await fitted();
  assert.ok(bounds.height < 240, 'keyboard-sized panel actually exercises the old minimum');
  await tap(40, 40);
  await remote.waitForFunction(() => document.activeElement.classList.contains('browser-live-keyboard'));
  const smallCaret = await run('document.querySelector("#plain").selectionStart');
  await remote.keyboard.insertText('S');
  await until(async () => await run('document.querySelector("#plain").value.indexOf("S")') === smallCaret, 'native input in the keyboard-sized viewport');
  await remote.keyboard.press('Backspace');
  await until(async () => await run('document.querySelector("#plain").value') === 'paste world', 'small-viewport native deletion');
  await remote.setViewportSize({ width: 390, height: 844 });
  await fitted();
  await tap(35, 110);
  await remote.waitForFunction(() => fieldsSeen.at(-1)?.field.kind === 'password' && document.activeElement.classList.contains('browser-live-keyboard'));
  assert.equal(await bridge.getAttribute('type'), 'password', 'native keyboard uses private password input semantics');
  assert.equal(await remote.evaluate(() => JSON.stringify(fieldsSeen).includes('fixture-private')), false, 'existing password never sent');
  await remote.keyboard.insertText('Z'); await remote.keyboard.press('Backspace');
  await until(async () => await run('document.querySelector("#password").value') === 'fixture-private', 'private incremental input');
  await tap(35, 180);
  await remote.waitForFunction(() => fieldsSeen.at(-1)?.field.multiline && document.activeElement.classList.contains('browser-live-keyboard'));
  await bridge.evaluate(node => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const start = node.selectionStart, end = node.selectionEnd;
    node.setRangeText('\u65e5\u672c', start, end, 'end');
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '\u65e5\u672c', isComposing: true }));
  });
  assert.equal(await run('document.querySelector("#multi").value.includes("日本")'), false, 'IME not partially committed');
  await bridge.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '\u65e5\u672c' })));
  await until(async () => await run('document.querySelector("#multi").value.includes("日本")'), 'IME commit');
  await remote.keyboard.press('Enter');
  await until(async () => (await run('document.querySelector("#multi").value')).split('\n').length === 3, 'multiline Enter');
  assert.equal(await bridge.inputValue(), await run('document.querySelector("#multi").value'), 'multiline bridge keeps context and caret in step');
  await tap(30, 270);
  await remote.waitForFunction(() => fieldsSeen.at(-1)?.field.multiline && !fieldsSeen.at(-1).field.mirror);
  await remote.keyboard.insertText('R');
  await until(async () => await run('document.querySelector("#rich").textContent.includes("R")'), 'contenteditable');
  await tap(330, 340);
  await remote.waitForFunction(() => !fieldsSeen.at(-1)?.field.editable);
  assert.equal(await remote.evaluate(() => document.activeElement.classList.contains('browser-live-keyboard')), false, 'blank tap does not open keyboard');
  // Real resize/rotation and native coordinate mapping hit the bottom-right edge.
  await remote.setViewportSize({ width: 844, height: 390 });
  bounds = await fitted();
  await tap(bounds.width - 12, bounds.height - 12);
  await until(async () => await run('window.edgeClicked') === true, 'fitted bottom-right coordinate');
  await tap(330, 340);
  await remote.mouse.move(bounds.x + 100, bounds.y + 300); await remote.mouse.wheel(0, 200);
  await until(async () => await run('scrollY') > 0, 'scaled scroll');
  assert.equal(await remote.evaluate(() => document.activeElement.classList.contains('browser-live-keyboard')), false, 'scroll does not open keyboard');
  await ask({ do: 'run', tab: first, code: 'scrollTo(0,0)' });
  // Agent front changes must not steal this scoped tab or its viewport.
  const beforeFront = await remote.evaluate(() => framesSeen.length);
  const secondViewport = await run('[innerWidth,innerHeight]', second);
  await ask({ do: 'front', tab: second });
  await run('document.body.style.backgroundColor = "rgb(21, 31, 41)"');
  await until(async () => await remote.evaluate(() => framesSeen.length) > beforeFront, 'fresh pinned frame after agent front');
  assert.equal((await remote.evaluate(() => framesSeen.at(-1))).tab, first);
  assert.deepEqual(await run('[innerWidth,innerHeight]', second), secondViewport, 'remote fit leaves the other native tab alone');
  await fitted();
  // Stale input and a stale field capability are rejected, not retargeted.
  await remote.evaluate(({ first, second }) => {
    const token = fieldsSeen.findLast(f => f.field.token)?.field.token;
    fixtureSocket.send(JSON.stringify({ do: 'edit', tab: second, field: token, text: 'stale' }));
    fixtureSocket.send(JSON.stringify({ do: 'edit', tab: first, field: token, text: 'stale' }));
  }, { first, second });
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await run('document.body.textContent.includes("stale")', second), false);
  assert.equal(await run('document.body.textContent.includes("stale")'), false);
  assert.equal(await run('document.querySelector("#plain").value', second), 'hello world');
  assert.equal(await run('document.querySelector("#plain").value'), 'paste world');
  await remote.evaluate(() => fixtureView.stop());
  await until(async () => JSON.stringify(await run('[innerWidth,innerHeight]')) === JSON.stringify(originalViewport), 'native view restored after remote stop');
  console.log('Verified real headed backend and remote stream: fit, native edit/deletion/selection/Enter, IME, password privacy, contenteditable, scroll, rotation and stale scope.');
});
