// Tests and checks run in imperfect's own engine: the Electron (Chromium) its
// window is built on, from this checkout, with nothing on screen. No other
// browser need be installed; CHROMIUM still chooses a system one
// (test-browser.mjs).
//
// Playwright connects to it as to any Chromium, through a small proxy here:
// Electron's DevTools cannot make a browser context or a page, nor reach a
// context's cookies, permissions or downloads, so the proxy hands those few
// commands to imperfect-browser-main.mjs, which does them with Electron's
// own sessions and windows. Everything else goes straight through.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';

export const enginePath = createRequire(import.meta.url)('electron');
const main = join(import.meta.dirname, 'imperfect-browser-main.mjs');

// What Playwright gives a Chromium it launches, for the same pages here:
// never throttled in the background, no first-run, the test keychain, and
// headless' hidden scrollbars and pointer.
const switches = [
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-back-forward-cache', '--disable-hang-monitor', '--disable-ipc-flooding-protection', '--disable-popup-blocking',
  '--disable-prompt-on-repost', '--allow-pre-commit-input', '--force-color-profile=srgb', '--no-first-run',
  '--password-store=basic', '--use-mock-keychain', '--enable-features=CDPScreenshotNewSurface', '--enable-unsafe-swiftshader',
];
const headless = ['--hide-scrollbars', '--mute-audio', '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'];

// A computer whose GPU will not start for Chromium (the GPU process exits as
// it begins: an old Mac on a patched macOS, a Linux box with no screen) has
// every page wait on it for a first frame. Once seen, later launches go
// without the GPU and draw in software, as headless Chromium does.
const noGpu = join(tmpdir(), `imperfect-browser-no-gpu-${process.getuid?.() ?? 'user'}`);

function waitForLine(stream, pattern, what, child, timeout) {
  return new Promise((resolve, reject) => {
    let seen = '';
    const done = (error, value) => { clearTimeout(timer); stream.off('data', read); child.off('exit', exited); error ? reject(error) : resolve(value); };
    const read = data => { seen = (seen + data).slice(-8000); const match = pattern.exec(seen); if (match) done(null, match[1]); };
    const exited = code => done(new Error(`imperfect's browser exited (${code}) before ${what}: ${seen.trim().slice(-1200)}`));
    const timer = setTimeout(() => done(new Error(`imperfect's browser gave no ${what} in ${timeout}ms: ${seen.trim().slice(-1200)}`)), timeout);
    stream.on('data', read); child.once('exit', exited);
  });
}

// The proxy between Playwright and Electron's DevTools.
function proxy(devtools, control) {
  const contexts = new Map(); // our browserContextId -> { partition, real }
  const ours = new Map(); // Electron's browserContextId -> ours
  const answers = new Map();
  let asked = 0, client = null, upstream = null;
  const ask = (method, params) => new Promise((resolve, reject) => {
    const id = ++asked; answers.set(id, { resolve, reject });
    control.send(JSON.stringify({ id, method, params }));
  });
  control.on('message', raw => {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const answer = answers.get(message.id); answers.delete(message.id);
      message.error ? answer?.reject(new Error(message.error)) : answer?.resolve(message.result);
    } else client?.send(JSON.stringify(message)); // a download's events
  });
  // While a page is being made, what Electron says waits, so Playwright hears
  // of the page (Target.attachedToTarget) before the answer that names it,
  // as it does from Chromium. Pages are made one at a time, so what is let
  // through when one is made never names another still being made.
  let making = 0, queue = Promise.resolve(); const held = [];
  const toClient = text => {
    if (text.includes('"browserContextId"')) text = text.replace(/"browserContextId":"([^"]+)"/g, (whole, id) => ours.has(id) ? `"browserContextId":"${ours.get(id)}"` : whole);
    client?.send(text);
  };
  const reply = (id, result, sessionId) => client?.send(JSON.stringify({ id, result, sessionId }));
  const fail = (id, error, sessionId) => client?.send(JSON.stringify({ id, error: { code: -32000, message: error?.message ?? String(error) }, sessionId }));
  const attached = new Set(), waiting = new Map(), targets = new Map(); // targets: sessionId -> targetId
  const heard = text => {
    if (!text.startsWith('{"method":"Target.attachedToTarget"')) return;
    const id = /"targetId":"([^"]+)"/.exec(text)?.[1];
    const session = /"sessionId":"([^"]+)"/.exec(text)?.[1];
    if (!id) return;
    if (session) targets.set(session, id);
    attached.add(id); waiting.get(id)?.(); waiting.delete(id);
  };
  const attachedTo = targetId => attached.has(targetId) ? Promise.resolve() : new Promise(resolve => {
    waiting.set(targetId, resolve); setTimeout(resolve, 10_000);
  });
  const partitionOf = id => {
    if (id === undefined) return '';
    const context = contexts.get(id);
    if (!context) throw new Error(`Failed to find browser context for id ${id}`);
    return context.partition;
  };
  let made = 0;
  const local = {
    'Target.createBrowserContext': async () => {
      const id = `IMPERFECT${String(++made).padStart(4, '0')}`;
      contexts.set(id, { partition: `imperfect-test-${process.pid}-${made}`, real: null });
      return { browserContextId: id };
    },
    'Target.disposeBrowserContext': async ({ browserContextId }) => {
      await ask('disposeProfile', { partition: partitionOf(browserContextId) });
      contexts.delete(browserContextId);
      return {};
    },
    'Target.createTarget': ({ url, browserContextId, width, height }) => {
      const page = queue.then(async () => {
        const partition = partitionOf(browserContextId);
        making++;
        try {
          const made = await ask('createTarget', { partition, url, width, height });
          const context = contexts.get(browserContextId);
          if (context && !context.real) { context.real = made.browserContextId; ours.set(made.browserContextId, browserContextId); }
          await attachedTo(made.targetId);
          return { targetId: made.targetId };
        } finally { making--; while (held.length) toClient(held.shift()); }
      });
      queue = page.catch(() => {});
      return page;
    },
    'Target.closeTarget': async params => {
      if ((await ask('closeTarget', params)).found) return { success: true };
      return forward('Target.closeTarget', params);
    },
    'Browser.setDownloadBehavior': async ({ browserContextId, ...params }) => ask('setDownloadBehavior', { partition: partitionOf(browserContextId), ...params }),
    'Browser.cancelDownload': async params => ask('cancelDownload', params),
    // Electron lets a page have what it asks for.
    'Browser.grantPermissions': async () => ({}),
    'Browser.resetPermissions': async () => ({}),
    'Storage.getCookies': async ({ browserContextId }) => ask('getCookies', { partition: partitionOf(browserContextId) }),
    'Storage.setCookies': async ({ browserContextId, cookies }) => ask('setCookies', { partition: partitionOf(browserContextId), cookies }),
    'Storage.clearCookies': async ({ browserContextId }) => ask('clearCookies', { partition: partitionOf(browserContextId) }),
  };
  // A page's own commands Electron's DevTools lacks: a PDF, handed back as
  // the stream Playwright reads it from.
  const streams = new Map();
  let printed = 0;
  const onPage = {
    'Page.printToPDF': async (params, sessionId) => {
      const { data } = await ask('printToPDF', { targetId: targets.get(sessionId), options: params });
      if (params.transferMode !== 'ReturnAsStream') return { data };
      const stream = `imperfect-pdf-${++printed}`;
      streams.set(stream, Buffer.from(data, 'base64'));
      return { data: '', stream };
    },
    'IO.read': async ({ handle, size = 1 << 20 }) => {
      const buffer = streams.get(handle);
      const chunk = buffer.subarray(0, size);
      streams.set(handle, buffer.subarray(chunk.length));
      return { base64Encoded: true, data: chunk.toString('base64'), eof: buffer.length <= size };
    },
    'IO.close': async ({ handle }) => { streams.delete(handle); return {}; },
  };
  const ownsCommand = message => message.sessionId && onPage[message.method]
    && (message.method === 'Page.printToPDF' || streams.has(message.params?.handle));
  // A command the proxy sends Electron itself, for one of its own answers.
  let own = 1e9; const owned = new Map();
  const forward = (method, params) => new Promise((resolve, reject) => {
    const id = ++own; owned.set(id, { resolve, reject });
    upstream.send(JSON.stringify({ id, method, params }));
  });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server.on('connection', socket => {
    client = socket;
    upstream = new WebSocket(devtools, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const early = [];
    upstream.on('open', () => { while (early.length) upstream.send(early.shift()); });
    upstream.on('message', raw => {
      const text = String(raw);
      if (text.startsWith(`{"id":`) && Number(/^\{"id":(\d+)/.exec(text)?.[1]) > 1e9) {
        const message = JSON.parse(text), waiter = owned.get(message.id); owned.delete(message.id);
        message.error ? waiter?.reject(new Error(message.error.message)) : waiter?.resolve(message.result);
        return;
      }
      heard(text);
      if (making) held.push(text); else toClient(text);
    });
    upstream.on('close', () => socket.close());
    socket.on('close', () => upstream.close());
    socket.on('message', raw => {
      const text = String(raw);
      const message = JSON.parse(text);
      const handle = !message.sessionId ? local[message.method] : ownsCommand(message) ? onPage[message.method] : null;
      if (handle) {
        handle(message.params ?? {}, message.sessionId).then(result => reply(message.id, result, message.sessionId), error => fail(message.id, error, message.sessionId));
        return;
      }
      upstream.readyState === WebSocket.OPEN ? upstream.send(text) : early.push(text);
    });
  });
  return new Promise(resolve => server.on('listening', () => resolve({ server, endpoint: `ws://127.0.0.1:${server.address().port}/devtools/browser/imperfect` })));
}

// Launch imperfect's browser and connect Playwright to it: the Browser that
// chromium.launch would give. Closing it ends the engine.
export async function launchImperfectBrowser({ args = [], headless: hidden = true, ignoreDefaultArgs = [], timeout = 120_000 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'imperfect-browser-'));
  const ignored = Array.isArray(ignoreDefaultArgs) ? ignoreDefaultArgs : [];
  const flags = [...switches, ...(hidden ? headless : [])].filter(flag => !ignored.includes(flag));
  if (process.platform === 'linux') {
    flags.push('--no-sandbox');
    // Hidden tests must not depend on a login's display. A user service can
    // inherit a stale DISPLAY even when no X server exists (Wayland/SSH).
    if (hidden || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) flags.push('--ozone-platform=headless');
  }
  if (existsSync(noGpu) && !flags.includes('--disable-gpu')) flags.push('--disable-gpu');
  const env = { ...process.env, IMPERFECT_BROWSER_SHOWN: hidden ? '0' : '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(enginePath, [...flags, ...args, '--remote-debugging-port=0', `--user-data-dir=${profile}`, main], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = new Promise(resolve => child.once('exit', resolve));
  child.stderr.on('data', data => { if (String(data).includes('Exiting GPU process due to errors during initialization')) writeFile(noGpu, '').catch(() => {}); });
  const end = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await ended; }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  let bridge;
  try {
    const [devtools, controlAddress] = await Promise.all([
      waitForLine(child.stderr, /DevTools listening on (ws:\/\/\S+)/, 'its DevTools address', child, timeout),
      waitForLine(child.stdout, /imperfect-browser (ws:\/\/\S+)/, 'its control address', child, timeout),
    ]);
    const control = new WebSocket(controlAddress);
    await new Promise((resolve, reject) => { control.once('open', resolve); control.once('error', reject); });
    bridge = await proxy(devtools, control);
    const browser = await chromium.connectOverCDP(bridge.endpoint, { timeout });
    browser.once('disconnected', () => { control.close(); bridge.server.close(); void end(); });
    // Closing a connected browser only disconnects; here it also ends the engine.
    const close = browser.close.bind(browser);
    browser.close = async (...rest) => { try { await close(...rest); } finally { await end(); } };
    return browser;
  } catch (error) {
    bridge?.server.close();
    await end();
    throw error;
  }
}
