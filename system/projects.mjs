// Projects: long-running sub-projects, each a folder of its own in
// ~/projects/<name>/ with a page (the first is ~/projects/dacre, plain HTML
// games). Workbench shows ~/projects as a tile for each, with a preview of
// its page as it looked when it last ran (public/js/projects.js). The
// preview clicked, the project's server starts and its page opens as a tab
// in the browser; once no tab anywhere shows it, it stops.
//
// The server is a systemd user unit of its own, imperfect-project-<name>,
// so it outlives imperfect restarting: the project's package.json `dev`
// script if it has one, else its folder served as it is
// (project-page.mjs), on a loopback port chosen once and remembered. Its
// page is carried on the page listener (shown.mjs), so the person's other
// computers and the phone open it as they open any page an agent shows,
// over the tailnet and nowhere else.
//
// Every window says which projects its tabs show, and says it again every
// while it does; a project no window holds stops GRACE after the last let
// go of it. A window not heard from for STALE has gone, and holds nothing.
//
//   GET  /projects.json                    { root, projects: [{ name, running, picture }] }
//   GET  /projects/<name>/picture          its page as it last looked (PNG)
//   POST /projects/<name>/start            { url } once its page answers
//   POST /projects/hold { window, names }  what a window's tabs show
//
// The projects' ports and when their pictures were taken are kept in
// <state>/projects.json, the pictures in <state>/projects/.

import { execFile } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { askPrivately } from '../apps/code/native/browser.mjs';
import { ownUnits, unitCommands } from './units.mjs';

export const GRACE = 30_000;
export const STALE = 45_000;
const UNIT = 'imperfect-project-';
// A name that is a folder's, a unit's and an address's alike.
const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

function portOpen(port) {
  return new Promise(resolve => {
    const socket = connect({ port, host: '127.0.0.1' }, () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

// The person's own systemd, as its commands do it (a Mac's stand-in for it
// answers the same commands: units.mjs).
export function systemdUser({ run = ownUnits() ? unitCommands() : promisify(execFile) } = {}) {
  return {
    active: unit => run('systemctl', ['--user', 'is-active', '--quiet', unit]).then(() => true, () => false),
    start: (unit, { cwd, command, env }) => run('systemd-run', ['--user', `--unit=${unit}`, '--collect', '--quiet',
      `--working-directory=${cwd}`, ...Object.entries(env).map(([name, value]) => `--setenv=${name}=${value}`), '--', ...command]),
    stop: unit => run('systemctl', ['--user', 'stop', unit]).catch(() => {}),
    running: async () => (await run('systemctl', ['--user', 'list-units', '--plain', '--no-legend', '--state=active', `${UNIT}*`]).catch(() => ({ stdout: '' })))
      .stdout.split('\n').map(line => line.trim().split(/\s+/)[0]).filter(unit => unit.startsWith(UNIT)).map(unit => unit.slice(UNIT.length).replace(/\.service$/, '')),
  };
}

// A picture of a page, from the private browser no one sees
// (apps/code/native/browser.mjs), its tab closed again after.
export async function pictureOf(url, { ask = askPrivately, wait = 1500 } = {}) {
  const session = 'imperfect-projects';
  const { tab } = await ask({ do: 'open', url, session });
  try {
    await new Promise(resolve => setTimeout(resolve, wait));
    const { png } = await ask({ do: 'capture', most: 4_000_000, tab, session });
    return png ? Buffer.from(png, 'base64') : null;
  } finally { await ask({ do: 'close', tab, session }).catch(() => {}); }
}

// shown: system/shown.mjs, for a page's address on every screen.
export function createProjects({
  root = join(homedir(), 'projects'), stateDir, shown, systemd = systemdUser(), picture = pictureOf,
  now = Date.now, grace = GRACE, stale = STALE, waitMs = 20_000, every = 5000,
} = {}) {
  const file = join(stateDir, 'projects.json'), pictures = join(stateDir, 'projects');
  let kept = null;
  const load = async () => (kept ??= await readFile(file, 'utf8').then(JSON.parse).catch(() => ({})));
  let writing = Promise.resolve();
  const keep = () => (writing = writing.then(async () => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(`${file}.tmp`, JSON.stringify(kept));
    await rename(`${file}.tmp`, file);
  }).catch(error => console.error(`projects: ${error.message}`)));

  // The projects running, by name: { port, since }, since being when a
  // window last held it (or it started). And what each window holds.
  const running = new Map(), windows = new Map();
  // Those running before this imperfect started are its own all the same.
  const found = systemd.running().then(async names => {
    const known = await load();
    for (const name of names) if (NAME.test(name) && known[name]?.port) running.set(name, { port: known[name].port, since: now() });
  }).catch(() => {});

  async function list() {
    const known = await load();
    const names = (await readdir(root, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory() && NAME.test(entry.name)).map(entry => entry.name).sort();
    const launchable = await Promise.all(names.map(async name => await entryFor(join(root, name)) ? name : null));
    return { root, projects: launchable.filter(Boolean).map(name => ({ name, running: running.has(name), picture: known[name]?.picture ?? 0 })) };
  }

  // Only a real dev script or an index page can launch a project preview.
  async function entryFor(folder) {
    const dev = await readFile(join(folder, 'package.json'), 'utf8').then(text => JSON.parse(text).scripts?.dev).catch(() => null);
    if (typeof dev === 'string' && dev.trim()) return 'dev';
    return (await stat(join(folder, 'index.html')).catch(() => null))?.isFile() ? 'html' : null;
  }
  // What runs it: its dev script, else its index page served as it is.
  async function commandFor(folder, port) {
    if (await entryFor(folder) === 'dev') return ['/bin/sh', '-c', 'exec npm run dev -- --port "$PORT"'];
    return [process.execPath, join(import.meta.dirname, 'project-page.mjs'), folder, String(port)];
  }

  const starting = new Map();
  async function start(name) {
    if (!NAME.test(String(name))) throw new Error(`${name} is not a project`);
    const folder = join(root, name);
    if (!(await stat(folder).catch(() => null))?.isDirectory()) throw new Error(`there is no project ${name} in ${root}`);
    if (!await entryFor(folder)) throw new Error(`${name} has no index.html or dev script to launch`);
    await found;
    if (!starting.has(name)) starting.set(name, run(name, folder).finally(() => starting.delete(name)));
    const port = await starting.get(name);
    const { url } = await shown.page(`http://localhost:${port}/`, { probe: true });
    return { url, path: folder };
  }
  async function run(name, folder) {
    const known = await load(), unit = `${UNIT}${name}`;
    const was = running.get(name);
    if (was && await systemd.active(unit) && await portOpen(was.port)) { was.since = now(); return was.port; }
    // Its own port again, unless something else took it.
    let port = known[name]?.port;
    if (!port || (await portOpen(port) && !await systemd.active(unit))) port = await freePort();
    if (!await systemd.active(unit)) {
      await systemd.start(unit, { cwd: folder, command: await commandFor(folder, port), env: { PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    }
    known[name] = { ...known[name], port };
    void keep();
    running.set(name, { port, since: now() });
    for (const until = now() + waitMs; !await portOpen(port);) {
      if (now() > until || !await systemd.active(unit)) {
        running.delete(name);
        await systemd.stop(unit);
        throw new Error(`${name} did not start; ${ownUnits() ? `~/.imperfect/logs/${unit}.log` : `journalctl --user -u ${unit}`} says why`);
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    void pictureFor(name, port);
    return port;
  }

  // A fresh picture of its page, for the preview.
  const picturing = new Set();
  async function pictureFor(name, port) {
    if (picturing.has(name)) return;
    picturing.add(name);
    try {
      const png = await picture(`http://127.0.0.1:${port}/`);
      if (!png) return;
      await mkdir(pictures, { recursive: true, mode: 0o700 });
      await writeFile(join(pictures, `${name}.png`), png);
      const known = await load();
      known[name] = { ...known[name], picture: now() };
      await keep();
    } catch { /* the preview stays as it was */ } finally { picturing.delete(name); }
  }

  function hold(window, names) {
    window = String(window ?? '').slice(0, 64);
    if (!window) return;
    const was = windows.get(window)?.names ?? new Set();
    names = new Set([].concat(names ?? []).map(String).filter(name => NAME.test(name)));
    // Held, or just let go: the grace runs from now.
    for (const name of new Set([...was, ...names])) { const one = running.get(name); if (one) one.since = now(); }
    if (names.size) windows.set(window, { names, at: now() });
    else windows.delete(window);
    sweep();
  }
  // Each project nobody holds, a grace after it was last held, stops. A
  // window gone quiet held its projects until it last said so.
  function sweep() {
    const held = new Set();
    for (const [window, { names, at }] of windows) {
      for (const name of names) { const one = running.get(name); if (one) one.since = Math.max(one.since, at); }
      if (now() - at >= stale) windows.delete(window);
      else for (const name of names) held.add(name);
    }
    for (const [name, one] of running) {
      if (!held.has(name) && now() - one.since >= grace && !starting.has(name)) { running.delete(name); void systemd.stop(`${UNIT}${name}`); }
    }
  }
  const timer = every ? setInterval(sweep, every) : null;
  timer?.unref?.();

  const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  async function body(req) {
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 8192) break; }
    try { return JSON.parse(text || '{}'); } catch { return {}; }
  }

  return {
    list, start, hold, sweep,
    // Whether a port is a running project's, for the page listener to carry.
    carries: port => [...running.values()].some(one => one.port === port),
    atPort: port => [...running].find(([, one]) => one.port === port)?.[0] ?? null,
    close: () => clearInterval(timer),
    // A request of imperfect's own; false for anything else.
    async handle(req, res, path) {
      if (path === '/projects.json' && req.method === 'GET') { json(res, 200, await list()); return true; }
      if (path === '/projects/hold' && req.method === 'POST') { const { window, names } = await body(req); hold(window, names); json(res, 200, { ok: true }); return true; }
      const asked = /^\/projects\/([^/]+)\/(start|picture)$/.exec(path);
      if (!asked) return false;
      const name = decodeURIComponent(asked[1]);
      if (asked[2] === 'start' && req.method === 'POST') {
        try { json(res, 200, await start(name)); } catch (error) { json(res, 500, { error: error.message }); }
        return true;
      }
      if (asked[2] === 'picture' && req.method === 'GET' && NAME.test(name)) {
        const png = await readFile(join(pictures, `${name}.png`)).catch(() => null);
        if (!png) json(res, 404, { error: 'not pictured yet' });
        else { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(png); }
        return true;
      }
      return false;
    },
  };
}
