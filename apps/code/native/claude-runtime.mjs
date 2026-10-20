import { EventEmitter } from 'node:events';
import { claudeAuth, claudeAuthRevision, claudeSubscriptionEnv } from './claude-auth.mjs';
export { claudeAuth } from './claude-auth.mjs';
import {
  query as sdkQuery,
  listSessions as sdkListSessions,
  getSessionMessages as sdkGetSessionMessages,
  getSessionInfo as sdkGetSessionInfo,
  renameSession as sdkRenameSession,
  resolveSettings as sdkResolveSettings,
} from '@anthropic-ai/claude-agent-sdk';
import { mcpSession } from './mcp.mjs';
import { createExtensionUI } from './extension-ui.mjs';
import { createTranscript } from './transcript.mjs';
import { claudeUsage as subscriptionUsage, usageStore } from './usage.mjs';
import { cwdRelative, section, sorted, startup, tildePath } from './startup.mjs';

// The second harness: Claude Code itself, through its SDK, behind the same
// members the tab host asks of Pi — events, snapshot, command, drop and close.
//
// It never touches a message list. `claudeEvents` turns each SDK frame into
// the events transcript.mjs understands, and the transcript folds them into
// the canonical shape the window draws, so the renderer knows no harness.
//
// Claude keeps its own sessions in ~/.claude, in its own format. Nothing here
// keeps a second copy: a resumed tab reads its transcript back from the SDK.

// Claude Code's own stored subscription sign-in, never Pi's Anthropic auth.
export function assertClaudeSubscription(account, { token = false } = {}) {
  // Recent Claude Code versions omit tokenSource for subscription logins and
  // report the plan instead. Neither an absent source nor firstParty alone
  // proves subscription billing; require a recognized plan in that case.
  // The shared subscription token (claude-auth.mjs) reports its variable,
  // which only imperfect sets, from the owner's file, and only then.
  const subscription = account?.tokenSource === 'claude.ai' ||
    (token && account?.tokenSource === 'CLAUDE_CODE_OAUTH_TOKEN') ||
    (account?.tokenSource == null && /^Claude (Pro|Max|Team|Enterprise)$/i.test(account?.subscriptionType ?? ''));
  if (account?.apiProvider !== 'firstParty' || !subscription ||
      (account.apiKeySource && account.apiKeySource !== 'none')) throw new Error('Claude Code is not using your Claude subscription. API and third-party billing are blocked; sign in to Claude Code in imperfect.');
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
}

// The pictures a tool handed back (a screenshot it read), in the
// transcript's image shape, so the person sees what the agent looked at.
function toolResultImages(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter(b => b?.type === 'image' && b.source?.type === 'base64' && b.source.data)
    .map(b => ({ type: 'image', data: b.source.data, mimeType: b.source.media_type }));
}

function describeToolInput(input) {
  if (!input || typeof input !== 'object' || !Object.keys(input).length) return '';
  try {
    const text = Object.entries(input).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n');
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch { return ''; }
}

// What the SDK's result frame counted, in the footer's words. Claude reports a
// context window per model; the last iteration's prompt is what is in it.
function claudeUsage(msg) {
  const usage = msg.usage ?? {};
  const out = { tokens: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 } };
  if (typeof msg.total_cost_usd === 'number') out.cost = msg.total_cost_usd;
  const contextWindow = Math.max(0, ...Object.values(msg.modelUsage ?? {}).map(m => Number(m?.contextWindow) || 0));
  if (contextWindow) {
    const last = (usage.iterations ?? []).at(-1);
    const held = last ? (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) : null;
    out.contextUsage = { contextWindow, ...(held != null ? { percent: (held / contextWindow) * 100 } : {}) };
  }
  return out;
}

// The stream ids Claude never writes down. Deltas arrive by content-block
// index inside the current API message; the frame that settles a block comes
// later, one block at a time, in the same order. This joins the two.
export function createClaudeContext() {
  return { names: new Map(), blocks: [], settled: 0, message: 0 };
}

// Claude's frames, as transcript events. Pure, so it can be run over a
// recorded stream (test/fixtures/claude-sdk.jsonl) and over a resumed
// session's history alike. `session` events carry facts the runtime keeps
// (model, version, tools); everything else is the conversation.
export function claudeEvents(msg, ctx = createClaudeContext()) {
  if (!msg || typeof msg !== 'object') return [];
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        return [{
          type: 'session', sessionId: msg.session_id, version: msg.claude_code_version, effort: msg.effort, model: msg.model,
          tools: Array.isArray(msg.tools) ? msg.tools : undefined,
        }];
      }
      // Compacting: begun when Claude says so, ended by its boundary (with
      // how many tokens it held before and after) or by its status clearing.
      if (msg.subtype === 'status') return msg.status === 'compacting' ? [{ type: 'compaction', state: 'start' }] : msg.status == null ? [{ type: 'compaction', state: 'stop' }] : [];
      if (msg.subtype === 'compact_boundary') return [{ type: 'compaction', state: 'end', tokensBefore: msg.compact_metadata?.pre_tokens, tokensAfter: msg.compact_metadata?.post_tokens }];
      return [{ type: 'unknown', kind: `system/${msg.subtype}` }];
    case 'stream_event': {
      const event = msg.event;
      if (event?.type === 'message_start') { ctx.message++; ctx.blocks = []; ctx.settled = 0; return []; }
      if (event?.type === 'content_block_start') { ctx.blocks[event.index] = `${ctx.message}:${event.index}`; return []; }
      if (event?.type === 'content_block_delta') {
        const id = ctx.blocks[event.index] ?? `${ctx.message}:${event.index}`;
        if (event.delta?.type === 'text_delta') return [{ type: 'text', id, delta: event.delta.text ?? '' }];
        if (event.delta?.type === 'thinking_delta') return [{ type: 'thinking', id, delta: event.delta.thinking ?? '' }];
      }
      // content_block_stop, message_delta, message_stop: nothing to draw.
      return [];
    }
    case 'assistant': {
      const out = [];
      const model = msg.message?.model ?? null;
      for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
        const id = ctx.blocks[ctx.settled] ?? `${ctx.message}:${ctx.settled}`;
        ctx.settled++;
        if (block?.type === 'text') out.push({ type: 'text', id, text: block.text ?? '', done: true, model });
        else if (block?.type === 'thinking') out.push({ type: 'thinking', id, text: block.thinking ?? '', done: true });
        else if (block?.type === 'tool_use') { ctx.names.set(block.id, block.name); out.push({ type: 'tool', id: block.id, name: block.name, arguments: block.input ?? {}, status: 'running' }); }
        else if (block?.type) out.push({ type: 'unknown', kind: `assistant/${block.type}` });
      }
      if (msg.error) out.push({ type: 'error', message: String(msg.error.message ?? msg.error) });
      return out;
    }
    case 'user': {
      const content = msg.message?.content;
      const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
      // A user frame carrying tool_result blocks is Claude reporting a tool.
      const results = blocks.filter(b => b?.type === 'tool_result');
      // The summary a compaction leaves is Claude's, not the person's: read
      // back it is where the conversation was compacted. Anything else Claude
      // wrote in the person's place is not drawn as theirs either.
      if (!results.length && msg.isCompactSummary) return [{ type: 'compaction', state: 'end' }];
      if (!results.length && (msg.isSynthetic || msg.isMeta || msg.is_meta)) return [];
      if (results.length) return results.map(r => ({ type: 'tool', id: r.tool_use_id, name: ctx.names.get(r.tool_use_id), status: r.is_error ? 'failed' : 'done', output: toolResultText(r.content), images: toolResultImages(r.content), isError: Boolean(r.is_error) }));
      const said = blocks.flatMap(b => b?.type === 'text' ? [{ type: 'text', text: b.text ?? '' }] : b?.type === 'image' && b.source?.type === 'base64' ? [{ type: 'image', data: b.source.data, mimeType: b.source.media_type }] : []);
      return said.length ? [{ type: 'user', content: said }] : [];
    }
    case 'result':
      return [{ type: 'usage', ...claudeUsage(msg) }, { type: 'turn', state: 'end', failed: msg.subtype && msg.subtype !== 'success' ? msg.subtype : null }];
    case 'rate_limit_event': return [];
    default: return [{ type: 'unknown', kind: String(msg.type) }];
  }
}

// Claude's half of the machine's history, read without a running tab. The
// SDK's option is `dir`, not `cwd`; history wants every session, so none is
// passed. `path` is the session id: Claude owns the file and its location.
export async function listClaudeSessions(listSessionsImpl = sdkListSessions) {
  if (!claudeAuth()) return [];
  const rows = await listSessionsImpl({}).catch(() => []);
  return rows.map(s => ({
    id: s.sessionId, path: s.sessionId,
    name: s.customTitle || s.summary || '', firstMessage: s.firstPrompt || '',
    cwd: s.cwd || '', modified: s.lastModified ?? s.createdAt ?? 0,
    agent: 'claude',
  }));
}

export async function createClaudeRuntime({
  cwd = process.cwd(), sessionPath = null, model: chosen = null,
  queryImpl = sdkQuery, sessionMessagesImpl = sdkGetSessionMessages,
  sessionInfoImpl = sdkGetSessionInfo, renameImpl = sdkRenameSession, resolveSettingsImpl = sdkResolveSettings,
  accountInfoImpl = query => query.accountInfo(), authImpl = claudeAuth,
} = {}) {
  // A new conversation needs the machine signed in. One already had keeps
  // its history on show without it (a lapsed sign-in, or the store's demo
  // computer); asking it anything answers with Claude's own sign-in error.
  if (!authImpl() && !sessionPath) throw new Error('This machine is not signed in to Claude. Sign in to Claude Code in imperfect to use your Claude subscription.');
  let history = [];
  // A name given here is Claude Code's own title for the session: it is
  // written with the SDK's renameSession, listed as customTitle, and read
  // back from there when the session is opened again.
  let title = '';
  if (sessionPath) {
    title = (await Promise.resolve(sessionInfoImpl?.(sessionPath)).catch(() => null))?.customTitle ?? '';
    try { history = await sessionMessagesImpl(sessionPath) ?? []; }
    catch (error) { throw new Error(`Cannot read Claude session ${sessionPath}: ${error?.message ?? error}`); }
    if (!history.length) throw new Error(`Claude session ${sessionPath} was not found or has no readable conversation; refusing to start a new one`);
  }
  // The model this machine's Claude Code settings pick, as Claude Code itself
  // resolves them; Opus 5.5 unless the person chose otherwise.
  const settings = await Promise.resolve(resolveSettingsImpl?.({ cwd, settingSources: [] })).catch(() => null);
  const configured = settings?.effective?.model || 'claude-opus-5-5';
  const events = new EventEmitter();
  let closed = false;
  let identityError = null;
  // Whether Claude Code has said it is in this conversation (its init). A
  // resumed one that fails before it does could not be resumed.
  let confirmed = false;
  // The snapshot is made once per change, however many ask for it.
  let cached = null;
  const changed = () => { cached = null; if (!closed) events.emit('change'); };
  const adapter = createExtensionUI(changed);

  const transcript = createTranscript();
  let promptSeq = 0;
  let ctx = createClaudeContext();
  let sessionId = sessionPath ?? null;
  let model = null;
  let supportedModels = [];
  let claudeVersion = null;
  let tools = [];
  // Locus's choice, 2026-10-01: Claude (Opus 5.5) thinks at extra-high effort unless told otherwise.
  let effort = 'xhigh';
  let sessionName = title;
  // A name given before the first turn waits for the session to exist.
  let unwritten = '';
  // Whether the turn running, and the last one to end, began with the person's
  // message. Claude also starts turns of its own (a background task reporting
  // back); those settle quietly.
  let asked = false, lastAsked = true;

  // Streaming input mode buys interrupt(), setModel() and a session that
  // outlives one prompt — the same shape as Pi's long-lived runtime. The next
  // message waits in `steering` and joins the transcript at the moment
  // Claude is handed it.
  let wake = null;
  const nudge = () => { const w = wake; wake = null; w?.(); };
  // One query at a time; one that ends is started again by the next prompt.
  // Each query's input stream ends with it, so an old one can never take the
  // new one's messages.
  let q = null, pumping = null, stream = null;
  // Work Claude left running when its turn ended: a subagent or a command it
  // put in the background. Its turn is over, but the tab is still working, and
  // says so, until that work is done; a restart waits for it too, since it
  // dies with this Claude Code. The SDK says which background tasks are live
  // (background_tasks_changed, the whole set each time; "ambient" ones are
  // not work) and when one settles (task_notification). Claude Code also says
  // whether it is running at all (session_state_changed): it stays running
  // while its subagents work, and runs again to answer a task that finished,
  // a turn nobody sent. A Claude Code that starts or ends has none of either.
  const background = new Map();
  let claudeState = 'idle';
  function noteBackground(msg) {
    if (msg?.type !== 'system') return;
    if (msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks)) {
      background.clear();
      for (const task of msg.tasks) if (task?.task_id && !task.ambient) background.set(String(task.task_id), String(task.description || task.task_type || 'a background task'));
    }
    if (msg.subtype === 'task_notification') background.delete(String(msg.task_id));
    if (msg.subtype === 'session_state_changed') claudeState = msg.state;
  }
  // What is still working outside the person's turn, in words for a log line.
  function backgroundWork() {
    const work = [...background.values()];
    if (!work.length && claudeState !== 'idle' && !transcript.streaming) work.push('Claude answering background work');
    return work;
  }
  const claudeContent = item => [
    { type: 'text', text: item.text || 'See attached.' },
    ...item.images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } })),
  ];
  // Steering goes to Claude Code at once, marked to be taken at its next
  // step ('next'), as what is typed while it works in a terminal is; it does
  // not wait for the turn to end. Without a turn running it starts one.
  const steering = [];
  async function* outbound(own) {
    while (!closed && own.live) {
      if (steering.length) {
        const next = steering.shift();
        const midTurn = transcript.streaming;
        transcript.absorb({ type: 'user', content: [{ type: 'text', text: next.text || 'See attached.' }, ...next.images.map(img => ({ type: 'image', data: img.data, mimeType: img.mimeType }))] });
        if (!midTurn) { transcript.absorb({ type: 'turn', state: 'start' }); asked = true; }
        changed();
        yield { type: 'user', message: { role: 'user', content: claudeContent(next) }, parent_tool_use_id: null, session_id: sessionId ?? '', ...(midTurn ? { priority: 'next' } : {}) };
        continue;
      }
      await new Promise(resolve => { wake = resolve; });
    }
  }

  let authRevision = claudeAuthRevision();
  const options = {
    cwd,
    // No claude.ai connectors (Gmail, Drive, custom ones) in imperfect's Claude: the
    // person's own tools are what imperfect gives it, and unconnected connectors
    // otherwise arrive as sign-in notices the model is told to repeat.
    settings: { disableClaudeAiConnectors: true },
    // Two things the SDK has no option for, so they are said as Claude Code
    // reads them, from its environment. Noah's choice, 2026-09-30: compact at
    // 40% of the window, well before the context fills and the answers thin
    // out. And Claude Code says when it is running, which the SDK otherwise
    // keeps to itself.
    env: { ...claudeSubscriptionEnv(), CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '40', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
    // A tab restored after a restart keeps the model it was on.
    model: chosen?.provider === 'claude-agent' && chosen.id ? chosen.id : configured,
    // Claude Code's own system prompt, untouched: imperfect adds no words to
    // it. Claude reads the person's instructions itself: the AGENTS.md of the
    // session's folder and every folder above it (~/AGENTS.md among them); if
    // any of those folders has a CLAUDE.md, the CLAUDE.md files instead.
    // Instruction files still load, but settings cannot inject API keys,
    // helpers, alternate routes or hooks ahead of the subscription.
    settingSources: [],
    // No skills, Claude Code's own or anyone's (Noah, 2026-10-01).
    skills: [],
    // Claude Code's tools that do nothing here or only add noise (Noah,
    // 2026-10-20): Skill and ReportFindings need skills; Workflow, /loop's
    // ScheduleWakeup and the cron tools are orchestration nobody asked for;
    // ListAgents, DesignSync and RemoteTrigger serve claude.ai and the cloud;
    // PushNotification is imperfect's notify again; plan mode, worktrees and
    // notebooks go unused.
    disallowedTools: [
      'Workflow', 'Skill', 'ReportFindings', 'ScheduleWakeup', 'ListAgents',
      'PushNotification', 'DesignSync', 'RemoteTrigger',
      'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
      'CronCreate', 'CronDelete', 'CronList', 'NotebookEdit',
    ],
    includePartialMessages: true,
    // Locus's choice, 2026-09-19: this window opens with permissions bypassed.
    // It is his own machine behind his own tailnet.
    permissionMode: 'bypassPermissions',
    effort,
    // Pi asks through dialogs the window already draws; Claude asks through
    // canUseTool, positionally (toolName, input, options). Same dialogs.
    canUseTool: async (toolName, input, { signal, title, displayName, description } = {}) => {
      // AskUserQuestion's answers are "collected by the permission component";
      // this is that component.
      if (toolName === 'AskUserQuestion' && Array.isArray(input?.questions) && input.questions.length) {
        const answers = await adapter.ui.askQuestions(input.questions, { signal });
        if (!answers) return { behavior: 'deny', message: 'The person closed the question without answering.' };
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      const detail = describeToolInput(input);
      const body = description ? (detail ? `${description}\n\n${detail}` : description) : detail;
      const allowed = await adapter.ui.confirm(title || `Run ${displayName || toolName || 'a tool'}?`, body, { signal });
      return allowed
        ? { behavior: 'allow', updatedInput: input ?? {} }
        : { behavior: 'deny', message: 'The person declined this tool call.' };
    },
  };

  function modelView(info) {
    if (!info?.value) return null;
    // `default` is named for the choice ("Default (recommended)"), not the
    // model answering under it; name that model instead.
    const name = info.value === 'default' && info.resolvedModel ? info.resolvedModel : info.displayName || info.value;
    return {
      provider: 'claude-agent', id: info.value, name,
      description: info.description || '', resolvedModel: info.resolvedModel,
      supportsEffort: info.supportsEffort === true,
      supportedEffortLevels: Array.isArray(info.supportedEffortLevels) ? [...info.supportedEffortLevels] : [],
    };
  }
  async function loadModels() {
    supportedModels = await live().supportedModels();
    return supportedModels;
  }
  async function nameModel(wanted) {
    if (!wanted) return;
    try {
      const rows = await loadModels();
      const info = rows.find(row => row.value === wanted) ?? rows.find(row => row.resolvedModel === wanted && row.value !== 'default') ?? rows.find(row => row.resolvedModel === wanted);
      model = modelView(info) ?? model ?? { id: wanted, provider: 'claude-agent', name: wanted };
      changed();
    } catch { /* offline or not signed in; init says soon enough */ }
  }

  function session(event) {
    claudeVersion = event.version ?? claudeVersion;
    effort = event.effort ?? effort;
    tools = event.tools ?? tools;
    if (event.model && model?.id !== event.model && model?.resolvedModel !== event.model) {
      model = { id: event.model, provider: 'claude-agent', name: event.model };
      void nameModel(event.model);
    }
  }
  function absorb(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'result' && msg.subtype !== 'success' && sessionPath && !confirmed) {
      identityError = (msg.errors ?? []).join('\n') || `Claude Code could not resume session ${sessionPath}`;
      throw new Error(identityError);
    }
    // The conversation's id is taken from the conversation: Claude Code also
    // runs its SessionStart hooks, and reports them under a new id, before any
    // prompt, and nothing is written under that id. Taking it gave a tab a
    // conversation to resume that did not exist.
    const conversation = ['assistant', 'user', 'result', 'stream_event'].includes(msg.type) || (msg.type === 'system' && msg.subtype === 'init');
    if (msg.session_id && conversation) {
      if (sessionId && msg.session_id !== sessionId) {
        identityError = `Claude returned session ${msg.session_id} instead of ${sessionId}; refusing to change conversations`;
        throw new Error(identityError);
      }
      sessionId = msg.session_id;
      if (msg.type === 'system') confirmed = true;
    }
    noteBackground(msg);
    // How much of the Claude subscription is used, as Claude Code reports it.
    if (msg.type === 'rate_limit_event') usageStore.claudeEvent(msg.rate_limit_info);
    for (const event of claudeEvents(msg, ctx)) {
      if (event.type === 'session') session(event);
      else transcript.absorb(event);
      if (event.type === 'turn' && event.state === 'end') {
        lastAsked = asked; asked = false; nudge();
        // By the end of its first turn the session is written down.
        if (unwritten && sessionId) { const name = unwritten; unwritten = ''; void rename(name); }
      }
    }
    changed();
  }

  // imperfect's own tools, from its MCP endpoint (mcp.mjs), up front rather
  // than behind tool search: how show and dev_server are meant to be used is
  // written in their descriptions. Nothing is installed or written into
  // ~/.claude; they exist only while Claude runs inside imperfect.
  // A call may take as long as it needs, as in Pi: left to itself, Claude Code
  // gives up on any call that has not answered in 60 seconds (a picture often
  // takes two minutes) while the tool goes on. Stopping the turn still stops it.
  const imperfect = mcpSession({ cwd: () => cwd, session: () => sessionId ?? '', harness: 'claude', ui: adapter.ui });
  const servers = () => { const config = imperfect.config(); return config ? { imperfect: { type: 'http', ...config, alwaysLoad: true, timeout: 24 * 60 * 60 * 1000 } } : {}; };

  let built = null;
  function start() {
    built = null;
    tools = [];
    stream = { live: true };
    background.clear(); claudeState = 'idle';
    const current = q = queryImpl({ prompt: outbound(stream), options: { ...options, ...(sessionId ? { resume: sessionId } : {}), mcpServers: servers() } });
    // Started before imperfect was serving (a tab restored as it starts): the
    // tools join once it is.
    if (!imperfect.config()) imperfect.whenServing(() => { if (q === current) void current.setMcpServers?.(servers()).catch(() => {}); });
    if (!model) void nameModel(options.model);
    pumping = (async () => {
      let failed = null;
      try { for await (const msg of current) { if (q !== current) break; absorb(msg); } }
      catch (error) { failed = error?.message ?? String(error); }
      // Claude Code ended under a live tab. Say so, and let the next prompt
      // start it again, rather than leave the tab waiting on nothing.
      if (closed || q !== current) return;
      q = null; stream.live = false;
      background.clear(); claudeState = 'idle';
      if (failed && sessionPath && !confirmed) identityError = failed;
      if (identityError) { try { current.close?.(); } catch { /* already ended */ } }
      if (failed || transcript.streaming) transcript.absorb({ type: 'turn', state: 'end', failed: failed ?? 'Claude Code stopped' });
      changed();
    })();
  }
  const live = () => { if (identityError) throw new Error(identityError); if (!q) start(); return q; };
  async function stop() {
    const current = q;
    q = null;
    if (stream) stream.live = false;
    nudge();
    try { current?.close?.(); } catch { /* already ended */ }
    await Promise.race([pumping?.catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000).unref())]);
  }
  hydrate();
  start();

  // A resumed session's transcript, read back from the harness that wrote it,
  // through the same adapter that reads it live.
  function hydrate() {
    if (!sessionId) return;
    const rows = history;
    if (!rows.length || transcript.messages.length) return;
    const past = createClaudeContext();
    // Each keeps the time its row was written, so a turn read back is timed.
    const events = rows.flatMap(row => {
      const at = Date.parse(row.timestamp);
      return claudeEvents(row, past).map(event => Number.isFinite(at) ? { ...event, timestamp: at } : event);
    }).filter(event => event.type !== 'session');
    if (!events.length || transcript.messages.length) return;
    ctx.names = past.names;
    transcript.absorbAll(events);
    transcript.absorb({ type: 'turn', state: 'end' });
    if (!sessionName) sessionName = transcript.firstUserLine().slice(0, 200);
    changed();
  }

  // What this Claude was put together from, asked of Claude Code itself: the
  // instruction files it loaded, its skills, its MCP servers and their tools.
  // Both answers are local and spend no tokens. Asked once, by the first
  // snapshot of an empty conversation.
  function survey() {
    if (built || !q) return;
    built = {};
    const current = q;
    // Asked before initialize has answered, the MCP servers are not there yet.
    Promise.resolve(current.initializationResult?.())
      .then(() => Promise.all([current.mcpServerStatus?.(), current.getContextUsage?.({ detail: 'summary' })]))
      .then(([servers, usage]) => { if (q !== current) return; built = { servers: servers ?? [], usage }; changed(); })
      .catch(() => { if (q === current) built = null; });
  }
  function overview() {
    const usage = built?.usage, servers = built?.servers ?? [];
    const memory = usage?.memoryFiles?.map(f => f.path) ?? [];
    const named = tools.length ? tools : servers.flatMap(s => (s.tools ?? []).map(t => t.name));
    return startup('Claude Code', claudeVersion, cwd, [
      section('Context', memory.map(p => cwdRelative(p, cwd)), memory.map(tildePath)),
      section('MCP', servers.map(s => s.status === 'connected' ? s.name : `${s.name} (${s.status})`),
        servers.map(s => `${s.name}: ${s.tools?.length ? s.tools.map(t => t.name).join(', ') : s.status}`)),
      section('Tools', sorted(named.map(name => name.replace(/^mcp__.+?__/, '')))),
    ]);
  }

  function snapshot() {
    return cached ??= build();
  }
  function build() {
    if (!transcript.messages.length) survey();
    return {
      turnAsked: lastAsked,
      ...transcript.view('claude', {
        level: effort, sessionId, sessionFile: sessionId, cwd, name: sessionName,
        model,
        billing: 'Claude subscription · extra usage if enabled in Claude',
        // What waits for a Claude Code that has ended goes with the next prompt.
        busy: transcript.streaming || (steering.length > 0 && Boolean(q)) || adapter.state.dialogs.length > 0,
        operation: transcript.compacting ? 'compacting' : backgroundWork().length ? 'background' : null,
        queue: { steering: steering.map(item => item.text), items: steering.map(item => ({ ...item, lane: 'steering' })) },
        ui: adapter.state,
        startup: overview(),
      }),
    };
  }

  async function rename(name) {
    try { await renameImpl(sessionId, name); }
    catch { /* the tab keeps the name until it closes */ }
  }

  const idle = () => { if (transcript.streaming) throw new Error('Claude is still working; abort or wait'); };

  async function command(c) {
    if (['prompt', 'models', 'model', 'usage', 'level'].includes(c?.type) && authRevision !== claudeAuthRevision()) {
      if (transcript.streaming || backgroundWork().length || adapter.state.dialogs.length) throw new Error('Claude sign-in changed; wait for this session to finish before continuing.');
      await stop();
      options.env = { ...claudeSubscriptionEnv(), CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '40', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
      authRevision = claudeAuthRevision();
    }
    switch (c?.type) {
      case 'snapshot': return snapshot();
      case 'dialog': adapter.respond({ ...c, id: c.dialogId }); return;
      // Already checked and made whole by the tab host (tabs.mjs).
      case 'prompt': {
        if (identityError) throw new Error(identityError);
        // Initialization/accountInfo is local: verify the actual SDK backend
        // before handing even the first prompt to Claude (managed policy too).
        let account;
        const checked = live();
        try { account = await accountInfoImpl(checked); }
        catch { throw new Error('Could not verify Claude Code subscription billing; no prompt was sent.'); }
        assertClaudeSubscription(account, { token: authImpl() === 'token' });
        if (closed || q !== checked || authRevision !== claudeAuthRevision()) throw new Error('Claude Code restarted or sign-in changed during billing verification; no prompt was sent. Try again.');
        const { text = '', images = [] } = c;
        steering.push({ id: c.requestId || `steer-${++promptSeq}`, text, images });
        if (!sessionName) sessionName = text.split('\n').map(s => s.trim()).find(Boolean)?.slice(0, 200) ?? '';
        transcript.failed = null;
        live(); nudge(); changed();
        return { accepted: true, queued: transcript.streaming, ...(transcript.streaming ? { steered: true } : {}) };
      }
      // What was waiting goes back to the composer.
      case 'abort': {
        adapter.reset();
        const items = steering.splice(0).map(item => ({ ...item, lane: 'steering' }));
        try { await q?.interrupt?.(); } catch { /* idle */ }
        transcript.absorb({ type: 'turn', state: 'end' });
        changed();
        return { steering: items.map(item => item.text), items };
      }
      case 'queue-take': {
        const at = c.queueId == null ? steering.length - 1 : steering.findIndex(item => item.id === c.queueId);
        const item = at < 0 ? null : steering.splice(at, 1)[0];
        changed();
        return { item: item ? { id: item.id, lane: 'steering', text: item.text, images: item.images.map(img => ({ type: 'image', data: img.data, mimeType: img.mimeType })) } : null };
      }
      case 'models': {
        try { return (await loadModels()).map(modelView).filter(Boolean).map(m => ({ ...m, billing: 'Claude subscription · extra usage if enabled in Claude' })); }
        catch { return model ? [model] : []; }
      }
      case 'usage': return subscriptionUsage({ query: live() });
      case 'model': {
        idle();
        await live().setModel(c.modelId);
        // A Claude Code started again (it ended, or a restart) keeps the choice.
        options.model = c.modelId;
        model = modelView(supportedModels.find(row => row.value === c.modelId || row.resolvedModel === c.modelId)) ?? { id: c.modelId, provider: 'claude-agent', name: c.modelId };
        changed();
        return { id: c.modelId };
      }
      // How hard it thinks: Claude Code calls it effort.
      case 'level': {
        // Before the first prompt the model is not known yet; ask for it.
        if (!model?.supportsEffort) await nameModel(model?.id ?? options.model ?? 'default');
        if (!c.level) return { current: effort, available: model?.supportsEffort ? model.supportedEffortLevels : [] };
        idle();
        if (!model?.supportsEffort || !model.supportedEffortLevels.includes(c.level)) throw new Error('This Claude model does not support that effort level');
        await live().applyFlagSettings({ effortLevel: c.level });
        // A Claude Code started again keeps the level.
        options.effort = effort = c.level;
        changed();
        return { current: effort, available: model.supportedEffortLevels };
      }
      case 'name': {
        if (typeof c.name !== 'string') throw new Error('Name must be text');
        sessionName = c.name.slice(0, 200);
        changed();
        if (sessionId) await rename(sessionName); else unwritten = sessionName;
        return;
      }
      default: throw new Error(`Unsupported command: ${c?.type}`);
    }
  }

  return {
    events, snapshot, command,
    background: backgroundWork,
    session: () => ({ sessionId, cwd }),
    // A closing tab lets its current turn finish (tabs.mjs waits for it), but
    // nothing is left to answer its questions or want its queue; waiting on
    // either never ended.
    drop() { steering.length = 0; adapter.reset(); changed(); },
    async close() {
      if (closed) return;
      closed = true;
      imperfect.close();
      await stop();
      events.removeAllListeners();
    },
  };
}
