import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { basename, join, dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRuntime, listPiSessions } from './runtime.mjs';
import { createClaudeRuntime, listClaudeSessions, claudeAuth } from './claude-runtime.mjs';
import { createCodexRuntime, listCodexSessions, codexAuth } from './codex-runtime.mjs';
import { SOURCES } from './canonical.mjs';
import { resolvePromptUploads } from './uploads.mjs';
import { readUsageHistory } from './usage-history.mjs';
import { codexCliUsage } from './usage.mjs';
import { closeAuditRecord, appendCloseAudit } from './tab-close-audit.mjs';
import { resolvePrefix } from '../../../system/machine.mjs';

// A Pi session is a file; a Claude session is an id, and stays one, or
// resuming it hands Claude a path it does not know. A Codex session is its
// rollout file, whose name ends with the thread's id.
function canonicalPath(path) {
  if (!path) return '';
  if (!isAbsolute(path)) return path;
  try { return realpathSync(path); } catch { return resolve(path); }
}
// A legacy import and its SQLite sidecar name the same Pi continuation.
function historyIdentity(agent, path) {
  const canonical = canonicalPath(path);
  return agent === 'pi' && canonical && !canonical.endsWith('.sqlite') ? canonicalPath(`${canonical}.durable.sqlite`) : canonical;
}
// Work a tab still holds: a turn, a question, or something waiting to be sent.
function pendingWork(s = {}) {
  return Boolean(s.busy || s.streaming || s.operation || s.ui?.dialogs?.length || s.queue?.items?.length);
}
// What is said while a handoff waits, as the composer's queue shows it.
const heldItem = item => ({ id: item.id, lane: 'steering', text: item.text, ...(item.images?.length ? { images: item.images } : {}) });
const validHeld = item => item && typeof item.id === 'string' && typeof item.text === 'string' && Array.isArray(item.images);

function messageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
}

// Done-pings follow a model turn, not composer busy. Preflight, dialogs and
// auth flip `busy` as soon as a prompt is accepted; `streaming` is the run.
export function turnActive(snap) {
  return Boolean(snap?.streaming ?? snap?.busy);
}

export function firstUserLine(snap) {
  for (const entry of snap?.messages ?? []) {
    if (entry?.role !== 'user') continue;
    const line = messageText(entry.content).split('\n').map(part => part.trim()).find(Boolean);
    if (line) return line;
  }
  return '';
}

export function tabLabel(snap) {
  const named = String(snap?.name ?? '').trim();
  // The rail uses 'new' as an untitled placeholder; a real /name wins, 'new' does not.
  if (named && named !== snap.sessionId && named !== 'new') return named;
  return firstUserLine(snap) || 'new';
}

// A resumed conversation names the model that actually answered, not today's default.
export function sessionModel(snap) {
  for (let i = (snap.messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = snap.messages[i];
    if (message.role !== 'assistant') continue;
    const id = typeof message.model === 'string' ? message.model : message.model?.id;
    if (id && !id.startsWith('<')) return id;
  }
  return snap.model?.name || snap.model?.id || null;
}

function summary(tab, focused) {
  const snap = tab.runtime.snapshot();
  return {
    id: tab.id,
    sessionId: snap.sessionId,
    revision: tab.revision ?? 0,
    sessionFile: snap.sessionFile,
    name: tabLabel(snap),
    prompt: firstUserLine(snap),
    model: sessionModel(snap),
    provider: snap.model?.provider ?? null,
    busy: snap.busy,
    streaming: Boolean(snap.streaming),
    failed: snap.failed ?? null,
    status: agentStatus(tab, snap),
    // imperfect's workspace token is the only real place value this machine has:
    // the runtime's current directory. There is no second workspace layer to
    // manufacture here.
    workspace: workspaceLabel(snap.cwd),
    // The rail is the one place a person can see which agent a tab is, so it
    // travels with every summary rather than being asked for separately.
    agent: tab.agent,
    focused,
  };
}

// The rail shows one word for where an agent is working, so home is `~` rather
// than the basename of the home directory. Anywhere else keeps its own name.
export function workspaceLabel(cwd, home = homedir()) {
  const value = String(cwd ?? '').replace(/[\\/]+$/, '');
  if (!value) return '';
  const at = String(home ?? '').replace(/[\\/]+$/, '');
  if (at && value === at) return '~';
  return basename(value) || value;
}

// imperfect calls a settled background turn `done`, but only until its tab is seen
// again. The host remembers that one fact; every other state remains a direct
// reading of the runtime rather than a second lifecycle machine.
export function agentStatus(tab, snap = tab.runtime.snapshot()) {
  if (snap?.ui?.dialogs?.length) return 'blocked';
  if (snap?.failed) return 'unknown';
  if (snap?.busy || snap?.streaming || snap?.operation) return 'working';
  if (tab.unseenSettled) return 'done';
  return tab.agent ? 'idle' : 'unknown';
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// A runtime is idle when nothing it has taken is left to do: no turn, no
// question waiting on the person, nothing queued that will go by itself.
export async function untilIdle(runtime) {
  while (runtime.snapshot().busy) await sleep(20);
}
// Ordinary retirement waits for idle. An explicit close aborts this turn
// before disposal, without polling a snapshot busy flag that may be stale.
async function retire(runtime, confirmed = false) {
  if (confirmed) {
    try { await runtime.drop?.(); }
    finally {
      try { await runtime.command({ type: 'abort' }); }
      finally { await runtime.close(); }
    }
  } else {
    await runtime.drop?.();
    await untilIdle(runtime);
    await runtime.close();
  }
}

export const STATUS_PRIORITY = Object.freeze({ blocked: 0, working: 1, done: 2, unknown: 3, idle: 4 });

// One machine, three harnesses. Claude runs only in Claude Code; Codex runs
// its own GPT models on the ChatGPT subscription; Pi runs every other
// provider (ChatGPT included, by its own sign-in). All answer the same
// members, so every surface above this point is shared, and adding another is
// one more row in the table below.
export const AGENTS = SOURCES;

export async function createTabHost(options = {}) {
  const events = new EventEmitter();
  // Tab ids are local to this host lifetime; fresh-session sends need its stamp.
  const instanceId = randomUUID();
  const {
    createRuntime: makeRuntime = createRuntime,
    createClaudeRuntime: makeClaudeRuntime = createClaudeRuntime,
    listPiSessions: piSessions = listPiSessions,
    listClaudeSessions: claudeSessions = listClaudeSessions,
    claudeAvailable = () => Boolean(claudeAuth()),
    createCodexRuntime: makeCodexRuntime = createCodexRuntime,
    listCodexSessions: codexSessions = listCodexSessions,
    codexAvailable = () => Boolean(codexAuth()),
    // With nothing to restore, open on a Pi tab, or on nothing (null): the
    // window then asks which harness, and so shows every one Imperfect ships.
    firstTab = 'pi',
    // Harnesses update every two hours (system/upgrade.mjs leaves
    // memory/open/upgrade.md for Pulse if that fails): no package check or
    // notice here. Accepted and ignored for old callers.
    checkUpdates: _checkUpdates,
    sessionToken, // Private signing authority is not a harness option.
    ...shared
  } = options;
  // Each harness: how it is made, how its history is listed, whether this
  // machine may start it, which model providers are its own. Pi is always
  // startable and is where every other provider's model lands.
  const HARNESSES = {
    pi: { make: extra => makeRuntime({ ...shared, ...extra }), list: () => piSessions(shared), available: () => true, providers: [] },
    claude: { make: extra => makeClaudeRuntime({ ...shared, ...extra }), list: () => claudeSessions(), available: claudeAvailable, providers: ['claude-agent'], blocked: 'Sign in to Claude Code in imperfect to use your Claude subscription on this machine' },
    codex: { make: extra => makeCodexRuntime({ ...shared, ...extra }), list: () => codexSessions(), available: codexAvailable, providers: ['codex'], blocked: 'Sign in to Codex in imperfect to use your ChatGPT subscription on this machine' },
  };
  const make = (extra, agent = 'pi') => HARNESSES[agentOf(agent)].make(extra);
  const agentOf = value => AGENTS.includes(value) ? value : 'pi';
  let closed = false;
  let legacy = [];
  // What is open is written down, because the machine restarts and a person
  // does not expect a restart to be an ending. Before this, the tabs existed
  // only in this process: an update, a crash or an agent restarting the very
  // service it was living in left the rail empty, and the conversation — still
  // whole on disk — read as though it had never been started.
  const store = shared.stateDir ? join(shared.stateDir, 'open-tabs.json') : null;
  let written = '';
  let persistenceError = null;
  // The handoff fence, for every harness at once. While it stands no tab is
  // opened or closed, and what is said is taken at once but held (`held`,
  // below) rather than sent; what was already sent goes on, so waitForIdle
  // means every turn has ended. Delivery is never paused: what is held is
  // written down with its tab and goes first thing once delivery resumes,
  // here if the restart does not happen, else after it.
  let quiescing = false;
  const lifecycle = new Set();
  function requestQuiesce() {
    quiescing = true;
    events.emit('change');
  }
  async function waitForIdle() {
    while (lifecycle.size) await Promise.all([...lifecycle]);
    await Promise.all([...tabs.map(tab => untilIdle(tab.runtime)), ...(shared.authentication && authRuntime ? [untilIdle(authRuntime)] : [])]);
    if (legacy.some(row => row.restoreError)) throw new Error('Session restore failed; handoff held for review');
  }
  async function resumeDelivery() {
    quiescing = false;
    events.emit('change');
    await Promise.all(tabs.map(deliverHeld));
  }
  // Pi holds each item until Durable commits its admission. A crash on either
  // side of that acknowledgement retries the same receipt, never loses input.
  // Claude has no durable admission API; retain its existing delivery policy.
  function deliverHeld(tab) {
    if (tab.delivering) return tab.delivering;
    let refused = false;
    const run = (async () => {
      await null;
      while (!quiescing && !closed && tabs.includes(tab) && tab.held.length) {
        const durable = tab.agent === 'pi', item = durable ? tab.held[0] : tab.held.shift();
        try { remember(); } catch { if (!durable) tab.held.unshift(item); refused = true; break; }
        try {
          await tab.runtime.command({ type: 'prompt', text: item.text, images: item.images, requestId: item.id });
          if (durable) {
            tab.held.shift();
            try { remember(); } catch (error) { tab.held.unshift(item); throw error; }
          }
        } catch {
          if (!durable) tab.held.unshift(item);
          refused = true;
          try { remember(); } catch { /* retained; retry Pi's committed receipt */ }
          break;
        } finally { changed(); }
      }
    })().finally(() => {
      if (tab.delivering !== run) return;
      tab.delivering = null;
      // Said while the last one went out.
      if (!refused && !quiescing && tab.held.length) void deliverHeld(tab);
    });
    tab.delivering = run;
    return run;
  }
  // `settling` is a session opening or closing; handoff waits for retirement,
  // including cancellation of a turn explicitly closed by the person.
  const handoffState = () => ({ quiescing, settling: lifecycle.size > 0, persistenceError: persistenceError?.message ?? null,
    recovery: legacy.filter(row => row.restoreError).map(row => ({ session: row.session, error: row.restoreError })) });
  function remember() {
    if (!store) return;
    const rows = tabs.map(tab => {
      const snap = tab.runtime.snapshot();
      return {
        agent: tab.agent,
        session: snap.sessionFile ?? snap.sessionId ?? '',
        cwd: snap.cwd ?? '',
        empty: !(snap.messages?.length),
        ...(tab.held.length ? { held: tab.held } : {}),
        name: snap.name,
        model: snap.model,
        focused: tab.id === focused,
      };
    // A tab with no conversation yet is kept too, if something waits in it.
    }).filter(row => row.session || row.held);
    const body = JSON.stringify([...rows, ...legacy]);
    if (body === written && !persistenceError) return;
    try {
      const created = mkdirSync(shared.stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(`${store}.tmp`, body, { mode: 0o600 });
      const file = openSync(`${store}.tmp`, 'r');
      try { fsyncSync(file); } finally { closeSync(file); }
      renameSync(`${store}.tmp`, store);
      const boundary = dirname(resolve(created ?? shared.stateDir));
      for (let path = resolve(shared.stateDir); ; path = dirname(path)) {
        const dir = openSync(path, 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
        if (path === boundary || path === dirname(path)) break;
      }
      written = body;
      persistenceError = null;
    } catch (error) { persistenceError = error; throw error; }
  }
  function remembered() {
    if (!store || !existsSync(store)) return [];
    try {
      const rows = JSON.parse(readFileSync(store, 'utf8'));
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row.session !== 'string' || !(row.session || row.empty || row.held?.length))) throw new Error('Invalid tab mapping');
      return rows;
    } catch (error) { throw new Error(`Cannot restore ${store}; preserved for review: ${error.message}`); }
  }
  // What a runtime says changed is written down once a tick, not once a word:
  // a streamed answer is many changes and the same open tabs. A command that
  // changes the tabs writes them before it answers.
  let rememberSoon = null;
  const changed = () => {
    if (closed) return;
    rememberSoon ??= setImmediate(() => {
      rememberSoon = null;
      if (closed) return;
      try { remember(); } catch (error) { persistenceError = error; /* Never interrupt a tool from a UI event. */ }
    });
    events.emit('change');
  };

  let seq = 0;
  const tabs = [];
  // Multiple viewers can open the same history row before its runtime finishes
  // loading. Share that creation promise, not just the eventual tab.
  const opening = new Map();
  let focused = null;
  // `focused` is only the restart/default pointer. A connected view supplies
  // its own selected id, so one viewer moving through the rail cannot move a
  // second viewer away from the runtime it is watching.
  const current = selectedId => tabs.find(tab => tab.id === selectedId)
    ?? tabs.find(tab => tab.id === focused)
    ?? tabs[0];

  // Claude Code and Codex become startable as soon as their own sign-ins complete.
  const startableHarnesses = () => AGENTS.filter(agent => HARNESSES[agent].available());
  const engineForModel = model => AGENTS.find(agent => HARNESSES[agent].providers.includes(model?.provider)) ?? 'pi';
  // The harness a new tab is when none is named: the last model picked's, and
  // with none picked before (a fresh computer), Claude Code on Opus 5.5.
  const usualAgent = (wanted = lastModel) => {
    const startable = startableHarnesses();
    return wanted && startable.includes(engineForModel(wanted)) ? engineForModel(wanted) : (startable.includes('claude') ? 'claude' : 'pi');
  };
  // What a window's new session offers: every harness imperfect ships,
  // whether this computer can start it now (and if not, why), and which it
  // would be unasked, with the model it would start on, for the input bar
  // to name before anything starts.
  const harnessChoices = () => {
    const startable = startableHarnesses(), usual = usualAgent();
    return AGENTS.map(agent => ({ agent, ready: startable.includes(agent), usual: agent === usual,
      ...(agent === usual && lastModel && engineForModel(lastModel) === agent ? { model: { provider: lastModel.provider, id: lastModel.id } } : {}),
      ...(!startable.includes(agent) && HARNESSES[agent].blocked ? { blocked: HARNESSES[agent].blocked } : {}) }));
  };
  // A person picks a model, not a harness: a Claude model runs in Claude
  // Code, a Codex model in Codex, every other model in Pi. Codex's models are
  // named under a provider of their own, so Pi's ChatGPT models stay in Pi
  // and Codex's in Codex. Pi's Anthropic route is never offered,
  // including on a fresh computer or one with an old Pi OAuth credential.
  // The last model picked is what a new tab starts on.
  const modelFile = shared.stateDir ? join(shared.stateDir, 'model.json') : null;
  let lastModel = null;
  try { lastModel = modelFile ? JSON.parse(readFileSync(modelFile, 'utf8')) : null; } catch { lastModel = null; }
  const rememberModel = model => {
    lastModel = model;
    try { if (modelFile) writeFileSync(modelFile, JSON.stringify(model)); } catch { /* it still holds until a restart */ }
  };
  // A harness with no tab open is asked through a runtime that is never a tab.
  const probes = new Map();
  const readingUsage = new Map();
  function runtimeFor(agent, selectedTab) {
    if (selectedTab?.agent === agent) return selectedTab.runtime;
    const open = tabs.find(tab => tab.agent === agent);
    if (open) return open.runtime;
    if (!probes.has(agent)) probes.set(agent, make({}, agent).catch(error => { probes.delete(agent); throw error; }));
    return probes.get(agent);
  }
  async function allModels(selectedTab) {
    const startable = startableHarnesses();
    const lists = await Promise.all(startable.map(async agent => {
      try { return (await (await runtimeFor(agent, selectedTab)).command({ type: 'models' })).map(m => ({ ...m, engine: agent })); }
      catch { return []; }
    }));
    return lists.flat().filter(m => !(m.engine === 'pi' && m.provider === 'anthropic'));
  }

  // How much of each subscription this computer's harnesses sign in with is
  // used (usage.mjs). A harness that cannot start here is not signed in.
  // ChatGPT's limits come from Pi's sign-in, or, when Pi has none or cannot
  // answer, from the Codex CLI's: either one signed in is enough. Codex's own
  // row is that same sign-in's answer.
  async function allUsage(selectedTab) {
    const startable = startableHarnesses();
    return Promise.all(AGENTS.map(async agent => {
      let row;
      if (!startable.includes(agent)) row = { agent, signedIn: false };
      else {
        try { row = { agent, ...await (await runtimeFor(agent, selectedTab)).command({ type: 'usage' }) }; }
        catch { row = { agent, error: 'Limits unavailable' }; }
      }
      if (agent === 'pi' && (!row.signedIn || row.error)) {
        try {
          const codex = await codexCliUsage();
          if (codex.signedIn) return { agent, ...codex };
        } catch { /* Pi's answer stands */ }
      }
      return row;
    }));
  }

  function bind(tab) {
    tab.runtime.events.on('change', () => {
      tab.revision = (tab.revision ?? 0) + 1;
      const snap = tab.runtime.snapshot();
      const next = turnActive(snap);
      if (tab.wasTurn && !next) {
        tab.unseenSettled = tab.id !== focused;
        events.emit('settled', { id: tab.id, asked: snap.turnAsked !== false });
      }
      tab.wasTurn = next;
      changed();
    });
  }

  function adopt(runtime, agent, saved = {}) {
    // `said`: the prompts this tab has taken, by the id a retried send repeats.
    // `held`: what was said while a handoff waited, not yet sent.
    const held = Array.isArray(saved.held) ? saved.held.filter(validHeld) : [];
    const tab = { id: `t${++seq}`, runtime, agent, wasTurn: turnActive(runtime.snapshot()), unseenSettled: false, said: new Set(held.map(item => item.id)), held };
    tabs.push(tab);
    bind(tab);
    return tab;
  }

  const restoredPaths = new Set();
  // A tab that had no conversation yet has nothing on disk to reopen: Pi
  // allocates a path before its first turn but need not flush a file, and
  // Claude Code and Codex have no session before their first turn. Such a
  // tab is not a lost conversation: it is dropped, or, if something was said
  // to it while a restart waited, it comes back as a new tab in the same
  // folder with that.
  // A Claude tab whose first turn failed before Claude Code named its session
  // shows what was said but has no session either, so it is judged the same.
  // Only a row that says which harness it was is judged so; existing
  // transcripts and missing nonempty or unknown rows still go through strict
  // restore, and hold a handoff if it fails.
  const hasFile = path => { try { return statSync(path).size > 0; } catch { return false; } };
  const unwritten = row => (row.agent === 'pi' ? row.empty === true && !hasFile(row.session) : AGENTS.includes(row.agent) && !row.session);
  for (const row of remembered()) {
    const agent = agentOf(row.agent);
    const home = typeof row.cwd === 'string' && row.cwd && existsSync(row.cwd) ? row.cwd : null;
    if (unwritten(row)) {
      if (!row.held?.length) continue;
      try {
        const tab = adopt(await make({ ...(home ? { cwd: home } : {}), model: row.model ?? null }, agent), agent, row);
        if (row.focused) focused = tab.id;
      } catch (error) { legacy.push({ ...row, restoreError: error.message }); }
      continue;
    }
    const identity = historyIdentity(agent, row.session);
    if (restoredPaths.has(identity)) continue;
    restoredPaths.add(identity);
    try {
      // Pi reads its model, thinking level and name back from its own session
      // file, Claude Code its name; sending them again wrote them there again
      // on every restart. Claude keeps no record of the model imperfect gave
      // it, so that is handed to it as its tab is made.
      const tab = adopt(await make({ sessionPath: row.session, ...(home ? { cwd: home } : {}), model: row.model ?? null }, agent), agent, row);
      if (row.focused) focused = tab.id;
    } catch (error) { legacy.push({ ...row, restoreError: error.message }); }
  }
  // Failed restores are preserved for recovery, never disguised as a new
  // conversation on the first launch after an update.
  if (!tabs.length && firstTab && !legacy.some(row => row.restoreError)) adopt(await make({}, firstTab), firstTab);
  if (!tabs.some(tab => tab.id === focused)) focused = tabs.at(-1)?.id ?? null;
  // One machine-level sign-in console, also visible while a Claude tab (or
  // no tab) is selected. A probe is not a session in the person's rail.
  // Never borrow a tab: retaining its sign-in API after close also retains
  // that conversation's SQLite writer, leaving a hidden, unopenable history.
  const authRuntime = shared.authentication ? await make({ onAuthChanged: async () => {
    // The auth console never owns a conversation. Each existing Pi runtime
    // must reread the shared credentials before sign-in becomes idle again.
    await Promise.all(tabs.filter(tab => tab.agent === 'pi').map(tab => tab.runtime.command({ type: 'refresh-auth' })));
  } }, 'pi') : null;
  if (authRuntime) {
    probes.set('pi', Promise.resolve(authRuntime));
    authRuntime.events.on('change', changed);
  }
  remember();

  function snapshot(selectedId) {
    const tab = current(selectedId);
    // No tabs is now a reachable state. There is no runtime to describe, so the
    // snapshot carries only enough shape for the window to draw the chooser.
    if (!tab) return { instanceId, handoff: handoffState(), agent: null, harnesses: harnessChoices(), tabs: [], messages: [], model: null, stats: {}, ...(authRuntime ? { auth: authRuntime.snapshot().auth } : {}) };
    // The host is the authority on which agent a tab is, not the runtime: a
    // face is chosen from this, so it must be right even for a runtime that
    // never says what it is.
    const selected = tab?.id ?? null;
    const snap = tab.runtime.snapshot();
    const queue = tab.held.length ? {
      steering: [...(snap.queue?.steering ?? []), ...tab.held.map(item => item.text)],
      items: [...(snap.queue?.items ?? []), ...tab.held.map(heldItem)],
    } : snap.queue;
    return { ...snap, instanceId, queue, ...(authRuntime ? { auth: authRuntime.snapshot().auth } : {}), handoff: handoffState(), agent: tab.agent, harnesses: harnessChoices(), tabs: tabs.map(item => summary(item, item.id === selected)) };
  }

  // Index archives without starting a runtime for each conversation. One
  // history, not one per harness: every row says which harness wrote it, and
  // each harness's own list is the whole truth of it, names included. It is
  // read when a window unfolds its rail, never on a timer.
  async function listAllSessions() {
    const listed = (await Promise.all(AGENTS.map(agent => HARNESSES[agent].available() ? Promise.resolve(HARNESSES[agent].list()).catch(() => []) : []))).flat();
    return listed.sort((a, b) => b.modified - a.modified);
  }

  const replacing = new Set(['tab-new', 'tab-open', 'tab-close']);
  // In-process request lifetime only; never part of a command or held item.
  function auditClose(c, connection) {
    return closeAuditRecord(c, tabs.find(tab => tab.id === c.tabId), connection);
  }
  function command(c, selectedId, context = {}) {
    if (c.type !== 'tab-close') return commandImpl(c, selectedId, context);
    const closeAudit = auditClose(c, context.connection);
    const task = commandImpl(c, selectedId, { ...context, closeAudit });
    return task.finally(() => { if (!closeAudit.accepted) appendCloseAudit(shared.stateDir, closeAudit); });
  }
  function commandImpl(c, selectedId, context) {
    if (quiescing && replacing.has(c.type)) return Promise.reject(new Error('Machine handoff is fenced; resume before changing sessions'));
    if (replacing.has(c.type) || c.type === 'prompt') {
      try { remember(); } catch (error) { return Promise.reject(new Error(`Tab mapping is not durable: ${error.message}`)); }
    }
    const task = runCommand(c, selectedId, context).then(result => {
      if (replacing.has(c.type)) remember();
      return result;
    });
    if (replacing.has(c.type)) {
      lifecycle.add(task);
      task.then(() => lifecycle.delete(task), () => lifecycle.delete(task));
    }
    return task;
  }
  async function runCommand(c, selectedId, { isCancelled, connection, closeAudit } = {}) {
    const selected = () => current(selectedId);
    if (c.agent && !AGENTS.includes(c.agent)) throw new Error('Unknown harness');
    if (c.type.startsWith('auth_') && authRuntime) {
      // A sign-in changes only its own harness's sessions: Claude Code's and
      // Codex's are their own, every other provider is Pi's. One of those at
      // work waits for it; another harness's never does (or a person talking
      // to Claude could never sign in to Codex).
      const harness = { 'claude-agent': 'claude', codex: 'codex' }[c.provider] ?? 'pi';
      if (['auth_login', 'auth_logout'].includes(c.type) && ((harness === 'pi' && pendingWork(authRuntime.snapshot())) || tabs.some(tab => tab.agent === harness && pendingWork(tab.runtime.snapshot())))) throw new Error('Agent is busy; wait before changing sign-in');
      return authRuntime.command(c);
    }
    if (c.type === 'prompt' && authRuntime?.snapshot().auth?.busy) throw new Error('Finish or cancel sign-in before sending a prompt');
    if (c.type === 'models') return allModels(selected());
    if (c.type === 'usage') return allUsage(selected());
    if (c.type === 'codex-reset-consume') {
      // Computer-scoped usage need not open a conversation on the PC. The
      // reset service still revalidates the exact account, credit and intent.
      if (c.scope === 'computer') return (await runtimeFor('pi', null)).command(c);
      const tab = selected();
      if (!tab || !c.expectedTabId || c.expectedTabId !== tab.id || c.expectedSessionId !== tab.runtime.snapshot().sessionId) throw new Error('Session changed; refresh limits');
      const pi = await runtimeFor('pi', tab);
      if (selected() !== tab || !tabs.includes(tab)) throw new Error('Session changed; refresh limits');
      return pi.command(c);
    }
    if (c.type === 'usage-history') {
      // Several windows can ask together; one read, no parallel scans or DB.
      const localOnly = c.thisComputerOnly === true;
      if (!readingUsage.has(localOnly)) readingUsage.set(localOnly, (async () => {
        let models = [];
        try { models = await (await runtimeFor('pi', null)).command({ type: 'usage-rates' }); } catch { /* missing catalog is explicitly unrated */ }
        return readUsageHistory({ agentDir: shared.agentDir, sessionDir: shared.sessionDir, memoryDir: join(resolvePrefix(), 'memory'), thisComputerOnly: localOnly, models: Array.isArray(models) ? models : [], cacheFile: shared.stateDir ? join(shared.stateDir, localOnly ? 'usage-history-local.json' : 'usage-history.json') : null });
      })().finally(() => { readingUsage.delete(localOnly); }));
      return readingUsage.get(localOnly);
    }
    // Asked for by a window, a snapshot is the one every window is sent.
    if (c.type === 'snapshot') return snapshot(selectedId);
    // A model of the other harness continues in a tab of its own, since
    // neither can carry on the other's conversation. A tab with nothing in it
    // yet simply becomes the new one.
    if (c.type === 'model') {
      if (c.provider === 'anthropic') throw new Error('Pi Anthropic is not used. Sign in to Claude Code for Claude on your subscription.');
      if (authRuntime?.snapshot().auth?.busy) throw new Error('Finish or cancel sign-in before changing model');
      const engine = engineForModel({ provider: c.provider, id: c.modelId });
      const before = selected();
      if (engine !== before?.agent) {
        const made = await command({ type: 'tab-new', agent: engine, model: null }, selectedId);
        selectedId = made.id;
        if (before && !(before.runtime.snapshot().messages ?? []).length) await command({ type: 'tab-close', tabId: before.id, gesture: 'model-switch-empty' }, selectedId, { connection }).catch(() => {});
      }
      const value = await selected().runtime.command(c);
      rememberModel({ provider: c.provider, id: c.modelId });
      return { __selectedTabId: selected().id, value };
    }
    if (c.type === 'tab-focus') {
      const tab = tabs.find(item => item.id === c.tabId);
      if (!tab) throw new Error('Unknown tab');
      focused = tab.id;
      tab.unseenSettled = false;
      // A restart/close immediately after focus must restore this selection,
      // not lose the scheduled mapping write with its event loop tick.
      remember();
      changed();
      return summary(tab, true);
    }
    if (c.type === 'tab-new') {
      // Without a harness named, the tab starts on the last model picked.
      const wanted = c.model === undefined ? lastModel : c.model;
      const agent = c.agent ? agentOf(c.agent) : usualAgent(wanted);
      if (!startableHarnesses().includes(agent)) throw new Error(HARNESSES[agent].blocked ?? 'That harness cannot start here');
      if (c.cwd !== undefined && !(typeof c.cwd === 'string' && existsSync(c.cwd))) throw new Error(`No such folder: ${c.cwd}`);
      const tab = adopt(await make(c.cwd ? { cwd: c.cwd } : {}, agent), agent);
      if (wanted && engineForModel(wanted) === agent) {
        // A model picked for a new session is the last model picked, as a
        // model picked in one is (the next new session starts on it too).
        try {
          await tab.runtime.command({ type: 'model', provider: wanted.provider, modelId: wanted.id });
          if (c.model) rememberModel({ provider: wanted.provider, id: wanted.id });
        } catch (error) {
          // A picker choice is explicit consent to that model, not its
          // default replacement. Never let the first prompt fall through.
          if (c.model) throw error;
        }
      }
      // Calls without a view retain the restart/default pointer. Server views
      // pass selectedId and keep selection private to that connection.
      if (selectedId === undefined) focused = tab.id;
      remember();
      changed();
      return summary(tab, true);
    }
    if (c.type === 'sessions') return listAllSessions();
    if (c.type === 'tab-open') {
      const path = c.path;
      if (typeof path !== 'string' || !path) throw new Error('Session path is required');
      const agent = agentOf(c.agent);
      const already = tabs.find(item => item.agent === agent && [item.runtime.snapshot().sessionId, item.runtime.snapshot().sessionFile]
        .some(identity => identity && historyIdentity(agent, identity) === historyIdentity(agent, path)));
      if (already) {
        if (selectedId === undefined) focused = already.id;
        already.unseenSettled = false;
        changed();
        return summary(already, true);
      }
      // A session belongs to the agent that wrote it; reopening one in
      // another harness would hand it a transcript it cannot continue.
      // And it belongs to the directory it ran in. Opening a past session used
      // to re-root it into whatever tree this machine was started in, so a
      // conversation about one project resumed pointing at another — the
      // transcript said one thing and `pwd` said another. The session's own
      // directory travels with it, and is only used if it is still there.
      const home = typeof c.cwd === 'string' && c.cwd && existsSync(c.cwd) ? c.cwd : null;
      const key = JSON.stringify([agent, historyIdentity(agent, path)]);
      let pending = opening.get(key);
      if (!pending) {
        pending = Promise.resolve()
          .then(() => make({ sessionPath: path, ...(home ? { cwd: home } : {}) }, agent))
          .then(runtime => adopt(runtime, agent));
        opening.set(key, pending);
      }
      let tab;
      try { tab = await pending; }
      finally { if (opening.get(key) === pending) opening.delete(key); }
      if (selectedId === undefined) focused = tab.id;
      remember();
      changed();
      return summary(tab, true);
    }
    if (c.type === 'tab-close') {
      // The last tab used to be un-closable, so MOD+Esc on a single session did
      // nothing and there was no way to reach an empty console. Closing the last
      // one now leaves no tabs at all, and the window starts a new one when asked.
      const index = tabs.findIndex(item => item.id === c.tabId);
      if (index < 0) throw new Error('Unknown tab');
      const snap = tabs[index].runtime.snapshot();
      if ((c.expectedTabId !== undefined && c.expectedTabId !== c.tabId)
        || (c.expectedSessionId !== undefined && (c.expectedSessionId == null
          ? c.expectedInstanceId !== instanceId
          : c.expectedSessionId !== (snap.sessionId ?? null)))
        || (c.expectedInstanceId !== undefined && c.expectedInstanceId !== instanceId)) throw new Error('Session changed; close cancelled');
      if (c.closeConfirmed !== true && (pendingWork(snap) || tabs[index].held.length)) throw new Error('Session has unfinished work; keep its tab open');
      const [tab] = tabs.splice(index, 1);
      if (closeAudit) {
        closeAudit.accepted = true; // cleanup failure does not undo removal
        appendCloseAudit(shared.stateDir, closeAudit);
      }
      tab.held.length = 0;
      // The window names the session that comes next (`then`, the next in its rail).
      if (focused === tab.id) focused = tabs.find(item => item.id === c.then)?.id ?? (tabs.length ? tabs[Math.min(index, tabs.length - 1)].id : null);
      changed();
      // Persist removal even when cancellation/cleanup rejects: a closed tab
      // and its discarded held prompts must not return on the next start.
      try { remember(); }
      finally { await retire(tab.runtime, c.closeConfirmed === true); }
      return { ok: true, focused };
    }
    const tab = selected();
    if (!tab) throw new Error('No tab is selected');
    if (c.type === 'prompt') {
      // Pi admissions are Durable receipts, not this process's second ledger.
      // Only the cross-harness handoff fence deduplicates its still-held input.
      if (c.requestId && (tab.held.some(item => item.id === c.requestId) || (tab.agent !== 'pi' && tab.said.has(c.requestId)))) return { accepted: true, duplicate: true };
      const before = tab.runtime.snapshot();
      const { text, images } = await resolvePromptUploads(c, { cwd: before.cwd,
        tabId: tab.id, sessionId: before.sessionId, instanceId, referenceKey: sessionToken });
      if (!tabs.includes(tab) || tab.runtime.snapshot().sessionId !== before.sessionId) throw new Error('Session changed while preparing attachments; nothing was sent');
      if ((!text && !images.length) || text.length > 200000) throw new Error('Prompt must be 1–200000 characters, or include an image');
      // During a handoff, and behind anything held then, it waits its turn.
      if (quiescing || tab.held.length) {
        if (isCancelled?.()) throw new Error('Request cancelled; nothing was sent');
        tab.held.push({ id: c.requestId || randomUUID(), text, images });
        try { remember(); } catch (error) { tab.held.pop(); throw new Error(`Tab mapping is not durable: ${error.message}`); }
        if (c.requestId && tab.agent !== 'pi') tab.said.add(c.requestId);
        changed();
        void deliverHeld(tab);
        return { accepted: true, queued: true };
      }
      // Preparation can outlast the HTTP request. Once admitted below (or
      // held above), later request cancellation does not withdraw the prompt.
      if (isCancelled?.()) throw new Error('Request cancelled; nothing was sent');
      const result = await tab.runtime.command({ type: 'prompt', text, images, ...(c.requestId ? { requestId: c.requestId } : {}) });
      if (c.requestId && tab.agent !== 'pi') tab.said.add(c.requestId);
      // A first prompt is what gives a Claude tab its session to write down.
      try { remember(); } catch (error) { persistenceError = error; }
      changed();
      return result;
    }
    // Something held is taken back, or handed back by a stop, like any
    // other pending steering.
    if (c.type === 'queue-take' && tab.held.length && (c.queueId ? tab.held.some(item => item.id === c.queueId) : true)) {
      const at = c.queueId ? tab.held.findIndex(item => item.id === c.queueId) : tab.held.length - 1;
      const [item] = tab.held.splice(at, 1);
      remember(); changed();
      return { item: heldItem(item) };
    }
    if (c.type === 'abort' && tab.held.length) {
      const result = await tab.runtime.command(c);
      const items = tab.held.splice(0).map(heldItem);
      remember(); changed();
      return { ...result, steering: [...(result?.steering ?? []), ...items.map(item => item.text)], items: [...(result?.items ?? []), ...items] };
    }
    return tab.runtime.command(c);
  }

  // What agents left working after their turns, each with its session's name:
  // a restart waits for it (system/server.mjs). Pi leaves nothing; its tools
  // finish inside its turn.
  const background = () => [...tabs, ...(authRuntime && !tabs.some(tab => tab.runtime === authRuntime) ? [{ runtime: authRuntime }] : [])]
    .flatMap(tab => (tab.runtime.background?.() ?? []).map(work => `${tabLabel(tab.runtime.snapshot())}: ${work}`));

  // Usage credentials belong to the Pi runtime, never a CLI fallback.
  return {
    events,
    snapshot,
    command,
    requestQuiesce,
    auditCloseRejected: (c, connection) => appendCloseAudit(shared.stateDir, auditClose(c, connection)),
    isIdle: () => !lifecycle.size && !authRuntime?.snapshot().busy && tabs.every(tab => !tab.runtime.snapshot().busy),
    waitForIdle,
    resumeDelivery,
    background,
    get focused() { return focused; },
    async close() {
      closed = true;
      clearImmediate(rememberSoon);
      for (const tab of tabs) await retire(tab.runtime);
      for (const probe of probes.values()) await probe.then(runtime => runtime.close(), () => {});
    },
  };
}
