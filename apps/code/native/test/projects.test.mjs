// Projects (system/projects.mjs): a project's server started as a unit of
// its own, its page answering on the port it keeps, pictured for its
// preview; held while a tab shows it, stopped a grace after the last lets
// go. systemd here is a stand-in that runs the command as a child, so the
// static server is the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GRACE, STALE, createProjects } from '../../../../system/projects.mjs';

function fakeSystemd() {
  const units = new Map(), started = [], stopped = [];
  return {
    units, started, stopped,
    async active(unit) { const child = units.get(unit); return Boolean(child) && child.exitCode === null && child.signalCode === null; },
    async start(unit, { cwd, command, env }) {
      started.push({ unit, cwd, command, env });
      // A dev script is npm's to run; here a page on its port stands in for it.
      const run = command[0] === '/bin/sh' ? [process.execPath, '-e', 'require("http").createServer((q, s) => s.end("dev " + process.env.PORT)).listen(process.env.PORT, "127.0.0.1")'] : command;
      const child = spawn(run[0], run.slice(1), { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
      units.set(unit, child);
    },
    async stop(unit) { stopped.push(unit); const child = units.get(unit); units.delete(unit); if (child?.exitCode === null) { const gone = new Promise(r => child.once('exit', r)); child.kill(); await gone; } },
    async running() { return [...units.keys()].map(unit => unit.replace('imperfect-project-', '')); },
    stopAll() { for (const unit of [...units.keys()]) this.stop(unit); },
  };
}

async function setup(t, { systemd = fakeSystemd(), stateDir } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'imperfect-projects-'));
  const root = join(home, 'projects');
  await mkdir(join(root, 'dacre'), { recursive: true });
  await writeFile(join(root, 'dacre', 'index.html'), '<title>Dacre</title><h1>games</h1>');
  await mkdir(join(root, 'dacre', 'snake'));
  await writeFile(join(root, 'dacre', 'snake', 'index.html'), 'snake');
  await mkdir(join(root, 'app'));
  await writeFile(join(root, 'app', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  await mkdir(join(root, '.hidden'));
  await writeFile(join(root, 'notes.txt'), 'not a project');
  let clock = 1_000_000;
  const pictured = [];
  const shown = { page: async url => ({ url: `https://desk.tail.ts.net:8443/port/${new URL(url).port}/` }) };
  const projects = createProjects({
    root, stateDir: stateDir ?? join(home, 'state'), shown, systemd, now: () => clock, every: 0,
    picture: async url => { pictured.push(url); return Buffer.from('png'); },
  });
  t.after(async () => { projects.close(); systemd.stopAll(); await new Promise(r => setTimeout(r, 100)); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { home, root, projects, systemd, pictured, tick: ms => { clock += ms; projects.sweep(); }, stateDir: stateDir ?? join(home, 'state') };
}
const until = async check => { for (let i = 0; i < 100 && !await check(); i++) await new Promise(r => setTimeout(r, 50)); };

test('a project starts as a unit of its own, its folder served on a port it keeps, its page carried and pictured', async t => {
  const { projects, systemd, pictured, stateDir, root } = await setup(t);
  assert.deepEqual((await projects.list()).projects, [{ name: 'app', running: false, picture: 0 }, { name: 'dacre', running: false, picture: 0 }], 'folders only, no hidden ones');

  const { url } = await projects.start('dacre');
  const port = Number(url.match(/\/port\/(\d+)\//)[1]);
  assert.equal(systemd.started.length, 1);
  const [{ unit, cwd, command, env }] = systemd.started;
  assert.equal(unit, 'imperfect-project-dacre');
  assert.equal(cwd, join(root, 'dacre'));
  assert.match(command.at(-3), /system\/project-page\.mjs$/, 'no dev script: the folder as it is');
  assert.equal(env.PORT, String(port));
  // The real static server: index.html at the folder, and in folders under it.
  assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /games/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/snake/`)).text(), 'snake');
  assert.equal((await fetch(`http://127.0.0.1:${port}/../../etc/passwd`)).status, 404);
  assert.equal(projects.carries(port), true, 'the page listener carries it');

  // Pictured for its preview, and the picture kept with the port.
  await until(async () => (await projects.list()).projects[1].picture);
  assert.deepEqual(pictured, [`http://127.0.0.1:${port}/`]);
  assert.equal(await readFile(join(stateDir, 'projects', 'dacre.png'), 'utf8'), 'png');
  assert.equal(JSON.parse(await readFile(join(stateDir, 'projects.json'), 'utf8')).dacre.port, port);
  assert.deepEqual((await projects.list()).projects[1], { name: 'dacre', running: true, picture: 1_000_000 });

  // Started again: the same server, not a second.
  assert.equal((await projects.start('dacre')).url, url);
  assert.equal(systemd.started.length, 1);
  await assert.rejects(projects.start('../etc'), /not a project/);
  await assert.rejects(projects.start('missing'), /no project missing/);
});

test('a project with a dev script runs it on its port', async t => {
  const { projects, systemd } = await setup(t);
  const { url } = await projects.start('app');
  const port = new URL(url).pathname.split('/')[2];
  assert.deepEqual(systemd.started[0].command, ['/bin/sh', '-c', 'exec npm run dev -- --port "$PORT"']);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), `dev ${port}`);
});

test('a project stops a grace after the last tab showing it closes, not while another window still shows it, nor while a window is still heard from', async t => {
  const { projects, systemd, tick } = await setup(t);
  const { url } = await projects.start('dacre');
  const port = Number(url.match(/\/port\/(\d+)\//)[1]);
  const running = () => (systemd.units.has('imperfect-project-dacre') && projects.carries(port));
  // Started and not yet held (the tab is on its way): the grace runs.
  tick(GRACE - 1000);
  assert.ok(running(), 'within the grace of starting');
  projects.hold('desk', ['dacre']);
  // Held by a window that keeps saying so, it runs on.
  for (let i = 0; i < 6; i++) { tick(15_000); projects.hold('desk', ['dacre']); }
  assert.ok(running());
  // Another window shows it too; the first lets go: it runs on.
  projects.hold('phone', ['dacre']);
  projects.hold('desk', []);
  tick(GRACE + 1000);
  assert.ok(running(), 'the phone still shows it');
  // The last lets go: a grace, then it stops.
  projects.hold('phone', []);
  tick(GRACE - 1000);
  assert.ok(running(), 'within the grace');
  tick(2000);
  await until(() => !systemd.units.size);
  assert.deepEqual(systemd.stopped, ['imperfect-project-dacre']);
  assert.equal(projects.carries(port), false);
  assert.equal((await projects.list()).projects[1].running, false);

  // A window that goes without a word (closed, crashed) holds nothing once
  // it has not been heard from for a while.
  await projects.start('dacre');
  projects.hold('gone', ['dacre']);
  tick(STALE - 1000);
  assert.ok(systemd.units.size, 'still heard from, recently');
  tick(2000);
  await until(() => !systemd.units.size);
  assert.equal(systemd.stopped.length, 2);
});

test('a project running when imperfect starts is its own, on the port it kept, and stops once nobody comes back for it', async t => {
  const systemd = fakeSystemd();
  const first = await setup(t, { systemd });
  const { url } = await first.projects.start('dacre');
  first.projects.close();
  // imperfect restarts; the unit runs on.
  const again = await setup(t, { systemd, stateDir: first.stateDir });
  assert.equal(systemd.units.size, 1);
  await until(async () => (await again.projects.list()).projects.find(p => p.name === 'dacre').running);
  assert.equal(new URL((await again.projects.start('dacre').catch(() => ({ url }))).url).pathname, new URL(url).pathname, 'the same port');
  again.tick(GRACE + 1000);
  await until(() => !systemd.units.size);
  assert.deepEqual(systemd.stopped, ['imperfect-project-dacre']);
});

test('the routes: the list, a start, a hold, and a picture', async t => {
  const { projects } = await setup(t);
  const server = createServer(async (req, res) => { if (!await projects.handle(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(404).end(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const at = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await (await fetch(`${at}/projects.json`)).json()).projects.map(p => p.name), ['app', 'dacre']);
  assert.equal((await fetch(`${at}/projects/dacre/picture`)).status, 404, 'not pictured yet');
  const started = await (await fetch(`${at}/projects/dacre/start`, { method: 'POST' })).json();
  assert.match(started.url, /^https:\/\/desk\.tail\.ts\.net:8443\/port\/\d+\/$/);
  assert.equal((await fetch(`${at}/projects/hold`, { method: 'POST', body: JSON.stringify({ window: 'w', names: ['dacre', '../x'] }) })).status, 200);
  await until(async () => (await fetch(`${at}/projects/dacre/picture`)).ok);
  const picture = await fetch(`${at}/projects/dacre/picture`);
  assert.equal(picture.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${at}/projects/nope/start`, { method: 'POST' })).status, 500);
});
