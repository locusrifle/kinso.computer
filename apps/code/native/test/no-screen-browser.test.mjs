import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { askWindow, runBrowser, windowSockets } from '../browser.mjs';
import { createBrowserIdle } from '../../../../desktop/electron/browser-idle.mjs';
import { pagePoint } from '../public/js/live.js';

function jpegSize(frame) {
  const bytes = Buffer.from(frame, 'base64');
  for (let at = 2; at < bytes.length;) {
    assert.equal(bytes[at++], 0xff);
    const marker = bytes[at++], length = bytes.readUInt16BE(at);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return { width: bytes.readUInt16BE(at + 5), height: bytes.readUInt16BE(at + 3) };
    at += length;
  }
  throw new Error('No JPEG size');
}

const pause = ms => new Promise(r => setTimeout(r, ms));
test('five-minute idle lifecycle holds for watchers and in-flight tool calls', () => {
  let tick, clock = 0, watches = 0, stopped = 0;
  const idle = createBrowserIdle({ watching: () => watches, stop: () => stopped++, now: () => clock,
    every: fn => { tick = fn; return {}; }, clear: () => {} });
  clock = 299_999; tick(); assert.equal(stopped, 0);
  const done = idle.begin(); clock += 600_000; tick(); assert.equal(stopped, 0);
  done(); watches++; clock += 600_000; tick(); assert.equal(stopped, 0);
  watches--; idle.touch(); clock += 299_999; tick(); assert.equal(stopped, 0);
  clock++; tick(); assert.equal(stopped, 1); idle.stop();
});

test('no-screen person browser shares tabs, screenshots and live real input, but not private state', async t => {
  const home = await mkdtemp(join(tmpdir(), 'imperfect-person-browser-'));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/cookie') res.setHeader('set-cookie', 'person=yes; Path=/');
    res.end('<title>Person</title><body style="background:#fc9"><button style="width:150px;height:70px" onclick="document.title=\'clicked\'">Click</button><button id="target" style="position:fixed;right:20px;bottom:20px;width:100px;height:60px" onclick="document.title=\'portrait clicked\'">Portrait</button></body>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let child;
  const sockets = () => windowSockets(5198, join(home, '.imperfect'));
  const launch = async () => {
    const env = { ...process.env, HOME: home, IMPERFECT_PORT: '5198' };
    for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    child = spawn(createRequire(import.meta.url)('electron'), ['--ozone-platform=headless', '--disable-gpu', '--ozone-override-screen-size=1280,800',
      fileURLToPath(new URL('../../../../desktop/electron/browser.mjs', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.on('data', data => { errors += data; });
    for (let n = 0; !(await sockets()).length; n++) { if (n > 200 || child.exitCode != null) throw new Error(`helper failed: ${errors}`); await pause(50); }
  };
  t.after(async () => { child?.kill(); await pause(500); await rm(home, { recursive: true, force: true }); server.close(); });
  const ask = request => askWindow(request, { sockets, open: launch });
  const url = `http://127.0.0.1:${server.address().port}`;
  await runBrowser({ action: 'open', url: `${url}/cookie`, session: 'agent' }, { ask });
  const { tabs } = await ask({ do: 'tabs', session: 'other' });
  const id = tabs[0].tab;
  assert.ok(id > 0); assert.equal(tabs[0].front, true);
  const picture = await runBrowser({ action: 'look', screenshot: true, session: 'agent' }, { ask });
  assert.ok(picture[1].data.length > 1000);
  const socket = connect((await sockets())[0]);
  socket.setEncoding('utf8');
  let buffer = '', frames = 0, latest;
  const errors = [];
  socket.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const cut = buffer.indexOf('\n'), said = JSON.parse(buffer.slice(0, cut)); buffer = buffer.slice(cut + 1);
      if (said.error) errors.push(said.error);
      if (said.frame) { frames++; latest = said; socket.write('{"ack":true}\n'); }
    }
  });
  await new Promise(r => socket.once('connect', r));
  socket.write('{"do":"watch","width":800,"height":600}\n');
  for (let n = 0; !frames && n < 100; n++) await pause(50);
  assert.ok(frames > 0, 'JPEG live frames');
  socket.write(JSON.stringify({ do: 'tap', tab: id, x: 50, y: 40 }) + '\n');
  for (let n = 0; n < 50 && (await ask({ do: 'run', tab: id, code: 'document.title' })).value !== 'clicked'; n++) await pause(50);
  assert.equal((await ask({ do: 'run', tab: id, code: 'document.title' })).value, 'clicked');
  const resized = async (width, height, scale = 2) => {
    socket.write(JSON.stringify({ size: { width, height, scale } }) + '\n');
    for (let n = 0; n < 100 && (latest.width !== width * scale || latest.height !== height * scale || jpegSize(latest.frame).width !== width * scale || jpegSize(latest.frame).height !== height * scale); n++) await pause(50);
    assert.deepEqual({ width: latest.width, height: latest.height }, { width: width * scale, height: height * scale }, 'frames follow CSS panel shape');
    assert.deepEqual(jpegSize(latest.frame), { width: width * scale, height: height * scale }, 'crisp device-scaled frames without letterboxing');
    assert.deepEqual(latest.size, { width, height, scale }, 'only a fitted stream advertises coordinate remapping');
    assert.deepEqual((await ask({ do: 'run', tab: id, code: '[innerWidth, innerHeight, devicePixelRatio]' })).value, [width, height, scale]);
  };
  await resized(390, 844);
  const at = pagePoint({ x: 320, y: 800 }, { left: 0, top: 0, width: 390, height: 844 }, latest);
  assert.deepEqual(at, { x: 640, y: 1600 });
  socket.write(JSON.stringify({ do: 'tap', tab: id, ...at, page: { width: latest.width, height: latest.height } }) + '\n');
  for (let n = 0; n < 50 && (await ask({ do: 'run', tab: id, code: 'document.title' })).value !== 'portrait clicked'; n++) await pause(50);
  assert.equal((await ask({ do: 'run', tab: id, code: 'document.title' })).value, 'portrait clicked', 'tap hits the responsive element after fitting');
  await ask({ do: 'run', tab: id, code: 'document.body.style.height = "3000px"' });
  socket.write(JSON.stringify({ do: 'scroll', tab: id, x: 640, y: 800, dy: 200, page: { width: latest.width, height: latest.height } }) + '\n');
  for (let n = 0; n < 50 && !(await ask({ do: 'run', tab: id, code: 'scrollY' })).value; n++) await pause(50);
  assert.equal((await ask({ do: 'run', tab: id, code: 'scrollY' })).value, 100, 'wheel distance is CSS pixels, not doubled by density');
  await resized(844, 390);
  // Navigating to a different origin must not reset Electron's page zoom.
  await ask({ do: 'open', tab: id, url: `http://localhost:${server.address().port}/next`, session: 'agent' });
  assert.deepEqual((await ask({ do: 'run', tab: id, code: '[innerWidth, innerHeight, devicePixelRatio]' })).value, [844, 390, 2]);
  socket.end();
  await pause(200);
  assert.deepEqual((await ask({ do: 'run', tab: id, code: '[innerWidth, innerHeight, devicePixelRatio]' })).value, [844, 390, 2], 'unwatched pages retain their last size');
  assert.deepEqual(errors, []);
  // A fixed watcher behind the portal front fits and wakes its own page.
  // Its density must not leak into another tab's navigation zoom invariant.
  const secondTab = await ask({ do: 'open', url, session: 'second-agent' });
  const fixed = connect((await sockets())[0]);
  t.after(() => fixed.destroy());
  fixed.setEncoding('utf8');
  let pending = '';
  const fixedFrames = [], fixedErrors = [];
  fixed.on('data', chunk => {
    pending += chunk;
    while (pending.includes('\n')) {
      const cut = pending.indexOf('\n'), said = JSON.parse(pending.slice(0, cut)); pending = pending.slice(cut + 1);
      if (said.error) fixedErrors.push(said);
      if (said.frame) { fixedFrames.push(said); fixed.write('{"ack":true}\n'); }
    }
  });
  await new Promise(resolve => fixed.once('connect', resolve));
  fixed.write(JSON.stringify({ do: 'watch', tab: secondTab.tab, size: { width: 640, height: 480, scale: 1 } }) + '\n');
  for (let n = 0; !fixedFrames.length && n < 100; n++) await pause(50);
  assert.ok(fixedFrames.length, 'a non-front watched page draws in screenless Electron');
  assert.ok(fixedFrames.every(frame => frame.tab === secondTab.tab));
  assert.deepEqual((await ask({ do: 'run', tab: secondTab.tab, code: '[innerWidth, innerHeight, devicePixelRatio]' })).value, [640, 480, 1]);
  assert.equal((await ask({ do: 'tabs' })).tabs.find(tab => tab.front).tab, id, 'watch did not select front');
  await ask({ do: 'open', tab: id, url: `${url}/after-other-fit`, session: 'agent' });
  assert.deepEqual((await ask({ do: 'run', tab: id, code: '[innerWidth, innerHeight, devicePixelRatio]' })).value, [844, 390, 2], 'another page fit cannot change navigation density');
  await ask({ do: 'close', tab: secondTab.tab });
  for (let n = 0; !fixedErrors.length && n < 100; n++) await pause(50);
  assert.equal(fixedErrors.at(-1)?.expired, true, 'closed fixed tab is terminal');
  const count = fixedFrames.length;
  await pause(150);
  assert.equal(fixedFrames.length, count, 'no front fallback after closing target');
  fixed.end();
  child.kill(); await new Promise(r => child.once('exit', r));
  await launch();
  const second = await ask({ do: 'open', url, session: 'agent' });
  assert.ok(second.tab > id, 'expired ids never hit new tabs');
  assert.equal((await ask({ do: 'run', tab: second.tab, code: 'document.cookie' })).value, 'person=yes', 'person logins persist across idle exits');
  await assert.rejects(ask({ do: 'run', tab: id, code: '1' }), /closed/);
});
