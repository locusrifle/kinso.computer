// Fixture transport only. Account/password/door/native/MCP authorization is production code.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { request as tlsRequest } from 'node:https';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stageClient, clientFiles } from '../../../../../desktop/client/build/stage.mjs';
import { STORE, COMPUTER, listen, close, httpsProxy } from '../../../../../locker/test/accounts-browser-fixture.mjs';

export { STORE, COMPUTER, listen, close };
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, label, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(50); }
  assert.fail(`Timed out: ${label}`);
}
export async function executable(env, candidates) {
  if (env) { await access(env); return env; }
  for (const path of candidates) { try { await access(path); return path; } catch {} }
  throw new Error(`Required desktop fixture dependency missing: ${candidates.join(', ')}`);
}
export async function childProcess(command, args, env, label) {
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', done = false;
  child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  child.once('exit', () => { done = true; }); child.once('error', error => { logs += error.message; done = true; });
  return { child, done: () => done, logs: () => logs, assertAlive() { assert.ok(!done, `${label} exited: ${logs}`); },
    async stop() {
      // dbus-run-session may exit before its compositor/background descendants.
      const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
      kill('SIGTERM');
      if (!done) await until(() => done, `${label} exit`, 5000).catch(() => kill('SIGKILL'));
      kill('SIGKILL');
      await until(() => done, `${label} reaped after termination`, 5000);
      child.stdout.destroy(); child.stderr.destroy();
    } };
}
export async function computerProxy(root, python, storePort, backendPort) {
  const proxy = await httpsProxy(root, python, storePort);
  let doorPort;
  const evidence = { pageChecks: 0, handsChecks: 0, paths: [] };
  const peers = new Set();
  const track = socket => { peers.add(socket); socket.once('close', () => peers.delete(socket)); };
  proxy.server.on('connection', track);
  const forward = (req, res, port) => {
    const upstream = request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); }); req.pipe(upstream);
  };
  const check = (req, path, callback) => {
    const probe = request({ host: '127.0.0.1', port: doorPort, path, headers: { ...req.headers,
      'x-forwarded-method': req.method, 'x-forwarded-uri': req.url, 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' } }, response => {
      response.resume(); callback(response.statusCode, response.headers);
    }); probe.on('error', () => callback(503, {})); probe.end();
  };
  proxy.server.removeAllListeners('request');
  proxy.server.on('request', (req, res) => {
    if (req.headers.host === new URL(STORE).host) return forward(req, res, storePort);
    if (req.headers.host !== new URL(COMPUTER).host || !doorPort) { res.writeHead(403); res.end(); return; }
    if (req.url.startsWith('/door/')) { evidence.paths.push(req.url); return forward(req, res, doorPort); }
    check(req, '/door/check', (status, headers) => {
      if (status !== 200) { res.writeHead(status, headers); res.end(); return; }
      evidence.pageChecks++; forward(req, res, backendPort);
    });
  });
  // Same exact-path, query-free credential gate as Caddy. The VM test owns Caddy itself.
  const upgrade = (req, socket, head) => {
    if (req.url !== '/device-hands' || req.headers.origin || req.headers.host !== new URL(COMPUTER).host) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    check(req, '/door/hands', status => {
      evidence.handsChecks++;
      if (status !== 200) { socket.end(`HTTP/1.1 ${status} Unauthorized\r\n\r\n`); return; }
      const upstream = request({ host: '127.0.0.1', port: backendPort, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${backendPort}` } });
      upstream.on('upgrade', (response, peer, first) => {
        track(peer); track(socket);
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([k,v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
        if (first.length) socket.write(first); if (head.length) peer.write(head);
        socket.pipe(peer); peer.pipe(socket); socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy());
        socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
      });
      upstream.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Unauthorized\r\n\r\n`); response.resume(); });
      upstream.on('error', () => socket.destroy()); upstream.end();
    });
  };
  // Hands transport stays loopback HTTP to avoid modifying production ws client TLS.
  const relay = createServer((_req, res) => { res.writeHead(404); res.end(); });
  relay.on('upgrade', (req, socket, head) => { req.headers.host = new URL(COMPUTER).host; upgrade(req, socket, head); });
  relay.on('connection', track);
  const relayPort = await listen(relay);
  return { ...proxy, evidence, relayPort, setBackendPort(port) { backendPort = port; }, setDoorPort(port) { doorPort = port; }, async stop() { for (const peer of peers) peer.destroy(); await close(relay); await close(proxy.server); } };
}
export async function realDoor({ root, source, python, registry, adapter }) {
  const reservation = createServer(); const port = await listen(reservation); await close(reservation);
  const state = join(root, 'door'); await mkdir(state);
  const publicKey = join(root, 'public.pem'); await writeFile(publicKey, registry.publicKey);
  const helper = fileURLToPath(new URL('./desktop-signin-door.py', import.meta.url));
  const process = await childProcess(python, [helper, source, adapter], { PATH: globalThis.process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1',
    DOOR_PORT: String(port), DOOR_BIND: '127.0.0.1', DOOR_USER: 'fixture-not-an-os-account', STATE_DIRECTORY: state,
    DOOR_PAGE: join(dirname(source), 'login.html'), DOOR_FONT: join(dirname(source), 'SpaceMono-Regular.woff2'),
    DOOR_SSO_STORE: registry.store, DOOR_SSO_COMPUTER: registry.computerId, DOOR_SSO_OWNER: registry.owner, DOOR_SSO_PUBLIC_KEY: publicKey, DOOR_ORIGIN: COMPUTER,
  }, 'Python door');
  try { await until(async () => { process.assertAlive(); return fetch(`http://127.0.0.1:${port}/door/check`).then(() => true, () => false); }, 'real Python door ready'); }
  catch (error) { await process.stop(); throw error; }
  return { ...process, port };
}
const replace = (source, old, value) => { assert.equal(source.split(old).length, 2, `staging injection unique: ${old}`); return source.replace(old, value); };
export async function stageElectron({ root, repo, proxy, browserOrigin }) {
  const stage = await stageClient(repo, join(root, 'standalone'));
  const hashes = {};
  for (const name of clientFiles) hashes[name] = createHash('sha256').update(await readFile(join(stage, name))).digest('hex');
  let main = await readFile(join(stage, 'main.mjs'), 'utf8');
  main = replace(main, "if (!smoke) app.setPath('userData', join(app.getPath('appData'), 'imperfect-desktop'));", '// Fixture: retain explicit disposable --user-data-dir.');
  main = replace(main, 'url => shell.openExternal(url)', `url => fetch(${JSON.stringify(browserOrigin)} + '/open', {method:'POST',body:url}).then(r => { if (!r.ok) throw new Error('Fixture browser failed'); })`);
  main = replace(main, 'url: url.href, token: grant.accessToken', `url: 'ws://127.0.0.1:${proxy.relayPort}/device-hands', token: grant.accessToken`);
  // Transport mapping preserves public origins, Host, certificate verification and redirects.
  const transport = `
import { request as fixtureTLS } from 'node:https';
import { readFileSync as fixtureRead } from 'node:fs';
const fixtureOrigins = new Set(${JSON.stringify([STORE, COMPUTER])});
const fixtureCA = fixtureRead(${JSON.stringify(join(root, 'tls-cert.pem'))});
globalThis.fetch = (input, init={}) => new Promise((resolve,reject) => {
  const target = new URL(input);
  if (!fixtureOrigins.has(target.origin) && target.origin !== ${JSON.stringify(browserOrigin)}) return reject(new Error('Fixture network denied'));
  if (target.origin === ${JSON.stringify(browserOrigin)}) return fixtureOriginalFetch(input,init).then(resolve,reject);
  const req = fixtureTLS({host:'127.0.0.1',port:${proxy.port},servername:target.hostname,ca:fixtureCA,path:target.pathname+target.search,
    method:init.method||'GET',headers:{...init.headers,host:target.host},signal:init.signal}, res => {
    if (res.statusCode >=300 && res.statusCode<400) {res.resume();reject(new Error('Fixture redirect denied'));return;}
    const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>32768)req.destroy(new Error('Fixture response too large'));else chunks.push(b)});
    res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
  });req.on('error',reject);req.end(init.body);
});
function fixtureNetwork(partition) {
  partition.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    callback({cancel: !['file:','devtools:','data:'].includes(url.protocol) && !fixtureOrigins.has(url.origin)});
  });
}
app.whenReady().then(()=> {fixtureNetwork(session.defaultSession);fixtureNetwork(session.fromPartition('renter'));fixtureNetwork(session.fromPartition('persist:renter'));});
`;
  main = `const fixtureOriginalFetch = globalThis.fetch;\n${transport}\n${main}`;
  // Local test control reports no account tokens/cookies. Commands only click real trusted UI.
  main += `
const fixtureControl = (await import('node:http')).createServer(async (req,res) => {
 try {
  if (Object.hasOwn(req.headers,'origin')) {res.writeHead(403);res.end();return;}
  let result;
  if (req.url === '/state') {
   if (!win || win.isDestroyed()) result={ready:false};
   else result={ready:true,ui:await win.webContents.executeJavaScript(\`document.querySelector('#status') && ({status:document.querySelector('#status').textContent,account:document.querySelector('#account').textContent,node:typeof require,bridge:typeof deviceApp,controls:[...document.querySelectorAll('[data-permission]')].map(x=>({name:x.dataset.permission,on:x.checked,disabled:x.disabled})),events:document.querySelector('#activity').textContent})\`),remote:view&&!view.webContents.isDestroyed()?{url:view.webContents.getURL(),security:Object.fromEntries(['sandbox','contextIsolation','nodeIntegration'].map(k=>[k,view.webContents.getLastWebPreferences()[k]])),page:await view.webContents.executeJavaScript(\`({title:document.title,node:typeof require,bridge:typeof deviceApp,body:document.body?.textContent.slice(0,100)})\`)}:null};
  } else if(req.method==='POST' && req.url==='/sign-in') result=await win.webContents.executeJavaScript("document.querySelector('#sign-in').click();true");
  else if(req.method==='POST' && req.url==='/commands-on') result=await win.webContents.executeJavaScript("(()=>{const input=document.querySelector('[data-permission=commands]');if(input.disabled)throw Error('Native opt-in disabled');input.click();return true})()");
  else if(req.method==='POST' && req.url==='/quit') {res.end('true');setImmediate(()=>app.quit());return;}
  else if(req.method==='POST' && req.url==='/remote-opt-in') result=await view.webContents.executeJavaScript("typeof deviceApp==='undefined' && typeof require==='undefined'");
  else {res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 }catch(e){res.writeHead(500);res.end(e.message);}
});
fixtureControl.listen(0,'127.0.0.1',()=>writeFile(${JSON.stringify(join(root, 'control.json'))},JSON.stringify({port:fixtureControl.address().port})));
app.on('before-quit',()=>fixtureControl.close());
`;
  await writeFile(join(stage, 'main.mjs'), main);
  return { stage, hashes, transformedMainHash: createHash('sha256').update(main).digest('hex') };
}
export async function headlessDesktop(root, electron, stage, proxy) {
  const runtime = join(root, 'xdg'); await mkdir(runtime, { mode: 0o700 });
  const config = join(root, 'sway.conf'); await writeFile(config, 'output HEADLESS-1 resolution 1400x900\n');
  const home = join(root, 'home'); await mkdir(home);
  const busFile = join(root, 'bus-address');
  const wayland = await childProcess('dbus-run-session', ['--', 'sh', '-c', 'printf "%s" "$DBUS_SESSION_BUS_ADDRESS" > "$1"; exec sway --unsupported-gpu -c "$2"', 'fixture-sway', busFile, config], {
    PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: runtime, WLR_BACKENDS: 'headless', WLR_LIBINPUT_NO_DEVICES: '1', WLR_RENDERER: 'pixman',
    LIBGL_ALWAYS_SOFTWARE: '1', LANG: 'C.UTF-8',
  }, 'fixture sway');
  const { readdir } = await import('node:fs/promises');
  try {
    let socket;
    await until(async () => { wayland.assertAlive(); socket = (await readdir(runtime)).find(n => /^wayland-\d+$/.test(n)); return socket; }, 'own headless Wayland');
    const cert = new X509Certificate(await readFile(join(root, 'tls-cert.pem')));
    const pin = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    const desktop = await childProcess(electron, [stage, `--user-data-dir=${join(root, 'profile')}`, '--ozone-platform=wayland', '--disable-gpu', '--no-proxy-server',
      '--disable-background-networking', `--ignore-certificate-errors-spki-list=${pin}`, `--host-resolver-rules=MAP *.imperfect.computer 127.0.0.1:${proxy.port}, MAP imperfect.computer 127.0.0.1:${proxy.port}, EXCLUDE 127.0.0.1, MAP * ~NOTFOUND`], {
      PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: socket, LANG: 'C.UTF-8', DBUS_SESSION_BUS_ADDRESS: await readFile(busFile, 'utf8'),
      // Linux needs its own trusted sandbox; never pass --no-sandbox to desktop Electron.
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'false',
    }, 'real desktop Electron');
    return { ...desktop, async stop() {
      try {
        const { port } = JSON.parse(await readFile(join(root, 'control.json'), 'utf8'));
        await fetch(`http://127.0.0.1:${port}/quit`, { method: 'POST', signal: AbortSignal.timeout(1500) });
        await until(desktop.done, 'native app orderly quit', 3000);
      } catch {} // Startup failures still terminate the entire owned group.
      try { await desktop.stop(); } finally { await wayland.stop(); }
    } };
  } catch (error) { await wayland.stop(); throw error; }
}
