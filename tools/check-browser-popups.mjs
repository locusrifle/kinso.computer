// Loopback-only OAuth-shaped regression in the actual headed and streamed
// Electron browsers, one process at a time, with throwaway profiles. No login.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGueyServer } from '../system/server.mjs';
import { createTabHost } from '../apps/code/native/tabs.mjs';
import { askWindow } from '../apps/code/native/browser.mjs';

const root = await mkdtemp(join(tmpdir(), 'imperfect-popup-'));
let child, machine, site, provider, stderr = '';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const until = async (check, name) => {
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    if (child?.exitCode != null) throw new Error(`Electron exited: ${stderr.slice(-3000)}`);
    const result = await check(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${name}\n${stderr.slice(-3000)}`);
};
const stop = async () => {
  if (child && child.exitCode === null) {
    const gone = new Promise(resolve => child.once('exit', resolve)); child.kill(); await gone;
  }
  child = null;
};
try {
  let at;
  site = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/opener') {
      res.setHeader('set-cookie', 'popup_fixture=shared; Path=/; SameSite=Lax');
      res.end(`<title>Opener</title><script>window.result=null;window.addEventListener('message',e=>{if(e.origin===location.origin)window.result={data:e.data,source:e.source===window.popup};});</script>`);
    } else if (req.url === '/callback') {
      res.end(`<title>Callback</title><script>window.complete=()=>{opener.postMessage({cookie:document.cookie.includes('popup_fixture=shared'),saved:localStorage.getItem('pending')},location.origin);window.close();};</script>`);
    } else { res.end('<title>Child</title>'); }
  });
  at = await listen(site);
  let postBody = '';
  provider = createServer(async (req, res) => {
    if (req.method === 'POST') { for await (const chunk of req) postBody += chunk; }
    res.writeHead(302, { location: `${at}/callback` }); res.end();
  });
  const other = await listen(provider);
  const fake = () => {
    const snap = { sessionId: 'popup-fixture', sessionFile: 'popup-fixture', cwd: root, messages: [], busy: false };
    return { events: new EventEmitter(), snapshot: () => snap, command: async () => ({}), close: async () => {} };
  };
  const runtime = await createTabHost({ cwd: root, stateDir: join(root, 'tabs'), createRuntime: fake, listPiSessions: async () => [], listClaudeSessions: async () => [] });
  machine = await createGueyServer({ host: '127.0.0.1', port: 0, stateDir: join(root, 'server'), sessionToken: 'popup-fixture-only', runtime,
    machines: { self: async () => 'check', selfId: async () => 'check', origins: async () => [], list: async () => [], peer: async () => null } });
  const port = (await machine.listen()).port;
  for (const mode of ['main', 'browser']) {
    const home = join(root, mode); await mkdir(join(home, '.imperfect'), { recursive: true });
    stderr = '';
    const env = { ...process.env, HOME: home, IMPERFECT_PORT: String(port) };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[key];
    child = spawn(join(import.meta.dirname, '../node_modules/.bin/electron'), [
      `desktop/electron/${mode}.mjs`, '--hidden', '--ozone-platform=headless', '--disable-gpu', '--no-first-run',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', `--user-data-dir=${join(home, 'profile')}`,
    ], { cwd: process.env.BROWSER_POPUP_ROOT ?? join(import.meta.dirname, '..'), env, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    const socket = await until(async () => (await readdir(join(home, '.imperfect'))).find(name => name.startsWith(`browser-${port}-`) && name.endsWith('.sock')), `${mode} socket`);
    const ask = request => askWindow({ session: 'popup-check', ...request }, { sockets: async () => [join(home, '.imperfect', socket)], open: async () => { throw new Error('fixture socket disappeared'); } });
    const run = async (tab, code) => (await ask({ do: 'run', tab, page: true, code })).value;
    const parent = (await ask({ do: 'open', url: `${at}/opener` })).tab;
    await run(parent, "localStorage.setItem('pending','kept');window.popup=window.open('about:blank','fixture-popup');!!window.popup").then(value => assert.equal(value, true));
    let list = await until(async () => { const tabs = (await ask({ do: 'tabs' })).tabs; return tabs.length === 2 && tabs; }, 'popup registered');
    const popup = list.find(page => page.tab !== parent).tab;
    assert.equal(await run(parent, 'location.pathname'), '/opener', 'pending sign-in page survives');
    assert.equal(await run(popup, '!!window.opener'), true, 'blank popup has its real opener');
    await run(parent, `window.popup.location.href=${JSON.stringify(`${other}/provider`)};true`);
    await until(async () => (await ask({ do: 'tabs' })).tabs.find(page => page.tab === popup)?.url === `${at}/callback`, 'cross-origin return');
    assert.deepEqual(await run(popup, '({node:typeof require,bridge:typeof window.imperfect,opener:!!window.opener})'), { node: 'undefined', bridge: 'undefined', opener: true });
    assert.equal(await run(parent, "window.open('','fixture-popup')===window.popup"), true, 'named window is reused');
    assert.equal((await ask({ do: 'tabs' })).tabs.length, 2);
    await run(popup, 'window.complete();true').catch(error => { if (!/closed|destroyed/.test(error.message)) throw error; });
    await until(async () => (await ask({ do: 'tabs' })).tabs.length === 1, 'script-driven close');
    assert.deepEqual(await run(parent, 'window.result'), { data: { cookie: true, saved: 'kept' }, source: true }, 'callback answers the waiting opener with shared cookies/storage');
    assert.equal((await ask({ do: 'tabs' })).tabs[0].front, true, 'front returns to opener');
    assert.equal(await run(parent, `window.open('http://127.0.0.1:${port}/')===null`), true, 'harness popup blocked');
    // target=_blank form submissions must keep Electron's original POST body.
    postBody = '';
    await run(parent, `(()=>{const f=document.createElement('form');f.method='POST';f.action=${JSON.stringify(`${other}/post`)};f.target='_blank';f.innerHTML='<input name="fixture" value="body-kept">';document.body.append(f);f.submit();return true;})()`);
    await until(() => postBody === 'fixture=body-kept', 'POST body retained');
    list = await until(async () => { const tabs = (await ask({ do: 'tabs' })).tabs; return tabs.length === 2 && tabs.find(t=>t.tab!==parent)?.url === `${at}/callback` && tabs; }, 'POST callback');
    await ask({ do: 'close', tab: list.find(t => t.tab !== parent).tab });
    await until(async () => (await ask({ do: 'tabs' })).tabs.length === 1, 'tool closes popup');
    if (mode === 'main') {
      await run(parent, `window.popup=window.open(${JSON.stringify(`${at}/child`)},'keyboard');true`);
      list = await until(async () => { const tabs = (await ask({ do: 'tabs' })).tabs; return tabs.length === 2 && tabs; }, 'keyboard popup');
      await ask({ do: 'key', tab: list.find(t => t.tab !== parent).tab, key: 'Control+w' }).catch(error => { if (!/closed|destroyed/.test(error.message)) throw error; });
      await until(async () => (await ask({ do: 'tabs' })).tabs.length === 1, 'Ctrl+W closes only popup');
      assert.equal(await run(parent, 'location.pathname'), '/opener');
    }
    assert.equal(await run(parent, `window.open(${JSON.stringify(`${at}/child`)},'_blank','noopener')===null`), true);
    list = await until(async () => { const tabs = (await ask({ do: 'tabs' })).tabs; return tabs.length === 2 && tabs; }, 'noopener popup');
    const isolated = list.find(t => t.tab !== parent).tab;
    await until(async () => (await ask({ do: 'tabs' })).tabs.find(t => t.tab === isolated)?.url === `${at}/child`, 'noopener document');
    assert.equal(await run(isolated, 'window.opener===null'), true, 'explicit noopener is respected');
    await ask({ do: 'close', tab: isolated });
    await until(async () => (await ask({ do: 'tabs' })).tabs.length === 1, 'noopener closed');
    await run(parent, `window.popup=window.open(${JSON.stringify(`${at}/child`)},'lifetime');true`);
    await until(async () => (await ask({ do: 'tabs' })).tabs.length === 2, 'lifetime popup');
    await ask({ do: 'close', tab: parent });
    await until(async () => (await ask({ do: 'tabs' })).tabs.length === 0, 'opener closing also closes popup');
    console.log(`ok: ${mode} real popup, opener, cross-origin redirect, cookies/storage, named reuse, close/front, sandbox, harness guard, POST body, noopener, opener lifetime${mode === 'main' ? ', Ctrl+W' : ''}`);
    await stop();
  }
} finally {
  await stop(); await machine?.close(); site?.close(); provider?.close(); await rm(root, { recursive: true, force: true });
}
