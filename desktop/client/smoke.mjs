// Linux CI launch, in a fresh headless Wayland compositor, never the person's.
// Requires sway and dbus-run-session. No sudo, installed service or profile.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

if (process.platform !== 'linux') throw new Error('This CI launcher requires Linux/sway');
const root = resolve(import.meta.dirname, '../..');
const scratch = await mkdtemp(join(tmpdir(), 'imperfect-desktop-smoke-'));
const output = process.argv[2] ? resolve(process.argv[2]) : join(scratch, 'result.json');
const runtime = join(scratch, 'runtime');
const { mkdir } = await import('node:fs/promises');
await mkdir(runtime, { mode: 0o700 });
const config = join(scratch, 'sway.conf');
await writeFile(config, 'xwayland disable\noutput * resolution 1400x900\nseat seat0 fallback true\ndefault_border none\n');
const env = { ...process.env, XDG_RUNTIME_DIR: runtime, WLR_BACKENDS: 'headless', WLR_LIBINPUT_NO_DEVICES: '1', WLR_RENDERER: 'pixman' };
delete env.DISPLAY; delete env.WAYLAND_DISPLAY; delete env.SWAYSOCK;
let compositor, electron, logs = '';
const done = child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode) resolve(child.exitCode); else child.once('exit', resolve); });
async function stop(child, group = false) {
  if (!child) return;
  if (group && child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  await Promise.race([done(child), new Promise(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000).unref())]);
}
try {
  compositor = spawn('dbus-run-session', ['--', 'sway', '--unsupported-gpu', '-c', config], { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  compositor.stderr.on('data', bytes => { logs += bytes; });
  compositor.on('error', error => { logs += error.message; });
  let display;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    display = (await readdir(runtime)).find(name => /^wayland-\d+$/.test(name));
    if (display) break;
    if (compositor.exitCode !== null) throw new Error('Headless compositor exited');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(display, 'Headless compositor did not start');
  const binary = process.env.IMPERFECT_DESKTOP_SMOKE_BINARY || join(root, 'node_modules', '.bin', 'electron');
  const args = process.env.IMPERFECT_DESKTOP_SMOKE_BINARY ? [] : ['desktop/client'];
  args.push('--ozone-platform=wayland', '--disable-gpu', '--smoke-test', '--smoke-output', output, `--user-data-dir=${join(scratch, 'profile')}`);
  if (process.env.IMPERFECT_DESKTOP_SMOKE_NO_SANDBOX === '1') args.push('--no-sandbox'); // CI-only escape hatch, NEVER packaging default.
  electron = spawn(binary, args, { cwd: root, env: { ...env, WAYLAND_DISPLAY: display }, stdio: ['ignore', 'ignore', 'pipe'] });
  electron.stderr.on('data', bytes => { logs += bytes; });
  electron.on('error', error => { logs += error.message; });
  const result = await Promise.race([done(electron), new Promise((_, reject) => setTimeout(() => reject(new Error('Native app smoke timed out')), 120_000).unref())]);
  assert.equal(result, 0, 'Native app exited unsuccessfully');
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(report.ok, true);
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(logs.slice(-12_000)); throw error; }
finally { await stop(electron); await stop(compositor, true); await rm(scratch, { recursive: true, force: true }); }
