// Renter window. This does NOT start or modify the local imperfect kiosk/server.
import { app, BrowserWindow, WebContentsView, Menu, ipcMain, shell, session, safeStorage, desktopCapturer, systemPreferences } from 'electron';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { beginSignIn, validateGrant, refreshGrant, restoreAccount, createAccountScope } from './auth.mjs';
import { canRemember, loadGrant, saveGrant, forgetGrant } from './session.mjs';
import { HandsClient } from './hands.mjs';

const smoke = process.argv.includes('--smoke-test');
if (smoke && !process.argv.some(arg => arg.startsWith('--user-data-dir='))) throw new Error('Smoke mode requires an isolated --user-data-dir= profile');
app.setName('imperfect-desktop');
// Separate from the PC/laptop kiosk profile, including in unpackaged development.
if (!smoke) app.setPath('userData', join(app.getPath('appData'), 'imperfect-desktop'));
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
if (!smoke && !app.requestSingleInstanceLock()) app.quit();
let win, view, hands, grant, login, generation = 0, quitting = false, signingIn = false, signingOut = false, refreshing = false, handsReady = false;
let status = 'Not connected', events = [], grantFile, savePending = Promise.resolve();
let account = createAccountScope();
const empty = () => ({ commands: false, screen: false, files: false });
const renterSession = () => session.fromPartition(canRemember(safeStorage) ? 'persist:renter' : 'renter');
function publish() {
  if (win && !win.isDestroyed()) win.webContents.send('device:state', {
    username: grant?.username ?? null, status, signingIn: signingIn || signingOut, connected: handsReady,
    permissions: hands?.permissions ?? empty(), events,
  });
}
function log(event) { events.push(event); if (events.length > 200) events.shift(); publish(); }
function notice(action, detail, state = 'done') { log({ id: randomUUID(), action, detail, status: state, time: Date.now() }); }
function native(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== new URL('./index.html', import.meta.url).href) throw new Error('Native app controls only');
}
function disposeHands() { handsReady = false; hands?.close(); hands = null; }
function disposeView() {
  if (view) { win?.contentView.removeChildView(view); view.webContents.close(); view = null; }
}
async function captureScreen() {
  if (process.platform === 'darwin' && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) throw new Error('Allow screen recording in macOS System Settings, then reopen the app');
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 }, fetchWindowIcons: false });
  if (!sources.length || sources[0].thumbnail.isEmpty()) throw new Error('Screen capture unavailable; check OS screen permission');
  // v1 captures the first display only; never a hidden remote browser frame.
  return { mime: 'image/png', data: sources[0].thumbnail.toPNG().toString('base64') };
}
function bounds() { if (view && win) { const [width, height] = win.getContentSize(); view.setBounds({ x: 320, y: 0, width: Math.max(0, width - 320), height }); } }
function makeRemoteView(remoteSession, origin) {
  remoteSession.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
  remoteSession.setPermissionCheckHandler(() => false);
  const result = new WebContentsView({ webPreferences: { session: remoteSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false } });
  const remote = result.webContents;
  remote.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const name of ['will-navigate', 'will-redirect']) remote.on(name, (event, url) => { try { if (new URL(url).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); } });
  remote.on('will-attach-webview', event => event.preventDefault());
  return result;
}
async function attach(next, epoch) {
  if (epoch !== generation || quitting) return;
  grant = validateGrant(next);
  account.track(grant);
  let remembered = false;
  const toSave = grant;
  savePending = savePending.catch(() => {}).then(async () => {
    if (epoch === generation && !quitting) remembered = await saveGrant(grantFile, toSave, safeStorage);
  });
  await savePending; // Unexpected storage failures must not preserve an older account silently.
  if (epoch !== generation || quitting) return;
  disposeHands(); disposeView();
  const remoteSession = renterSession();
  const cookie = { url: grant.computerOrigin, name: grant.doorCookie.name, value: grant.doorCookie.value,
    path: '/', secure: true, httpOnly: true, sameSite: 'lax', expirationDate: grant.doorCookie.expiresAt / 1000 };
  // Use the same account-storage queue as logout; an in-flight cookie write
  // must finish BEFORE logout clears the profile, never recreate it afterward.
  savePending = savePending.catch(() => {}).then(async () => {
    if (epoch === generation && !quitting) await remoteSession.cookies.set(cookie);
  });
  await savePending;
  if (epoch !== generation || quitting) return;
  const origin = grant.computerOrigin;
  view = makeRemoteView(remoteSession, origin);
  const remote = view.webContents;
  remote.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => { if (isMainFrame && code !== -3) { status = 'Computer page unavailable — reconnect or sign in again'; publish(); } });
  win.contentView.addChildView(view); bounds();
  scheduleExpiry(epoch);
  await remote.loadURL(origin).catch(() => {});
  if (epoch !== generation || quitting) return;
  const url = new URL('/device-hands', origin); url.protocol = 'wss:';
  hands = new HandsClient({ url: url.href, token: grant.accessToken, deviceId: grant.deviceId,
    name: hostname().slice(0, 80), captureScreen, onEvent: log,
    onStatus: value => { if (epoch !== generation) return; if (/^(Disconnected|Connecting)/.test(value)) handsReady = false; status = `${value}${remembered ? '' : ' · Session not saved: OS key store unavailable'}`; publish(); } });
  publish();
  hands.connect().then(() => { if (epoch === generation && hands) { handsReady = true; publish(); } }).catch(() => { if (epoch === generation) { handsReady = false; status = 'Device connection unavailable; all hands are off'; publish(); } });
}
let expiryTimer;
function scheduleExpiry(epoch) {
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(async () => {
    if (epoch !== generation || !grant) return;
    const nextEpoch = ++generation;
    refreshing = true;
    disposeHands(); status = 'Refreshing account; all hands off'; publish();
    const cached = grant;
    try { await attach(await account.run(options => refreshGrant(cached, options)), nextEpoch); }
    catch { if (nextEpoch === generation) { disposeView(); status = 'Session expired — sign out and sign in again'; publish(); } }
    finally { if (nextEpoch === generation) refreshing = false; }
  }, Math.min(2_147_483_647, Math.max(0, Math.min(grant.expiresAt, grant.doorCookie.expiresAt) - Date.now())));
}
async function signIn() {
  if (signingIn || signingOut || grant) return;
  signingIn = true; status = 'Finish signing in in your browser'; publish();
  const epoch = ++generation;
  const previousAccount = account;
  account = createAccountScope();
  try {
    await previousAccount.close(async () => {});
    savePending = savePending.catch(() => {}).then(async () => {
      await forgetGrant(grantFile);
      await session.fromPartition('persist:renter').clearStorageData();
      await session.fromPartition('renter').clearStorageData();
    });
    await savePending;
    if (epoch !== generation || quitting) return;
    const next = await account.run(options => {
      login = beginSignIn({ ...options, deviceName: hostname().slice(0, 80), openExternal: url => shell.openExternal(url) });
      return login.result;
    });
    await attach(next, epoch);
  }
  catch { if (epoch === generation) { disposeHands(); disposeView(); grant = null; status = 'Sign-in failed. Check your OS key store; the desktop account bridge must also be enabled by imperfect.'; publish(); } }
  finally { if (epoch === generation) { signingIn = false; login = null; publish(); } }
}
async function reconnect() {
  if (!grant || signingIn || signingOut || refreshing) return;
  const cached = grant, epoch = ++generation;
  refreshing = true;
  disposeHands(); notice('connection', 'Reconnecting; all hands off');
  try { await attach(cached.expiresAt > Date.now() && cached.doorCookie.expiresAt > Date.now()
    ? cached : await account.run(options => refreshGrant(cached, options)), epoch); }
  catch { if (epoch === generation) { disposeHands(); disposeView(); status = 'Reconnect failed — sign out and sign in again'; publish(); } }
  finally { if (epoch === generation) refreshing = false; }
}
async function signOut() {
  if (signingOut) return;
  signingOut = true;
  const epoch = ++generation; login?.cancel(); login = null; signingIn = false; refreshing = false; clearTimeout(expiryTimer);
  const oldAccount = account;
  disposeHands(); disposeView(); grant = null; status = 'Signing out; all hands off'; publish();
  try {
    const revoked = await oldAccount.close(async () => {
      savePending = savePending.catch(() => {}).then(async () => {
        // Attempt every cleanup even when a file removal or one profile fails.
        const results = await Promise.allSettled([
          forgetGrant(grantFile),
          session.fromPartition('persist:renter').clearStorageData(),
          session.fromPartition('renter').clearStorageData(),
        ]);
        if (results.some(result => result.status === 'rejected')) throw new Error('Session removal failed');
      });
      await savePending;
    });
    if (epoch === generation) {
      status = revoked ? 'Signed out' : 'Signed out locally; device revocation unavailable — revoke it on your account page when online';
      notice('account', revoked ? 'Signed out; all hands off' : 'All hands off locally; server revocation not confirmed', revoked ? 'done' : 'refused');
    }
  } catch { if (epoch === generation) status = 'Hands disconnected; session removal failed — check your OS key store'; }
  finally { signingOut = false; publish(); }
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; ++generation; clearTimeout(expiryTimer); login?.cancel(); account.cancel(); disposeHands(); });
app.whenReady().then(async () => {
  grantFile = join(app.getPath('userData'), 'account.enc');
  const startupEpoch = ++generation, startupAccount = account;
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null);
  win = new BrowserWindow({ width: 1400, height: 900, minWidth: 740, minHeight: 600, show: !smoke,
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.on('resize', bounds);
  win.on('close', () => { quitting = true; ++generation; clearTimeout(expiryTimer); login?.cancel(); account.cancel(); disposeHands(); });
  win.webContents.on('render-process-gone', () => {
    quitting = true; ++generation; clearTimeout(expiryTimer); login?.cancel(); account.cancel(); disposeHands(); disposeView();
    app.quit(); // No control surface means no local connection, even after pending login/refresh.
  });
  for (const [name, handler] of Object.entries({
    'sign-in': signIn, 'sign-out': signOut, reconnect, 'ready': publish,
    'permission': (name, on) => {
      if (!hands || !['commands', 'screen', 'files'].includes(name) || typeof on !== 'boolean') return;
      try {
        hands.setPermission(name, on);
        const warning = status.indexOf(' · Session');
        status = 'Connected' + (warning < 0 ? '' : status.slice(warning));
        notice('permission', `${name} ${on ? 'on' : 'off'}`);
      }
      catch { notice('permission', 'Device not connected; permission unchanged', 'refused'); }
      publish();
    },
    stop: () => { hands?.stop(); notice('stop', 'All permissions off; pending work cancelled'); publish(); },
  })) ipcMain.handle(`device:${name}`, (event, ...args) => { native(event); return handler(...args); });
  await win.loadFile(join(import.meta.dirname, 'index.html'));
  publish();
  if (smoke) {
    try {
      const result = await win.webContents.executeJavaScript(`({title: document.title, controls: [...document.querySelectorAll('[data-permission]')].map(x=>({name:x.dataset.permission,on:x.checked,disabled:x.disabled})), bridge:typeof deviceApp, node:typeof require, stop:document.querySelector('#stop').textContent})`);
      if (result.title !== 'imperfect' || result.bridge !== 'object' || result.node !== 'undefined' || result.controls.length !== 3 || result.controls.some(x => x.on || !x.disabled)) throw new Error('Native smoke assertion failed');
      // Exercise the exact remote view policy without any real account or device.
      const { createServer } = await import('node:http');
      const fixture = createServer((_req, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>Remote fixture</title><p>Untrusted remote page</p>'); });
      await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
      const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
      const testView = makeRemoteView(session.fromPartition('smoke-remote'), fixtureOrigin);
      try {
        await testView.webContents.loadURL(fixtureOrigin);
        result.remote = await testView.webContents.executeJavaScript(`({bridge:typeof deviceApp,node:typeof require,popupDenied:window.open('https://example.invalid')===null})`);
        try { native({ sender: testView.webContents, senderFrame: testView.webContents.mainFrame }); result.remote.ipcDenied = false; }
        catch { result.remote.ipcDenied = true; }
        native({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
        await win.webContents.executeJavaScript('deviceApp.stop()');
        result.nativeStop = events.some(event => event.action === 'stop');
        if (result.remote.bridge !== 'undefined' || result.remote.node !== 'undefined' || !result.remote.popupDenied || !result.remote.ipcDenied || !result.nativeStop) throw new Error('Remote isolation smoke failed');
      } finally { testView.webContents.close(); fixture.close(); fixture.closeAllConnections(); }
      win.setContentSize(1000, 600);
      result.visibility = await win.webContents.executeJavaScript(`new Promise(resolve => setTimeout(() => {
        document.querySelector('.controls').scrollTop = 100000;
        document.querySelector('#activity').scrollTop = 100000;
        const stop = document.querySelector('#stop').getBoundingClientRect(), log = document.querySelector('#activity').getBoundingClientRect();
        resolve({height:innerHeight,stop:stop.top>=0&&stop.bottom<=innerHeight,log:log.height>=30&&log.bottom<=innerHeight});
      },100))`);
      if (result.visibility.height > 650 || !result.visibility.stop || !result.visibility.log) throw new Error('Native Stop/activity must stay visible at minimum height');
      const index = process.argv.indexOf('--smoke-output');
      if (index > 0) await writeFile(process.argv[index + 1], JSON.stringify({ ok: true, ...result }, null, 2));
      app.exit(0);
    } catch { app.exit(1); }
    return;
  }
  await restoreAccount({
    load: async () => {
      const cached = await loadGrant(grantFile, safeStorage);
      if (cached && startupEpoch === generation && !quitting) account.track(cached);
      return cached;
    },
    refresh: cached => account.run(options => refreshGrant(cached, options)),
    discard: cached => startupAccount.track(cached),
    attach: next => attach(next, startupEpoch), current: () => startupEpoch === generation && !quitting,
    failed: () => { disposeHands(); disposeView(); grant = null; status = 'Remembered session expired — sign in again'; publish(); },
  });
  if (startupEpoch === generation && !grant && !canRemember(safeStorage)) { status = 'OS key store unavailable; sign-in will last only while this app is open'; publish(); }
}).catch(() => { console.error('imperfect desktop could not start'); app.exit(1); });
