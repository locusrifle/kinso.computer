// One desktop window (desktop/electron/main.mjs): imperfect-open again comes
// to the window already open, as a new session in it, or Workbench at a
// folder, never a second window. Real Electron, on Chromium's headless
// platform with a profile and port of its own, so nothing appears on screen
// and the person's own window never hears of it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../../../../', import.meta.url).pathname;
const electronBin = join(root, 'node_modules/electron/dist/electron');
let available = true;
try { readFileSync(electronBin); } catch { available = false; }

// The machine, as far as the window needs one: healthy, and a page that
// listens for launches as harness.js does, telling the test what it heard.
async function machine({ holdListener = false } = {}) {
  const heard = [], loads = [], listeners = [];
  let wake = () => {};
  const release = () => { for (const res of listeners.splice(0)) res.end(); };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return res.end('{"native-gui":true}');
    if (url.pathname === '/listen') { if (holdListener) listeners.push(res); else res.end(); return; }
    if (url.pathname === '/heard') { heard.push(JSON.parse(url.searchParams.get('asked'))); wake(); return res.end(); }
    loads.push(url.search);
    res.setHeader('content-type', 'text/html');
    res.end(`<script>fetch('/listen').then(() => imperfectDesk.onOpen(asked => fetch('/heard?asked=' + encodeURIComponent(JSON.stringify(asked)))));</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const until = async count => {
    for (const end = Date.now() + 60_000; heard.length < count && Date.now() < end;) await new Promise(resolve => { wake = resolve; setTimeout(resolve, 200); });
    return heard;
  };
  return { port: server.address().port, heard, loads, listeners, release, until, close: () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }) };
}

function launcher(port) {
  const profile = mkdtempSync(join(tmpdir(), 'imperfect-single-'));
  // Keep the browser sockets as well as Chromium's profile in this test's home.
  mkdirSync(join(profile, '.imperfect'));
  const env = { ...process.env, HOME: profile, IMPERFECT_PORT: String(port), ELECTRON_ENABLE_LOGGING: '0' };
  delete env.DISPLAY; delete env.WAYLAND_DISPLAY; delete env.HYPRLAND_INSTANCE_SIGNATURE;
  const children = [];
  const open = (...args) => {
    const child = spawn(electronBin, [join(root, 'desktop/electron'), '--ozone-platform=headless', `--user-data-dir=${profile}`, ...args], { env, stdio: 'ignore' });
    child.exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
    children.push(child);
    return child;
  };
  const done = async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(child => child.exited));
    // Chromium's network/cache subprocesses can finish a profile write after
    // the main process exits. Retry transient removal races, but still fail
    // cleanup if they persist (at most 750ms of retry delay).
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  const ownsLock = child => {
    try { return readlinkSync(join(profile, 'SingletonLock')).endsWith(`-${child.pid}`); }
    catch { return false; }
  };
  return { open, done, ownsLock };
}

const within = async (promise, ms, what) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took over ${ms}ms`)), ms); })]); }
  finally { clearTimeout(timer); }
};
const until = async (condition, what) => {
  const end = Date.now() + 60000;
  while (!condition()) { assert.ok(Date.now() < end, what); await new Promise(resolve => setTimeout(resolve, 50)); }
};

test('a second launch becomes a new session in the one window, and leaves', { skip: !available, timeout: 180_000 }, async () => {
  const m = await machine(), l = launcher(m.port);
  try {
    const first = l.open('--face', 'code');
    // The page up and listening: the first launch adds nothing of its own.
    await until(() => m.loads.length, 'the first window loaded');
    assert.equal(m.loads.length, 1);
    const second = l.open('--face', 'code');
    assert.equal(await within(second.exited, 60_000, 'the second launch'), 0);
    assert.deepEqual(await m.until(1), [{ face: 'code' }]);
    // Workbench at a folder goes to the page as it is: no reload, so nothing unsaved in it is lost.
    const files = l.open('--face', 'files', '--path', '/tmp/a folder');
    assert.equal(await within(files.exited, 60_000, 'the files launch'), 0);
    assert.deepEqual((await m.until(2))[1], { face: 'files', path: '/tmp/a folder' });
    assert.equal(m.loads.length, 1, 'the window never reloaded');
    assert.equal(first.exitCode, null, 'the first window is still open');
  } finally { try { await l.done(); } finally { await m.close(); } }
});

test('rapid repeats each arrive once, none opens a window', { skip: !available, timeout: 180_000 }, async () => {
  const m = await machine(), l = launcher(m.port);
  try {
    const first = l.open();
    await until(() => m.loads.length, 'the first window loaded');
    const repeats = Array.from({ length: 6 }, () => l.open('--face', 'code'));
    assert.deepEqual(await within(Promise.all(repeats.map(r => r.exited)), 60_000, 'the repeats'), Array(6).fill(0));
    const heard = await m.until(6);
    assert.equal(heard.length, 6);
    assert.ok(heard.every(asked => asked.face === 'code'));
    assert.equal(m.loads.length, 1);
    assert.equal(first.exitCode, null);
  } finally { try { await l.done(); } finally { await m.close(); } }
});

test('launches while the window is still starting are held until the page listens', { skip: !available, timeout: 180_000 }, async () => {
  const m = await machine({ holdListener: true }), l = launcher(m.port);
  try {
    const first = l.open();
    // Observe the real single-instance lock; 400ms did not establish which
    // process became primary on a busy machine. Hold page readiness explicitly.
    await until(() => l.ownsLock(first), 'the first launch acquired its singleton');
    const early = l.open('--face', 'files', '--path', '/tmp');
    assert.equal(await within(early.exited, 60_000, 'the early launch'), 0);
    await until(() => m.listeners.length, 'the page waits before registering its listener');
    assert.deepEqual(m.heard, [], 'nothing delivered before the page listens');
    m.release();
    assert.deepEqual(await m.until(1), [{ face: 'files', path: '/tmp' }]);
  } finally { try { await l.done(); } finally { await m.close(); } }
});

test('a hidden checking window neither takes the lock nor hears launches', { skip: !available, timeout: 180_000 }, async () => {
  const m = await machine(), l = launcher(m.port);
  try {
    const hiddenOne = l.open('--hidden');
    await until(() => m.loads.length, 'the hidden window loaded');
    // A real launch beside it is a window of its own, not a message to it.
    const real = l.open('--face', 'code');
    await until(() => m.loads.length >= 2, 'a separate real window loaded');
    assert.equal(m.loads.length, 2);
    assert.equal(real.exitCode, null);
    assert.equal(hiddenOne.exitCode, null);
    assert.deepEqual(m.heard, []);
  } finally { try { await l.done(); } finally { await m.close(); } }
});

test('the page starts a session through the same path as Alt+Space', () => {
  const harness = readFileSync(join(root, 'apps/code/native/public/js/harness.js'), 'utf8');
  // A file or folder from a Mac's Finder or Dock is that Mac's (here).
  assert.match(harness, /imperfectDesk\?\.onOpen\?\.\(\(\{ face, path, here \}\) => face === 'files' \? openFiles\(path \|\| '', here \? \{ base: '' \} : \{\}\) : newTab\(\)\.catch\(fail\)\)/);
  // newTab drops a request while one is already being chosen or made, so a burst makes one.
  assert.match(harness, /if \(creating \|\| choosing\) return;/);
});
