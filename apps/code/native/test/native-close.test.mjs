import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { installNativeClose, nativeCloseKey } from '../../../../desktop/electron/close.mjs';
import { desktopSession } from '../browser.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
function window() {
  const win = new EventEmitter();
  win.dead = false;
  win.isDestroyed = () => win.dead;
  win.destroy = () => { win.dead = true; win.emit('closed'); };
  win.close = () => { const event = { preventDefault() { this.prevented = true; } }; win.emit('close', event); assert.equal(event.prevented, true); };
  return win;
}

test('the window closes at once, without consulting embedded pages', async () => {
  const win = window();
  installNativeClose(win);
  win.close(); await turn(); assert.equal(win.dead, true);
});

test('only Ctrl+Shift+W is native close; Alt+W and Ctrl+W remain distinct', () => {
  const input = { type: 'keyDown', code: 'KeyW', key: 'W', control: true, shift: true };
  assert.equal(nativeCloseKey(input), true);
  for (const changed of [{ shift: false }, { control: false, alt: true, shift: false }, { alt: true }, { meta: true }, { type: 'keyUp' }]) assert.equal(Boolean(nativeCloseKey({ ...input, ...changed })), false);
});

test('desktop wires native close and the native keyboard before guest forwarding', async () => {
  const main = await readFile(new URL('../../../../desktop/electron/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /installNativeClose\(win\)/);
  assert.doesNotMatch(main, /execFileSync|spawnSync/);
  assert.match(main, /promisify\(execFile\)\(command, args, \{ timeout: 2000, killSignal: 'SIGKILL' \}\)/);
  assert.match(main, /execFile\('wl-copy'.*timeout: 2000/);
  assert.match(main, /'start', '--no-block'/);
  assert.ok(main.indexOf('if (nativeCloseKey(input))') < main.indexOf("const key = escape ? 'restoreFullWindow' : windowKey(input)"));
});

test('real Electron host close bypasses guest and host unload veto with backend unavailable', { timeout: 90000 }, async t => {
  // Like imperfect itself, a service started before login asks the user manager.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '' };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) Object.assign(env, await desktopSession());
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return t.skip('no desktop display in this process or the user manager');
  const platform = env.WAYLAND_DISPLAY ? 'wayland' : 'x11';
  // Chromium starts before the fixture's app.whenReady: isolate that startup
  // profile too, rather than contending for Electron's default singleton.
  const profile = await mkdtemp(join(tmpdir(), 'imperfect-native-close-'));
  const child = spawn(new URL('../../../../node_modules/.bin/electron', import.meta.url).pathname,
    [new URL('./fixtures/electron-close.mjs', import.meta.url).pathname, `--ozone-platform=${platform}`, `--user-data-dir=${profile}`],
    { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  // .bin/electron is a Node launcher with an Electron child. Kill our own
  // process group on failure, not just that launcher (and leak its renderers).
  const kill = () => {
    try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let output = '', timedOut = false;
  child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const timer = setTimeout(() => { timedOut = true; kill(); }, 60000);
  try {
    const { code, signal } = await exited;
    assert.equal(timedOut, false, `Electron startup/close deadline exceeded\n${output}`);
    assert.equal(code, 0, `signal=${signal}\n${output}`);
    assert.match(output, /native-close-ok/);
  } finally {
    clearTimeout(timer);
    if (child.pid && child.exitCode === null && !child.signalCode) { kill(); await exited; }
    await rm(profile, { recursive: true, force: true });
  }
});
