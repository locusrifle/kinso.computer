import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ModelRuntime, SettingsManager, SessionManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { Harness, createRegistry, hook, ToolTask, InboxDoc } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { AssistantMessageEventStream, getSupportedThinkingLevels, clampThinkingLevel } from '@earendil-works/pi-ai';
import { createExtensionUI } from './extension-ui.mjs';
import { createAuth } from './auth.mjs';
import { canonicalSnapshot } from './canonical.mjs';
import { mcpSession } from './mcp.mjs';
import { availableTools } from './tools.mjs';
import { onDeviceHandsChange } from '../../../system/device-hands.mjs';
import { questionsTool } from './questions.mjs';
import { resources, codingTools, instructions, resourceStartup, sessionStats, expandPromptTemplate } from './durable-resources.mjs';
import { withGPTFastMode } from './gpt-fast-policy.mjs';
import { withCompactRequestImages } from './request-images.mjs';
import { usageStore } from './usage.mjs';
import { codexResets } from './codex-resets.mjs';
import { durableSubagents, terminal } from './subagent.mjs';
import { context, SessionInfo, cleanJSON, openSessionFile, initializeSession, transcript } from './durable-session.mjs';

// The persistent, out-of-checkout service guard rejects pre-Durable rollbacks.
export const PI_HISTORY_FORMAT = 'durable-sqlite-v1';
export const piAnthropicBlocked = () => new Error('Claude runs only in Claude Code on your subscription. Pi Anthropic credentials are not used; sign in to Claude Code in imperfect.');
export function withoutPiAnthropic(stream) {
  return (model, ...args) => { if (model?.provider === 'anthropic') throw piAnthropicBlocked(); return stream(model, ...args); };
}
export function assertChatGPTSubscription(models, model) {
  if (model?.provider !== 'openai-codex') return;
  if (!models.isUsingSubscription('openai-codex')) throw new Error('ChatGPT requires OAuth subscription sign-in; refusing API-key fallback');
  const url = new URL(model.baseUrl);
  if (model.api !== 'openai-codex-responses' || url.protocol !== 'https:' || url.host !== 'chatgpt.com' || url.username || url.password || url.pathname.replace(/\/$/, '') !== '/backend-api' || url.search) throw new Error('ChatGPT requires the built-in subscription endpoint; refusing a paid or overridden route');
}

// Listing is read-only; saved tabs import at startup, other Classic histories
// import only when opened. Never start a Harness for every history just to list
// it. A JSONL row and its sidecar are one continuation, including path aliases.
export async function listPiSessions({ agentDir = getAgentDir(), sessionDir = null } = {}) {
  const canonical = path => realpath(path).catch(error => { if (error.code === 'ENOENT') return resolve(path); throw error; });
  const children = dir => readdir(dir, { withFileTypes: true }).catch(error => { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return []; throw error; });
  const roots = [sessionDir, join(agentDir, 'sessions'), join(agentDir, 'sessions-from-the-other-runtime'), sessionDir && join(dirname(sessionDir), 'sessions-from-the-other-runtime')].filter(Boolean);
  const paths = new Set();
  for (const root of roots) {
    paths.add(await canonical(root));
    // Both flat custom directories and Classic's cwd-grouped directories,
    // including those put aside by a previous runtime switch, remain visible.
    for (const entry of await children(root)) if (entry.isDirectory() || entry.isSymbolicLink()) {
      const path = join(root, entry.name);
      if ((await stat(path).catch(() => null))?.isDirectory()) paths.add(await canonical(path));
    }
  }
  const legacy = new Map();
  for (const dir of paths) for (const row of await SessionManager.listAll(dir)) {
    const path = await canonical(row.path);
    legacy.set(path, { ...row, path });
  }
  const durable = [], seen = new Set();
  for (const dir of paths) for (const entry of await children(dir)) {
    if (!entry.name.endsWith('.sqlite') || !(entry.isFile() || entry.isSymbolicLink())) continue;
    const path = await canonical(join(dir, entry.name));
    if (seen.has(path)) continue;
    seen.add(path);
    // Listing never opens a second Harness/writer. The archive reader below
    // uses a read-only SQLite connection, including the owner's live WAL.
    const { readDurableArchive } = await import('./durable-archive.mjs');
    const modified = Math.max((await stat(path)).mtimeMs, (await stat(`${path}-wal`).catch(() => null))?.mtimeMs || 0);
    try {
      const archive = readDurableArchive(path), messages = archive.messages;
      const content = messages.find(m => m.role === 'user')?.content;
      durable.push({ id: archive.info.id, path, cwd: archive.info.cwd, name: archive.info.name, firstMessage: typeof content === 'string' ? content : content?.filter(b => b.type === 'text').map(b => b.text).join('') || '', modified, messageCount: messages.length, agent: 'pi' });
    } catch {
      durable.push({ id: path, path, name: 'History needs review', firstMessage: 'Could not read this Durable history. It is preserved; opening it will not start fresh.', modified, agent: 'pi', readError: true });
    }
  }
  const unimported = [];
  for (const row of legacy.values()) if (!seen.has(await canonical(`${row.path}.durable.sqlite`))) unimported.push({ ...row, modified: new Date(row.modified).getTime() || 0, agent: 'pi' });
  return [...durable, ...unimported];
}

export async function createRuntime({ cwd = process.cwd(), agentDir = getAgentDir(), sessionDir, authentication = false, serviceOptions = {}, sessionPath = null, claudeSignIn, codexSignIn, onAuthChanged } = {}) {
  const events = new EventEmitter();
  let cached, lastError, disposed = false, admitting = 0, harness, root, view, infoState, archive = [], stops = [];
  const changed = () => { cached = null; if (!disposed) events.emit('change'); };
  // Reports include contained hook/subscriber failures. They are diagnostics,
  // not execution vetoes; fatal failures are enforced by the Session itself.
  const report = error => { lastError = String(error?.message || error); changed(); };
  let notice = async () => {};
  const adapter = createExtensionUI(changed, text => { void notice(text).catch(report); });
  const initialCwd = cwd;
  const initialSettings = serviceOptions.settingsManager || SettingsManager.create(cwd, agentDir);
  const configuredDir = process.env.PI_CODING_AGENT_SESSION_DIR || initialSettings.getSessionDir();
  if (!sessionDir && configuredDir) sessionDir = resolve(cwd, configuredDir.replace(/^~(?=\/|$)/, homedir()));
  const file = await openSessionFile({ cwd, agentDir, sessionDir, sessionPath });
  cwd = file.cwd;
  let imperfect, workers;
  try {
    const settings = serviceOptions.settingsManager || (cwd === initialCwd ? initialSettings : SettingsManager.create(cwd, agentDir));
    const models = serviceOptions.modelRuntime || await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') });
    const loader = await resources({ cwd, agentDir, settings, serviceOptions });
    const registry = createRegistry();
    registry.install(codingTools(cwd, settings, models));
    // Old approval dialogs have no durable answer. Never turn recovery of a
    // pending call into consent; settle it without execution instead.
    let recoveredCalls = new Set();
    const stream = withoutPiAnthropic(withGPTFastMode(withCompactRequestImages((...args) => models.streamSimple(...args))));
    const modelAccess = new Proxy(models, { get(target, key) {
      if (key === 'completeSimple') return (...args) => modelAccess.streamSimple(...args).result();
      if (key === 'streamSimple') return (model, transcript, options) => {
        const output = new AssistantMessageEventStream();
        void (async () => {
          try {
            assertChatGPTSubscription(target, model);
            const request = settings.getBlockImages() ? { ...transcript, messages: transcript.messages.map(m => !Array.isArray(m.content) ? m : { ...m, content: m.content.map(b => b.type === 'image' ? { type: 'text', text: 'Image reading is disabled.' } : b) }) } : transcript;
            const response = await stream(model, request, { thinkingBudgets: settings.getThinkingBudgets(), websocketConnectTimeoutMs: settings.getWebSocketConnectTimeoutMs(), timeoutMs: settings.getHttpIdleTimeoutMs() || 2147483647, ...options, onResponse: async (response, selected) => { usageStore.codexHeaders(response.headers); await options?.onResponse?.(response, selected); }, onProviderStreamEvent: async (data, selected) => { if (selected.provider === 'openai-codex') usageStore.codexEvent(data); await options?.onProviderStreamEvent?.(data, selected); } });
            for await (const event of response) output.push(event);
          } catch (error) {
            output.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'error', errorMessage: String(error.message || error), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
          }
        })();
        return output;
      };
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const question = questionsTool(adapter.ui);
    const ask = { name: question.name, description: question.description, parameters: question.parameters, replay: 'safe', async execute(args, api, ctx) {
      const previous = await api.memo('answer', ctx);
      if (previous) return previous;
      const result = await question.execute(api.callId, args, ctx.abortSignal);
      return api.memo('answer', cleanJSON({ output: result.content, details: result.details }), ctx);
    } };
    imperfect = mcpSession({ cwd: () => cwd, session: () => infoState?.value?.id || '', harness: 'pi', ui: adapter.ui });
    function refreshTools() {
      if (serviceOptions.worker || !imperfect.config()) return;
      registry.install({ name: 'imperfect-tools', tools: availableTools().map(([tool]) => ({ ...tool, name: `mcp__imperfect__${tool.name}`, replay: 'unsafe', async execute(args, api, ctx) {
        if (!availableTools().some(([active]) => active.name === tool.name)) return { output: [{ type: 'text', text: 'Tool is no longer available' }], isError: true };
        const config = imperfect.config();
        if (!config) throw new Error('imperfect MCP server is not listening yet');
        let response;
        try {
          response = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: api.taskId, method: 'tools/call', params: { name: tool.name, arguments: args } }), signal: ctx.abortSignal });
          if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
          const reply = await response.json();
          if (reply.error) throw new Error(reply.error.message);
          return { output: reply.result.content, isError: reply.result.isError };
        } catch (error) {
          // The server may have completed before the response was lost. Never
          // retry the transport; preserve uncertainty for inspection on a fresh run.
          await api.commit(async tx => { (await tx.doc(SessionInfo, root.id)).review.push({ taskId: api.taskId, name: tool.name, arguments: args, reason: 'MCP delivery/effect is uncertain' }); }, context);
          return { output: [{ type: 'text', text: 'MCP delivery/effect uncertain; check before repeating.' }], isError: true, control: { terminate: true } };
        }
      } })) });
      changed();
    }
    imperfect.whenServing(refreshTools); stops.push(onDeviceHandsChange(refreshTools));
    registry.install({ name: 'imperfect', tools: serviceOptions.worker ? [] : [ask], sections: [{ key: 'imperfect-instructions', tag: false, render: ({ agent }) => instructions(loader, cwd, agent.tools) }, {
      key: 'interrupted-actions',
      render: () => 'An interrupted, timed-out or lost-response action may already have happened. Do not blindly repeat it, or treat recovery as authorization. Inspect the destination/state first; make a fresh tool call only when justified by the result and the person’s existing intent. Report unknown outcomes plainly, without asking for interruption/retry approval. Separate required consents still apply.',
    }], hooks: [hook(ToolTask, {
      beforeTool: async (call, api) => {
        const tool = registry.snapshot().tools().findLast(row => row.tool.name === call.name)?.tool;
        const info = await harness.snapshot(SessionInfo, root.id, context);
        if (tool?.replay === 'safe' || (call.name === 'subagent' && ['status', 'result'].includes(call.arguments?.action))) return;
        if (serviceOptions.worker && (info.review.length || info.requireEffectApproval)) return { block: 'An interrupted worker requires parent review before further effectful tools' };
        if (recoveredCalls.has(api.taskId)) return { block: 'This pending action was interrupted before execution. It was not run on recovery. Inspect state before choosing a fresh call under the existing user intent.' };
      },
      afterTool: async (call, result, api) => {
        const tool = registry.snapshot().tools().findLast(row => row.tool.name === call.name)?.tool;
        // A completed shell exit is a known outcome, not a lost response. It
        // can have effects but will not replay automatically. A timeout/throw,
        // interrupted intent or unknown effectful transport still needs review.
        if (!result.isError || tool?.replay === 'safe' || (call.name === 'subagent' && ['status', 'result'].includes(call.arguments?.action)) || (['bash', 'powershell'].includes(call.name) && result.diagnostics?.some(d => d.code === 'exit_code'))) return;
        await root.commit(async tx => {
          const info = await tx.doc(SessionInfo, root.id);
          if (!info.review.some(item => item.taskId === api.taskId)) info.review.push({ taskId: api.taskId, name: call.name, arguments: call.arguments, reason: 'Unsafe tool reported an error; it may already have had effects' });
        }, context);
        // Keep an explicit tool control; only interactive runs add termination.
        // The worker's beforeTool fence permits inspection, never further effects.
        if (!serviceOptions.worker) return { ...result, control: { ...result.control, terminate: true } };
      },
    })] });
    for (const extension of serviceOptions.durableExtensions || []) registry.install(extension);
    const selectedProvider = file.legacy?.projected.model?.provider || settings.getDefaultProvider() || 'openai-codex';
    const selectedId = file.legacy?.projected.model?.modelId || settings.getDefaultModel() || 'gpt-6.1-sol';
    const selectedModel = await models.getModel(selectedProvider, selectedId);
    let currentModel = selectedModel;
    const level = file.legacy?.projected.thinkingLevel || settings.getModelThinkingLevel(selectedProvider, selectedId) || settings.getDefaultThinkingLevel() || 'medium';
    harness = await Harness.open(file.storage, { models: modelAccess, registry, env: ({ cwd: dir }) => new NodeExecutionEnv({ cwd: dir || cwd, shellPath: settings.getShellPath(), shellEnv: serviceOptions.shellEnv }), settings: { stream: { transport: settings.getTransport(), ...settings.getProviderRetrySettings() }, retry: settings.getRetrySettings(), get compaction() { return { ...settings.getCompactionSettings(currentModel), backgroundTokens: 0 }; }, steeringMode: settings.getSteeringMode(), followUpMode: settings.getFollowUpMode() }, onReport: report }, context);
    root = await harness.root(context, { agent: { cwd: file.legacy?.header.cwd || cwd, model: { provider: selectedProvider, modelId: selectedId }, thinkingLevel: level }, init: (tx, id) => initializeSession(tx, id, { cwd, legacy: file.legacy }) });
    const imported = await harness.snapshot(SessionInfo, root.id, context);
    if (file.legacy && imported?.imported?.sha256 !== file.legacy.hash) throw new Error('Original Pi history changed since import; refusing to silently ignore its newer branch. Both histories are preserved.');
    if (serviceOptions.worker && ((await root.agent(context)).model?.provider !== 'openai-codex' || (await root.agent(context)).model?.modelId !== 'gpt-6.1-sol')) throw new Error('Worker history selected another model; refusing subscription-route changes');
    // Find effectful calls interrupted after their recorded execution intent,
    // BEFORE resume enables the scheduler. Durable won't rerun the call; our
    // worker fence also prevents subsequent effects, while allowing reports.
    async function recordUncertainEffects(reason) {
      const effects = (await harness.inspect(context)).tasks.filter(task => task.record.kind === 'pi.tool' && task.record.state.checkpoint?.phase === 'execute' && task.record.state.checkpoint.replay !== 'safe');
      if (!effects.length) return;
      await root.commit(async tx => {
        const descriptions = [];
        for (const { record } of effects) {
          const input = record.input;
          const message = input.kind === 'model' ? (await tx.entry(input.assistant))?.model?.[0] : undefined;
          const call = input.call || message?.content.find(b => b.type === 'toolCall' && b.id === input.callId);
          if (call?.name === 'subagent' && ['status', 'result'].includes(record.state.checkpoint.arguments?.action)) continue;
          descriptions.push({ taskId: record.id, name: call?.name || 'Unknown unsafe tool', arguments: record.state.checkpoint.arguments, reason });
        }
        const info = await tx.doc(SessionInfo, root.id);
        info.review.push(...descriptions.filter(item => !info.review.some(previous => previous.taskId === item.taskId)));
      }, context);
    }
    const recovering = (await harness.inspect(context)).tasks.some(t => ['pi.generation', 'pi.compaction'].includes(t.record.kind) && ['request', 'poll', 'summarize'].includes(t.record.state.checkpoint?.phase));
    if (recovering) await root.commit(async tx => { (await tx.doc(SessionInfo, root.id)).usageIncomplete = true; }, context);
    await recordUncertainEffects('Unsafe tool interrupted after execution intent; may already have run');
    // Includes legacy calls paused in beforeTool awaiting effect-approval.
    // Unsafe execute checkpoints are settled as interrupted by Durable itself;
    // committed results stay authoritative. Only fresh calls may execute.
    recoveredCalls = new Set((await harness.inspect(context)).tasks
      .filter(task => task.record.kind === 'pi.tool' && task.record.state.checkpoint?.phase === 'call')
      .map(task => task.record.id));
    let page, cursor;
    do { page = await root.entries({ order: 'ascending' }, 500, cursor, context); archive.push(...page.items); cursor = page.next; } while (cursor);
    stops.push(harness.subscribeCommits(publication => { for (const change of publication.changes) if (change.type === 'entry' && change.value.conversationId === root.id) archive.push(change.value); changed(); }));
    view = await root.viewState(context); stops.push(view.subscribe(changed));
    infoState = await harness.documentState(SessionInfo, root.id, context); stops.push(infoState.subscribe(changed));
    const info = () => infoState.value;
    cwd = info().cwd;
    workers = serviceOptions.worker ? null : durableSubagents({ ...(serviceOptions.subagentOptions || {}), root, harness, agentDir, cwd, owner: info().id, registry, context });
    const auth = authentication ? createAuth({ models: () => models, changed, assertIdle: idle, onAuthChanged, ...(claudeSignIn ? { claude: claudeSignIn } : {}), ...(codexSignIn ? { codex: codexSignIn } : {}) }) : null;
    function idle() { if (view.value.docs['pi.live']?.run || admitting || adapter.state.dialogs.length || auth?.busy) throw new Error('Agent is busy; abort or wait before changing model'); }
    const currentAgent = () => view.value.docs['pi.agent'] || {};
    async function refreshModel() { const ref = currentAgent().model; currentModel = ref ? await models.getModel(ref.provider, ref.modelId) : undefined; changed(); }
    await refreshModel();
    function queue(inboxItems = view.value.docs['pi.inbox']?.items || []) {
      const items = inboxItems.filter(item => item.mode !== 'write').map(item => {
        const blocks = typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : item.content;
        return { id: item.id, lane: 'steering', text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''), images: blocks.filter(b => b.type === 'image') };
      });
      return { steering: items.map(i => i.text), items };
    }
    function snapshot() {
      if (cached) return cached;
      const live = view.value.docs['pi.live'] || {};
      const messages = [
        ...transcript(archive, { live }),
        ...(live.compactionFailure ? [{ role: 'assistant', content: [], errorMessage: `Compaction failed: ${live.compactionFailure.error}` }] : []),
        ...(lastError ? [{ role: 'assistant', content: [], errorMessage: lastError }] : []),
      ];
      const usingSubscription = models.isUsingSubscription(currentModel?.provider);
      const streaming = Boolean(live.run || live.compactions?.length || queue().items.length);
      return cached = canonicalSnapshot({ sessionId: info().id, sessionFile: file.path, cwd, name: info().name, model: currentModel ? { provider: currentModel.provider, id: currentModel.id, name: currentModel.name, contextWindow: currentModel.contextWindow } : null, level: currentAgent().thinkingLevel, billing: currentModel?.provider === 'anthropic' ? 'Blocked · Pi Anthropic is not used' : usingSubscription ? 'Subscription' : 'API / provider billing', busy: streaming || admitting > 0 || adapter.state.dialogs.length > 0 || Boolean(auth?.busy), streaming, operation: live.compactions?.length ? 'compacting' : null, ...(auth ? { auth: auth.snapshot() } : {}), messages, partial: live.generation?.message, queue: queue(), stats: sessionStats(archive, view.value, info(), currentModel, usingSubscription), ui: adapter.state, startup: resourceStartup(loader, cwd, registry.snapshot().tools().map(t => t.tool), settings) }, 'pi');
    }
    const signIn = () => { if (!auth) throw new Error('GUI login is not enabled for this service'); return auth; };
    let admissions = Promise.resolve();
    async function command(c) {
      switch (c.type) {
        case 'snapshot': return snapshot();
        case 'auth_providers': return signIn().providers();
        case 'auth_accounts': return signIn().accounts();
        case 'auth_login': return signIn().login(c.provider, c.method);
        case 'auth_logout': return signIn().logout(c.provider);
        case 'auth_answer': signIn().answer(c.promptId, c.value); return;
        case 'auth_cancel': await auth?.cancel(); return;
        case 'auth_dismiss': auth?.dismiss(); return;
        case 'refresh-auth': await models.getAvailable(); changed(); return;
        case 'models': return (await models.getAvailable()).filter(m => m.provider !== 'anthropic').map(m => ({ provider: m.provider, id: m.id, name: m.name, billing: models.isUsingSubscription(m.provider) ? 'Subscription' : 'API / provider billing' }));
        case 'usage': return codexResets.limits({ modelRuntime: models });
        case 'usage-rates': return models.getModels().map(m => ({ provider: m.provider, id: m.id, api: m.api, cost: m.cost }));
        case 'codex-reset-consume': return codexResets.consume({ accountId: c.accountId, creditId: c.creditId, confirmed: c.confirmed, operationId: c.operationId, modelRuntime: models });
        case 'dialog': adapter.respond({ ...c, id: c.dialogId }); changed(); return;
        case 'abort': {
          await recordUncertainEffects('Stopped during an unsafe tool; effect may already have happened');
          adapter.reset();
          await auth?.cancel();
          // Inspection/cancellation can yield across a turn boundary. Return
          // only inputs selected and withdrawn together on Durable's line.
          const back = await root.commit(async tx => {
            const inbox = await tx.doc(InboxDoc, root.id);
            const back = cleanJSON(queue(inbox.items));
            for (const item of back.items) tx.settleSubmission(item.id, { status: 'unanswered', reason: 'withdrawn' });
            inbox.items = inbox.items.filter(item => item.mode === 'write');
            return back;
          }, context);
          await root.abort(context);
          changed();
          return back;
        }
        case 'queue-take': {
          // Withdrawal and choosing the exact item share one commit, so two
          // clicks cannot return it twice or withdraw one already placed.
          const item = await root.commit(async tx => {
            const inbox = await tx.doc(InboxDoc, root.id);
            const found = inbox.items.filter(i => i.mode !== 'write').findLast(i => c.queueId ? i.id === c.queueId : true);
            if (!found) return null;
            const row = cleanJSON(queue([found]).items[0]);
            inbox.items = inbox.items.filter(i => i.id !== found.id);
            tx.settleSubmission(found.id, { status: 'unanswered', reason: 'withdrawn' });
            return row;
          }, context);
          changed(); return { item };
        }
        case 'prompt': {
          const requestId = c.requestId || c.id || randomUUID();
          const admit = async () => {
            if (auth?.busy) throw new Error('Finish or cancel sign-in before sending a prompt');
            if (currentModel?.provider === 'anthropic') throw piAnthropicBlocked();
            assertChatGPTSubscription(models, currentModel);
            admitting++; changed();
            try {
              const previous = await root.commit(tx => tx.submissionByRequest(root.id, requestId), context);
              const content = [{ type: 'text', text: expandPromptTemplate(c.text || 'See attached.', loader.getPrompts().prompts) }, ...(c.images || [])];
              const receipt = await root.submit({ type: 'input', content, requestId, whenBusy: 'steer' }, context);
              const record = await receipt.status(context);
              return { accepted: true, requestId, submissionId: receipt.id, ...(previous ? { duplicate: true } : {}), ...(record.status === 'queued' ? { queued: true } : {}) };
            } finally { admitting--; changed(); }
          };
          const answer = admissions.then(admit); admissions = answer.catch(() => {}); return answer;
        }
        case 'model': {
          idle(); if (c.provider === 'anthropic') throw piAnthropicBlocked();
          const model = (await models.getAvailable()).find(m => m.provider === c.provider && m.id === c.modelId);
          if (!model) throw new Error('Unknown or unauthenticated model');
          idle(); await root.configure({ model: { provider: model.provider, modelId: model.id }, thinkingLevel: clampThinkingLevel(model, settings.getModelThinkingLevel(model.provider, model.id) || currentAgent().thinkingLevel || 'medium') }, context);
          if (auth && c.persist !== false) settings.setDefaultModelAndProvider(model.provider, model.id);
          await refreshModel(); return;
        }
        case 'level': {
          const available = currentModel ? getSupportedThinkingLevels(currentModel) : ['off'];
          if (c.level) { idle(); if (!available.includes(c.level)) throw new Error('Unsupported reasoning level'); await root.configure({ thinkingLevel: c.level }, context); if (auth) settings.setModelThinkingLevel(currentModel.provider, currentModel.id, c.level); changed(); }
          return { current: currentAgent().thinkingLevel, available };
        }
        case 'name': if (typeof c.name !== 'string') throw new Error('Name must be text'); await root.commit(async tx => { (await tx.doc(SessionInfo, root.id)).name = c.name.slice(0, 200); }, context); changed(); return;
        default: throw new Error(`Unsupported command: ${c.type}`);
      }
    }
    notice = async text => { if (!root || disposed) return; await root.submit({ type: 'write', entry: { kind: 'imperfect.notice', data: { text: String(text) } } }, context); };
    // Execution, queued ingress and recovery are Durable's. There is no Pi
    // AgentSession, preflight buffer, steer queue, drain loop or retry engine.
    if (serviceOptions.resume !== false) harness.resume();
    return { events, snapshot, command, session: () => ({ harness, conversation: root, models, registry }),
      background: () => workers?.manager?.list().filter(t => !terminal(t.status)).map(t => `subagent ${t.id}`) || [],
      async drop() { if (disposed) return; adapter.reset(); await auth?.cancel(); await root.commit(async tx => { const inbox = await tx.doc(InboxDoc, root.id); for (const item of inbox.items.filter(i => i.mode !== 'write')) tx.settleSubmission(item.id, { status: 'unanswered', reason: 'tab closed' }); inbox.items = inbox.items.filter(i => i.mode === 'write'); }, context); },
      async close() { if (disposed) return; disposed = true; adapter.reset(); workers?.dispose(); imperfect.close(); for (const stop of stops) stop?.(); view.dispose(); infoState.dispose(); await auth?.cancel(); await harness.close(context); await file.release(); await settings.flush(); events.removeAllListeners(); },
    };
  } catch (error) {
    disposed = true; adapter.reset(); workers?.dispose(); imperfect?.close(); for (const stop of stops) stop?.(); view?.dispose(); infoState?.dispose(); if (harness) await harness.close(context); else await file.storage.close(); await file.release(); throw error;
  }
}
