// Actual product server/frontend; only the computer/runtime/browser transports are fixtures.
// Like native/test/fixtures/hosted-pages.mjs, this owns a private server/home and never
// talks to the installed service. No illustrated document or simulated Google pixels.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createGueyServer } from '../../../system/server.mjs';
import { readTheme, themeCss } from '../../../system/theme.mjs';
import { launchShopURL } from '../../../apps/code/native/public/js/launch-open.js';

// ids: the site locks whose tickets it takes (imperfect.computer's "noah"; kinso.computer's lock opens "kinso").
export async function launchProductFixture({ verifyTicket, launchOrigin, ids = ['noah'], publicOrigin = null }) {
  const root = await mkdtemp(join(tmpdir(), 'launch-product-'));
  const home = join(root, 'home');
  await mkdir(home);
  const lightCss = themeCss(await readTheme('mac-light', home));
  const seen = { tickets: [], roots: [], requests: [], commands: [], browser: [], browserSources: [], watches: [], watchSources: [] };
  const sockets = new Set(), relays = new Set(), usedTickets = new Set();
  let sessionCookie = randomUUID(), authenticated = false;
  const hasSession = req => authenticated && (req.headers.cookie || '').split(';').some(value => value.trim() === `launch-fixture=${sessionCookie}`);
  let backend, mode = 'ready', backendPort;
  const live = new WebSocketServer({ noServer: true });
  const tabs = [];
  const sendLive = ws => { if (ws.readyState === 1) ws.send(JSON.stringify({ scope: 'browser', watching: tabs.find(tab => tab.front)?.tab ?? null,
    tabs, error: 'Isolated test transport: external websites are not loaded.' })); };
  const front = id => {
    assert.ok(tabs.some(tab => tab.tab === id), 'front targets an actual existing native browser tab');
    for (const tab of tabs) tab.front = tab.tab === id;
    for (const ws of live.clients) sendLive(ws);
  };
  const json = (res, value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      const path = url.pathname.replace(/^\/b\/[^/]+/, '');
      seen.requests.push({ method: req.method, path });
      if (path === '/door/ticket') {
        const raw = url.searchParams.get('t'), ticket = await verifyTicket(raw);
        const valid = ids.includes(ticket?.id) && !usedTickets.has(raw);
        seen.tickets.push({ valid, id: ticket?.id });
        if (!valid) return json(res, { error: 'Fixture ticket refused' }, 403);
        usedTickets.add(raw); authenticated = true;
        // Like the real door: one ticket, then an HttpOnly cookie shared by the
        // primary and phone roots. Never substitute a product document here.
        res.writeHead(302, { location: '/?face=code',
          'set-cookie': `launch-fixture=${sessionCookie}; Path=/; HttpOnly; SameSite=Lax` }); res.end(); return;
      }
      if (path === '/') {
        const auth = hasSession(req);
        seen.roots.push({ authenticated: auth, launch: url.searchParams.get('launch'), face: url.searchParams.get('face') });
        if (!auth) return json(res, { error: 'Fixture session required' }, 401);
      }
      if (path === '/' && mode === 'offline') {
        res.writeHead(503, { 'content-type': 'text/html' });
        res.end('<h1>Offline fixture MUST NEVER BE VISIBLE</h1>'); return;
      }
      if (path === '/elsewhere') { res.end('Unverified fixture document'); return; }
      if (path === '/js/brand.js' && ids.includes('kinso')) {
        // Like the demo-ready allowlist below, substitute this dedicated
        // fixture origin for Kinso's real computer. The ticket redirect above
        // still drops ?for=, exercising a brand-new visitor with no storage.
        const source = (await readFile(new URL('../../../apps/code/native/public/js/brand.js', import.meta.url), 'utf8'))
          .replace("'https://computer.kinso.computer'", JSON.stringify(origin));
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(source); return;
      }
      if (path === '/js/demo-ready.js') {
        let source = await readFile(new URL('../../../apps/code/native/public/js/demo-ready.js', import.meta.url), 'utf8');
        // Test-only allowlists: preserve all real ready/assembly/source/origin guards.
        // An exact loopback pair replaces deployment DNS, never a production bypass.
        assert.match(source, /const PARENTS = new Set\([^\n]+\);/);
        assert.match(source, /const DEMOS = [^\n]+;/);
        source = source.replace(/const PARENTS = new Set\([^\n]+\);/, `const PARENTS = new Set([${JSON.stringify(launchOrigin())}]);`)
          .replace(/const DEMOS = [^\n]+;/, `const DEMOS = { test: origin => origin === ${JSON.stringify(origin)} };`);
        if (mode === 'manual') source = source.replace("if (!win || !doc || win.parent === win", "if (true || !win || !doc || win.parent === win");
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(source); return;
      }
      if (path === '/theme.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(lightCss); return; }
      // Fixture home is explicit: no listing/reading the person's actual home.
      if (path === '/files/list') {
        const path = url.searchParams.get('path') || home;
        return json(res, { path, home, entries: ['Desktop', 'Documents', 'Downloads', 'Projects'].map(name => ({ name, path: join(path, name), dir: true, size: 0, mtime: 0 })) });
      }
      if (path === '/files/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture\n\n'); return; }
      if (path.startsWith('/files/')) return json(res, { error: 'Read-only fixture' }, 403);
      if (path === '/browser') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const command = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        seen.browser.push(command);
        seen.browserSources.push(req.headers.referer || '');
        if (command.do === 'tabs') return json(res, { tabs });
        if (command.do === 'open') {
          const url = new URL(command.url);
          const google = command.url === 'https://www.google.com';
          const shop = launchShopURL(command.url);
          assert.ok(google || shop === command.url, 'actual product validator admits only canonical official Shop URLs');
          if (command.tab !== undefined) {
            const tab = tabs.find(tab => tab.tab === command.tab);
            assert.ok(shop && tab && tab.tab !== 101, 'explicit navigation only reuses the remembered Shop, never Google');
            tab.url = command.url; tab.title = 'Shop · imperfect';
            for (const ws of live.clients) sendLive(ws);
            return json(res, tab);
          }
          assert.ok(!tabs.some(tab => new URL(tab.url).origin === url.origin && new URL(tab.url).pathname === url.pathname), 'launch must reuse an existing Google/Shop tab');
          const tab = { tab: google ? 101 : 102, url: google ? 'https://www.google.com/' : command.url, title: google ? 'Google' : 'Shop · imperfect', front: false };
          tabs.push(tab);
          return json(res, tab);
        }
        if (command.do === 'front') { front(command.tab); return json(res, {}); }
        assert.fail(`Unexpected browser fixture action: ${command.do}`);
      }
      if (path === '/usage.json') return json(res, { providers: [], machines: [] });
      if (path === '/sessions.json') return json(res, { machine: 'fixture', sessions: [] });
      // Proxy real product responses. The fixture door, like the actual deployed
      // door, supplies the one allowed frame ancestor instead of local-server DENY.
      const upstream = request({ hostname: '127.0.0.1', port: backendPort, path: req.url,
        method: req.method, headers: { ...req.headers, host: `127.0.0.1:${backendPort}` } }, reply => {
        const headers = { ...reply.headers };
        delete headers['x-frame-options'];
        if (headers['content-security-policy']) {
          headers['content-security-policy'] = headers['content-security-policy'].replace("frame-ancestors 'none'", `frame-ancestors ${launchOrigin()}`);
          // frame-src comes unchanged from the real product server. Kinso's
          // exact-origin fixture must exercise its dedicated hosted policy.
        }
        res.writeHead(reply.statusCode, headers); reply.pipe(res);
      });
      upstream.on('error', error => { if (!res.headersSent) res.writeHead(502); res.end(error.message); });
      res.once('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(error.stack); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (!hasSession(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    if (req.url === '/browser/live') {
      live.handleUpgrade(req, socket, head, ws => {
        ws.on('message', raw => {
          const said = JSON.parse(raw); seen.watches.push(said); seen.watchSources.push(req.headers.referer || '');
          if (!said.do) return;
          if (said.do === 'front') front(said.tab);
          // Deliberately no fake screenshot: exercise the real browser pane's
          // tabs/real unavailable state, without visiting any external website.
          sendLive(ws);
        });
      }); return;
    }
    const upstream = connect(backendPort, '127.0.0.1', () => {
      const headers = { ...req.headers, host: `127.0.0.1:${backendPort}` };
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    relays.add(upstream); upstream.once('close', () => relays.delete(upstream));
    socket.on('close', () => upstream.destroy()); socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const transportOrigin = `http://127.0.0.1:${server.address().port}`;
  const origin = publicOrigin ?? transportOrigin;
  const snapshot = { agent: 'pi', sessionId: 'fixture-existing', cwd: home, busy: false,
    instanceId: 'launch-fixture', model: { provider: 'fixture', id: 'fixture', name: 'Fixture' },
    messages: [{ role: 'assistant', content: 'Existing session (fixture)' }], queue: { items: [] }, stats: {}, ui: {},
    harnesses: ['pi', 'claude', 'codex'].map(agent => ({ agent, ready: true, usual: agent === 'pi' })),
    tabs: [{ id: 'fixture-tab', sessionId: 'fixture-existing', focused: true, agent: 'pi', name: 'Existing session', status: 'idle' }] };
  const runtime = { events: new EventEmitter(), snapshot: () => snapshot, close: async () => {},
    command: async command => {
      seen.commands.push(command);
      if (command.type === 'sessions') return [];
      if (command.type === 'snapshot') return snapshot;
      if (command.type === 'usage') return { providers: [], machines: [] };
      if (command.type === 'tab-new') return { id: 'fixture-created' };
      return {};
    } };
  const machines = { self: async () => 'fixture', selfId: async () => 'fixture', origins: async () => [origin],
    published: async () => '', peer: async () => null,
    list: async () => [{ id: 'fixture', name: 'Cloud computer', self: true, home: true, hosted: true, reachable: true, capabilities: ['files'] }] };
  backend = await createGueyServer({ host: '127.0.0.1', port: 0, hosted: true, origins: [origin], cwd: home, stateDir: join(root, 'state'),
    runtime, machines, sessionToken: 'fixture-only-not-a-secret',
    identityOptions: { status: async () => ({ Self: { StableID: 'fixture' } }) },
    browser: { sockets: async () => [], open: async () => { throw new Error('Fixture never opens another browser'); } },
    projects: { root: join(root, 'projects') }, files: { thumbnailDir: join(root, 'thumbnails') } });
  backendPort = (await backend.listen()).port;
  return { origin, transportOrigin, seen, home, tabs,
    set mode(value) { mode = value; },
    reset() {
      for (const values of Object.values(seen)) values.length = 0;
      tabs.length = 0; usedTickets.clear(); authenticated = false; sessionCookie = randomUUID();
    },
    async close() {
      for (const ws of live.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      for (const socket of relays) socket.destroy();
      await new Promise(ok => live.close(ok));
      await new Promise(ok => server.close(ok));
      await backend.close(); await rm(root, { recursive: true, force: true });
    } };
}
