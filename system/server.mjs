import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readdir, readFile, mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer } from 'ws';
import { createTabHost, tabLabel } from '../apps/code/native/tabs.mjs';
import { staleCommandError, tabCloseBusyError } from '../apps/code/native/public/js/session-logic.js';
import { windowOf } from '../apps/code/native/public/js/pages.js';
import { receiveHttpUpload, uploadReference, openUpload, filenameFromHeader, MAX_UPLOAD_BYTES, UPLOAD_TIMEOUT_MS, OTHER_POST_TIMEOUT_MS } from '../apps/code/native/uploads.mjs';
import { MIME, READS, createFiles, fromElsewhere } from './files.mjs';
import { createShown } from './shown.mjs';
import { createProjects } from './projects.mjs';
import { createTranscriber } from './transcribe.mjs';
import { createDictation } from './dictate.mjs';
import { createMemoryRoute } from './memory.mjs';
import { createInboxRoute, inboxSource, isInboxPath } from './inbox.mjs';
import { listenLend } from './inbox-lend.mjs';
import { createPhoneApp } from './phone-app.mjs';
import { createClipboard } from './clipboard.mjs';
import { createDeviceHands, provideDeviceHands } from './device-hands.mjs';
import { createSystemControls } from './controls.mjs';
import { openSession, provideSessions, provideShownTabs } from '../apps/code/native/code-control.mjs';
import { provideWindowPort, closeTabsWhenSessionsEnd, createBrowser, provideBrowser } from '../apps/code/native/browser.mjs';
import { serveMcp, serveMcpOn, stopMcpOn } from '../apps/code/native/mcp.mjs';
import { createImageBox, provideKeyBox } from '../apps/code/native/images.mjs';
import { bootId, ownerHolds, ownerRecord, parseOwner } from '../apps/code/native/owner.mjs';
import { AUTO, currentLook, listThemes, readTheme, setTheme, themeChoice, themeCss, watchThemes } from './theme.mjs';
import { MACHINE_CAPABILITIES, MACHINE_PROTOCOL, solitaryMachines } from './machines.mjs';
import { startupIdentity } from './startup-identity.mjs';
import { Readable } from 'node:stream';
import { createPulseRoute } from './pulse-route.mjs';
import { invariantRegistry } from './doctor.mjs';
import { createIncidentLedger, createWorkerLedger } from './pulse-ledger.mjs';
import { createNotify, provideNotify } from './notify.mjs';
import { getSessionToken } from './session-token.mjs';
import { sessionComputer, openPeerSession } from './session-peer.mjs';

// One active run plus one dirty bit: filesystem bursts cannot build a queue.
function coalescedTask(run) {
  let active = null, dirty = false, stopped = false;
  return {
    request() {
      if (stopped) return Promise.resolve();
      dirty = true;
      if (!active) active = (async () => {
        while (dirty && !stopped) { dirty = false; await run(); }
      })().finally(() => { active = null; });
      return active;
    },
    stop() { stopped = true; dirty = false; },
  };
}

// The page this server serves is the one it started with: the files under
// public/, read whole when it starts (they are small) and served from memory
// until it stops. So the page and the server it talks to are always the same
// version, and change together, at a restart; a page file changed on disk
// waits for one. The build is a hash of them, on any checkout, with or
// without git (the demo image is an archive).
export async function pageSnapshot(dir) {
  const hash = createHash('sha256'), files = new Map();
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const full = join(dir, name);
    if (!(await stat(full)).isFile()) continue;
    const body = await readFile(full);
    hash.update(name).update(body);
    files.set(`/${name.split(sep).join('/')}`, body);
  }
  const build = hash.digest('hex').slice(0, 12);
  // Relative module imports and CSS URLs inherit this build too.
  const index = files.get('/index.html');
  if (index) files.set('/index.html', Buffer.from(index.toString('utf8').replace(/(src|href)="\/(js|css)\//g, `$1="/b/${build}/$2/`)));
  return { build, files };
}

function loopbackRequest(host = '') {
  try {
    const parsed = new URL(`http://${host}`).hostname;
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed);
  } catch { return false; }
}

// Every file under public/ answers at its own path and at /b/<build>/<path>.
// index.html links the second form, so a window keeps the files for a year
// and fetches them again only when they change; relative imports and url()s
// inherit the version from the file that named them.
const VERSIONED = /^\/b\/[^/]+(\/.*)$/;
function asset(surface, urlPath) {
  const versioned = VERSIONED.exec(urlPath)?.[1];
  const name = versioned ?? (urlPath === '/' ? '/index.html' : urlPath);
  const body = surface.files.get(name), type = MIME[extname(name)];
  return body && type ? { body, type, versioned: Boolean(versioned), favicon: name === '/favicon.svg' } : null;
}

// What imperfect's window may load. {pages}: where what agents show plays
// from (system/shown.mjs).
const POLICY = "default-src 'self'; connect-src 'self'; media-src 'self' blob: {pages}; img-src 'self' data: blob: {pages}; style-src 'self'; script-src 'self'; frame-src 'self' {pages}; frame-ancestors 'none'";

// Work an agent left running after its turn (a subagent, a command in the
// background, Claude answering one that finished) dies with its harness when
// imperfect restarts, so a restart waits for it as it does for a turn. It waits
// with the fence lifted, since that can take a while and every session should
// take prompts meanwhile. And not forever: a forgotten server or a stuck task
// would hold every update. Three hours is well past any worker here (pictures,
// code, a render: minutes, an hour at most), so past it imperfect restarts
// anyway and logs what that cut off. A turn is never cut off.
export const BACKGROUND_LIMIT = 3 * 60 * 60_000;

// Explicit operator handoff only. Installation/artifact activation stays external.
export function createHandoff(runtime, restart = () => process.kill(process.pid, 'SIGTERM'), {
  backgroundLimit = BACKGROUND_LIMIT, settle = 2000, poll = 5000, log = message => console.log(`handoff: ${message}`),
} = {}) {
  let generation = 0;
  let state = { phase: 'running', error: null };
  let startup = null;
  // When background work stops holding a restart: set by the first request
  // and kept by later ones, so each commit asking again cannot start the clock
  // over, until delivery resumes.
  let deadline = null;
  const publish = () => runtime.events.emit('change');
  const fail = error => { runtime.requestQuiesce(); state = { ...state, phase: 'held', error: error.message }; deadline = null; publish(); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms).unref());
  const fence = () => { state = { phase: 'quiescing', error: null }; runtime.requestQuiesce(); publish(); };
  // resumeDelivery may run an entire turn. Never hold the transport ACK.
  const deliver = epoch => { Promise.resolve(runtime.resumeDelivery()).catch(error => { if (epoch === generation) fail(error); }); };
  // Every turn done and nothing left in the background, asked again after a
  // moment: Claude takes that long to start answering a task that has just
  // finished. Only the final recheck holds delivery for the restart.
  const idle = () => runtime.isIdle?.() ?? !(runtime.snapshot?.().busy || runtime.snapshot?.().handoff?.settling);
  async function settled(epoch) {
    for (;;) {
      await runtime.waitForIdle();
      if (epoch !== generation) return false;
      await sleep(settle);
      if (epoch !== generation) return false;
      const left = runtime.background?.() ?? [];
      if (left.length && Date.now() < deadline) {
        state = { phase: 'waiting', error: null, background: left }; publish();
        await sleep(poll);
        continue;
      }
      // The idle wait is advisory while sessions can change. Fence only now,
      // and recheck every tab and lifecycle operation, not just the selected tab.
      fence();
      if (epoch !== generation) return false;
      if (!idle()) {
        state = { phase: 'waiting', error: null }; deliver(epoch); publish();
        continue;
      }
      await runtime.waitForIdle(); // also keeps restore failures strict
      if (epoch !== generation) return false;
      const remaining = runtime.background?.() ?? [];
      if (!idle() || (remaining.length && Date.now() < deadline)) {
        state = { phase: 'waiting', error: null }; deliver(epoch); publish();
        continue;
      }
      if (remaining.length) log(`restarting anyway after ${Math.round(backgroundLimit / 60_000)} minutes waiting on background work, which this cuts off: ${remaining.join('; ')}`);
      state = { ...state, phase: 'restarting' }; publish();
      if (epoch !== generation) return false;
      // No extra promise continuation between the final check and restart.
      const result = await restart();
      if (result === false && epoch === generation) {
        // An idle activation recheck may find the person's new changes.
        // Stand down without restarting and release the fence only now.
        state = { phase: 'running', error: null };
        deadline = null;
        deliver(epoch);
        publish();
        return false;
      }
      return true;
    }
  }
  return {
    snapshot: () => ({ ...state, generation }),
    startDelivery() {
      if (!startup) {
        startup = Promise.resolve().then(() => {
          if (state.phase === 'running') return runtime.resumeDelivery?.();
        }).catch(fail);
      }
      return startup;
    },
    // Wait with normal session delivery; fence only the final idle check.
    request() {
      // Final activation is already underway. A new request must not resume
      // delivery while an asynchronous fast-forward holds the idle fence.
      if (state.phase === 'restarting') return { accepted: false, ...state };
      const epoch = ++generation;
      deadline ??= Date.now() + backgroundLimit;
      state = { phase: 'waiting', error: null };
      deliver(epoch);
      publish();
      // Defer beyond the ACK. A turn has no deadline, abort, or rendered-busy shortcut.
      setImmediate(() => {
        if (epoch !== generation) return;
        settled(epoch).catch(error => { if (epoch === generation) fail(error); });
      });
      return { accepted: true, ...state };
    },
    resume() {
      if (state.phase === 'restarting') return { accepted: false, ...state };
      const epoch = ++generation;
      state = { phase: 'running', error: null };
      deadline = null;
      try { deliver(epoch); } catch (error) { fail(error); throw error; }
      publish();
      return { accepted: true, ...state };
    },
    cancelWaiter() { generation++; },
  };
}

// options.runtime: a tab host (apps/code/native/tabs.mjs), or a stand-in for
// one in the tests; otherwise one is made here.
export async function createGueyServer(options = {}) {
  const host = '127.0.0.1';
  const port = options.port ?? 0;
  // The pages agents show are served beside it (system/shown.mjs).
  const pagePort = options.pagePort ?? (port ? port + 1 : 0);
  const cwd = resolve(options.cwd ?? process.cwd());
  const stateDir = resolve(options.stateDir);
  const surface = await pageSnapshot(resolve(import.meta.dirname, '../apps/code/native/public'));
  // Fail before taking ownership or constructing providers (and replaying
  // their inboxes). Role constructors must never snapshot a discovery fallback.
  const machines = options.machines ?? solitaryMachines();
  const authority = options.authority ?? {};
  // Used only through the web (machine.json, system/machine.mjs).
  const hosted = options.hosted === true;
  const selfId = await startupIdentity({ machines, authority, ...(options.identityOptions ?? {}), hosted });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  const lockPath = join(stateDir, 'owner.pid');
  const alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  };
  try {
    const held = parseOwner(await readFile(lockPath, 'utf8'));
    if (await ownerHolds(held, { boot: await bootId(), alive })) {
      throw new Error(`state is owned by process ${held.pid}`);
    }
    await unlink(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(JSON.stringify(await ownerRecord()));
  await lock.close();

  let runtime, deviceHands;
  try {
    runtime = options.runtime ?? await createTabHost({
      cwd,
      stateDir,
      sessionDir: options.sessionDir,
      agentDir: options.agentDir,
      authentication: true,
      sessionToken: options.sessionToken,
      serviceOptions: options.serviceOptions,
      firstTab: null, // a first visit starts a tab on the last model
    });
    deviceHands = await createDeviceHands({ deviceHandsTokenFile: options.deviceHandsTokenFile, deviceHandsAccount: options.deviceHandsAccount, deviceHandsTestInsecure: options.deviceHandsTestInsecure });
  } catch (error) {
    await runtime?.close();
    await unlink(lockPath);
    throw error;
  }

  const handoff = createHandoff(runtime, options.restart, options.handoff);

  const uploadMaxBytes = options.uploadMaxBytes ?? MAX_UPLOAD_BYTES;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
  // This machine's own tailnet address is trusted because the tailnet says it
  // is ours, not because someone wrote it down. A hand-kept list is what a
  // rename silently breaks.
  const configuredOrigins = (options.origins ?? []).map(origin => new URL(origin));
  const clients = new Set();
  const files = createFiles(options.files);
  // A tool names its session as its harness knows it; the windows, as the tabs do.
  const resolveSession = session => runtime.snapshot().tabs?.find(tab => tab.id === session || tab.sessionId === session)?.sessionId || session;
  // The computer the others follow (the authority), as this one reaches it:
  // null when this is it (or there are no others), url '' while unreachable.
  const authorityPeer = async () => {
    if (!authority.id || selfId === authority.id) return null;
    const peer = await machines.peer(authority.id).catch(() => null);
    return { url: peer?.url ?? '', name: peer?.name || authority.name || 'the PC' };
  };
  // Something of the person's own on this machine (the store telling Locus of
  // a sale, a script, a timer) asking for a session. The right to ask is the
  // token in ~/.imperfect/session-token, which only they can read; made when
  // imperfect starts.
  const home = homedir();
  const pulseMemory = join(resolve(stateDir, '../..'), 'memory');
  const pulse = createPulseRoute({ stateDir, host: () => machines.self(),
    incidents: createIncidentLedger({ stateDir, memoryDir: pulseMemory, registry: invariantRegistry() }),
    workers: createWorkerLedger({ stateDir, memoryDir: pulseMemory }), ...options.pulse });
  const sessionToken = () => getSessionToken(options.sessionToken);
  void sessionToken().catch(() => {});
  // Something of the person's own on this computer: loopback, no page's
  // origin, and the session token.
  const localCaller = async req => {
    if (!loopbackRequest(req.headers.host) || req.headers.origin) return false;
    const expected = await sessionToken();
    const supplied = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    return expected.length > 0 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  // Notifications to the person's devices and open windows (system/notify.mjs).
  const notifications = createNotify({
    // start.mjs: ~/.imperfect/push, and the credentials whose values never go out.
    dir: join(stateDir, 'push'),
    session: id => resolveSession(id),
    tell: message => { let told = 0; for (const ws of clients) if (ws.readyState === 1) { send(ws, { type: 'notify', ...message }); told++; } return told; },
    ...options.notify,
  });
  provideNotify(notifications);
  // What agents show the person, played in the conversation, or as a tab
  // in the browser, told to every window.
  // Hosted previews use the person's browser on their owning computer, not
  // whichever desktop an agent last used. Keep one tab per shown target; a
  // reload or stale idle-expired id is resolved before a panel watches it.
  const shownViews = new Map();
  async function shownView({ url, reload }) {
    const before = shownViews.get(url);
    const next = (async () => {
      const kept = await before?.catch(() => null);
      const { tabs = [] } = await browser.answer({ do: 'tabs' });
      // The person may have taken the cached tab elsewhere. Showing the
      // original again must not navigate their reused tab away from that page.
      const tab = tabs.find(tab => tab.tab === kept?.tab && tab.url === kept.url) ?? tabs.find(tab => tab.url === url);
      if (tab && !reload) return { tab: tab.tab, url: tab.url };
      const page = await browser.answer({ do: 'open', url, ...(tab ? { tab: tab.tab } : {}), session: 'shown' });
      if (page.error || !Number.isSafeInteger(page.tab) || page.tab <= 0) throw new Error(page.error || 'The browser did not open this page');
      return { tab: page.tab, url: page.url };
    })();
    shownViews.set(url, next);
    try { return await next; }
    catch (error) { if (shownViews.get(url) === next) shownViews.delete(url); throw error; }
  }
  const hostedPageOrigin = configuredOrigins[0]?.origin ?? (hosted ? (await machines.origins().catch(() => []))[0] : '');
  const shown = createShown({ stateDir, machines, carries: port => projects.carries(port), projectAt: port => projects.atPort(port),
    hosted, webOrigin: () => hostedPageOrigin || `http://${host}:${server?.address()?.port ?? port}`, view: shownView,
    reservedPorts: () => [server?.address()?.port ?? port, 5080] });
  // Projects, their pages carried beside what agents show.
  const projects = createProjects({ stateDir, shown, ...options.projects });
  provideShownTabs(({ session, target, kind }) => { for (const ws of clients) send(ws, { type: 'shown', session: resolveSession(String(session ?? '')), target, ...(kind ? { kind } : {}) }); });
  // Freeze and validate the destination before any upload body or decoding.
  function attachmentTarget({ tab, session, instanceId }) {
    const host = runtime.snapshot();
    const held = host.tabs?.find(item => tab ? item.id === tab : item.sessionId === session || item.id === session);
    if ((!tab && !session) || !held || (tab && (session != null ? held.sessionId !== session : !instanceId || instanceId !== host.instanceId))) {
      throw Object.assign(new Error('selected session is no longer available'), { status: 409 });
    }
    return { referenceKey: options.sessionToken, cwd: runtime.snapshot(held.id).cwd, tabId: held.id, sessionId: held.sessionId ?? null, instanceId: host.instanceId };
  }
  async function openAudio(prompt) {
    const target = attachmentTarget(prompt);
    const { file } = await openUpload(prompt.audio, target);
    return file.createReadStream();
  }
  const transcribe = createTranscriber({ openAudio });
  const dictation = createDictation({ runtime, hear: transcribe.hear, openAudio });
  // The OpenAI API key lives in one box, on the authority: generate_image's
  // sunburst and flare here have the authority make the picture when this
  // computer has no key.
  provideKeyBox(authorityPeer);
  const imageBox = createImageBox();
  // Memory is kept on the authority too: recall there searches it, and
  // recall on another computer asks it (POST /memory).
  const memory = createMemoryRoute({
    authority: async () => (authority.id && selfId !== authority.id ? (await machines.peer(authority.id).catch(() => null))?.url ?? '' : null),
  });
  // So are Messages, with the Unipile key: /inbox/ here asks the PC when
  // this is not it (system/inbox.mjs), and an agent's draft is told to
  // this computer's windows. A hosted computer shows the demo inbox unless
  // its machine.json says otherwise ("inbox"); the PC lends its own only to
  // the computers it names (system/inbox-lend.mjs).
  const messagesFrom = inboxSource({ hosted, inbox: options.inboxSetting });
  // The person's real messages, from their own computers only: this one's
  // screen, and through the tailnet their own devices -- never a tagged
  // node, someone else's shared one, a computer that says it is hosted, or
  // Funnel. (A computer reached some other way says "inbox": "own".)
  const ownDevicesOnly = async req => {
    const h = req.headers;
    if (h['tailscale-funnel-request']) return 'Messages are never on the public internet';
    if (!h['x-forwarded-for'] && !h['tailscale-user-login'] && !h['tailscale-user-name']) return '';
    const from = String(h['x-forwarded-for'] ?? '').split(',')[0].trim();
    const own = h['tailscale-user-login'] && from && await machines.caller?.(from).catch(() => null);
    return own ? '' : 'Messages are only for the person\'s own computers';
  };
  const inbox = createInboxRoute({
    source: messagesFrom,
    authority: authorityPeer,
    dir: join(stateDir, 'inbox'),
    // A separate server/test state must not silently read this PC's live key.
    // start.mjs supplies the actual computer's credentials explicitly.
    keyFile: join(stateDir, 'inbox', 'unipile.json'),
    // Session sockets (including /peer/.../pi) are not inbox authority.
    // Broadcast only an invalidation; words and keys stay behind /inbox/'s guard.
    tell: () => { for (const ws of clients) send(ws, { type: 'inbox-changed' }); },
    guard: messagesFrom.kind === 'personal' ? ownDevicesOnly : async () => '',
    ...options.inbox,
  });
  let lend = null;
  // An agent's browser follows the person: to the window they used last, on
  // this computer or another; from the phone, this computer's, which the phone
  // watches live (apps/code/native/browser.mjs).
  // options.browser: the windows' sockets, in the tests.
  const browser = createBrowser({
    self: async () => ({ id: await machines.selfId(), name: await machines.self() }),
    peer: identity => machines.peer(identity),
    peers: async () => (await machines.list()).filter(machine => !machine.self && machine.reachable && machine.url),
    here: url => shown.here(url),
    ...options.browser,
  });
  provideBrowser(browser);
  // Wi-Fi, Bluetooth, sound, brightness, battery and power, for this
  // computer's own screen only (system/controls.mjs).
  const controls = createSystemControls({ hosted,
    onPowerMenu: () => { for (const ws of clients) if (ws.own) send(ws, { type: 'power-menu' }); },
    ...options.controls });
  // The clipboard's history and the screenshot key, for the same screen only
  // (system/clipboard.mjs); a screenshot is told to that screen's windows.
  const clipboard = createClipboard({
    hosted,
    onBegin: capture => { for (const ws of clients) if (ws.own) send(ws, { type: 'screenshot-begin', capture }); },
    onShot: (name, target) => { for (const ws of clients) if (ws.own) send(ws, { type: 'screenshot', name, ...target }); },
    ...options.clipboard,
  });
  const phoneApp = createPhoneApp({
    authority: async () => (authority.id && selfId !== authority.id ? (await machines.peer(authority.id))?.url ?? null : null),
  });
  // Every machine runs a checkout of the product (install.sh), updated only
  // when its person takes an update; open windows reload themselves when the
  // build changes, which is at a restart (pageSnapshot).
  const { build } = surface;

  // The sessions on this disk, each saying which machine it is on. The rail
  // shows several machines' history at once, and a row that did not say where
  // it lives could only be opened by guessing.
  const sessionIndexPath = join(stateDir, 'peer-sessions.json');
  let sessionIndex = {};
  try {
    const parsed = JSON.parse(await readFile(sessionIndexPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sessionIndex = parsed;
  } catch { /* the index is a disposable view; transcripts remain at their owners */ }
  let sessionSave = Promise.resolve();
  let sessionSaveSeq = 0;
  function saveSessionIndex() {
    sessionSave = sessionSave.then(async () => {
      const snapshot = JSON.stringify(sessionIndex);
      const next = `${sessionIndexPath}.${process.pid}.${++sessionSaveSeq}.tmp`;
      await writeFile(next, `${snapshot}\n`, { mode: 0o600 });
      await rename(next, sessionIndexPath);
    });
    return sessionSave;
  }
  async function localSessions() {
    const [me, owner] = await Promise.all([machines.self(), machines.selfId()]);
    const rows = await runtime.command({ type: 'sessions' }).catch(() => []);
    return (rows ?? []).map(row => ({ ...row, machine: me, owner }));
  }
  // Cache only the list metadata, never transcript contents. That lets an
  // offline owner keep its rows under its own heading without making those
  // rows runnable anywhere else.
  async function readAllSessions() {
    const [own, peers] = await Promise.all([localSessions(), machines.list().catch(() => [])]);
    let changed = false;
    const theirs = await Promise.all(peers.filter(peer => !peer.self).map(async peer => {
      if (peer.reachable) try {
        const res = await fetch(`${peer.url}/sessions.json`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`session list ${res.status}`);
        const rows = ((await res.json()).sessions ?? []).slice(0, 2000).map(row => ({ ...row, machine: peer.name, owner: peer.id, offline: false }));
        sessionIndex[peer.id] = { machine: peer.name, rows, seenAt: Date.now() };
        changed = true;
        return rows;
      } catch { /* retain the last owner-qualified index below */ }
      return (sessionIndex[peer.id]?.rows ?? []).map(row => ({ ...row, machine: peer.name, owner: peer.id, offline: true }));
    }));
    if (changed) await saveSessionIndex().catch(() => {});
    return [...own, ...theirs.flat()].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
  }
  let sessionRead = Promise.resolve([]);
  function allSessions() {
    // A slow older peer response must not overwrite a newer cache snapshot.
    // Serializing the bounded metadata refresh also serializes its atomic save.
    sessionRead = sessionRead.then(readAllSessions, readAllSessions);
    return sessionRead;
  }
  async function readJson(req, limit = 8192) {
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      body += chunk;
      if (body.length > limit) throw Object.assign(new Error('too long'), { status: 413 });
    }
    return JSON.parse(body || '{}');
  }
  const sendJson = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  // A request for another machine, answered by that machine. Every surface
  // stays on its own origin -- no CORS, no second login -- and reaching the
  // desktop's disk from the laptop is the same request with a prefix. It does
  // not chain: `/peer/a/peer/b` would let one machine be used to hide another.
  const httpRelays = new Set();
  const HOP = new Set(['host', 'origin', 'referer', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-user']);
  // A refusal is a sentence, said as one: never a file, to a browser or a
  // phone's WebView guessing at a response with no type.
  const PLAIN = { 'content-type': 'text/plain; charset=utf-8' };
  async function proxyPeer(req, res, name, rest) {
    // Another computer's Wi-Fi, power or screen is never changed from here.
    let asked = [];
    try { asked = [rest.split('?')[0], new URL(rest, 'http://peer').pathname].map(decodeURIComponent); } catch { /* refused below */ }
    if (!asked.length || asked.some(path => /^\/+(?:system|clipboard|screenshots)(?:\/|$)/.test(path))) { res.writeHead(403, PLAIN).end('system controls act only on the computer whose screen this is'); return; }
    const peer = await machines.peer(name);
    if (!peer) { res.writeHead(404, PLAIN).end(`${name} is not reachable`); return; }
    if (!rest.startsWith('/') || rest.startsWith('/peer/')) { res.writeHead(400, PLAIN).end('bad peer path'); return; }
    // The other computer cannot tell where a browser asked from, once this
    // one has asked for it; its files are refused here as they would be there.
    if (asked.some(path => READS.has(path)) && fromElsewhere(req)) { res.writeHead(403, PLAIN).end('files are read only from Workbench'); return; }
    // Messages are asked of this computer's own /inbox/, which knows where they are kept.
    if (asked.some(isInboxPath)) { res.writeHead(403, PLAIN).end('messages are read only from this computer\'s own /inbox/'); return; }
    if (req.method === 'POST' && /^\/(upload|dictate|transcribe)$/.test(rest.split('?')[0]) && !req.headers.origin) { res.writeHead(403, PLAIN).end('exact origin required'); return; }
    await relayPeer(req, res, peer, rest);
  }
  async function relayPeer(req, res, peer, rest) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) if (!HOP.has(key)) headers[key] = value;
    // A minute to answer; then as long as it takes, so a film plays on and
    // a stream of changes stays open, until this end goes away.
    const stop = new AbortController();
    httpRelays.add(stop);
    const attachment = req.method === 'POST' && /^\/(upload|dictate|transcribe)$/.test(rest.split('?')[0]);
    if (attachment) headers.origin = new URL(peer.url).origin;
    const slow = setTimeout(() => stop.abort(), attachment ? UPLOAD_TIMEOUT_MS : 60_000);
    res.once('close', () => { httpRelays.delete(stop); stop.abort(); });
    let upstream;
    try {
      upstream = await fetch(`${peer.url}${rest}`, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Readable.toWeb(req),
        duplex: 'half',
        redirect: 'manual',
        signal: stop.signal,
      });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) res.writeHead(502, PLAIN).end(`${peer.name}: ${error.message}`);
      return;
    } finally {
      clearTimeout(slow);
    }
    res.removeHeader('Content-Security-Policy');
    const out = {};
    for (const key of ['content-type', 'cache-control', 'content-disposition', 'content-security-policy', 'location', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag', 'x-accel-buffering']) {
      const value = upstream.headers.get(key);
      if (value) out[key] = value;
    }
    res.writeHead(upstream.status, out);
    if (!upstream.body) { res.end(); return; }
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  }
  // Another machine's agent socket is the same request: `/peer/<id>/pi`, the
  // same lookup, never chained; and its live browser, `/peer/<id>/browser/live`.
  // Once that machine accepts the upgrade the two sockets are joined byte for
  // byte; each end keeps its own limits and checks.
  const relayed = new Set();
  async function proxyPeerSocket(req, socket, head, name, rest = '/pi') {
    socket.on('error', () => socket.destroy());
    const refuse = status => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    const peer = await machines.peer(name);
    if (!peer) { refuse('404 Not Found'); return; }
    const target = new URL(rest, peer.url);
    const headers = { connection: 'Upgrade', upgrade: 'websocket', origin: target.origin, 'x-imperfect-peer': selfId };
    for (const key of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) if (req.headers[key]) headers[key] = req.headers[key];
    const ask = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { headers, timeout: 5000 });
    const gone = () => ask.destroy();
    socket.once('close', gone);
    ask.on('timeout', () => ask.destroy(new Error('timeout')));
    ask.on('error', () => refuse('502 Bad Gateway'));
    ask.on('response', res => { res.resume(); refuse('502 Bad Gateway'); });
    ask.on('upgrade', (res, upstream, upstreamHead) => {
      socket.off('close', gone);
      upstream.setTimeout(0);
      if (socket.destroyed) { upstream.destroy(); return; }
      let reply = 'HTTP/1.1 101 Switching Protocols\r\n';
      for (let i = 0; i < res.rawHeaders.length; i += 2) reply += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
      socket.write(`${reply}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      relayed.add(socket);
      const end = () => { relayed.delete(socket); socket.destroy(); upstream.destroy(); };
      for (const side of [socket, upstream]) side.on('error', end).on('close', end);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    ask.end();
  }
  let server;
  // Tailscale names can change while the process stays alive. Re-read the
  // self-origin through the bounded discovery cache for every validation
  // decision; this widens trust only to this node's current tailnet identity.
  const uiHost = () => `${host}:${server.address()?.port ?? port}`;
  const validRequest = async req => {
    const expectedHost = uiHost();
    const dynamic = await machines.origins().catch(() => []);
    const origins = [...configuredOrigins, ...dynamic.map(origin => new URL(origin))];
    const trusted = new Set([expectedHost, ...origins.flatMap(url => [url.host, url.hostname])]);
    const bare = req.headers.host?.replace(/:\d+$/, '');
    if (!trusted.has(req.headers.host) && !trusted.has(bare)) return false;
    if (!req.headers.origin) return true;
    return [`http://${expectedHost}`, ...origins.map(url => url.origin)].includes(req.headers.origin);
  };

  function sendAsset(res, { body, type, versioned, favicon }) {
    // The trusted favicon's inline media-query CSS must work even when the
    // page disallows inline styles. This policy still permits no scripts.
    if (favicon) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : type.includes('charset') ? 'no-cache' : 'public, max-age=3600');
    res.end(body);
  }

  server = createServer({ requestTimeout: 0, headersTimeout: 60_000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // {pages}: where what agents show plays from, this computer's page
    // origin and the others' (system/shown.mjs).
    // Only Kinso's dedicated hosted computer embeds its visitor-side concept.
    // Keep ordinary imperfect browsers and every other frame source unchanged.
    const policy = POLICY.replaceAll('{pages}', await shown.sources());
    res.setHeader('Content-Security-Policy', hosted && hostedPageOrigin === 'https://computer.kinso.computer'
      ? policy.replace("frame-src 'self'", "frame-src 'self' https://kinso.computer/kinso/") : policy);

    let path, search = '';
    try {
      const asked = new URL(req.url, 'http://local');
      path = decodeURIComponent(asked.pathname);
      search = asked.search;
    }
    catch { res.writeHead(400).end('Bad path'); return; }
    if (!await validRequest(req)) { res.writeHead(403, PLAIN).end('Private local origin required'); return; }

    // Native pairing is WebSocket-only; no public HTTP action/registration API.
    if (path === '/device-hands' || path.startsWith('/device-hands/')) { res.writeHead(404).end(); return; }
    // imperfect's tools for its agents (mcp.mjs); a call takes as long as it takes.
    if (await serveMcp(req, res, path)) return;
    if (await controls(req, res, path)) return;
    if (await clipboard.handle(req, res, path)) return;
    // Byte uploads and hearing have their own body deadlines; decoding/hearing
    // can outlast a short POST, as can media generation and X processing.
    if (req.method === 'POST' && !/^\/(?:peer\/[^/]+\/)?(?:upload|dictate|transcribe)$/.test(path) && path !== '/images/make') {
      const timer = setTimeout(() => {
        if (!res.headersSent) res.writeHead(408).end('timeout');
        req.destroy();
      }, OTHER_POST_TIMEOUT_MS);
      res.once('close', () => clearTimeout(timer));
      res.once('finish', () => clearTimeout(timer));
    }


    if (path === '/transcribe' && req.method === 'POST') {
      if (!req.headers.origin) { res.writeHead(403).end('exact origin required'); return; }
      await transcribe(req, res, path);
      return;
    }
    if (await dictation(req, res, path)) return;

    if (path === '/upload' && req.method === 'POST') {
      if (!req.headers.origin) { res.writeHead(403).end('exact origin required'); return; }
      try {
        const target = attachmentTarget({ tab: req.headers['x-tab-id'], session: req.headers['x-session-id'] || null, instanceId: req.headers['x-instance-id'] });
        const saved = await receiveHttpUpload(req, {
          cwd: target.cwd,
          res,
          filename: filenameFromHeader(req.headers['x-filename']),
          maxBytes: uploadMaxBytes,
          timeoutMs: uploadTimeoutMs,
        });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ...saved, reference: await uploadReference(saved, target) }));
      } catch (error) {
        if (!res.headersSent) res.writeHead(Number(error.status) || 500).end(error.message || 'upload failed');
        req.destroy();
      }
      return;
    }

    if (path.startsWith('/peer/')) {
      const raw = req.url.slice('/peer/'.length);
      const cut = raw.indexOf('/');
      await proxyPeer(req, res, cut < 0 ? raw : raw.slice(0, cut), cut < 0 ? '/' : raw.slice(cut));
      return;
    }
    // The computer the others follow is marked home: a new session starts
    // there unless the person picks another (harness.js).
    if (path === '/machines.json' && req.method === 'GET') {
      sendJson(res, 200, { authority: authority.id || '', machines: (await machines.list()).map(machine => ({ ...machine, ...(machine.self ? { hosted } : {}), home: authority.id ? machine.id === authority.id : hosted && Boolean(machine.self) })) });
      return;
    }
    if (path === '/pulse.json' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      sendJson(res, 200, await pulse.view());
      return;
    }
    if (path === '/sessions.json' && req.method === 'GET') {
      sendJson(res, 200, { machine: await machines.self(), sessions: await localSessions() });
      return;
    }
    if (await files(req, res, path, search)) return;
    if (await shown.handle(req, res, path)) return;
    if (await projects.handle(req, res, path)) return;
    if (await imageBox(req, res, path)) return;
    if (await memory(req, res, path)) return;
    if (await inbox(req, res, path, search)) return;
    if (await phoneApp(req, res, path)) return;
    // Another of the person's computers, for an agent whose person is at a
    // window here: this computer's windows answer. Guarded like /images/make: only
    // this computer's own tailnet name or loopback, with the exact origin,
    // which a page elsewhere cannot claim and /peer/ drops.
    if (path === '/browser' && req.method === 'POST') {
      if (!req.headers.origin) { sendJson(res, 403, { error: 'exact origin required' }); return; }
      const stop = new AbortController();
      res.once('close', () => { if (!res.writableFinished) stop.abort(); });
      try { sendJson(res, 200, await browser.answer(await readJson(req, 4 * 1024 * 1024), { signal: stop.signal })); }
      catch (error) { if (!res.headersSent) sendJson(res, 502, { error: error.message }); }
      return;
    }
    if (await notifications.handle(req, res, path, { local: localCaller })) return;
    if (path === '/sessions/open' && req.method === 'POST') {
      const expected = await sessionToken();
      const supplied = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(403).end('session token required'); return; }
      const { cwd, agent, name, prompt, model, thinking, computer } = await readJson(req, 64 * 1024);
      // A harness that can't start here (Claude not signed in yet) is the
      // caller's answer, never a reason for imperfect itself to stop.
      try { sendJson(res, 200, await openSession({ cwd, agent: ['pi', 'claude', 'codex'].includes(agent) ? agent : 'pi', name, prompt, model, thinking, computer })); }
      catch (error) { if (!res.headersSent) sendJson(res, 409, { error: error.message }); }
      return;
    }
    // The themes (system/theme.mjs): Mac · Dark, Mac · Light, and the
    // person's own in ~/.imperfect/themes.
    if (path === '/themes.json' && req.method === 'GET') {
      const themes = await listThemes(home).catch(() => []);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ auto: (await themeChoice(home)) === AUTO, themes: themes.map(({ id, name, mode, background, foreground, accent, current }) => ({ id, name, mode, background, foreground, accent, current })) }));
      return;
    }
    if (path === '/theme' && req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) { res.writeHead(413).end('too long'); return; }
      }
      try {
        const asked = JSON.parse(body || '{}');
        await setTheme(asked?.id, home);
        void lookUpdates.request();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ id: asked.id }));
      } catch (error) {
        res.writeHead(400).end(error.message || 'no such theme');
      }
      return;
    }
    if (path.startsWith('/media/') && req.method === 'GET') {
      const picture = media.get(path.slice('/media/'.length));
      if (!picture) { res.writeHead(404).end('No such picture'); return; }
      res.setHeader('Content-Type', picture.type || 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.end(picture.body);
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (path === '/health') {
      const snapshot = runtime.snapshot();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ok: !snapshot.failed,
        pulse: await pulse.summary(),
        handoff: { ...handoff.snapshot(), host: snapshot.handoff ?? null },
        ui: 'native-gui',
        protocol: MACHINE_PROTOCOL,
        capabilities: MACHINE_CAPABILITIES,
        hosted,
        owner: await machines.selfId(),
        machine: await machines.self(),
        pid: process.pid,
        cwd: snapshot.cwd,
        sessionId: snapshot.sessionId,
        busy: (snapshot.tabs ?? []).some(tab => tab.status === 'working' || tab.status === 'blocked'), // a question still holds a turn
      }));
      return;
    }
    if (path === '/theme.css' && new URLSearchParams(search).get('theme')) {
      const theme = await readTheme(new URLSearchParams(search).get('theme'), home);
      if (!theme) { res.writeHead(404).end('No such theme'); return; }
      const css = themeCss(theme);
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      // private: a theme's colours change here (Locus did), and a shared cache
      // in front of the demo kept the old ones for every visitor
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.end(css);
      return;
    }
    if (path === '/theme.css') {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.end((await currentLook(home)).css);
      return;
    }
    const found = asset(surface, path);
    if (!found) { res.writeHead(404).end('Not found'); return; }
    sendAsset(res, found);
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  // A phone whose network went away with its screen leaves a socket that
  // reads as open for minutes. A ping every half minute finds it and lets it
  // go; meanwhile the traffic keeps the flow alive through NAT and the tailnet.
  // The person's phone watching this computer's browser (browser.mjs, relayLive).
  const liveSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const heartbeat = setInterval(() => {
    for (const ws of [...sockets.clients, ...liveSockets.clients]) {
      if (ws.alive === false) { ws.terminate(); continue; }
      ws.alive = false;
      try { ws.ping(); } catch { ws.terminate(); }
    }
  }, 30_000);
  heartbeat.unref?.();
  const send = (ws, value) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(value));
  };
  const sendSnapshot = (ws, raw) => {
    if (ws.readyState !== 1 || ws.bufferedAmount > 1024 * 1024) return false;
    ws.send(raw);
    return true;
  };
  const withTabs = data => ({
    ...data,
    tabs: (data.tabs ?? []).map(tab => ({
      ...tab,
      name: tab.name || tabLabel({ name: tab.name, sessionId: tab.sessionId, messages: tab.messages }),
      status: tab.status ?? ((tab.focused ? data.busy : tab.busy) ? 'working' : 'idle'),
      workspace: tab.workspace ?? basename(String(tab.cwd ?? data.cwd ?? '').replace(/[\\/]+$/, '')),
    })),
  });
  // A picture pasted into a conversation stayed in it as base64, so every
  // update to a long session carried every picture again. The window is
  // handed an address instead and the bytes are kept here by content hash;
  // what the model receives is untouched. A viewed message is remembered by
  // identity, so a message that did not change is the same object each time.
  const MEDIA_BYTES = 64 * 1024 * 1024;
  const media = new Map(); // sha256 -> { type, body }
  let mediaBytes = 0;
  const viewed = new WeakMap();
  // The window never draws how an answer was reached: what the model
  // thought and what it passed to its tools stay here, and the window gets
  // only that they were there. They were most of a long session's bytes.
  const THOUGHT = Object.freeze({ type: 'thinking' });
  const unseen = block => block?.type === 'thinking' || block?.type === 'toolCall' || (block?.type === 'image' && typeof block.data === 'string');
  const viewBlock = block => {
    if (!unseen(block)) return block;
    if (block.type === 'thinking') return THOUGHT;
    if (block.type === 'toolCall') {
      if (!viewed.has(block)) viewed.set(block, { block: { type: 'toolCall', id: block.id, name: block.name } });
      return viewed.get(block).block;
    }
    const kept = viewed.get(block);
    if (kept && media.has(kept.id)) return kept.block;
    const body = Buffer.from(block.data, 'base64');
    const id = createHash('sha256').update(body).digest('hex');
    if (!media.has(id)) {
      for (const [old, entry] of media) { if (mediaBytes + body.length <= MEDIA_BYTES) break; media.delete(old); mediaBytes -= entry.body.length; }
      media.set(id, { type: block.mimeType, body });
      mediaBytes += body.length;
    }
    const { data: _bytes, ...rest } = block;
    const shown = { ...rest, url: `/media/${id}` };
    viewed.set(block, { id, block: shown });
    return shown;
  };
  // What a tool said back is drawn only as what it showed: the line saying
  // so, which pages.js reads (windowOf), and its pictures. Its whole output (a
  // build log, a file) went to the window only to be searched for that line.
  const viewResult = entry => {
    const kept = viewed.get(entry);
    if (kept?.result && kept.pictures.every(id => media.has(id))) return kept.message;
    const blocks = Array.isArray(entry.content) ? entry.content : [{ type: 'text', text: String(entry.content ?? '') }];
    const line = blocks.filter(block => block?.type === 'text').flatMap(block => String(block.text ?? '').split('\n')).find(windowOf);
    const pictures = blocks.filter(block => block?.type === 'image' && typeof block.data === 'string').map(viewBlock);
    const { content: _output, details: _details, ...rest } = entry;
    const message = { ...rest, content: [...(line ? [{ type: 'text', text: line }] : []), ...pictures] };
    viewed.set(entry, { result: true, message, pictures: pictures.map(picture => picture.url.slice('/media/'.length)) });
    return message;
  };
  const viewMessage = entry => {
    if (entry?.role === 'toolResult') return viewResult(entry);
    if (!Array.isArray(entry?.content) || !entry.content.some(unseen)) return entry;
    const kept = viewed.get(entry);
    const content = entry.content.map(viewBlock);
    if (kept && kept.content.every((block, i) => block === content[i])) return kept.message;
    const message = { ...entry, content };
    viewed.set(entry, { content, message });
    return message;
  };
  // `from` is where the messages sent begin in the whole conversation.
  const view = (data, from = 0) => withTabs({ ...data, ...(data.messages ? { messages: data.messages.slice(from).map(viewMessage), messagesFrom: from } : {}),
    partial: viewMessage(data.partial), handoff: { ...handoff.snapshot(), host: data.handoff ?? null } });
  // A window is sent the newest tenth, at least forty and at most two
  // hundred messages, and asks for the rest in equally bounded pages as
  // the reader scrolls up (messages-before). The session itself is untouched.
  const PAGE = 40;
  const pageOf = total => Math.min(200, Math.max(PAGE, Math.ceil(total / 10)));
  const latest = data => { const total = data.messages?.length ?? 0; return view(data, Math.max(0, total - pageOf(total))); };

  let timer;
  let retryTimer;
  // Once a window holds a session, an update carries only the messages
  // added since (messagesBase, messagesTail) beside the small live fields,
  // and the window appends. Another session, a history that shrank, or a
  // last message that changed underneath goes whole again. A streamed token
  // used to resend every message of the conversation.
  const sameMessage = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
  const remember = (ws, data) => { ws.warm?.delete(ws.selectedTabId); ws.sent = { sessionId: data.sessionId, count: data.messages?.length ?? 0, last: viewMessage(data.messages?.at(-1)) }; };
  function snapshotFor(ws, data) {
    const messages = data.messages ?? [];
    const sent = ws.sent;
    if (!sent || sent.sessionId !== data.sessionId || messages.length < sent.count || (sent.count && !sameMessage(viewMessage(messages[sent.count - 1]), sent.last))) return latest(data);
    const { messages: _whole, ...rest } = data;
    return { ...view(rest), messagesBase: sent.count, messagesTail: messages.slice(sent.count).map(viewMessage) };
  }
  // Only a visible desktop talking to its own machine keeps background tabs
  // warm. Phones, peer viewers and hidden windows keep the selected stream.
  function warmTabs(ws, tabs) {
    if (!ws.localSurface || ws.surfaceKind !== 'desktop' || !ws.visible) return true;
    ws.warm ??= new Map();
    const kept = new Set(tabs.slice(0, 32).map(tab => tab.id));
    for (const id of ws.warm.keys()) if (!kept.has(id)) ws.warm.delete(id);
    for (const tab of tabs.slice(0, 32)) {
      if (tab.id === ws.selectedTabId) continue;
      const previous = ws.warm.get(tab.id);
      if (previous && tab.revision != null && previous.revision === tab.revision && previous.sessionId === tab.sessionId) continue;
      const data = runtime.snapshot(tab.id);
      const base = { sent: previous?.sent };
      if (!sendSnapshot(ws, JSON.stringify({ type: 'tab-snapshot', tabId: tab.id, data: snapshotFor(base, data) }))) return false;
      remember(base, data);
      ws.warm.set(tab.id, { revision: tab.revision, sessionId: data.sessionId, sent: base.sent });
    }
    return true;
  }
  const flushSnapshots = () => {
    let blocked = false;
    for (const ws of clients) {
      const data = runtime.snapshot(ws.selectedTabId);
      if (sendSnapshot(ws, JSON.stringify({ type: 'snapshot', data: snapshotFor(ws, data) }))) remember(ws, data); else blocked = true;
      if (!warmTabs(ws, data.tabs ?? [])) blocked = true;
    }
    if (blocked && !retryTimer) retryTimer = setTimeout(() => { retryTimer = null; flushSnapshots(); }, 80);
  };
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flushSnapshots(); }, 40);
  };
  const emitTurn = info => { for (const ws of clients) send(ws, { type: 'turn', ...info }); };
  // Explicitly requested interactive work: a new tab, named, with an optional
  // first prompt, and for a Pi session a model ("provider/id") and thinking
  // level of its own, which leave the person's defaults as they are. Attach
  // its rejection handler before starting the prompt; the opener must not
  // wait for the whole agent turn.
  provideSessions(async ({ cwd, agent, name, prompt, model, thinking, computer }) => {
    const peer = await sessionComputer(machines, computer);
    if (peer) return openPeerSession(peer, { cwd, agent, name, prompt, model, thinking });
    const made = await runtime.command({ type: 'tab-new', agent, ...(cwd ? { cwd } : {}) });
    if (name) await runtime.command({ type: 'name', name }, made.id).catch(() => {});
    if (agent === 'pi' && typeof model === 'string' && model.includes('/')) {
      const cut = model.indexOf('/');
      await runtime.command({ type: 'model', provider: model.slice(0, cut), modelId: model.slice(cut + 1), persist: false }, made.id)
        .catch(error => console.error(`code_session: model ${model}: ${error.message}`));
    }
    if (agent === 'pi' && typeof thinking === 'string' && thinking) await runtime.command({ type: 'thinking', level: thinking }, made.id).catch(error => console.error(`code_session: thinking ${thinking}: ${error.message}`));
    if (prompt) void Promise.resolve().then(() => runtime.command({ type: 'prompt', text: prompt }, made.id))
      .catch(error => console.error(`code_session: first message: ${error.message}`));
    return { id: made.id };
  });
  // What this machine looks like -- theme and build -- told to every window
  // when it connects and again whenever it changes. Nothing polls.
  const emitLook = async (only = null) => {
    const { theme, rev } = await currentLook(home).catch(() => ({}));
    const raw = JSON.stringify({ type: 'look', data: { theme, rev, build } });
    for (const ws of only ? [only] : clients) sendSnapshot(ws, raw);
  };
  const lookUpdates = coalescedTask(emitLook);
  const stopThemes = watchThemes(() => { void lookUpdates.request(); }, home);
  runtime.events.on('change', changed);
  runtime.events.on('settled', emitTurn);

  server.on('upgrade', async (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { socket.destroy(); return; }
    if (url.pathname === '/device-hands') { await deviceHands.upgrade(req, socket, head); return; }
    const peer = /^\/peer\/([^/]+)(\/pi|\/browser\/live)$/.exec(url.pathname);
    const live = url.pathname === '/browser/live';
    if (!await validRequest(req) || url.search || (url.pathname !== '/pi' && !live && !peer)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    if (peer) { await proxyPeerSocket(req, socket, head, peer[1], peer[2]); return; }
    if (live) {
      liveSockets.handleUpgrade(req, socket, head, ws => {
        ws.alive = true;
        ws.on('pong', () => { ws.alive = true; });
        browser.live(ws);
      });
      return;
    }
    const own = await clipboard.own(req);
    sockets.handleUpgrade(req, socket, head, ws => {
      ws.own = own;
      ws.alive = true;
      ws.on('pong', () => { ws.alive = true; });
      // Tailscale Serve terminates remote connections on the loopback listener,
      // so remoteAddress is not an authority signal. The original Host remains
      // the owner DNS name; only a loopback Host may claim desktop face state.
      attach(ws, loopbackRequest(req.headers.host), req.headers['x-imperfect-peer']);
    });
  });
  // Asks a window to show a computer's browser live (pages.js, watch).
  const tellBrowse = ws => ({ front, machine }) => ws.readyState === 1 && (send(ws, { type: 'browse', front: Boolean(front), machine: String(machine ?? '') }), true);
  function attach(ws, localSurface, peerMachine) {
    clients.add(ws);
    // Diagnostic declarations only, never authorization. No headers/tokens
    // are copied into the close record.
    ws.closeConnection = { kind: peerMachine ? 'peer' : localSurface ? 'local' : 'viewer', machine: typeof peerMachine === 'string' ? peerMachine.slice(0, 256) : null };
    ws.localSurface = localSurface;
    ws.selectedTabId = runtime.snapshot().tabs?.find(tab => tab.focused)?.id ?? null;
    const first = runtime.snapshot(ws.selectedTabId);
    send(ws, { type: 'snapshot', data: latest(first) });
    remember(ws, first);
    void emitLook(ws);
    ws.on('error', () => {});
    ws.on('close', () => {
      clients.delete(ws);
      changed();
    });
    ws.on('message', async raw => {
      let command, closeDispatched = false;
      try {
        command = JSON.parse(raw.toString());
        if (!command || Array.isArray(command) || typeof command.type !== 'string' || typeof command.id !== 'string') throw new Error('Command requires string id and type');
        if (command.type === 'hello') {
          const askedKind = ['phone', 'desktop', 'viewer'].includes(command.kind) ? command.kind : 'viewer';
          ws.surfaceKind = askedKind === 'desktop' && !ws.localSurface ? 'viewer' : askedKind;
          ws.closeConnection = { kind: askedKind === 'phone' ? 'phone' : peerMachine ? 'peer' : ws.surfaceKind === 'desktop' ? 'local' : 'viewer',
            machine: typeof command.machine === 'string' ? command.machine.slice(0, 256) : ws.closeConnection.machine };
          ws.visible = command.visible !== false;
          // A hosted computer's person is only ever on the web, where no
          // window takes websites: the one they opened last watches this
          // computer's browser live, as a phone does.
          if (hosted && !ws.localSurface && ws.visible) browser.seen({ machine: selfId, kind: 'phone', tell: tellBrowse(ws) });
          send(ws, { type: 'response', id: command.id, success: true, data: { kind: ws.surfaceKind } });
          if (!warmTabs(ws, runtime.snapshot(ws.selectedTabId).tabs ?? [])) changed();
          return;
        }
        // The person used a window just now (harness.js): on this computer or
        // another, or the phone, which an agent's browser asks to show this
        // computer's browser live.
        if (command.type === 'here') {
          // Nobody sits at a hosted computer: its own window, on a screen no
          // one sees, takes focus as the agent opens tabs, not as a person.
          if (!(hosted && ws.localSurface)) browser.seen({ machine: command.machine, kind: command.kind, ago: command.ago, tell: tellBrowse(ws) });
          send(ws, { type: 'response', id: command.id, success: true, data: null });
          return;
        }
        if (command.type === 'machine-restart') {
          send(ws, { type: 'response', id: command.id, success: true, data: handoff.request() });
          return;
        }
        if (command.type === 'sessions') {
          send(ws, { type: 'response', id: command.id, success: true, data: await allSessions() });
          return;
        }
        if (command.type === 'session-attach') {
          const me = await machines.selfId();
          if (String(command.owner ?? '') !== me) throw new Error('Session owner does not match this machine');
          const open = runtime.snapshot(ws.selectedTabId).tabs?.find(item => item.sessionId === command.sessionId && item.agent === command.agent);
          const row = open ? null : (await localSessions()).find(item => item.id === command.sessionId && item.agent === command.agent);
          if (!open && !row) throw new Error('That session is not on this machine');
          const data = open ?? await runtime.command({ type: 'tab-open', path: row.path ?? row.id, agent: row.agent, cwd: row.cwd ?? '' }, ws.selectedTabId);
          ws.selectedTabId = data.id;
          send(ws, { type: 'response', id: command.id, success: true, data });
          changed();
          return;
        }
        if (command.type === 'tab-focus') {
          const tab = runtime.snapshot(ws.selectedTabId).tabs?.find(item => item.id === command.tabId);
          if (!tab) throw new Error('Unknown tab');
          ws.selectedTabId = tab.id;
          const whole = runtime.snapshot(tab.id);
          // A switch is one response that carries the tab's snapshot.
          send(ws, { type: 'response', id: command.id, success: true, data: { ...tab, focused: true, snapshot: latest(whole) } });
          remember(ws, whole);
          return;
        }
        // The page before `before` of a conversation, for a window scrolled
        // up to the start of what it holds.
        if (command.type === 'messages-before') {
          const data = runtime.snapshot(command.tabId ?? ws.selectedTabId);
          if (!data.sessionId || data.sessionId !== command.sessionId) throw new Error('That session is no longer in this tab');
          const messages = data.messages ?? [];
          const before = Math.min(Math.max(0, Math.floor(Number(command.before)) || 0), messages.length);
          const from = Math.max(0, before - pageOf(messages.length));
          send(ws, { type: 'response', id: command.id, success: true, data: { sessionId: data.sessionId, from, messages: messages.slice(from, before).map(viewMessage) } });
          return;
        }
        // Dialog sheets can be answered after the viewer has left their tab.
        // Resolve the captured tab explicitly, never against the new selection.
        const selectedAtStart = ws.selectedTabId;
        const targetId = command.type === 'dialog' && command.expectedTabId != null ? command.expectedTabId : selectedAtStart;
        if (command.type === 'dialog' && command.expectedTabId != null && !runtime.snapshot(selectedAtStart).tabs?.some(tab => tab.id === targetId)) throw new Error('Unknown dialog tab');
        const snapshot = runtime.snapshot(targetId);
        const stale = staleCommandError(command, snapshot) || tabCloseBusyError(command, snapshot);
        if (stale) throw new Error(stale);
        closeDispatched = command.type === 'tab-close';
        let data = await runtime.command(command, targetId, { connection: ws.closeConnection });
        if (command.type === 'tab-new' || command.type === 'tab-open') ws.selectedTabId = data?.id ?? ws.selectedTabId;
        if (command.type === 'model' && data?.__selectedTabId) {
          if (ws.selectedTabId === selectedAtStart) ws.selectedTabId = data.__selectedTabId;
          data = data.value;
        }
        if (command.type === 'tab-close' && command.tabId === ws.selectedTabId) {
          ws.selectedTabId = runtime.snapshot(ws.selectedTabId).tabs?.find(tab => tab.focused)?.id ?? null;
        }
        if (command.type === 'snapshot') { remember(ws, data); data = latest(data); }
        send(ws, { type: 'response', id: command.id, success: true, data });
        changed();
      } catch (error) {
        if (command?.type === 'tab-close' && !closeDispatched) runtime.auditCloseRejected?.(command, ws.closeConnection);
        send(ws, { type: 'response', id: command?.id, success: false, error: error.message });
      }
    });
  }

  let stopTabWatch = null;
  return {
    server,
    runtime,
    stateDir,
    sockets,
    handoff,
    browser,
    deviceHands,
    listen: async () => {
      // What agents show has its own listener (system/shown.mjs), there
      // before any tool can ask for an address on it.
      await shown.listen(pagePort);
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, async () => {
          const bound = server.address();
          // The desktop window onto this port is the one its agents browse in,
          // and the tabs a session opened close when it ends, wherever they are.
          provideWindowPort(bound.port);
          serveMcpOn(bound.port);
          provideDeviceHands(deviceHands);
          stopTabWatch ??= closeTabsWhenSessionsEnd(runtime, { end: browser.end });
          // All listeners/transports are bound before any restored inbox replay.
          void handoff.startDelivery();
          // The PC's inbox, lent to the computers its list names, if it has one.
          if (options.lendFile) lend = await listenLend({ local: () => inbox.local(), file: options.lendFile }).catch(() => null);
          resolveListen(bound);
        });
      });
    },
    async close() {
      stopMcpOn(server.address()?.port);
      await lend?.close();
      handoff.cancelWaiter();
      deviceHands.close();
      files.close();
      for (const stop of httpRelays) stop.abort();
      for (const socket of relayed) socket.destroy();
      stopThemes();
      lookUpdates.stop();
      clearTimeout(timer);
      clearTimeout(retryTimer);
      runtime.events.off('change', changed);
      runtime.events.off('settled', emitTurn);
      stopTabWatch?.();
      for (const ws of [...sockets.clients, ...liveSockets.clients]) ws.terminate();
      clearInterval(heartbeat);
      sockets.close();
      liveSockets.close();
      // A browser connection that never finishes its request must not hold the restart: the laptop's window hung
      // on one through an update (19 Oct), the port shut, the old server waiting forever. Idle ones close now, the
      // rest after a moment.
      await new Promise(done => {
        const cut = setTimeout(() => server.closeAllConnections(), 2000);
        server.close(() => { clearTimeout(cut); done(); });
        server.closeIdleConnections();
      });
      await shown.close();
      projects.close();
      await runtime.close();
      await unlink(lockPath);
    },
  };
}
