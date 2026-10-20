// Real native input and clipboard, full production composer/transcript and
// sandboxed guest/popup/frame/View. Only backend data is fixed test material.
import assert from 'node:assert/strict';
import { app, BrowserWindow, WebContentsView, clipboard, Menu } from 'electron';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { installEditing } from '../../../../../desktop/electron/edit.mjs';
import { installWebsitePopups } from '../../../../../desktop/electron/popups.mjs';
import { themeCss } from '../../../../../system/theme.mjs';

installEditing(app, { mod: 'meta', platform: 'linux' });
const created = new Set();
app.on('web-contents-created', (_, contents) => created.add(contents.id));
app.on('window-all-closed', () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label) => {
  for (const end = Date.now() + 15000; Date.now() < end;) { if (await check()) return; await wait(20); }
  throw new Error(`Timed out: ${label}`);
};
const js = (page, code) => page.executeJavaScript(code, true);
const chord = async (page, key, more = {}) => {
  if (!more.preserveFocus) {
    BrowserWindow.fromWebContents(page)?.focus();
    page.focus();
  }
  const modifiers = ['meta', ...(more.shift ? ['shift'] : [])];
  page.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
  page.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
  await wait(100);
};
let server, wss, win, popup;
app.whenReady().then(async () => {
  try {
    Menu.setApplicationMenu(null);
    console.log('edit-fixture: ready');
    const root = new URL('../../public/', import.meta.url);
    const theme = themeCss(JSON.parse(await readFile(new URL('./themes/black.json', import.meta.url), 'utf8')));
    const html = (await readFile(new URL('index.html', root), 'utf8')).replace(/<script[^>]*src="\/js\/site.js"[^>]*><\/script>/, '');
    server = createServer(async (req, res) => {
      const path = new URL(req.url, 'http://fixture').pathname;
      try {
        res.setHeader('Content-Type', 'text/html');
        if (path === '/') return res.end(html);
        if (path === '/guest') return res.end('<p id="selection">fixed guest selection</p><textarea id="editor"></textarea><input id="password" type="password"><div id="rich" contenteditable="true"></div><script>window.keyCount=0; addEventListener("keydown", () => keyCount++);</script>');
        if (path === '/frame') return res.end('<iframe src="/guest"></iframe>');
        if (path === '/theme.css') { res.setHeader('Content-Type', 'text/css'); return res.end(theme); }
        if (path === '/files/text') { res.setHeader('Content-Type', 'application/json'); return res.end('{"text":"","version":"fixture","size":0}'); }
        if (path === '/files/list') { res.setHeader('Content-Type', 'application/json'); return res.end('{"path":"/fixture","home":"/fixture","entries":[]}'); }
        if (path.endsWith('.json')) { res.setHeader('Content-Type', 'application/json'); return res.end('{"machines":[],"providers":[]}'); }
        res.setHeader('Content-Type', /\.m?js$/.test(path) ? 'text/javascript' : 'text/css');
        res.end(await readFile(new URL(path.slice(1), root)));
      } catch { res.statusCode = 404; res.end(); }
    });
    wss = new WebSocketServer({ server });
    const snapshot = { agent: 'pi', sessionId: 'thread-a', cwd: '/fixture', busy: true,
      model: { provider: 'fixture', id: 'fixture' }, queue: { items: [] }, stats: {}, ui: {},
      tabs: [{ id: 'tab-a', sessionId: 'thread-a', focused: true, agent: 'pi', name: 'A', status: 'busy' }],
      messages: [{ role: 'assistant', content: 'fixed transcript selection' }] };
    const commands = [];
    wss.on('connection', ws => {
      ws.send(JSON.stringify({ type: 'snapshot', data: snapshot }));
      ws.on('message', raw => { const c = JSON.parse(raw); commands.push(c.type); ws.send(JSON.stringify({ type: 'response', id: c.id, success: true, data: c.type === 'snapshot' ? snapshot : {} })); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    win = new BrowserWindow({ show: true, width: 1280, height: 900, webPreferences: { webviewTag: true, backgroundThrottling: false } });
    win.setContentSize(1280, 900);
    console.log('edit-fixture: window created');
    await win.loadURL(url);
    console.log('edit-fixture: host loaded');
    const host = win.webContents;
    await js(host, `(async () => { globalThis.imperfectDesk = { mod: 'meta', altAlias: false, onKey() {}, onBrowse() {}, onTab() {}, front() {} };
      await import('/js/site.js'); })()`);
    await until(() => js(host, `document.querySelector('#entry-output .gui-assistant')?.textContent.includes('fixed transcript selection')`), 'production transcript');
    await js(host, `document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    await until(async () => (await host.capturePage()).getSize().width >= 1200, 'painted host');
    // The actual MOD+K card teaches the native keys, not just registry data.
    await js(host, `dispatchEvent(new KeyboardEvent('keydown', { code:'KeyK', key:'k', metaKey:true, bubbles:true, cancelable:true }))`);
    await until(() => js(host, `document.body.classList.contains('keys-open')`), 'keys card');
    const guide = await js(host, `document.querySelector('.keys-list').textContent`);
    for (const [key, description] of [['C','copy'],['V','paste'],['X','cut'],['A','select all'],['Z','undo'],['Shift+Z','redo']]) assert.ok(guide.includes(`Super+${key}${description}`));
    await wait(200); // native capture must follow the DOM's keys-card paint
    if (process.env.IMPERFECT_EDIT_SCREENSHOT) await writeFile(process.env.IMPERFECT_EDIT_SCREENSHOT, (await host.capturePage()).toPNG());
    await js(host, `dispatchEvent(new KeyboardEvent('keydown', {code:'Escape',key:'Escape',bubbles:true,cancelable:true}))`);
    // Fail if the editing chord also arrives at a renderer shortcut.
    await js(host, `window.editKeyCount=0; addEventListener('keydown', e => { if (e.metaKey && ['KeyC','KeyV','KeyX','KeyA','KeyZ'].includes(e.code)) editKeyCount++; });
      document.querySelector('#entry-input').blur();
      const article=document.querySelector('#entry-output .gui-assistant'); article.scrollIntoView(); article.getBoundingClientRect();
      const range=document.createRange(); range.selectNodeContents(article);
      getSelection().removeAllRanges(); getSelection().addRange(range);`);
    assert.equal((await js(host, 'getSelection().toString()')).trim(), 'fixed transcript selection');
    await chord(host, 'C', { preserveFocus: true });
    assert.equal((await clipboard.readText()).trim(), 'fixed transcript selection');
    await js(host, `document.querySelector('#entry-input').focus()`);
    await chord(host, 'V');
    assert.equal(await js(host, `document.querySelector('#entry-input').value`), 'fixed transcript selection');
    assert.equal(commands.includes('abort'), false, 'Super+C is not composer Ctrl+C');
    // Ctrl+C still interrupts the busy composer, exactly as before.
    // CDP delivers the Ctrl chord to the DOM, unlike sendInputEvent's native
    // Linux editing accelerator; the unit test also proves Ctrl is not consumed.
    host.debugger.attach('1.3');
    await host.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
    await host.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 });
    host.debugger.detach();
    await until(() => commands.includes('abort'), 'Ctrl+C interrupt');
    // Mount Workbench's actual editor, backed only by a fixed fake file.
    await js(host, `(async () => { const { openEditor } = await import('/js/workbench-edit.js');
      const line=document.createElement('p'); document.body.append(line);
      window.fileEditor = await openEditor({ doc: document, base: '', file: { name: 'fixture.txt', path: '/fixture.txt' }, line });
      document.body.append(fileEditor.area); fileEditor.focus(); })()`);
    await clipboard.writeText('fixed workbench text');
    await chord(host, 'V');
    assert.equal(await js(host, `document.querySelector('.workbench-editor').value`), 'fixed workbench text');
    await chord(host, 'A'); await chord(host, 'X');
    assert.equal(await clipboard.readText(), 'fixed workbench text');
    assert.equal(await js(host, `document.querySelector('.workbench-editor').value`), '');
    await chord(host, 'Z');
    assert.equal(await js(host, `document.querySelector('.workbench-editor').value`), 'fixed workbench text');
    await chord(host, 'Z', { shift: true });
    assert.equal(await js(host, `document.querySelector('.workbench-editor').value`), '');
    assert.equal(await js(host, 'editKeyCount'), 0);
    // The browser pane is a real Electron webview, not a renderer mock.
    const guestReady = new Promise(resolve => host.once('did-attach-webview', (_, guest) => guest.once('did-finish-load', () => resolve(guest))));
    await js(host, `const view=document.createElement('webview'); view.setAttribute('allowpopups',''); view.src=${JSON.stringify(url + '/guest')}; view.style='position:fixed;inset:0;display:flex;width:1280px;height:900px;z-index:2147483647'; document.body.append(view); view.focus();`);
    const guest = await guestReady;
    assert.ok(created.has(guest.id), 'guest comes through global WebContents creation');
    const pasteInto = async (page, selector, value, property = 'value') => {
      await clipboard.writeText(value);
      await js(page, `document.querySelector(${JSON.stringify(selector)}).focus()`);
      await chord(page, 'V');
      assert.equal(await js(page, `document.querySelector(${JSON.stringify(selector)})[${JSON.stringify(property)}]`), value);
    };
    await js(host, `const sheet=document.createElement('dialog'); sheet.id='fixed-sheet'; sheet.innerHTML='<input id="sheet-password" type="password">'; document.body.append(sheet); sheet.showModal();`);
    await pasteInto(host, '#sheet-password', 'fixed sheet password');
    await js(host, `document.querySelector('#fixed-sheet').close()`);
    await js(host, `document.querySelector('webview').focus()`);
    await pasteInto(guest, '#editor', 'fixed browser paste');
    await pasteInto(guest, '#password', 'fixed password paste');
    await pasteInto(guest, '#rich', 'fixed rich paste', 'textContent');
    assert.equal(await js(guest, 'keyCount'), 0, 'guest cannot also handle consumed Super chords');
    console.log('edit-fixture: host, sheet and guest editing passed');
    // Actual Chromium-created popup gets the same global installation.
    installWebsitePopups(guest, { ours: () => false, windowOptions: { show: true } });
    const popupReady = new Promise(resolve => guest.once('did-create-window', child => { popup = child; child.webContents.once('did-finish-load', () => resolve(child.webContents)); }));
    await js(guest, `void window.open('/guest', 'edit-popup')`);
    await pasteInto(await popupReady, '#editor', 'fixed popup paste');
    // A View is neither the host nor a webview; still covered automatically.
    const view = new WebContentsView(); win.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 400, height: 200 });
    await view.webContents.loadURL(url + '/guest');
    await pasteInto(view.webContents, '#editor', 'fixed view paste');
    win.contentView.removeChildView(view);
    view.webContents.close();
    // Same-process child frame: command follows Chromium's focused frame.
    await host.loadURL(url + '/frame');
    await until(() => js(host, `Boolean(document.querySelector('iframe').contentDocument?.querySelector('#editor'))`), 'child frame');
    await clipboard.writeText('fixed frame paste');
    await js(host, `document.querySelector('iframe').contentDocument.querySelector('#editor').focus()`);
    await chord(host, 'V');
    assert.equal(await js(host, `document.querySelector('iframe').contentDocument.querySelector('#editor').value`), 'fixed frame paste');
    console.log('edit-fixture: popup, View and frame editing passed');
    // The stream's real native keyboard mirror; only the wire peer is fake.
    await host.loadURL(url + '/guest');
    await js(host, `(async () => {
      const { mountLive } = await import('/js/live.js');
      window.liveSaid=[]; window.remoteMirror=true;
      const connect = () => {
        const socket={ readyState:1, close(){}, send(raw){
          const said=JSON.parse(raw); liveSaid.push(said);
          const reply=value => setTimeout(() => socket.onmessage({data:JSON.stringify(value)}));
          if(said.do==='watch') {
            reply({tabs:[{tab:1,front:true,title:'fixture',url:'https://fixture.invalid/'}]});
            reply({frame:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',tab:1,width:600,height:300});
          }
          if(said.do==='tap') reply({gesture:said.gesture,field:{editable:true,token:'fixed-field',kind:'text',mirror:remoteMirror,multiline:true,...(remoteMirror?{value:'fixed remote field',start:0,end:18}:{})}});
        }};
        setTimeout(() => socket.onopen()); return socket;
      };
      window.stream=mountLive({connect}); stream.body.style='width:600px;height:400px'; document.body.replaceChildren(stream.bar,stream.body);
      document.querySelector('.browser-live-frame').style='width:600px;height:300px';
      window.tapStream=() => {
        const node=document.querySelector('.browser-live-frame'), r=node.getBoundingClientRect();
        for(const type of ['pointerdown','pointerup']) node.dispatchEvent(new PointerEvent(type,{bubbles:true,isPrimary:true,clientX:r.left+20,clientY:r.top+20}));
      };
    })()`);
    await until(() => js(host, `Boolean(document.querySelector('.browser-live-frame').src)`), 'stream frame');
    await js(host, 'tapStream()');
    await until(() => js(host, `document.activeElement.classList.contains('browser-live-keyboard')`), 'stream mirror');
    await chord(host, 'C');
    assert.equal(await clipboard.readText(), 'fixed remote field');
    await clipboard.writeText('fixed stream paste');
    await chord(host, 'V');
    await until(() => js(host, `liveSaid.some(said => said.do==='edit' && said.field==='fixed-field' && said.text==='fixed stream paste')`), 'stream field edit');
    // Non-mirrored fields have no truthful copy-out selection. Do not copy
    // their sentinel; paste still travels as an incremental remote edit.
    await js(host, 'remoteMirror=false; tapStream()');
    await until(() => js(host, `document.activeElement.value==='\u200b'`), 'private stream sentinel');
    await clipboard.writeText('fixed clipboard kept');
    await chord(host, 'A'); await chord(host, 'C');
    assert.equal(await clipboard.readText(), 'fixed clipboard kept');
    await clipboard.writeText('fixed private stream paste');
    await chord(host, 'V');
    await until(() => js(host, `liveSaid.some(said => said.do==='edit' && said.text==='fixed private stream paste')`), 'private stream edit');
    await js(host, 'stream.stop()');
    console.log('super-edit-native-ok: transcript composer Ctrl+C editor guest password rich popup View frame stream mirror/private; no duplicate DOM keys');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    popup?.destroy(); win?.destroy();
    for (const ws of wss?.clients ?? []) ws.terminate();
    wss?.close(); server?.closeAllConnections(); server?.close();
    app.exit(process.exitCode || 0);
  }
}).catch(error => { console.error(error); app.exit(1); });
