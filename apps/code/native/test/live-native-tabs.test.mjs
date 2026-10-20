import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askWindow, windowSockets } from '../browser.mjs';

const until = async ok => {
  for (const end = Date.now() + 10000; !await ok(); await new Promise(resolve => setTimeout(resolve, 20))) {
    if (Date.now() > end) throw new Error('Native live tabs did not settle');
  }
};

test('screenless portal new and background close use the real browser backend; fixed watches retain ownership', { timeout: 30000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'imperfect-live-tabs-'));
  const env = { ...process.env, HOME: home, IMPERFECT_PORT: '5197' };
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  const child = spawn(createRequire(import.meta.url)('electron'), ['--ozone-platform=headless', '--disable-gpu', '--ozone-override-screen-size=1280,800',
    fileURLToPath(new URL('../../../../desktop/electron/browser.mjs', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const closed = new Promise(resolve => child.once('exit', resolve));
  const viewers = [];
  t.after(async () => { viewers.forEach(viewer => viewer.socket.destroy()); child.kill(); await closed; await rm(home, { recursive: true, force: true }); });
  const sockets = () => windowSockets(5197, join(home, '.imperfect'));
  await until(async () => {
    if (child.exitCode != null) throw new Error(`Browser exited: ${errors}`);
    return (await sockets()).length;
  });
  const ask = said => askWindow(said, { sockets, open: () => assert.fail('already launched') });
  async function watch(tab) {
    const socket = connect((await sockets())[0]); socket.setEncoding('utf8');
    const heard = [];
    let pending = '';
    socket.on('data', chunk => {
      pending += chunk;
      while (pending.includes('\n')) {
        const at = pending.indexOf('\n'), said = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1);
        heard.push(said); if (said.frame && !socket.destroyed) socket.write('{"ack":true}\n');
      }
    });
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const say = said => socket.write(`${JSON.stringify(said)}\n`);
    say({ do: 'watch', ...(tab == null ? {} : { tab }), width: 320, height: 240 });
    await until(() => heard.some(said => said.tabs));
    const viewer = { socket, heard, say }; viewers.push(viewer); return viewer;
  }
  const portal = await watch();
  assert.deepEqual(portal.heard[0].tabs, [], 'watch alone does not create a tab');
  portal.say({ do: 'new' });
  await until(async () => { const { tabs } = await ask({ do: 'tabs' }); return tabs.length === 1 && tabs[0].url === 'about:blank'; });
  const first = (await ask({ do: 'tabs' })).tabs[0];
  assert.equal(first.url, 'about:blank'); assert.equal(first.front, true);
  portal.say({ do: 'new' });
  await until(async () => { const { tabs } = await ask({ do: 'tabs' }); return tabs.length === 2 && tabs.every(one => one.url === 'about:blank'); });
  const second = (await ask({ do: 'tabs' })).tabs.find(one => one.front);
  assert.notEqual(first.tab, second.tab); assert.equal(second.url, 'about:blank');
  const fixed = await watch(first.tab);
  for (const said of [{ do: 'new' }, { do: 'close', tab: second.tab }, { do: 'close', tab: first.tab }]) fixed.say(said);
  await until(() => fixed.heard.filter(said => said.error).length === 3);
  assert.ok(fixed.heard.filter(said => said.error).every(said => /cannot create or close/.test(said.error)));
  assert.equal((await ask({ do: 'tabs' })).tabs.length, 2);
  await ask({ do: 'run', tab: first.tab, code: 'document.title = "Agent background"' });
  await until(() => portal.heard.some(said => said.tabs?.some(one => one.tab === first.tab && one.driving && one.title === 'Agent background')));
  portal.say({ do: 'close', tab: first.tab });
  await until(async () => (await ask({ do: 'tabs' })).tabs.length === 1);
  await until(() => fixed.heard.some(said => said.expired && said.watching === first.tab));
  assert.equal((await ask({ do: 'tabs' })).tabs[0].tab, second.tab, 'background close leaves front unchanged');
  portal.say({ do: 'close', tab: second.tab });
  await until(async () => !(await ask({ do: 'tabs' })).tabs.length);
  portal.say({ do: 'new' });
  await until(async () => (await ask({ do: 'tabs' })).tabs.length === 1);
  assert.ok((await ask({ do: 'tabs' })).tabs[0].tab > second.tab);
  assert.deepEqual(portal.heard.filter(said => said.error), []);
});
