import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { installNativeClose } from '../../../../../desktop/electron/close.mjs';

app.whenReady().then(async () => {
const profile = await mkdtemp(join(tmpdir(), 'imperfect-close-'));
app.setPath('userData', profile);
app.on('window-all-closed', () => {});
let server, win;
try {
  console.log('close-fixture: ready');
  server = createServer((req, res) => {
    if (req.url === '/health') return; // simulate a backend that never replies
    res.setHeader('Content-Type', 'text/html');
    res.end(req.url === '/guest'
      ? `<script>onbeforeunload = e => { e.preventDefault(); e.returnValue = ''; }; </script>guest`
      : `<script>onbeforeunload = e => { e.preventDefault(); e.returnValue = ''; }; </script><webview style="display:flex;width:600px;height:400px" src="http://127.0.0.1:${server.address().port}/guest"></webview>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, webPreferences: { webviewTag: true } });
  const guestReady = new Promise(resolve => win.webContents.once('did-attach-webview', (_, guest) => guest.once('did-finish-load', () => resolve(guest))));
  await win.loadURL(url);
  console.log('close-fixture: host loaded');
  const guest = await guestReady;
  console.log('close-fixture: guest loaded');
  assert.equal(await guest.executeJavaScript('typeof onbeforeunload'), 'function');
  assert.equal(await win.webContents.executeJavaScript('typeof onbeforeunload'), 'function');
  // A disconnected backend must not make close depend on a health/save request.
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  installNativeClose(win);
  const closed = once(win, 'closed');
  const guestClosed = once(guest, 'destroyed');
  win.close(); await closed; await guestClosed;
  assert.equal(win.isDestroyed(), true);
  assert.equal(guest.isDestroyed(), true, 'guest veto cannot retain host');
  // A second host closes while its backend request is hung, without stopping
  // that server (standing in for the independently running agents).
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  win = new BrowserWindow({ show: false, webPreferences: { webviewTag: true } });
  const nextGuestReady = new Promise(resolve => win.webContents.once('did-attach-webview', (_, page) => page.once('did-finish-load', resolve)));
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  await nextGuestReady;
  await win.webContents.executeJavaScript("void fetch('/health')");
  installNativeClose(win);
  const nextClosed = once(win, 'closed');
  win.close(); await nextClosed;
  assert.equal(server.listening, true, 'closing host leaves backend running');
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/guest`)).status, 200);
  console.log('native-close-ok');
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  if (win && !win.isDestroyed()) win.destroy();
  server?.closeAllConnections(); server?.close();
  await rm(profile, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
}
}).catch(error => { console.error(error); app.exit(1); });
