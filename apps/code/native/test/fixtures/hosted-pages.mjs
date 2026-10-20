// An isolated hosted computer behind a door. The visitor is Chromium; the
// websites are rendered only by the real person's headless Electron browser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { launchChromium } from '../../../../../tools/test-browser.mjs';
import { createGueyServer } from '../../../../../system/server.mjs';
import { askWindow, windowSockets } from '../../browser.mjs';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, description, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${description}`);
    await pause(50);
  }
}
// These are fixture credentials, not the person's credentials.
export const AUTH = `Basic ${Buffer.from('proof:fixture-only').toString('base64')}`;

export async function hostedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-pages-proof-'));
  const home = join(root, 'home');
  await mkdir(home);
  let app, visitor, electron, electronClosed, spawnError, backend, errors = '';
  const connections = new Set(), relays = new Set();
  const seen = { requests: [], upgrades: [], live: [], responses: [] };
  const authenticated = req => req.headers.authorization === AUTH;
  const denied = res => { res.writeHead(401, { 'www-authenticate': 'Basic realm="proof door"' }); res.end('Unauthorized'); };
  const door = createServer((req, res) => {
    seen.requests.push({ method: req.method, path: req.url, authenticated: authenticated(req) });
    if (!authenticated(req)) return denied(res);
    const upstream = request({ hostname: '127.0.0.1', port: backend, path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${backend}` } }, reply => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
    upstream.on('error', error => { if (!res.headersSent) res.writeHead(502); res.end(error.message); });
    req.pipe(upstream);
  });
  door.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  door.on('upgrade', (req, socket, head) => {
    seen.upgrades.push({ path: req.url, authenticated: authenticated(req) });
    if (!authenticated(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="proof door"\r\nContent-Length: 0\r\n\r\n'); return; }
    const upstream = connect(backend, '127.0.0.1', () => {
      const headers = { ...req.headers, host: `127.0.0.1:${backend}` };
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    relays.add(upstream); upstream.once('close', () => relays.delete(upstream));
    socket.on('close', () => upstream.destroy()); socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  t.after(async () => {
    try { await visitor?.close(); }
    finally {
      try {
        for (const socket of connections) socket.destroy();
        for (const socket of relays) socket.destroy();
        await new Promise(resolve => door.close(resolve));
      } finally {
        try { await app?.close(); }
        finally {
          try {
            if (electron) {
              // Reap the browser and its own renderer group before deleting
              // their profile, even when initialization/visitor cleanup fails.
              const kill = signal => {
                if (!electron.pid) return;
                try { process.kill(-electron.pid, signal); }
                catch (error) { if (error.code !== 'ESRCH') throw error; }
              };
              kill('SIGTERM');
              const force = setTimeout(() => kill('SIGKILL'), 3000);
              try { await electronClosed; }
              finally { clearTimeout(force); kill('SIGKILL'); }
            }
          } finally { await rm(root, { recursive: true, force: true }); }
        }
      }
    }
  });
  await new Promise((resolve, reject) => { door.once('error', reject); door.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${door.address().port}`;
  // This number names only the isolated browser profile/socket, never a live
  // imperfect service. HOME and userData are both under the test's temp root.
  const port = 5197;
  const sockets = () => windowSockets(port, join(home, '.imperfect'));
  async function launch() {
    if (electron) throw new Error(`Person browser unexpectedly disappeared: ${errors}`);
    const env = { ...process.env, HOME: home, IMPERFECT_PORT: String(port) };
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    electron = spawn(createRequire(import.meta.url)('electron'), ['--ozone-platform=headless', '--disable-gpu',
      '--ozone-override-screen-size=1280,800', fileURLToPath(new URL('../../../../../desktop/electron/browser.mjs', import.meta.url))],
    { env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    electronClosed = new Promise(resolve => {
      electron.once('error', error => { spawnError = error; });
      electron.once('close', resolve);
    });
    electron.stderr.on('data', data => { errors = (errors + data).slice(-12000); });
    await until(async () => {
      if (spawnError) throw spawnError;
      if (electron.exitCode != null || electron.signalCode != null) throw new Error(`Person Electron failed: ${errors}`);
      return (await sockets()).length;
    }, 'person Electron socket');
  }
  const snapshot = { agent: 'pi', sessionId: 'proof-session', cwd: root,
    model: { provider: 'fixture', id: 'fixture' }, messages: [{ role: 'assistant', content: 'Ready' }],
    queue: { items: [] }, stats: {}, ui: {}, busy: false,
    tabs: [{ id: 'proof-tab', sessionId: 'proof-session', focused: true, agent: 'pi', name: 'Proof', status: 'idle' }] };
  const runtime = { events: new EventEmitter(), snapshot: () => snapshot,
    command: async command => command.type === 'sessions' ? [] : {}, close: async () => {} };
  const machines = { self: async () => 'proof', selfId: async () => 'proof', origins: async () => [origin],
    published: async () => '', peer: async () => null,
    list: async () => [{ id: 'proof', name: 'Proof computer', self: true, home: true, reachable: true, capabilities: ['files'] }] };
  app = await createGueyServer({ hosted: true, origins: [origin], cwd: root, stateDir: join(root, 'state'), runtime, machines,
    sessionToken: 'fixture-token-not-a-secret', identityOptions: { status: async () => ({ Self: { StableID: 'proof' } }) },
    browser: { sockets, open: launch }, projects: { root: join(root, 'projects') } });
  backend = (await app.listen()).port;
  const ask = said => askWindow(said, { sockets, open: launch });
  const json = async (path, value) => {
    const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { authorization: AUTH,
      origin, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    const result = await response.json();
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
    return result;
  };
  visitor = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  // Test app transport/input, not the ambient visuals. Use the real supported
  // reduced-motion preference so parallel software renderers do not dominate.
  const context = await visitor.newContext({ httpCredentials: { username: 'proof', password: 'fixture-only' }, viewport: { width: 1536, height: 900 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => seen.responses.push({ url: response.url(), status: response.status(), type: response.headers()['content-type'] ?? '' }));
  page.on('websocket', ws => {
    if (!ws.url().includes('/browser/live')) return;
    const live = { url: ws.url(), sent: [], received: [], closed: false }; seen.live.push(live);
    ws.on('close', () => { live.closed = true; });
    ws.on('framesent', ({ payload }) => { try { live.sent.push(JSON.parse(payload)); } catch {} });
    ws.on('framereceived', ({ payload }) => { try { const said = JSON.parse(payload); live.received.push(said.frame ? { ...said, frame: said.frame.slice(0, 32) } : said); } catch {} });
  });
  await page.goto(`${origin}/?face=code`);
  await page.locator('#entry-output .gui-assistant').waitFor();
  return { root, home, origin, page, app, ask, json, seen, pageErrors,
    say: text => { snapshot.messages = [{ role: 'assistant', content: text }]; runtime.events.emit('change'); },
    showResult: content => { snapshot.messages = [{ role: 'assistant', content: 'Shown media' }, { role: 'toolResult', toolName: 'show', content }]; runtime.events.emit('change'); },
    evaluate: async (tab, code) => (await ask({ do: 'run', tab, code, page: true })).value };
}

// Click a DOM target's actual pixels in the streamed picture. DOM inspection
// finds coordinates only; the person input goes through UI -> /browser/live
// -> the normal owner socket -> Electron sendInputEvent.
export async function clickStream(fixture, tab, selector, frameSelector = '.wm-files .browser-live-frame') {
  const { page, evaluate, seen } = fixture;
  const image = page.locator(frameSelector);
  // Bringing a panel into view starts/resizes its stream. Coordinates taken
  // before scrolling can belong to the old native viewport, not these pixels.
  await image.scrollIntoViewIfNeeded();
  let at;
  await until(async () => {
    const viewport = await image.evaluate(image => {
      const view = image.closest('.browser-live-view');
      return { width: Math.round(Math.max(240, Math.min(1920, view.clientWidth))),
        height: Math.round(Math.max(240, Math.min(1920, view.clientHeight))),
        drawn: image.complete && image.naturalWidth > 0, widthDrawn: image.naturalWidth, heightDrawn: image.naturalHeight };
    });
    const frame = seen.live.flatMap(live => live.received).findLast(said => said.frame && said.tab === tab
      && said.size?.width === viewport.width && said.size?.height === viewport.height);
    if (!frame || !viewport.drawn || viewport.widthDrawn !== viewport.width || viewport.heightDrawn !== viewport.height) return false;
    at = await evaluate(tab, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2, width:innerWidth, height:innerHeight }; })()`);
    return at.width === viewport.width && at.height === viewport.height;
  }, `streamed viewport ready for ${selector} on tab ${tab}`);
  const box = await image.boundingBox();
  assert.ok(box?.width > 0 && box.height > 0, 'streamed image has a real UI viewport');
  const scale = Math.min(box.width / at.width, box.height / at.height);
  await page.mouse.click(box.x + (box.width - at.width * scale) / 2 + at.x * scale,
    box.y + (box.height - at.height * scale) / 2 + at.y * scale);
}
