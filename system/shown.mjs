// What an agent shows the person, played in the conversation as a window or
// a tab (public/js/pages.js). The `show` tool (apps/code/native/code-control.mjs)
// names a file, a folder or a local address; a file or folder is served from
// here, with its folder around it so a page's scripts, pictures and sounds
// come too, and a page an agent runs on this computer's loopback is carried.
//
// Each thing shown has one address, made here when it is shown, that every
// screen loads just as it is: this computer's window, the person's other
// computers', the phone. It is on a listener of its own, beside imperfect's,
// with nothing else on it (no window, files, sessions or anything to post
// to), so a page has an origin apart from imperfect's: it keeps its saves,
// and cannot ask imperfect for anything.
//
//   GET  /files/raw?path=<path>   media inside an already shown folder
//   GET  /shown/<absolute path>   pages/assets and old media addresses
//   *    /port/<port>/<path>      a page an agent opened on this computer's loopback
//
// That listener is on loopback at imperfect's port + 1 (5068). install.sh
// publishes it to the person's own devices (`tailscale serve --https=8443`),
// and then the address is https://<this computer>.<tailnet>.ts.net:8443/...,
// which reaches it from anywhere on their tailnet; without that,
// http://127.0.0.1:5068/..., which this computer alone can open. In the
// hosted setup IMPERFECT_PAGE_ORIGIN can name where a port is seen.
// Hosted computers instead stream page/PDF previews from the person's browser:
// native loopback dev URLs, and private *.localhost folder sites for files.
// Only media bytes travel directly through their authenticated Files route.
//
// imperfect's own server answers one request about them, for its window:
//
//   POST /shown/add {path}   the address of a file, or local address, named in
//                            the conversation (made playable, if a file)
//
// Only folders something was shown from are served, kept in
// data/state/shown.json so a conversation read again after a restart still
// plays, and only ports an agent opened (show, or a dev_server still
// running) or a project running (projects.mjs, carries) are carried.

import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { MIME, inside, sendRange } from './files.mjs';
import { devServers } from '../apps/code/native/dev-servers.mjs';
import { viewOf as viewKind } from '../apps/code/native/public/js/pages.js';
import { withPaneShortcut } from '../apps/code/native/public/js/pane-shortcut.js';

const KEY = Symbol.for('imperfect.shown');
// Every page is sandboxed, so it may not take imperfect's window elsewhere,
// with an origin of its own (the page origin's), so it keeps its saves.
const PAGE_POLICY = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-same-origin';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);
const media = path => /^(image|video|audio)\/|^application\/pdf$/.test(MIME[extname(path).toLowerCase()] ?? '');

// machines: system/machines.mjs, for where the tailnet publishes the listener.
export function createShown({ stateDir, machines, pageOrigin = process.env.IMPERFECT_PAGE_ORIGIN ?? '', servers = devServers, carries = () => false, projectAt = () => null,
  hosted = false, webOrigin = '', view = null, reservedPorts = () => [] } = {}) {
  const file = join(stateDir, 'shown.json');
  let roots = null;
  // The ports show opened, those of dev servers still running, and the
  // projects' that run.
  const ports = new Set(), sockets = new Set();
  const portOf = url => { try { return Number(new URL(url).port) || 80; } catch { return 0; } };
  const allowedPort = port => port >= 1024 && port <= 65535 && (!hosted || ![listening(), ...reservedPorts()].includes(port));
  const carried = port => allowedPort(port) && (ports.has(port) || carries(port) || servers().list().some(server => server.running && server.url && portOf(server.url) === port));
  const load = async () => (roots ??= new Set(await readFile(file, 'utf8').then(JSON.parse).catch(() => [])));
  let writing = Promise.resolve();
  const keep = () => (writing = writing.then(async () => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, JSON.stringify([...roots]));
    await rename(`${file}.tmp`, file);
  }).catch(error => console.error(`shown: ${error.message}`)));

  // Where the listener is seen from: the demo's name for it, else its
  // address on the tailnet once one publishes it, else its own.
  let listener = null;
  const listening = () => listener?.address()?.port ?? 0;
  async function origin(port = listening()) {
    if (pageOrigin) return pageOrigin.replaceAll('{port}', String(port));
    return (await machines?.published?.(port).catch(() => '')) || `http://127.0.0.1:${port}`;
  }
  const webAddress = () => typeof webOrigin === 'function' ? webOrigin() : webOrigin;
  // Hosted HTML runs on a loopback-only origin for its containing folder.
  // Chromium resolves *.localhost itself: no public DNS or certificates, and
  // /assets and ES imports work without changing the person's source files.
  // A DNS label is at most 63 bytes; 128 bits is enough to name a folder.
  const rootName = root => createHash('sha256').update(root).digest('hex').slice(0, 32);
  async function siteRoot(host = '') {
    const name = host.replace(/:\d+$/, '').toLowerCase();
    if (!hosted || !name.endsWith('.localhost')) return null;
    for (const root of await load()) if (`${rootName(root)}.localhost` === name) return root;
    return null;
  }
  async function fileAddress(path, root = dirname(path)) {
    if (hosted && (!media(path) || viewKind(path) === 'pdf')) return `http://${rootName(root)}.localhost:${listening()}/${path.slice(root.endsWith('/') ? root.length : root.length + 1).split('/').map(encodeURIComponent).join('/')}`;
    const at = hosted && webAddress() ? webAddress() : await origin();
    return `${at}${media(path) ? `/files/raw?path=${encodeURIComponent(path)}` : `/shown${path.split('/').map(encodeURIComponent).join('/')}`}`;
  }
  async function portAddress(local) {
    const url = new URL(local), rest = `${url.pathname}${url.search}${url.hash}`;
    if (hosted) return `${url.protocol}//localhost:${portOf(url.href)}${rest}`;
    return pageOrigin ? `${await origin(portOf(url.href))}${rest}` : `${await origin()}/port/${portOf(url.href)}${rest}`;
  }

  async function indexFile(folder) {
    for (const name of await readdir(folder).catch(() => [])) {
      if (/^index\.html?$/i.test(name) && (await stat(join(folder, name)).catch(() => null))?.isFile()) return join(folder, name);
    }
    return null;
  }
  // A folder plays its index.html; without one it opens in Workbench,
  // without exposing its contents on the page listener.
  async function add(path, cwd = '') {
    const full = resolve(String(cwd || process.cwd()), String(path ?? '').replace(/^~(?=\/|$)/, homedir()));
    const info = await stat(full).catch(() => null);
    if (!info) throw new Error(`${full} does not exist`);
    let target = full;
    if (info.isDirectory()) {
      target = await indexFile(full);
      if (!target) return { path: full, kind: 'folder' };
    } else if (!viewKind(full)) throw new Error(`${basename(full)} is not something a window can play: a page, picture, video, sound or PDF`);
    const root = info.isDirectory() ? full : dirname(full);
    if (!(await load()).has(root)) { roots.add(root); await keep(); }
    return { path: target, kind: viewKind(target), url: await fileAddress(target, root) };
  }
  // A page on this computer's loopback; opened: an agent showed it, so it is
  // carried from now on.
  async function local(address, { opened = false, probe = false } = {}) {
    const url = new URL(address), port = portOf(url.href);
    if (!/^https?:$/.test(url.protocol) || !LOOPBACK.has(url.hostname) || !allowedPort(port) || url.username || url.password) throw new Error(`${url.href} is not a page running on this computer`);
    if (opened) ports.add(port);
    else if ((hosted || !pageOrigin) && !carried(port)) throw new Error(`nothing an agent opened is running on port ${port} of that computer; ask it to start it with dev_server and show it`);
    if (probe) {
      const check = new URL(url);
      if (!hosted || ['0.0.0.0', '[::]'].includes(check.hostname)) check.hostname = check.hostname === '[::]' && hosted ? '[::1]' : '127.0.0.1';
      const response = await fetch(check, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10000) });
      // The hosted browser follows redirects and displays dev error pages;
      // any HTTP answer proves availability. Keep ordinary preview behavior.
      if (!response.ok && !hosted) throw new Error(`Server unavailable (${response.status})`);
    }
    url.hostname = 'localhost';
    return { path: url.href, kind: 'page', url: await portAddress(url.href) };
  }
  // Resolve only registered local services, on their owning computer. Saved
  // dev views use cwd/name, not a port which another process could take later.
  async function preview({ target, service } = {}) {
    let localURL;
    if (service) {
      const matches = servers().list().filter(one => one.running && one.cwd === service.cwd && one.name === service.name && one.url);
      if (matches.length !== 1) throw new Error('This app is no longer running; start it and Retry');
      localURL = new URL(service.rest || '/', matches[0].url);
      if (localURL.origin !== new URL(matches[0].url).origin) throw new Error('Invalid app path');
    } else {
      const url = new URL(String(target));
      const match = url.pathname.match(/^\/port\/(\d+)(\/.*)$/);
      if (match && (url.origin === new URL(await origin()).origin || (hosted && webAddress() && url.origin === new URL(webAddress()).origin))) localURL = new URL(`${match[2]}${url.search}${url.hash}`, `http://localhost:${match[1]}`);
      else if (pageOrigin && publicName) {
        const found = String(target).match(publicName);
        if (found) localURL = new URL(`${url.pathname}${url.search}${url.hash}`, `http://localhost:${found[1]}`);
      }
      if (!localURL && LOOPBACK.has(url.hostname)) localURL = url;
      if (!localURL) return { local: false };
    }
    const port = portOf(localURL.href);
    const project = projectAt(port);
    if (project) return { local: true, project };
    const own = servers().list().filter(one => one.running && one.url && portOf(one.url) === port);
    // An explicitly shown, manually started hosted server can still open in
    // the browser panel. Registered apps keep their stable Files identity;
    // ordinary computers retain the existing refusal for unregistered apps.
    if (hosted && own.length === 0 && ports.has(port) && allowedPort(port)) {
      await local(localURL.href, { probe: true });
      return { local: false };
    }
    if (own.length !== 1) throw new Error('No registered app owns this address; start it with dev_server and show it');
    const rest = `${localURL.pathname}${localURL.search}${localURL.hash}`;
    return { local: true, service: { cwd: own[0].cwd, name: own[0].name, rest }, url: (await local(localURL.href, { probe: true })).url };
  }

  // Only shown files and registered/opened services can become a hosted view.
  // Saved pre-hosted /shown and /port addresses are resolved on their owner.
  async function viewTarget(target) {
    if (typeof target !== 'string' || !target.trim()) throw new Error('A preview needs a file, folder or local address');
    if (!/^https?:\/\//i.test(target)) return add(target);
    const url = new URL(String(target));
    const root = Number(url.port) === listening() && await siteRoot(url.host);
    if (root) {
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (!inside(path, root) || !await authorized(path)) throw new Error('This page is outside its shown folder');
      return { path, kind: viewKind(path), url: url.href };
    }
    const own = (LOOPBACK.has(url.hostname) && Number(url.port) === listening()) || (webAddress() && url.origin === new URL(webAddress()).origin);
    if (own) {
      if (url.pathname.startsWith('/shown/')) return add(decodeURIComponent(url.pathname.slice('/shown'.length)));
      if (url.pathname === '/files/raw') return add(url.searchParams.get('path'));
      const match = url.pathname.match(/^\/port\/(\d+)(\/.*)$/);
      if (match) return local(`http://localhost:${match[1]}${match[2]}${url.search}${url.hash}`);
    }
    if (LOOPBACK.has(url.hostname)) return local(url.href);
    if (hosted) throw new Error('This is not a page shown by this computer');
    return { kind: 'page', url: url.href };
  }

  // The `show` tool reaches it here, from whichever harness runs it.
  globalThis[KEY] = async (path, cwd) => (/^https?:\/\//i.test(String(path)) ? local(String(path), { opened: true }) : add(path, cwd));

  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 8192) break; }
    try { return JSON.parse(text || '{}'); } catch { return {}; }
  }
  // Both names share the registry boundary, including resolved symlinks.
  // The raw endpoint serves only what was shown, never what Workbench lists.
  async function authorized(path) {
    if (!path?.startsWith('/') || path.includes('\0')) return null;
    const full = resolve(path);
    const canonical = await realpath(full).catch(() => null);
    if (!canonical) return null;
    for (const root of await load()) {
      if (!inside(full, root)) continue;
      const boundary = await realpath(root).catch(() => null);
      if (boundary && inside(canonical, boundary)) return canonical;
    }
    return null;
  }
  async function serve(req, res, path, raw = false) {
    const full = await authorized(path);
    if (!full || (raw && (!media(path) || !media(full)))) return json(res, 404, { error: 'nothing was shown from there' });
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) return json(res, 404, { error: 'not found' });
    const ext = extname(full).toLowerCase();
    const headers = { 'content-type': MIME[ext] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'content-security-policy': PAGE_POLICY };
    if (ext === '.html' || ext === '.htm') {
      const html = withPaneShortcut(await readFile(full, 'utf8'));
      res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(html) });
      res.end(req.method === 'HEAD' ? undefined : html);
    } else sendRange(req, res, full, info.size, headers);
  }

  // Root-relative dev assets stay in the authorized /port namespace.
  // No application request is ever forwarded to imperfect's API listener.
  function rewrite(text, type, port) {
    const prefix = `/port/${port}`;
    // HTML attributes, CSS URLs and JS import/fetch literals. Leave protocol
    // relative URLs and already carried paths untouched.
    text = text.replace(/(["'`])\/(?!\/|port\/)([^\s"'`)<]*)/g, (_, quote, path) => `${quote}${prefix}/${path}`);
    if (/css/i.test(type)) text = text.replace(/url\(\/(?!\/|port\/)/gi, `url(${prefix}/`);
    if (/html/i.test(type)) {
      // Dynamic fetches and dev HMR sockets need the same root mapping. This
      // executes only inside the isolated app, never alongside host controls.
      const shim = `<script>(()=>{const prefix=${JSON.stringify(prefix)};const map=value=>{try{const u=new URL(String(value),location.href);if(['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&u.port===${JSON.stringify(String(port))}){u.host=location.host;u.protocol=/^wss?:$/.test(u.protocol)?(location.protocol==='https:'?'wss:':'ws:'):location.protocol}if(u.host===location.host&&!u.pathname.startsWith(prefix+'/'))u.pathname=prefix+u.pathname;return u.href}catch{return value}};const F=window.fetch;window.fetch=(input,options)=>F(input instanceof Request?new Request(map(input.url),input):map(input),options);const W=window.WebSocket;window.WebSocket=class extends W{constructor(url,protocols){super(map(url),protocols)}};const X=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...args){return X.call(this,method,map(url),...args)}})();</script>`;
      if (/<head(?:\s[^>]*)?>/i.test(text)) text = text.replace(/<head(?:\s[^>]*)?>/i, match => match + shim);
      else if (/<!doctype[^>]*>/i.test(text)) text = text.replace(/<!doctype[^>]*>/i, match => match + shim);
      else text = shim + text;
    }
    return /html/i.test(type) ? withPaneShortcut(text) : text;
  }

  // A carried page, as its own server answers, sandboxed like a shown one.
  // Its server sees a request from localhost and nothing of the page
  // origin's (no cookies, no origin); what it answers may not set cookies or
  // keep itself out of a frame, and a redirect stays carried.
  const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];
  function carry(req, res, port, rest) {
    if (!carried(port)) return json(res, 404, { error: `port ${port} is not one an agent opened here` });
    const headers = { ...req.headers, host: `localhost:${port}`, 'accept-encoding': 'identity' };
    for (const name of [...HOP, 'origin', 'referer', 'cookie', 'authorization', 'proxy-authorization']) delete headers[name];
    const ask = httpRequest({ host: 'localhost', port, method: req.method, path: rest, headers }, reply => {
      const out = { ...reply.headers };
      for (const name of [...HOP, 'set-cookie', 'content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy']) delete out[name];
      if (out.location) out.location = carriedLocation(out.location, port, rest);
      const type = out['content-type'] || '';
      if (req.method !== 'HEAD' && !pageOrigin && /(?:html|javascript|css)/i.test(type) && !out['content-encoding']) {
        delete out['content-length']; delete out.etag;
        const chunks = [];
        reply.on('data', chunk => chunks.push(chunk));
        reply.on('end', () => { res.writeHead(reply.statusCode, { ...out, 'content-security-policy': PAGE_POLICY }); res.end(rewrite(Buffer.concat(chunks).toString('utf8'), type, port)); });
        reply.on('error', () => res.destroy());
      } else {
        res.writeHead(reply.statusCode, { ...out, 'content-security-policy': PAGE_POLICY });
        reply.on('error', () => res.destroy()).pipe(res);
      }
    });
    ask.on('error', error => { if (!res.headersSent) json(res, 502, { error: `nothing answered on port ${port} (${error.message})` }); else res.destroy(); });
    res.on('close', () => ask.destroy());
    req.pipe(ask);
  }
  // A redirect to the page's own server, relative, so it stays carried.
  function carriedLocation(location, port, rest) {
    let to;
    try { to = new URL(location, `http://localhost:${port}${rest}`); } catch { return location; }
    if (!LOOPBACK.has(to.hostname) || portOf(to.href) !== port) return location;
    const depth = rest.split('?')[0].split('/').length - 2;
    return `./${'../'.repeat(depth)}${to.pathname.slice(1)}${to.search}${to.hash}`;
  }

  // The listener answers only by the names it has: loopback, this
  // computer's on the tailnet. Another name (a website pointing its own at
  // 127.0.0.1) gets nothing.
  async function named(host = '') {
    const name = host.replace(/:\d+$/, '').toLowerCase();
    if (LOOPBACK.has(name) || await siteRoot(host)) return true;
    const own = await machines?.origins?.().catch(() => []) ?? [];
    return own.some(at => new URL(at).hostname.toLowerCase() === name);
  }
  async function page(req, res) {
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://page').pathname); } catch { return json(res, 400, { error: 'bad path' }); }
    if (!await named(req.headers.host)) return json(res, 403, { error: 'not this computer\'s page address' });
    const root = await siteRoot(req.headers.host);
    if (root) {
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'shown files are read only' });
      const full = resolve(root, `.${path}`);
      if (!inside(full, root)) return json(res, 404, { error: 'outside shown folder' });
      const info = await stat(full).catch(() => null);
      const target = info?.isDirectory() ? await indexFile(full) : full;
      if (!target) return json(res, 404, { error: 'no index page' });
      // A symlink into a different shown folder still must not escape this site.
      const [canonical, boundary] = await Promise.all([realpath(target).catch(() => null), realpath(root).catch(() => null)]);
      if (!canonical || !boundary || !inside(canonical, boundary)) return json(res, 404, { error: 'outside shown folder' });
      return serve(req, res, target);
    }
    // Status probes reveal no page data or authenticated host resources.
    if (req.method === 'HEAD') res.setHeader('access-control-allow-origin', '*');
    if (['GET', 'HEAD'].includes(req.method)) {
      if (path === '/files/raw') return serve(req, res, new URL(req.url, 'http://page').searchParams.get('path'), true);
      if (path.startsWith('/shown/')) return serve(req, res, path.slice('/shown'.length));
    }
    const port = path.match(/^\/port\/(\d+)(\/|$)/);
    if (port && !port[2]) { res.writeHead(301, { location: `${port[1]}/` }).end(); return; }
    if (port && !req.url.startsWith(`/port/${port[1]}/`)) return json(res, 400, { error: 'bad port path' });
    if (port) return carry(req, res, Number(port[1]), req.url.slice(`/port/${port[1]}`.length));
    json(res, 404, { error: 'not found' });
  }

  // The demo's name for a port, as a pattern: https://demo-(\d+).imperfect.computer.
  const publicName = pageOrigin && new RegExp(`^${pageOrigin.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace('{port}', '(\\d+)')}(?=[/?#]|$)`, 'i');
  return {
    // One of its addresses as a window on this computer opens it: a port the
    // demo names publicly (which only the visitor's browser reaches, through
    // the broker) is that port on loopback.
    here(address) {
      if (hosted) {
        try {
          const url = new URL(address);
          const own = (webAddress() && url.origin === new URL(webAddress()).origin) || (LOOPBACK.has(url.hostname) && Number(url.port) === listening());
          if (own) {
            const match = url.pathname.match(/^\/port\/(\d+)(\/.*)$/);
            if (match) return `http://localhost:${match[1]}${match[2]}${url.search}${url.hash}`;
            if (url.pathname === '/files/raw' || url.pathname.startsWith('/shown/')) return `http://127.0.0.1:${listening()}${url.pathname}${url.search}${url.hash}`;
          }
        } catch { /* not a shown address */ }
      }
      const found = publicName && String(address).match(publicName);
      if (!found) return address;
      const port = Number(found[1]);
      return `http://${port === listening() ? '127.0.0.1' : 'localhost'}:${port}${String(address).slice(found[0].length) || '/'}`;
    },
    // imperfect's own request: a POST /shown/add; false for anything else.
    async handle(req, res, path) {
      if (path === '/shown/view' && req.method === 'POST') {
        try {
          const asked = await body(req), resolved = await viewTarget(asked.target);
          if (!resolved.url) throw new Error('This folder has no page to play');
          const streamed = hosted && ['page', 'pdf'].includes(resolved.kind);
          if (streamed && !view) throw new Error('The hosted browser is unavailable');
          json(res, 200, streamed ? { stream: true, ...await view({ url: resolved.url, reload: asked.reload === true }) } : { stream: false, url: resolved.url });
        } catch (error) { json(res, 503, { error: error.message }); }
        return true;
      }
      if (path === '/shown/preview' && req.method === 'POST') {
        try { json(res, 200, await preview(await body(req))); }
        catch (error) { json(res, 503, { error: error.message, local: true }); }
        return true;
      }
      if (path !== '/shown/add' || req.method !== 'POST') return false;
      try {
        const asked = String((await body(req)).path ?? '');
        json(res, 200, await (/^https?:\/\//i.test(asked) ? local(asked) : add(asked)));
      } catch (error) { if (!res.headersSent) json(res, 500, { error: error.message }); }
      return true;
    },
    // The page listener, on loopback.
    listen(port = 0) {
      listener = createServer({ requestTimeout: 0, headersTimeout: 60_000 }, (req, res) => {
        page(req, res).catch(error => { if (!res.headersSent) json(res, 500, { error: error.message }); else res.destroy(); });
      });
      listener.on('upgrade', async (req, socket, head) => {
        const match = req.url.match(/^\/port\/(\d+)(\/.*)$/);
        if (!match || !carried(Number(match[1])) || !await named(req.headers.host)) { socket.destroy(); return; }
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        // Cookies and host bearer headers never cross into the app.
        const headers = { ...req.headers, host: `localhost:${match[1]}` };
        for (const name of ['cookie', 'authorization', 'proxy-authorization', 'origin', 'referer']) delete headers[name];
        const upstream = httpRequest({ host: 'localhost', port: Number(match[1]), path: match[2], headers });
        upstream.on('upgrade', (reply, remote, rest) => {
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).filter(([name]) => !['set-cookie'].includes(name)).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`);
          if (head.length) remote.write(head);
          if (rest.length) socket.write(rest);
          socket.pipe(remote).pipe(socket);
          socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
          socket.on('close', () => remote.destroy());
        });
        upstream.on('response', () => socket.destroy());
        upstream.on('error', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
        upstream.end();
      });
      return new Promise((resolveListen, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', () => resolveListen(listener.address()));
      });
    },
    close: () => new Promise(done => { if (!listener) return done(); for (const socket of sockets) socket.destroy(); listener.closeAllConnections?.(); listener.close(() => done()); }),
    // Where imperfect's window may play them from, as a policy's sources:
    // this listener, and every computer's on the person's tailnet.
    async sources() {
      // Hosted clients receive authenticated media and browser pictures only;
      // their own localhost must never be mistaken for this computer's pages.
      if (hosted) return '';
      const own = await machines?.origins?.().catch(() => []) ?? [];
      const tailnet = own.map(at => { const url = new URL(at); return `${url.protocol}//${url.hostname.replace(/^[^.]+/, '*')}:*`; });
      return [...new Set([`http://127.0.0.1:${listening()}`, ...tailnet, ...(pageOrigin ? [await origin()] : [])])].join(' ');
    },
    origin,
    // The address of a page on this computer's loopback that is carried.
    page: address => local(address),
  };
}
