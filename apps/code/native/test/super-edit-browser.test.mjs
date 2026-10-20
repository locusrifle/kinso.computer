import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

// Run under the same CPU/memory/lock envelope as the other browser tests.
// Headless Ozone uses no real display/profile/clipboard owner.
test('real Electron: Super editing reaches production text and every native page type', { timeout: 90000, skip: process.platform !== 'linux' && 'native Super desktop fixture is Linux-only' }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'imperfect-super-edit-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron'), [
    '--ozone-platform=headless', '--ozone-override-screen-size=1280,900', '--disable-gpu', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    new URL('./fixtures/electron-edit.mjs', import.meta.url).pathname,
  ], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', expired = false;
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const timer = setTimeout(() => { expired = true; kill(); }, 70000);
  try {
    const { code, signal } = await exited;
    assert.equal(expired, false, output);
    assert.equal(code, 0, `signal=${signal}\n${output}`);
    assert.match(output, /super-edit-native-ok/);
  } finally {
    clearTimeout(timer);
    if (child.pid && child.exitCode === null && !child.signalCode) { kill(); await exited; }
    await rm(profile, { recursive: true, force: true });
  }
});
