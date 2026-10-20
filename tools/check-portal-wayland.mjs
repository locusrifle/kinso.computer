// Isolated, mapped native Wayland host. Only local synthetic pages; no installed
// window, session, profile or browser is used. Requires a Wayland compositor.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { chromium } from 'playwright';
import { createGueyServer } from '../system/server.mjs';
import { createTabHost } from '../apps/code/native/tabs.mjs';
import { askWindow, provideWindowPort, windowSockets } from '../apps/code/native/browser.mjs';
assert.ok(process.env.WAYLAND_DISPLAY, 'requires native Wayland');
const root = await mkdtemp(join(tmpdir(), 'imperfect-portal-wayland-'));
const site = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>Portal fixture</title><body style="background:#123456">Local fixture</body>'); });
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const snap = { sessionId: 'fixture', sessionFile: 'fixture', cwd: root, messages: [], busy: false, streaming: false, failed: null };
const runtime = await createTabHost({ cwd: root, stateDir: join(root, 'tabs'), createRuntime: () => ({ events: new EventEmitter(), snapshot: () => snap, command: async () => ({ ok: true }), close: async () => {} }), listPiSessions: async () => [], listClaudeSessions: async () => [] });
const machine = await createGueyServer({ host: '127.0.0.1', port: 0, stateDir: join(root, 'server'), runtime, machines: { self: async () => 'fixture', selfId: async () => 'fixture', origins: async () => [], list: async () => [], peer: async () => null } });
const port = (await machine.listen()).port;
provideWindowPort(port);
let electron, cdp, phone, stderr = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, what) => { for (const end = Date.now() + 15000; Date.now() < end;) { const got = await fn(); if (got) return got; await pause(50); } throw new Error(`Timed out: ${what}`); };
try {
  electron = spawn(join(import.meta.dirname, '../node_modules/.bin/electron'), ['desktop/electron/main.mjs', '--ozone-platform=wayland', '--remote-debugging-port=0', `--user-data-dir=${join(root, 'profile')}`], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, IMPERFECT_PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  electron.stderr.on('data', data => { stderr += data; });
  const endpoint = await until(() => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1], 'debug endpoint');
  cdp = await chromium.connectOverCDP(endpoint);
  const shell = await until(() => cdp.contexts()[0].pages().find(page => page.url().startsWith(`http://127.0.0.1:${port}/`)), 'host page');
  await shell.waitForFunction(() => !!document.querySelector('.entry-browser'));
  await until(async () => (await windowSockets()).length, 'native socket');
  const { tab } = await askWindow({ do: 'open', session: 'fixture', url: `http://127.0.0.1:${site.address().port}/` }, { open: async () => {} });
  const rect = () => shell.evaluate(() => { const r = document.querySelector('.wm-browser').getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth, scroll: document.querySelector('.canvas-strip').scrollLeft }; });
  await pause(600); // let the new column's opening animation finish
  const before = await rect();
  await askWindow({ do: 'front', session: 'fixture', tab });
  await pause(400);
  assert.deepEqual(await rect(), before, 'agent front must leave viewport alone');
  console.log('agent-front rectangle', before);
  phone = new WebSocket(`ws://127.0.0.1:${port}/browser/live`);
  const heard = [];
  phone.on('message', data => { const said = JSON.parse(data); heard.push(said); if (said.frame) phone.send('{"ack":true}'); });
  await new Promise((resolve, reject) => { phone.once('open', resolve); phone.once('error', reject); });
  phone.send(JSON.stringify({ do: 'watch', width: 960, height: 540 }));
  await until(() => heard.some(said => said.tabs), 'tab list');
  await pause(1500);
  console.log('passive-watch', await rect(), 'frames', heard.filter(said => said.frame).length);
  phone.send('{"do":"launch"}');
  await pause(1800);
  console.log('explicit-launch', await rect(), 'frames', heard.filter(said => said.frame).length);
  const shown = await rect();
  assert.ok(shown.left >= -2 && shown.left < shown.width && shown.right > 0, 'explicit remote launch reveals the browser');
  const frame = await until(() => heard.find(said => said.frame && said.tab === tab), 'native guest frame');
  assert.match(frame.frame, /^\/9j\//);
  assert.ok(frame.width > 0 && frame.height > 0);
  const capture = await askWindow({ do: 'capture', session: 'fixture', tab }, { open: async () => {} });
  assert.match(capture.jpeg, /^\/9j\//, 'guest capture succeeds after reveal');
  console.log('ok: native Wayland remote launch reveals and paints; agent front stays quiet');
} catch (error) { console.error(stderr.split('\n').slice(-15).join('\n')); throw error; }
finally {
  phone?.terminate(); await cdp?.close();
  if (electron && electron.exitCode === null && electron.signalCode === null) { const ended = new Promise(resolve => electron.once('exit', resolve)); electron.kill(); await ended; }
  await machine.close(); site.close(); await rm(root, { recursive: true, force: true });
}
