// `browser` lets an agent use the browser beside the conversation in the
// person's window, the one they browse in (public/js/pages.js): open a tab,
// look at it, click, type, press keys, scroll, go back and forward, run a
// line of script, in a tab in front of them or behind it. Each tab has an
// id; a conversation uses the tab it last opened or used unless it names
// another, and brings one to the front only when it means the person to look.
// Every harness gets it from tools.mjs.
//
// It follows the person: the window is the one they used last, on whichever
// of their computers (createBrowser, below). A phone has no browser of its
// own: there, the window is the one on the computer the session is on, which
// the phone shows live (relayLive, below; desktop/electron/live.mjs).
//
// A computer's window answers on a socket only this person can open,
// ~/.imperfect/browser-<port>-<pid>.sock (desktop/electron/main.mjs), and does
// what it is asked with real input: the mouse at an element's centre, typed
// text, keys. Sites take that as a person's, where they refuse script.
// Everything the tool knows about a page it learns from the scripts below,
// run in the page in a world of their own, so the page cannot see them.
//
// With headless: true it uses a private browser of its own instead, which no
// one sees and which holds nothing of the person's (privately, below).
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { addressOf } from './public/js/pages.js';
import { PICTURE_BYTES } from './code-control.mjs';
import { pictureForModel } from './request-images.mjs';

const ACTIONS = ['open', 'tabs', 'front', 'close', 'look', 'click', 'type', 'key', 'scroll', 'back', 'forward', 'eval'];
const TEXT_CHARS = 4000;
const MOST_THINGS = 150;

export const BROWSER_TOOL = {
  name: 'browser',
  description: "The person's own browser beside the conversation, on the computer they used last and signed in where they are; when they are on their phone it is this computer's window, which their phone shows live, never the private browser. Use it to work in a website: their logins, clicking, typing, a page you made. To only read a public page or search, a plain fetch or web search is cheaper when you have one. Never open another browser (xdg-open, chromium, firefox). open makes a tab behind the one they are looking at and answers its id; every other action uses the tab you last used, or tab. look gives the page's text and numbered refs to click or type into; refs only hold for that page, so look again after it changes. front shows them a tab: when they ask you to open something, open it and bring it to the front. Tabs you open close when this session ends. Ask before sending, buying, posting or deleting anything. headless: true uses a private browser nobody sees, signed in nowhere, for your own research; its tabs have negative numbers and need headless: true too, and front does not work there.",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'what to do' },
      url: { type: 'string', description: 'open: the address, words to search for, or the absolute path of a page you made' },
      computer: { type: 'string', description: 'rarely needed: the id or name of a computer to use instead of the one they used last; must match the tab' },
      tab: { type: 'number', description: 'the tab to use, as open and tabs give it (default: the one you last opened or used)' },
      ref: { type: 'number', description: 'click, type: the number look gave the thing' },
      text: { type: 'string', description: 'type: what to type; it replaces what is in the field, and with no ref goes where the focus is' },
      submit: { type: 'boolean', description: 'type: press Enter after' },
      key: { type: 'string', description: 'key: the key, with any modifiers (Enter, Escape, Tab, ArrowDown, PageDown, Control+a)' },
      dy: { type: 'number', description: 'scroll: pixels down, negative for up (default most of a screen)' },
      js: { type: 'string', description: 'eval: the expression' },
      screenshot: { type: 'boolean', description: 'also return a picture of the page as it is afterwards' },
      headless: { type: 'boolean', description: 'use the private browser (default false)' },
    },
    required: ['action'],
  },
};

// The windows onto this machine's port are the ones its agents browse in,
// so a second imperfect (a playground, a test) never drives the person's.
const PORT = Symbol.for('imperfect.window-port');
export function provideWindowPort(port) { globalThis[PORT] = port; }
const windowPort = () => globalThis[PORT] ?? (Number(process.env.IMPERFECT_PORT) || 5067);

// Each desktop window listens at ~/.imperfect/browser-<port>-<pid>.sock
// (desktop/electron/main.mjs) and touches it when it is turned to, so the
// newest is the window the person is using.
export async function windowSockets(port = windowPort(), dir = join(homedir(), '.imperfect')) {
  const names = (await readdir(dir).catch(() => [])).filter(name => name.startsWith(`browser-${port}-`) && name.endsWith('.sock'));
  const found = await Promise.all(names.map(async name => ({ path: join(dir, name), at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs })));
  return found.filter(one => one.at != null).sort((a, b) => b.at - a.at).map(one => one.path);
}

export const NO_WINDOW = "imperfect's window on this computer did not answer; try again.";
export const NO_SCREEN = "This computer has no screen to open imperfect's browser on.";

// With no window open here, the tool opens one, as the person's imperfect key
// does (desktop/product/imperfect-open), and waits for it to answer. Only a
// computer with a screen uses the canvas; without one it starts only the
// person's headless browser, with the same socket and live protocol.
// Opened from imperfect running as a systemd service, the window gets a scope
// of its own, as one opened by the person's key has: otherwise a restart of
// the service would take the window, and the person's tabs, with it.
//
// The service can start at boot, before the desktop session has told systemd
// its display, and then its own environment has no screen for good. So with
// none of its own it asks the user manager, which has the session's display
// once someone is logged in (a virtual screen counts).
export function desktopSession({ exec = execFile } = {}) {
  return new Promise(resolve => exec('systemctl', ['--user', 'show-environment'], { timeout: 3000 }, (error, stdout) => {
    const found = {};
    if (!error) for (const line of String(stdout).split('\n')) {
      const match = /^(WAYLAND_DISPLAY|DISPLAY|HYPRLAND_INSTANCE_SIGNATURE|XDG_CURRENT_DESKTOP|XDG_SESSION_TYPE)=(.+)$/.exec(line);
      if (match) found[match[1]] = match[2];
    }
    resolve(found);
  }));
}
// A Mac always has its screen: imperfect.app is opened (by its bundle id,
// wherever it was put), behind whatever the person is looking at; without
// it installed, the checkout's own Electron opens the same window.
export function macLaunch({ installed = MAC_APP } = {}) {
  if (installed) return ['/usr/bin/open', ['-g', '-b', 'computer.imperfect.code']];
  return [createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('../../../desktop/electron', import.meta.url)), '--face', 'code']];
}
const MAC_APP = process.platform === 'darwin' && ['/Applications/imperfect.app', join(homedir(), 'Applications/imperfect.app')].some(path => existsSync(path));
let launching = null;
export function openWindow({ sockets = windowSockets, env = process.env, session = desktopSession, launcher = join(homedir(), '.local/bin/imperfect-open'), run = spawn, wait = 60_000, platform = process.platform } = {}) {
  return launching ??= (async () => {
    if (platform === 'darwin') {
      const [command, args] = macLaunch();
      const child = run(command, args, { stdio: 'ignore', detached: true, env: { ...env, IMPERFECT_PORT: String(windowPort()) } });
      let failed = null;
      child.on('error', error => { failed = error.message; });
      child.unref();
      for (const until = Date.now() + wait; Date.now() < until; await new Promise(resolve => setTimeout(resolve, 200))) {
        if ((await sockets()).length) return;
        if (failed) throw new Error(`imperfect's window could not be opened here: ${failed}`);
      }
      throw new Error("imperfect's window did not open in time");
    }
    if (!env.WAYLAND_DISPLAY && !env.DISPLAY) env = { ...env, ...(await session()) };
    const screen = Boolean(env.WAYLAND_DISPLAY || env.DISPLAY);
    const launch = screen ? [launcher, 'code'] : [createRequire(import.meta.url)('electron'),
      '--ozone-platform=headless', '--ozone-override-screen-size=1280,800', '--disable-gpu', '--no-first-run',
      fileURLToPath(new URL('../../../desktop/electron/browser.mjs', import.meta.url))];
    if (!screen) {
      env = { ...env };
      for (const name of ['WAYLAND_DISPLAY', 'DISPLAY', 'ELECTRON_RUN_AS_NODE']) delete env[name];
    }
    let failed = null;
    const [command, args] = env.INVOCATION_ID ? ['systemd-run', ['--user', '--scope', '--quiet', '--collect', ...launch]] : [launch[0], launch.slice(1)];
    const child = run(command, args, { stdio: 'ignore', detached: true, env: { ...env, IMPERFECT_PORT: String(windowPort()) } });
    child.on('error', error => { failed = error.message; });
    child.on('exit', code => { failed ??= `it closed (${code})`; });
    child.unref();
    for (const until = Date.now() + wait; Date.now() < until; await new Promise(resolve => setTimeout(resolve, 200))) {
      if ((await sockets()).length) return;
      if (failed) throw new Error(`imperfect's window could not be opened here: ${failed}`);
    }
    throw new Error("imperfect's window did not open in time");
  })().finally(() => { launching = null; });
}

// One request to a window, one answer: the request is written and the
// writing side closed; the window answers and closes. A socket nobody
// answers is a window that crashed; it is cleared away and the next tried.
// With none left, a window is opened and asked.
export async function askWindow(request, { sockets = windowSockets, open = openWindow, signal, timeout = 45_000 } = {}) {
  for (let opened = false; ; opened = true) {
    for (const path of await sockets()) {
      try { return await askOne(path, request, { signal, timeout }); }
      catch (error) {
        if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') throw error;
        await rm(path, { force: true });
      }
    }
    if (opened) throw new Error(NO_WINDOW);
    await open({ sockets });
  }
}

// A session has ended: every window closes the tabs it opened, but for one
// the person has in front (desktop/electron/main.mjs). A window that cannot
// answer is passed by; this is tidying, nothing waits on it.
export async function endSession(session, { sockets = windowSockets } = {}) {
  await Promise.all((await sockets()).map(path => askOne(path, { do: 'ended', session: String(session) }, { timeout: 5000 }).catch(() => {})));
}

// The tabs an agent opened close when its session ends: when its tab in
// imperfect is closed, or another session takes that tab's place (new,
// resume). Never because its turn finished or it went quiet: it is still
// open. Nor when imperfect restarts: the sessions come back. host: the tab
// host (tabs.mjs), whose snapshot lists the sessions open in it. Answers a
// function that stops watching.
export function closeTabsWhenSessionsEnd(host, { end = endSession, wait = 1000 } = {}) {
  const open = () => new Set((host.snapshot?.()?.tabs ?? []).map(tab => tab.sessionId).filter(Boolean));
  let was = open(), soon = null;
  const look = () => {
    soon = null;
    const now = open();
    for (const session of was) if (!now.has(session)) void end(session).catch(() => {});
    was = now;
  };
  const changed = () => { if (!soon) { soon = setTimeout(look, wait); soon.unref?.(); } };
  host.events.on('change', changed);
  return () => { host.events.off('change', changed); clearTimeout(soon); };
}

// The browser follows the person. Each window they use says so as they use
// it (harness.js), to every computer it is connected to, through /peer/ for
// the others, and the machine server tells it here (system/server.mjs). A
// new tab opens in the window used last: on this computer, or on another of
// theirs (asked at its /browser, which its own windows answer). The phone
// has no browser for agents: when it was used last, the tab opens in this
// computer's window (opened if none is; the one named with computer), which
// the phone is told to watch live (tell). Never the private browser. Before any
// window has said, or while theirs cannot be reached, this computer's. A
// conversation keeps to its own tab, wherever that is.
//
// A tab is known to the agent by a number of this computer's, kept with the
// computer it lives on and its id there, so a number means one tab wherever
// the person goes next. The numbers last until imperfect restarts.
//
// self(): this computer, { id, name }; peer(id): another, { name, url }, or
// null while it cannot be reached; peers(): the others reachable now.
// here(url): an address as this computer's own window opens it (on a hosted
// computer, a page's public name is loopback there; system/shown.mjs).
export function createBrowser({ self, peer, peers = async () => [], here = url => url, sockets = windowSockets, open = openWindow, send = fetch } = {}) {
  let person = null; // the window used last: { machine, kind, at, tell }
  const places = [null], numbers = new Map(); // the agent's number <-> { machine, name, tab }
  const mine = new Map(); // session -> the number of its tab
  const number = (to, tab) => {
    const key = `${to.machine} ${tab}`;
    if (!numbers.has(key)) { numbers.set(key, places.length); places.push({ machine: to.machine, name: to.name, tab }); }
    return numbers.get(key);
  };
  // A computer as a request reaches it: this one, another (with its url), or
  // null when that one cannot be reached.
  async function reach(machine) {
    const me = await self();
    if (!machine || machine === me.id) return { machine: me.id, name: me.name };
    const at = await peer(machine).catch(() => null);
    return at?.url ? { machine, name: at.name, url: at.url } : null;
  }
  async function target(computer) {
    if (typeof computer !== 'string' || !computer.trim()) throw new Error('computer needs a non-empty string');
    const wanted = computer.trim(), name = wanted.toLowerCase();
    const me = await self();
    if (name === 'local' || name === 'self') return reach(me.id);
    const all = [me, ...await peers()];
    const exact = all.filter(at => at.id === wanted);
    const matches = exact.length ? exact : all.filter(at => at.name?.toLowerCase() === name);
    if (matches.length > 1) throw new Error(`Computer ${wanted} is ambiguous; use its id`);
    const to = await reach(matches[0]?.id ?? wanted);
    if (!to) throw new Error(`Computer ${wanted} is unknown or cannot be reached right now`);
    return to;
  }
  function mark(to, page, session) {
    if (page.tab != null) mine.set(session, page.tab = number(to, page.tab));
    for (const one of page.tabs ?? []) one.tab = number(to, one.tab);
    return { ...page, where: to.name };
  }
  // The person on their phone is told to watch the computer the tab is on
  // live: behind for a tab opened, in front for one brought there for them.
  function watched(to, request, page) {
    if (['open', 'front'].includes(request.do)) person.tell?.({ front: request.do === 'front', machine: to.machine });
    return { ...page, phone: true };
  }
  async function away(to, request, signal) {
    let res;
    try {
      res = await send(`${to.url}/browser`, {
        method: 'POST', headers: { origin: to.url, 'content-type': 'application/json' }, body: JSON.stringify(request),
        signal: AbortSignal.any([AbortSignal.timeout(150_000), ...(signal ? [signal] : [])]), redirect: 'error',
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`${to.name} could not be reached (${error.message})`);
    }
    const said = await res.json().catch(() => ({}));
    if (!res.ok || said.error) throw new Error(said.error || `${to.name} answered ${res.status}`);
    return said;
  }
  return {
    // A window the person used ago ms since: a computer's, or the phone's,
    // which tell({ front }) asks to show this computer's browser live, in
    // front of them or behind. Told by every window, so the latest use wins,
    // not the latest word of it.
    seen({ machine, kind, ago = 0, tell }) {
      const at = Date.now() - Math.max(0, Number(ago) || 0);
      if (!person || at >= person.at) person = { machine: String(machine ?? ''), kind: kind === 'phone' ? 'phone' : 'desktop', at, tell };
    },
    // One request from an agent's tool, to where it belongs.
    async ask({ tab, computer, ...request }, { signal } = {}) {
      // A tab named, or else the conversation's own (but for a new one, and
      // the list), goes where that tab is; the rest, where the person is.
      const session = String(request.session ?? '');
      const theirs = request.do === 'open' || request.do === 'tabs';
      const place = tab != null ? places[Number(tab)] : theirs ? null : places[mine.get(session)];
      if (tab != null && !place) throw new Error(`There is no tab ${tab}; tabs lists the open ones`);
      let to;
      if (computer !== undefined) {
        to = await target(computer);
        if (place && place.machine !== to.machine) throw new Error(`Computer ${computer} does not match tab ${tab ?? mine.get(session)} on ${place.name}`);
      } else if (place) {
        to = await reach(place.machine);
        if (!to) throw new Error(`${place.name}, where that tab is, cannot be reached right now`);
      } else if (person?.kind === 'phone') to = await reach();
      else to = await reach(person?.machine) ?? await reach();
      if (to.url && request.do === 'open') request.url = await carried(request.url);
      else if (request.do === 'open') request.url = here(request.url);
      const asked = place ? { ...request, tab: place.tab } : request;
      const page = mark(to, to.url ? await away(to, asked, signal) : await askWindow(asked, { sockets, open, signal }), session);
      return person?.kind === 'phone' ? watched(to, request, page) : page;
    },
    // Another of the person's computers asking for its agent (POST /browser,
    // system/server.mjs): this computer's windows answer, as for its own.
    async answer(request, { signal } = {}) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('A browser request is an object');
      if (request.do === 'ended') { await endSession(String(request.session ?? ''), { sockets }); return {}; }
      return askWindow(request, { sockets, open, signal });
    },
    // The person's phone watching this computer's browser (relayLive).
    live: ws => relayLive(ws, { sockets, open }),
    // A session has ended: its tabs close here and on every other computer
    // it may have opened them on.
    async end(session) {
      mine.delete(String(session));
      const others = await peers().catch(() => []);
      await Promise.all([
        endSession(session, { sockets }),
        endPrivately(session),
        ...others.map(at => away(at, { do: 'ended', session: String(session) }, AbortSignal.timeout(5000)).catch(() => {})),
      ]);
    },
  };
}

// The person's phone watching this computer's browser live
// (public/js/live.js), on a WebSocket of this computer's imperfect
// (/browser/live, system/server.mjs; through /peer/<id>/ from another): the
// phone's messages go a line each to the window the person turned to last,
// which answers with pictures of the tab in front, the tabs and what went
// wrong, a line each (desktop/electron/live.mjs). The first is
// { do: 'watch', width, height }; anything else said before the window
// answers is dropped, never kept to land later. With no window open here,
// one is opened, as for the tool; with none to be had, or one opened before
// it could be watched (it says nothing), the phone is told why.
export const OLD_WINDOW = "imperfect's window on this computer is from before its browser could be watched: close it and open it again once.";
export function relayLive(ws, { sockets = windowSockets, open = openWindow, wait = 8000 } = {}) {
  let window = null, gone = false, heard = '', asked = false, silent = 0;
  const send = said => { if (ws.readyState === 1) ws.send(typeof said === 'string' ? said : JSON.stringify(said)); };
  const end = () => { gone = true; clearTimeout(silent); window?.destroy(); if (ws.readyState <= 1) ws.close(); };
  ws.on('message', raw => {
    let said;
    try { said = JSON.parse(String(raw)); } catch { return; }
    if (!said || typeof said !== 'object' || Array.isArray(said)) return;
    const line = `${JSON.stringify(said)}\n`;
    if (window) { window.write(line); return; }
    if (asked) return;
    asked = true;
    if (said.do !== 'watch') { send({ error: 'A live view starts by asking to watch' }); end(); return; }
    watchWindow({ sockets, open }).then(socket => {
      if (gone) { socket.destroy(); return; }
      window = socket;
      socket.setEncoding('utf8');
      // A window that can be watched says which tabs it has at once.
      silent = setTimeout(() => { send({ error: OLD_WINDOW }); end(); }, wait);
      socket.on('data', chunk => {
        clearTimeout(silent);
        heard += chunk;
        for (let cut = heard.indexOf('\n'); cut >= 0; cut = heard.indexOf('\n')) {
          send(heard.slice(0, cut));
          heard = heard.slice(cut + 1);
        }
      });
      socket.on('error', () => {});
      socket.on('close', end);
      socket.write(line);
    }, error => { send({ error: error.message }); end(); });
  });
  ws.on('close', end);
  ws.on('error', () => {});
}
async function watchWindow({ sockets, open }) {
  const reach = path => new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('error', reject);
    socket.once('connect', () => { socket.off('error', reject); resolve(socket); });
  });
  for (let opened = false; ; opened = true) {
    for (const path of await sockets()) {
      try { return await reach(path); }
      catch (error) {
        if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') throw error;
        await rm(path, { force: true });
      }
    }
    if (opened) throw new Error(NO_WINDOW);
    await open({ sockets });
  }
}

// The browser the machine server keeps (createBrowser), which the tool asks
// in every harness; without one, this computer's window.
const BROWSER = Symbol.for('imperfect.browser');
export function provideBrowser(browser) { globalThis[BROWSER] = browser; }
const askPerson = (request, options) => (globalThis[BROWSER] ?? { ask: askWindow }).ask(request, options);

/* -------------------------------------------------- the private browser */

// desktop/electron/private.mjs, in the project's own Electron, started the
// first time an agent asks for it and stopped once no tab is left in it. It
// is given no display, so it cannot show anything on any screen, even where
// there is one, and it works on a computer with none. Its tabs are numbered
// downward from -1, never reused. Headed numbers are always positive; no
// amount of browsing can make the two modes' numbers collide.
export const PRIVATE_TABS = -1;
let helper = null, privateNumber = PRIVATE_TABS;
const privateTabs = new Map(); // the agent's number <-> { run, id }
export const isPrivateTab = tab => Number.isSafeInteger(Number(tab)) && Number(tab) < 0;

export function startPrivate({ env = process.env, run = spawn, startupTimeout = 20_000 } = {}) {
  const electron = createRequire(import.meta.url)('electron');
  const profile = mkdtempSync(join(tmpdir(), `imperfect-private-${process.pid}-`));
  const quiet = { ...env, IMPERFECT_PORT: String(windowPort()), IMPERFECT_PRIVATE_PROFILE: profile };
  for (const name of ['WAYLAND_DISPLAY', 'DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'ELECTRON_RUN_AS_NODE']) delete quiet[name];
  const child = run(electron, [
    '--ozone-platform=headless', '--ozone-override-screen-size=1280,800', '--disable-gpu', '--mute-audio', '--no-first-run',
    fileURLToPath(new URL('../../../desktop/electron/private.mjs', import.meta.url)),
  ], { stdio: ['pipe', 'pipe', 'ignore'], env: quiet });
  const waiting = new Map();
  let next = 0, gone = null, started;
  const ready = new Promise((resolve, reject) => { started = { resolve, reject }; });
  ready.catch(() => {});
  // Stopped, or left by the machine, it takes its profile with it. Chromium's
  // own helpers can write there a moment longer; whatever is left, the next
  // start clears.
  const forget = () => { try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* cleared next time */ } };
  const stop = () => { if (helper?.child === child) helper = null; if (!child.killed) child.kill(); };
  const leave = () => { child.stdin.destroy(); child.kill(); forget(); };
  const lateStart = setTimeout(() => { failed('did not start in time'); stop(); }, startupTimeout).unref();
  function failed(why) {
    gone ??= why;
    clearTimeout(lateStart);
    started.reject(new Error(`The private browser ${gone}`));
    for (const answer of waiting.values()) answer({ error: `The private browser ${gone}` });
    if (helper?.child === child) helper = null;
  }
  process.once('exit', leave);
  createInterface({ input: child.stdout }).on('line', line => {
    let said;
    try { said = JSON.parse(line); } catch { return; }
    if (said.ready) { clearTimeout(lateStart); return started.resolve(); }
    waiting.get(said.id)?.(said);
  });
  child.stdin.on('error', () => {});
  child.on('error', error => {
    failed(`could not start (${error.message})`);
    forget();
    process.off('exit', leave);
    stop();
  });
  child.on('exit', code => {
    forget();
    setTimeout(forget, 1000).unref();
    process.off('exit', leave);
    failed(`stopped (${code ?? 'killed'})`);
  });
  return {
    child, run: Symbol('run'), stop,
    async ask(request, { signal, timeout = 45_000 } = {}) {
      if (signal?.aborted) throw new Error('Stopped');
      let interrupted;
      try {
        await (signal ? Promise.race([ready, new Promise((_, reject) => {
          interrupted = () => reject(new Error('Stopped'));
          signal.addEventListener('abort', interrupted, { once: true });
        })]) : ready);
      } finally { if (interrupted) signal.removeEventListener('abort', interrupted); }
      if (signal?.aborted) throw new Error('Stopped');
      if (gone) throw new Error(`The private browser ${gone}`);
      const id = ++next;
      return new Promise((resolve, reject) => {
        const done = said => { waiting.delete(id); clearTimeout(late); signal?.removeEventListener('abort', stopped); if (said.error) reject(new Error(said.error)); else resolve(said); };
        const late = setTimeout(() => done({ error: 'The private browser took too long to answer' }), timeout);
        const stopped = () => done({ error: 'Stopped' });
        if (signal?.aborted) return stopped();
        signal?.addEventListener('abort', stopped, { once: true });
        waiting.set(id, done);
        child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
      });
    },
  };
}

// One request from the tool to the private browser, with the agent's tab
// numbers turned into the private browser's and back.
export async function askPrivately({ tab, computer, ...request }, { signal, start = startPrivate } = {}) {
  if (signal?.aborted) throw new Error('Stopped');
  if (computer !== undefined && !['local', 'self'].includes(String(computer).trim().toLowerCase())) throw new Error('The private browser runs on this computer only: leave computer out, or use headless: false');
  if (tab != null && !isPrivateTab(tab)) throw new Error(`Tab ${tab} is not a private tab: use it without headless, or open one with headless: true`);
  const place = tab != null ? privateTabs.get(Number(tab)) : null;
  if (tab != null && (!place || place.run !== helper?.run)) throw new Error(`Private tab ${tab} is closed; tabs lists the open ones`);
  // Only open starts it: with none running there is no private tab.
  if (!helper && request.do === 'tabs') return { tabs: [], where: 'the private browser' };
  if (!helper && request.do !== 'open') throw new Error(tab != null ? `Private tab ${tab} is closed; tabs lists the open ones` : 'You have no private tab open: open one with headless: true');
  const using = helper ??= start();
  const page = await using.ask(place ? { ...request, tab: place.id } : request, { signal });
  const number = id => {
    for (const [n, at] of privateTabs) if (at.run === using.run && at.id === id) return n;
    privateTabs.set(privateNumber, { run: using.run, id });
    return privateNumber--;
  };
  if (page.tab != null) page.tab = number(page.tab);
  for (const one of page.tabs ?? []) one.tab = number(one.tab);
  if (page.left === 0) using.stop();
  return { ...page, where: 'the private browser' };
}

// A session has ended: its private tabs close and what they kept is
// forgotten. With no private browser running, there is nothing to do.
export async function endPrivately(session) {
  const using = helper;
  await using?.ask({ do: 'ended', session: String(session) }, { timeout: 5000 }).then(said => {
    if (said.left === 0) using.stop();
  }).catch(() => {});
}

function askOne(path, request, { signal, timeout }) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let answer = '';
    const stop = () => socket.destroy(new Error('Stopped'));
    signal?.addEventListener('abort', stop, { once: true });
    socket.setEncoding('utf8');
    socket.setTimeout(timeout, () => socket.destroy(new Error('The window took too long to answer')));
    socket.on('connect', () => socket.end(JSON.stringify(request)));
    socket.on('data', chunk => { answer += chunk; });
    socket.on('error', reject);
    socket.on('close', () => {
      signal?.removeEventListener('abort', stop);
      let said;
      try { said = JSON.parse(answer); } catch { reject(new Error('The window answered with nothing')); return; }
      if (said.error) reject(new Error(said.error)); else resolve(said);
    });
  });
}

/* ------------------------------------------------- run inside the page */

// What is on screen: the page's text, and each thing to use in view,
// numbered. The numbers stay with the page (in this world) for aim().
function look({ most, chars }) {
  const pick = 'a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=switch], [role=option], [role=textbox], [role=searchbox], [role=combobox], [contenteditable]:not([contenteditable=false])';
  const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  const inView = el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && el.checkVisibility({ checkVisibilityCSS: true });
  };
  const kindOf = el => {
    const role = el.getAttribute('role');
    if (role) return role;
    if (el.localName === 'a') return 'link';
    if (el.localName === 'input') return ['button', 'submit', 'reset', 'image'].includes(el.type) ? 'button' : ['checkbox', 'radio'].includes(el.type) ? el.type : `input ${el.type}`;
    return el.isContentEditable && !['button', 'select', 'textarea'].includes(el.localName) ? 'editable' : el.localName;
  };
  const field = el => ['input', 'textarea', 'select'].includes(el.localName) || el.isContentEditable;
  const nameOf = el => squash(el.getAttribute('aria-label') || [...(el.labels ?? [])].map(label => label.innerText).join(' ')
    || (field(el) ? '' : el.innerText) || el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('title')
    || el.querySelector('img[alt]')?.alt || el.getAttribute('name') || (el.localName === 'input' ? el.value : '')).slice(0, 80);
  const refs = [null], things = [];
  for (const el of document.querySelectorAll(pick)) {
    if (things.length >= most) break;
    if (!inView(el)) continue;
    refs.push(el);
    const thing = { ref: refs.length - 1, kind: kindOf(el), name: nameOf(el) };
    if (el.localName === 'a' && el.href) thing.href = el.href;
    if (thing.href?.length > 120) thing.href = `${thing.href.slice(0, 119)}…`;
    if (field(el) && !['checkbox', 'radio'].includes(el.type)) thing.value = squash(el.localName === 'select' ? el.selectedOptions[0]?.text : el.isContentEditable ? el.innerText : el.value).slice(0, 80);
    if (['checkbox', 'radio'].includes(el.type) ? el.checked : el.getAttribute('aria-checked') === 'true') thing.checked = true;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') thing.disabled = true;
    things.push(thing);
  }
  globalThis.imperfectRefs = refs;
  const text = (document.body?.innerText ?? '').replace(/[ \t ]+/g, ' ').replace(/ ?\n[\s]*/g, '\n').trim();
  const room = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  return { url: location.href, title: document.title, text: text.slice(0, chars), more: Math.max(0, text.length - chars), things, down: Math.round(Math.min(1, scrollY / room) * 100) };
}

// Where to put the mouse for a thing: its centre, brought into view first.
function aim(ref) {
  const el = globalThis.imperfectRefs?.[ref];
  if (!el?.isConnected) return null;
  let r = el.getBoundingClientRect();
  if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    r = el.getBoundingClientRect();
  }
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  return { x, y, covered: top && !el.contains(top) && !top.contains(el) ? top.localName : '' };
}

// What is in a field is chosen, so what is typed replaces it.
function choose(ref) {
  const el = globalThis.imperfectRefs?.[ref];
  if (!el?.isConnected) return false;
  if (!el.contains(document.activeElement)) el.focus();
  if (typeof el.select === 'function') el.select();
  else if (el.isContentEditable) getSelection().selectAllChildren(el);
  return true;
}

// Scrolling the page, or the part of it in the middle of the screen that
// scrolls by itself, straight there: a wheel's smooth scroll only moves while
// the window is drawn, and the person may be looking elsewhere.
function scroll(dy) {
  let box = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll|overlay/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  box ??= document.scrollingElement;
  const from = box.scrollTop;
  box.scrollBy({ top: dy || Math.round(innerHeight * 0.8), behavior: 'instant' });
  return Math.round(box.scrollTop - from);
}

const inPage = (fn, arg) => `(${fn})(${JSON.stringify(arg)})`;

/* --------------------------------------------------------- the words */

export function lookText(seen) {
  const lines = [`${seen.title || '(no title)'} — ${seen.url}${seen.down ? ` (scrolled ${seen.down}% down)` : ''}`];
  if (seen.text) lines.push('', seen.text + (seen.more ? `\n… (${seen.more} more characters: eval document.body.innerText.slice(${seen.text.length}, ${seen.text.length + 8000}) reads on)` : ''));
  lines.push('', seen.things.length ? 'On screen to use (ref, then what it is):' : 'Nothing on screen to click or type into.');
  for (const t of seen.things) {
    lines.push(`[${t.ref}] ${t.kind}${t.name ? ` "${t.name}"` : ''}${t.value ? ` = "${t.value}"` : ''}${t.checked ? ' (checked)' : ''}${t.disabled ? ' (disabled)' : ''}${t.href ? ` → ${t.href}` : ''}`);
  }
  return lines.join('\n');
}

// What the person away from the computer (on their phone, or a hosted
// computer's page) sees of it.
const onPhone = page => (page.phone ? '; the person is away from this computer and watches this browser live' : '');
const at = page => `${page.title || '(no title)'} — ${page.url}${page.tab != null ? ` (tab ${page.tab}${page.where ? ` on ${page.where}` : ''})` : ''}`;
const tabLine = t => `[${t.tab}] ${t.title || '(no title)'} — ${t.url}${t.front ? ' (in front)' : ''}${t.yours ? ' (yours)' : ''}`;

// A page an agent made, opened by its path, and a page on this computer's
// loopback opened on another screen: at the address `show` gives it
// (system/shown.mjs).
async function shownAt(target) {
  const add = globalThis[Symbol.for('imperfect.shown')];
  if (!add) throw new Error('imperfect is not serving here, so a file cannot be opened; use show');
  return (await add(target)).url;
}
const pageAddress = (path, cwd) => shownAt(resolve(String(cwd || process.cwd()), String(path).replace(/^~(?=\/)/, homedir())));
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);
async function carried(url) {
  try { if (!LOOPBACK.has(new URL(url).hostname)) return url; } catch { return url; }
  return shownAt(url);
}
const value = v => (v === undefined ? 'undefined' : typeof v === 'string' ? v : JSON.stringify(v, null, 1)).slice(0, 20_000);

// ask: one request to the person's window (createBrowser, else askWindow, or
// a stand-in in the tests). session: the conversation calling, filled in by
// the harness; the window remembers its tab.
export async function runBrowser({ action, url, computer, tab, ref, text, submit, key, dy, js, screenshot, headless, session, cwd, signal } = {}, { ask = headless ? askPrivately : askPerson } = {}) {
  if (!headless && tab != null && isPrivateTab(tab)) throw new Error(`Tab ${tab} is a private tab: use it with headless: true`);
  // The tab named, else the window's choice; once it answers, that tab.
  let using = tab ?? null;
  const tell = async request => {
    const page = await ask({ ...request, session: String(session ?? ''), ...(computer !== undefined ? { computer } : {}), ...(using != null ? { tab: using } : {}) }, { signal });
    if (page.tab != null) using = page.tab;
    return page;
  };
  const run = async (fn, arg) => (await tell({ do: 'run', code: inPage(fn, arg) })).value;
  const thing = async () => {
    const n = Number(ref);
    const aimed = Number.isInteger(n) && n > 0 ? await run(aim, n) : null;
    if (!aimed) throw new Error(`There is no [${ref}] on the page now; look again for fresh refs.`);
    return aimed;
  };
  let said;
  switch (action) {
    case 'open': {
      const address = /^(~\/|\/)/.test(String(url ?? '').trim()) ? await pageAddress(String(url).trim(), cwd) : addressOf(url);
      if (!/^https?:/.test(address)) throw new Error('open needs a web address, words to search for, or the path of a page');
      const page = await tell({ do: 'open', url: address });
      said = `Opened ${at(page)}${headless ? ', where no one sees it' : tab == null ? ', behind the tab in front' : ''}${onPhone(page)}`;
      break;
    }
    case 'tabs': {
      const { tabs, where } = await tell({ do: 'tabs' });
      const list = tabs.length ? tabs.map(tabLine).join('\n') : 'No tabs are open in the browser.';
      return where ? `On ${where}:\n${list}` : list;
    }
    case 'front': { const page = await tell({ do: 'front' }); said = `In front now: ${at(page)}${onPhone(page)}`; break; }
    case 'close': return `Closed ${at(await tell({ do: 'close' }))}`;
    case 'look': said = lookText(await run(look, { most: MOST_THINGS, chars: TEXT_CHARS })); break;
    case 'click': {
      const { x, y, covered } = await thing();
      said = `Clicked [${ref}]${covered ? ` (a ${covered} was over it, and took the click)` : ''}. Now at ${at(await tell({ do: 'click', x, y }))}`;
      break;
    }
    case 'type': {
      if (text == null) throw new Error('type needs the text');
      if (ref != null) {
        const { x, y } = await thing();
        await tell({ do: 'click', x, y });
        await run(choose, Number(ref));
      }
      let page = await tell({ do: 'insert', text: String(text) });
      if (submit) page = await tell({ do: 'key', key: 'Enter' });
      said = `Typed ${JSON.stringify(String(text))}${ref != null ? ` into [${ref}]` : ''}${submit ? ' and pressed Enter' : ''}. Now at ${at(page)}`;
      break;
    }
    case 'key': {
      if (!key) throw new Error('key needs a key, e.g. Enter');
      said = `Pressed ${key}. Now at ${at(await tell({ do: 'key', key: String(key) }))}`;
      break;
    }
    case 'scroll': {
      const { value: moved, ...page } = await tell({ do: 'run', code: inPage(scroll, Number(dy) || 0) });
      said = moved ? `Scrolled ${moved > 0 ? 'down' : 'up'} ${Math.abs(moved)} pixels on ${at(page)}` : `Nothing moved on ${at(page)}: that is as far as it goes`;
      break;
    }
    case 'back': case 'forward': said = `Went ${action} to ${at(await tell({ do: action }))}`; break;
    case 'eval': {
      if (!js) throw new Error('eval needs an expression');
      said = value((await tell({ do: 'run', code: String(js), page: true })).value);
      break;
    }
    default: throw new Error(`browser: the action is one of ${ACTIONS.join(', ')}`);
  }
  if (!screenshot) return said;
  const { png, jpeg } = await tell({ do: 'capture', most: PICTURE_BYTES });
  const seen = await pictureForModel(Buffer.from(png ?? jpeg, 'base64'), png ? 'image/png' : 'image/jpeg');
  if (!seen) return `${said}\n(the screenshot was too big to send)`;
  return [{ type: 'text', text: said }, seen.block];
}
