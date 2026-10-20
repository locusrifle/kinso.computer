import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { codexAuth, codexAuthRevision, codexHome, codexServer } from './codex-auth.mjs';
export { codexAuth } from './codex-auth.mjs';
import { mcpSession } from './mcp.mjs';
import { createExtensionUI } from './extension-ui.mjs';
import { createTranscript } from './transcript.mjs';
import { codexCliUsage } from './usage.mjs';
import { cwdRelative, section, startup, tildePath } from './startup.mjs';

// The third harness: the Codex CLI, through its app server (codex-auth.mjs
// starts it), behind the same members the tab host asks of Pi and Claude
// Code: events, snapshot, command, drop and close.
//
// Codex already speaks in items (a message, its reasoning, a command, a
// patch, a tool call), each started and then completed, with deltas between.
// `codexEvents` turns them into the events transcript.mjs folds. A resumed
// thread's items, read back from Codex, go through the same function, so
// history and a live turn are drawn alike.
//
// Codex's models go by the provider 'codex', not Pi's 'openai-codex'. The same
// ChatGPT subscription reaches GPT through either harness, and the provider is
// how a picked model says which one runs it (tabs.mjs engineForModel).
//
// Codex keeps its own threads in ~/.codex, as its CLI does. Nothing here
// keeps a second copy.

const joined = parts => (Array.isArray(parts) ? parts : []).filter(part => typeof part === 'string' && part).join('\n\n');
const dataImage = url => {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(url ?? ''));
  return match ? { type: 'image', data: match[2], mimeType: match[1] } : null;
};

// What an MCP tool handed back, as the transcript's words and pictures, so
// imperfect's own `show` is drawn as it is for the other harnesses.
function mcpOutput(item) {
  const content = Array.isArray(item.result?.content) ? item.result.content : [];
  return {
    text: item.error?.message ?? content.filter(b => b?.type === 'text').map(b => b.text).join('\n'),
    images: content.filter(b => b?.type === 'image' && b.data).map(b => ({ type: 'image', data: b.data, mimeType: b.mimeType })),
    failed: item.status === 'failed' || Boolean(item.error) || item.result?.isError === true,
  };
}

// One item, as transcript events: `done` once Codex has completed it. The
// conversation is drawn, not how Codex got there, so a tool's name is a word
// for a log, not something the window branches on.
export function codexItemEvents(item, done = true) {
  if (!item?.type) return [];
  const id = item.id;
  const tool = (name, args, output = {}) => [{
    type: 'tool', id, name, arguments: args ?? {},
    status: !done ? 'running' : output.failed ? 'failed' : 'done',
    ...(done ? { output: output.text ?? '', images: output.images ?? [], isError: Boolean(output.failed) } : {}),
  }];
  switch (item.type) {
    case 'userMessage': {
      const content = (item.content ?? []).flatMap(part => part?.type === 'text' ? [{ type: 'text', text: part.text ?? '' }] : part?.type === 'image' ? [dataImage(part.url)].filter(Boolean) : []);
      return done && content.length ? [{ type: 'user', content }] : [];
    }
    case 'agentMessage': return done ? [{ type: 'text', id, text: item.text ?? '', done: true }] : [];
    case 'reasoning': {
      const said = joined(item.summary) || joined(item.content);
      return done && said ? [{ type: 'thinking', id, text: said, done: true }] : [];
    }
    case 'commandExecution': return tool('bash', { command: item.command, cwd: item.cwd }, { text: item.aggregatedOutput ?? '', failed: item.status !== 'completed' });
    case 'fileChange': return tool('apply_patch', { changes: item.changes }, { text: (item.changes ?? []).map(c => `${c.path}\n${c.diff ?? ''}`).join('\n'), failed: item.status !== 'completed' });
    case 'mcpToolCall': return tool(`mcp__${item.server}__${item.tool}`, item.arguments, mcpOutput(item));
    case 'dynamicToolCall': return tool(item.tool, item.arguments, { text: (item.contentItems ?? []).filter(b => b?.type === 'inputText').map(b => b.text).join('\n'), images: (item.contentItems ?? []).map(b => b?.type === 'inputImage' && dataImage(b.imageUrl)).filter(Boolean), failed: item.success === false });
    case 'webSearch': return tool('web_search', { query: item.query });
    case 'imageView': return tool('view_image', { path: item.path });
    // A picture Codex made is shown, as one a tool handed back is.
    case 'imageGeneration': return tool('image_generation', { prompt: item.revisedPrompt }, { images: item.result ? [{ type: 'image', data: item.result, mimeType: 'image/png' }] : [], failed: Boolean(item.failure) });
    case 'collabAgentToolCall': return tool(item.tool, { prompt: item.prompt }, { failed: item.status === 'failed' });
    case 'contextCompaction': return [{ type: 'compaction', state: done ? 'end' : 'start' }];
    // A plan, a hook's prompt, review mode, a pause: nothing the window draws.
    default: return [];
  }
}

// What Codex counted, in the footer's words. Its input includes what was read
// from cache; the transcript's does not. What the last request held is what
// is in the context window now.
function codexUsage(usage) {
  const total = usage?.total ?? {}, last = usage?.last ?? {};
  const out = { tokens: { input: Math.max(0, (total.inputTokens ?? 0) - (total.cachedInputTokens ?? 0)), output: total.outputTokens ?? 0, cacheRead: total.cachedInputTokens ?? 0, cacheWrite: total.cacheWriteInputTokens ?? 0 } };
  if (usage?.modelContextWindow > 0) out.contextUsage = { contextWindow: usage.modelContextWindow, percent: ((last.inputTokens ?? 0) + (last.outputTokens ?? 0)) / usage.modelContextWindow * 100 };
  return out;
}

// The app server's notifications, as transcript events. Pure, so it runs over
// a recorded turn (test/fixtures/codex-app-server.jsonl). `session` events
// carry facts the runtime keeps (a name, a model); the rest is the
// conversation. A failed turn says why in the conversation; one the person
// stopped is not a failure.
export function codexEvents(msg) {
  const p = msg?.params ?? {};
  switch (msg?.method) {
    case 'turn/started': return [{ type: 'turn', state: 'start' }];
    case 'turn/completed': {
      if (p.turn?.status !== 'failed') return [{ type: 'turn', state: 'end' }];
      const why = p.turn.error?.message || 'Codex could not finish this turn';
      return [{ type: 'error', message: why }, { type: 'turn', state: 'end', failed: why }];
    }
    case 'item/started': return codexItemEvents(p.item, false);
    case 'item/completed': return codexItemEvents(p.item, true);
    case 'item/agentMessage/delta': return [{ type: 'text', id: p.itemId, delta: p.delta ?? '' }];
    case 'item/reasoning/summaryPartAdded': return p.summaryIndex > 0 ? [{ type: 'thinking', id: p.itemId, delta: '\n\n' }] : [];
    case 'item/reasoning/summaryTextDelta': return [{ type: 'thinking', id: p.itemId, delta: p.delta ?? '' }];
    case 'thread/tokenUsage/updated': return [{ type: 'usage', ...codexUsage(p.tokenUsage) }];
    case 'thread/name/updated': return typeof p.threadName === 'string' ? [{ type: 'session', name: p.threadName }] : [];
    case 'model/rerouted': return p.toModel ? [{ type: 'session', model: p.toModel }] : [];
    // `error` is a retry under way, or says again what the failed turn says.
    default: return [];
  }
}

// A thread is named by its id; a rollout file's name ends with it.
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const threadOf = path => (isAbsolute(path) ? UUID.exec(basename(path))?.[1] : null) ?? path;

// The head of a rollout: what the thread is and the first thing said in it.
// Rollouts can be long; reading stops at the first message.
async function rolloutHead(path) {
  const input = createReadStream(path, { encoding: 'utf8', end: 8 * 1024 * 1024 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let meta = null, first = '';
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const p = row?.payload;
      if (row?.type === 'session_meta') meta = p;
      else if (row?.type === 'event_msg' && p?.type === 'user_message' && typeof p.message === 'string') first = p.message;
      else if (row?.type === 'event_msg' && p?.type === 'item_completed' && p.item?.type === 'UserMessage') first = (p.item.content ?? []).filter(c => c?.type === 'text').map(c => c.text).join('\n');
      if (meta && first.trim()) break;
    }
  } finally { lines.close(); input.destroy(); }
  return { meta, first: first.trim() };
}

// Codex's half of the machine's history, read from its own files without a
// running Codex: a thread is a rollout under sessions/YYYY/MM/DD, and its name,
// if it was given one, the last written for it in session_index.jsonl. Only
// what Codex itself lists as a conversation (its terminal's and its app
// server's): `codex exec` runs and subagents are not. A rollout is read once
// for as long as it is unchanged.
const heads = new Map();
export async function listCodexSessions({ home = codexHome() } = {}) {
  const names = new Map();
  for (const line of (await readFile(join(home, 'session_index.jsonl'), 'utf8').catch(() => '')).split('\n')) {
    try { const row = JSON.parse(line); if (row?.id && typeof row.thread_name === 'string') names.set(row.id, row.thread_name); } catch { /* a line being written */ }
  }
  const root = join(home, 'sessions');
  const files = (await readdir(root, { recursive: true }).catch(() => [])).filter(name => /(^|[\\/])rollout-[^\\/]*\.jsonl$/.test(name)).map(name => join(root, name));
  const rows = await Promise.all(files.map(async path => {
    try {
      const { mtimeMs, size } = await stat(path);
      const kept = heads.get(path);
      const head = kept?.mtimeMs === mtimeMs && kept.size === size ? kept.head : await rolloutHead(path);
      heads.set(path, { mtimeMs, size, head });
      const { meta, first } = head;
      if (!meta?.id || !first || !['cli', 'vscode'].includes(meta.source)) return null;
      return { id: meta.id, path, name: names.get(meta.id) || '', firstMessage: first, cwd: meta.cwd || '', modified: mtimeMs, agent: 'codex' };
    } catch { return null; }
  }));
  return rows.filter(Boolean);
}

export async function createCodexRuntime({
  cwd: given = null, sessionPath = null, model: chosen = null,
  serverImpl = codexServer, authImpl = codexAuth, usageImpl = codexCliUsage,
} = {}) {
  // A new conversation needs the machine signed in. One already had keeps its
  // history on show without it; asking it anything answers with Codex's error.
  if (!authImpl() && !sessionPath) throw new Error('This machine is not signed in to Codex. Sign in to Codex in imperfect to use your ChatGPT subscription.');
  const events = new EventEmitter();
  let closed = false;
  let cached = null;
  const changed = () => { cached = null; if (!closed) events.emit('change'); };
  const adapter = createExtensionUI(changed);
  const transcript = createTranscript();

  let threadId = sessionPath ? threadOf(sessionPath) : null;
  let rollout = sessionPath && isAbsolute(sessionPath) ? sessionPath : null;
  // Whether this thread has a turn written down: until then there is nothing
  // to resume, so the tab says it has no session yet, as a new Claude tab does.
  let written = Boolean(sessionPath);
  let cwd = given;
  let sessionName = '';
  let unwritten = '';
  let model = null, effort = null, catalog = [], version = null, instructions = [];
  const servers = new Map(); // MCP server -> its startup status
  let billing = authImpl() === 'apikey' ? 'API · OpenAI key' : 'ChatGPT subscription';
  let sending = 0;
  // The turn under way, and one the person stopped: what Codex still says of
  // that one after the stop is not drawn under it.
  let turnId = null, stopped = null;
  let authRevision = codexAuthRevision();

  const view = id => {
    const row = catalog.find(m => m.id === id || m.model === id);
    return { provider: 'codex', id: row?.id ?? id, name: row?.displayName || id };
  };
  const levels = () => (catalog.find(m => m.id === model?.id)?.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort);
  const defaultLevel = () => catalog.find(m => m.id === model?.id)?.defaultReasoningEffort ?? null;
  async function loadModels() {
    const rows = [];
    let cursor = null;
    do {
      const page = await connect().request('model/list', cursor ? { cursor } : {});
      rows.push(...(page?.data ?? []));
      cursor = page?.nextCursor ?? null;
    } while (cursor);
    catalog = rows.filter(m => !m.hidden);
    if (model) model = view(model.id);
    changed();
    return catalog;
  }

  // One app server per tab, started again by the next command if it ends.
  // A thread lives in the server that started or resumed it, so one that ends
  // takes its thread with it; the next prompt resumes it by its id.
  let server = null, opened = null, surveyed = false;
  // A thread with no turn yet was never written down: there is nothing to
  // resume, and the next prompt starts it again.
  const forget = () => { server = null; opened = null; surveyed = false; turnId = null; if (!written) threadId = null; };
  function connect() {
    if (closed) throw new Error('This Codex tab is closed');
    if (server) return server;
    const current = server = serverImpl();
    current.ready.then(info => { version = /\/(\d+\.\d+\.\d+)/.exec(info?.userAgent ?? '')?.[1] ?? version; changed(); }, () => {});
    current.events.on('notification', msg => { if (server === current) absorb(msg); });
    current.events.on('request', msg => { if (server === current) void answer(current, msg); else current.refuse(msg.id, 'This tab has moved on'); });
    current.events.on('exit', () => {
      if (server !== current) return;
      forget();
      adapter.reset();
      if (transcript.streaming) transcript.absorb({ type: 'turn', state: 'end', failed: 'Codex stopped' });
      changed();
    });
    return current;
  }
  function restart() {
    const current = server;
    forget();
    current?.close();
  }

  // imperfect's own tools, from its MCP endpoint (mcp.mjs), handed to Codex
  // with the thread as one more MCP server; nothing is written into
  // ~/.codex. A call may take as long as it needs, as in the other harnesses.
  const imperfect = mcpSession({ cwd: () => cwd, session: () => threadId ?? '', harness: 'codex', ui: adapter.ui });
  // Codex's own extras that only add noise here are switched off, as Claude
  // Code's are (Noah, 2026-10-20): its bundled skills (no harness in imperfect
  // has skills), goals, the clock, ChatGPT apps and plugins and the tool
  // suggestions for them, and its own browser, computer use and pictures,
  // which imperfect's tools already do. Its shell, patches, images, questions
  // and subagents stay.
  const quiet = {
    skills: { bundled: { enabled: false } },
    features: Object.fromEntries([
      'goals', 'sleep_tool', 'apps', 'plugins', 'remote_plugin', 'plugin_sharing',
      'tool_suggest', 'skill_search', 'skill_mcp_dependency_install', 'image_generation',
      'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser',
      'computer_use', 'worktrees', 'realtime_conversation',
    ].map(feature => [feature, false])),
  };
  const tools = () => {
    const at = imperfect.config();
    return { config: { ...quiet, ...(at ? { mcp_servers: { imperfect: { url: at.url, http_headers: at.headers, tool_timeout_sec: 24 * 60 * 60 } } } : {}) } };
  };

  // The thread, live in this server: started, or resumed by its id. Locus's
  // choice for Claude Code, 2026-09-19, holds here too: the window runs with
  // approvals off and no sandbox. It is his own machine behind his tailnet.
  function open() {
    return opened ??= (async () => {
      const current = connect();
      const params = { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access', ...tools(), ...(model ? { model: model.id } : {}) };
      const result = threadId
        ? await current.request('thread/resume', { threadId, ...params, excludeTurns: true })
        : await current.request('thread/start', params);
      if (server !== current) throw new Error('Codex restarted; try again');
      if (threadId && result?.thread?.id !== threadId) throw new Error(`Codex returned thread ${result?.thread?.id} instead of ${threadId}; refusing to change conversations`);
      threadId = result.thread.id;
      rollout = result.thread.path ?? rollout;
      instructions = result.instructionSources ?? instructions;
      if (result.model && result.model !== model?.id) model = view(result.model);
      effort ??= result.reasoningEffort ?? null;
      changed();
      return current;
    })().catch(error => { opened = null; throw error; });
  }

  function absorb(msg) {
    const p = msg.params ?? {};
    // A subagent's thread reports through the same server; it is not this tab.
    if (p.threadId && threadId && p.threadId !== threadId) return;
    if (msg.method === 'mcpServer/startupStatus/updated' && p.name) { servers.set(p.name, p.status); changed(); return; }
    const turn = p.turnId ?? p.turn?.id;
    if (turn && turn === stopped && /^(item|turn)\//.test(msg.method)) { if (msg.method === 'turn/completed') stopped = null; return; }
    if (msg.method === 'turn/started') turnId = p.turn?.id ?? turnId;
    if (msg.method === 'turn/completed') {
      // Another turn's end (one stopped and already gone) is not this one's.
      if (turnId && turn !== turnId) return;
      turnId = null;
    }
    let any = false;
    for (const event of codexEvents(msg)) {
      any = true;
      if (event.type === 'session') {
        if (event.name != null) sessionName = event.name;
        if (event.model) model = view(event.model);
      // Codex orders acknowledged input among its answer items. Drawing a
      // mid-turn send optimistically can put it before an earlier answer,
      // then move it on reopen. Its user item is the one transcript authority.
      } else transcript.absorb(event);
      // By the end of its first turn the thread is written down.
      if (event.type === 'turn' && event.state === 'end' && unwritten && written) { const name = unwritten; unwritten = ''; void rename(name); }
    }
    if (any) changed();
  }

  // What Codex asks the person. With approvals off it asks only its own
  // questions (request_user_input), in the window's one questions dialog;
  // an approval, should one come, is the same confirm Claude's are.
  async function answer(current, { id, method, params = {} }) {
    try {
      if (method === 'item/tool/requestUserInput') {
        const asked = (params.questions ?? []).map(q => ({ question: q.question, header: q.header, options: (q.options ?? []).map(o => ({ label: o.label, description: o.description })), multiSelect: false }));
        const answers = await adapter.ui.askQuestions(asked);
        return current.respond(id, { answers: Object.fromEntries((params.questions ?? []).map(q => [q.id, { answers: answers?.[q.question] ? [String(answers[q.question])] : [] }])) });
      }
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        const allowed = await adapter.ui.confirm(params.command ? `Run ${params.command}?` : 'Let Codex change these files?', params.reason ?? '');
        return current.respond(id, { decision: allowed ? 'accept' : 'decline' });
      }
      current.refuse(id, `imperfect does not answer ${method}`);
    } catch (error) { current.refuse(id, error?.message ?? String(error)); }
  }

  // A resumed thread's conversation, read back from Codex through the same
  // adapter that reads it live, each item timed by its turn.
  async function hydrate() {
    const current = connect();
    let thread;
    try { thread = (await current.request('thread/read', { threadId }))?.thread; }
    catch (error) { throw new Error(`Cannot read Codex session ${sessionPath}: ${error?.message ?? error}`); }
    const turns = [];
    let cursor = null;
    do {
      const page = await current.request('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 100, ...(cursor ? { cursor } : {}) });
      turns.push(...(page?.data ?? []));
      cursor = page?.nextCursor ?? null;
    } while (cursor);
    const past = turns.flatMap(turn => (turn.items ?? []).flatMap(item => codexItemEvents(item, true).map(event => {
      const at = (event.type === 'user' ? turn.startedAt : turn.completedAt ?? turn.startedAt) * 1000;
      return Number.isFinite(at) ? { ...event, timestamp: at } : event;
    })));
    if (!past.length) throw new Error(`Codex session ${sessionPath} was not found or has no readable conversation; refusing to start a new one`);
    transcript.absorbAll(past);
    transcript.absorb({ type: 'turn', state: 'end' });
    cwd ??= thread?.cwd ?? null;
    rollout = thread?.path ?? rollout;
    sessionName = thread?.name || transcript.firstUserLine().slice(0, 200);
    if (thread?.model) model = view(thread.model);
    effort = thread?.reasoningEffort ?? null;
  }

  try {
    await connect().ready;
    if (sessionPath) await hydrate();
  } catch (error) { server?.close(); throw error; }
  cwd ??= process.cwd();
  if (chosen?.provider === 'codex' && chosen.id) model = view(chosen.id);
  // The model a new thread starts on, as this computer's Codex settings pick
  // it, and the names of them all; asked once, in the background.
  void (async () => {
    if (!model) {
      const setting = (await connect().request('config/read', { cwd }).catch(() => null))?.config?.model;
      if (setting && !model) model = view(setting);
    }
    await loadModels();
    if (!model) { const usual = catalog.find(m => m.isDefault); if (usual) model = view(usual.id); }
    changed();
  })().catch(() => {});

  // An empty conversation in view starts its thread, once, so its overview
  // can say what Codex loaded (its instruction files, its MCP servers). A
  // thread with no turn leaves nothing on disk.
  function survey() {
    if (surveyed || threadId || opened || !imperfect.config()) return;
    surveyed = true;
    void open().catch(() => {});
  }
  function overview() {
    return startup('Codex', version, cwd, [
      section('Context', instructions.map(p => cwdRelative(p, cwd)), instructions.map(tildePath)),
      section('MCP', [...servers].map(([name, status]) => status === 'ready' ? name : `${name} (${status})`)),
    ]);
  }

  function snapshot() { return cached ??= build(); }
  function build() {
    if (!transcript.messages.length) survey();
    return transcript.view('codex', {
      level: effort ?? defaultLevel(), sessionId: written ? threadId : null, sessionFile: written ? rollout ?? threadId : null, cwd, name: sessionName,
      model, billing,
      busy: transcript.streaming || sending > 0 || adapter.state.dialogs.length > 0,
      operation: transcript.compacting ? 'compacting' : null,
      // What is said mid-turn goes to Codex at once; nothing waits here.
      queue: { steering: [], items: [] },
      ui: adapter.state,
      startup: overview(),
    });
  }

  async function rename(name) {
    try { await (await open()).request('thread/name/set', { threadId, name }); }
    catch { /* the tab keeps the name until it closes */ }
  }
  const idle = () => { if (transcript.streaming) throw new Error('Codex is still working; abort or wait'); };

  async function command(c) {
    // A sign-in changed under an idle tab: its server held the old one.
    if (['prompt', 'models', 'model', 'level'].includes(c?.type) && authRevision !== codexAuthRevision()) {
      if (transcript.streaming || adapter.state.dialogs.length) throw new Error('Codex sign-in changed; wait for this session to finish before continuing.');
      restart();
      authRevision = codexAuthRevision();
      billing = authImpl() === 'apikey' ? 'API · OpenAI key' : 'ChatGPT subscription';
    }
    switch (c?.type) {
      case 'snapshot': return snapshot();
      case 'dialog': adapter.respond({ ...c, id: c.dialogId }); return;
      // Already checked and made whole by the tab host (tabs.mjs). Said
      // during a turn, it goes into that turn, as typing into Codex's
      // terminal does; otherwise it starts one.
      case 'prompt': {
        const { text = '', images = [] } = c;
        const words = text || 'See attached.';
        sending++; changed();
        try {
          const current = await open();
          const midTurn = transcript.streaming;
          const started = await current.request('turn/start', {
            threadId, input: [{ type: 'text', text: words, text_elements: [] }, ...images.map(img => ({ type: 'image', url: `data:${img.mimeType};base64,${img.data}` }))],
            ...(model ? { model: model.id } : {}), ...(effort ? { effort } : {}),
          });
          written = true;
          if (!midTurn) { transcript.absorb({ type: 'turn', state: 'start' }); turnId = started?.turn?.id ?? turnId; }
          if (!sessionName) sessionName = text.split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 200) ?? '';
          return { accepted: true, queued: midTurn, ...(midTurn ? { steered: true } : {}) };
        } finally { sending--; changed(); }
      }
      case 'abort': {
        adapter.reset();
        const turn = turnId;
        stopped = turn; turnId = null;
        if (server && threadId && turn) await server.request('turn/interrupt', { threadId, turnId: turn }).catch(() => {});
        transcript.absorb({ type: 'turn', state: 'end' });
        changed();
        return { steering: [], items: [] };
      }
      case 'queue-take': return { item: null };
      case 'models': {
        try { return (await loadModels()).map(m => ({ ...view(m.id), description: m.description || '', billing })); }
        catch { return model ? [{ ...model, billing }] : []; }
      }
      // The ChatGPT subscription's limits, read with Codex's own sign-in
      // (usage.mjs), as they are when Pi has none.
      case 'usage': return usageImpl();
      // Taken with the next turn, and every turn after it.
      case 'model': {
        idle();
        if (!catalog.length) await loadModels().catch(() => {});
        if (catalog.length && !catalog.some(m => m.id === c.modelId)) throw new Error('Codex does not offer that model here');
        model = view(c.modelId);
        if (effort && levels().length && !levels().includes(effort)) effort = null;
        changed();
        return { id: c.modelId };
      }
      // How hard it thinks: Codex calls it reasoning effort.
      case 'level': {
        if (!catalog.length) await loadModels().catch(() => {});
        if (!c.level) return { current: effort ?? defaultLevel(), available: levels() };
        idle();
        if (!levels().includes(c.level)) throw new Error('This Codex model does not support that effort level');
        effort = c.level;
        changed();
        return { current: effort, available: levels() };
      }
      case 'name': {
        if (typeof c.name !== 'string') throw new Error('Name must be text');
        sessionName = c.name.slice(0, 200);
        changed();
        // Named before its first turn, a thread would be written down empty.
        if (written) await rename(sessionName); else unwritten = sessionName;
        return;
      }
      default: throw new Error(`Unsupported command: ${c?.type}`);
    }
  }

  return {
    events, snapshot, command,
    background: () => [],
    session: () => ({ sessionId: threadId, cwd }),
    // A closing tab lets its current turn finish (tabs.mjs waits for it), but
    // nothing is left to answer its questions.
    drop() { adapter.reset(); changed(); },
    async close() {
      if (closed) return;
      closed = true;
      imperfect.close();
      adapter.reset();
      restart();
      events.removeAllListeners();
    },
  };
}
