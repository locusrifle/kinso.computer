import { stat } from 'node:fs/promises';
import { DefaultPackageManager, DefaultResourceLoader, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition } from '@earendil-works/pi-coding-agent';
import { createCodingTools, createBashTool, createPowerShellTool } from '@earendil-works/pi-durable/tools';
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node';
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import { cwdRelative, section, sorted, startup, tildePath } from './startup.mjs';

// These pure SDK helpers are not exported at the package root in pinned 1.2.
// Keep the coding-agent dependency (auth, archives, CLI and image consumers too)
// in the tested Durable version group; do not copy its parsers or run a session.
const sdk = import.meta.resolve('@earendil-works/pi-coding-agent');
export const { expandPromptTemplate } = await import(new URL('./core/prompt-templates.js', sdk));
const { buildSystemPrompt } = await import(new URL('./core/system-prompt.js', sdk));
// One lazy, off-thread image processor per process, shared by conversations.
const codingImages = await createNodePhotonImages();

export async function resources({ cwd, agentDir, settings, serviceOptions }) {
  const options = serviceOptions.resourceLoaderOptions || {};
  if (options.extensionFactories?.length || options.additionalExtensionPaths?.length || options.extensionsOverride) throw new Error('Pi coding-agent extensions need a Durable port; refusing to silently drop them');
  // Ask Pi's actual resolver, including trust, exclusions and package filters.
  // A prompts-only package is not an executable extension. Never install one
  // simply to open a GUI conversation or to inspect migration compatibility.
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  for (const pkg of packages.listConfiguredPackages()) {
    const installed = pkg.installedPath && await stat(pkg.installedPath).catch(() => null);
    if (!installed || (pkg.source.startsWith('npm:') && !await packages.installedNpmMatchesConfiguredVersion(packages.parseSource(pkg.source), pkg.installedPath))) throw new Error('A configured Pi package is missing or mismatched; resolve it explicitly before activation (no automatic installs)');
  }
  const paths = await packages.resolve(async () => 'error');
  const incompatible = options.noExtensions ? [] : paths.extensions.filter(r => r.enabled);
  if (incompatible.length) throw new Error(`Pi coding-agent extensions need a Durable port: ${incompatible.map(r => r.path).join(', ')}. No extension code was loaded; choose a port or explicitly disable it before activation.`);
  const loader = serviceOptions.resourceLoader || new DefaultResourceLoader({ ...options, cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true });
  // Pinned 1.2 has no public no-install loader option. Reuse our vetted snapshot
  // instead of its second, potentially installing resolution after settings
  // reload. This instance-only SDK-internal seam is covered by package tests.
  if (!serviceOptions.resourceLoader) loader.packageManager.resolve = async () => paths;
  await loader.reload();
  if (loader.getExtensions().extensions.length) throw new Error('Pi coding-agent extensions need a Durable port; custom resource loader supplied executable extensions');
  if (loader.getSkills().skills.length) throw new Error('This GUI disables skills; explicit skill resources need a compatibility decision, not silent omission');
  return loader;
}

export function codingTools(cwd, settings, models) {
  const bridge = definition => ({ name: definition.name, description: definition.description, parameters: definition.parameters, replay: 'safe', async execute(args, api, ctx) {
    const ref = (await api.agent(ctx)).model;
    const result = await definition.execute(api.callId, args, ctx.abortSignal, undefined, { cwd, model: ref && await models.getModel(ref.provider, ref.modelId) });
    return { output: result.content, details: result.details };
  } });
  const images = { prepare: (bytes, mime, limits) => codingImages.prepare(bytes, mime, settings.getImageAutoResize() ? limits : { maxWidth: Number.MAX_SAFE_INTEGER, maxHeight: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER }) };
  const coding = createCodingTools({ images });
  const all = [...coding.tools.filter(t => t.name !== 'bash').map(t => t.name === 'read' ? { ...t, replay: 'safe' } : t),
    createBashTool({ commandPrefix: settings.getShellCommandPrefix(), prepare: execution => { execution.command += '\nexit $?'; } }),
    createPowerShellTool(), ...[createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd)].map(bridge)];
  const selected = settings.getDefaultTools() || ['read', 'bash', 'edit', 'write'];
  const missing = selected.filter(name => !all.some(t => t.name === name));
  if (missing.length) throw new Error(`Configured tools need a Durable port: ${missing.join(', ')}; refusing to drop working tools`);
  return { name: 'coding-tools', tools: selected.map(name => all.find(t => t.name === name)) };
}

export function instructions(loader, cwd, tools) {
  return buildSystemPrompt({ cwd, selectedTools: tools.map(t => t.name), customPrompt: loader.getSystemPrompt(), appendSystemPrompt: loader.getAppendSystemPrompt().join('\n\n'), contextFiles: loader.getAgentsFiles().agentsFiles, toolSnippets: Object.fromEntries(tools.map(t => [t.name, t.description.split('\n')[0]])) });
}

const startupDiagnostics = new WeakMap();
export function resourceStartup(loader, cwd, tools, settings) {
  const files = [...(loader.getSystemPromptSource?.() ? [loader.getSystemPromptSource()] : []), ...(loader.getAppendSystemPromptSources?.() || []), ...loader.getAgentsFiles().agentsFiles];
  const diagnostics = startupDiagnostics.get(loader) || [...loader.getPrompts().diagnostics, ...loader.getThemes().diagnostics, ...loader.getExtensions().errors.map(e => ({ message: e.error, path: e.path })), ...settings.drainErrors().map(e => ({ message: e.error.message, path: e.path }))];
  startupDiagnostics.set(loader, diagnostics);
  return startup('Pi Durable', '1.2.0', cwd, [
    section('Context', files.map(f => cwdRelative(f.path, cwd)), files.map(f => tildePath(f.path))),
    section('Prompts', sorted(loader.getPrompts().prompts.map(t => `/${t.name}`))),
    section('Tools', sorted(tools.map(t => t.name.replace(/^mcp__imperfect__/, '')))),
    section('Compatibility', ['Skills disabled (as before); classic Pi extensions require a Durable port; terminal Pi cannot resume SQLite continuations; automatic cache warming is not ported']),
    section('Diagnostics', diagnostics.map(d => `${d.path || ''}: ${d.message}`)),
  ]);
}

export function sessionStats(entries, view, info, model, usingSubscription) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, totalTokens: 0 };
  let cost = 0, cacheHitRate;
  const add = usage => { if (!usage) return; for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) tokens[key] += usage[key] || 0; cost += usage.cost?.total || 0; };
  for (const entry of entries) if (entry.kind === 'imperfect.legacy') {
    for (const row of entry.data.entries) { add(row.usage); if (row.type === 'message') add(row.message?.usage); }
  }
  for (const usage of [...Object.values(view.docs['pi.usage']?.models || {}), ...Object.values(view.docs['pi.usage']?.tools || {})]) add(usage);
  for (const entry of entries) for (const m of entry.kind === 'imperfect.legacy' ? entry.data.entries.filter(e => e.type === 'message').map(e => e.message) : entry.model || []) {
    const u = m.role === 'assistant' && m.usage, prompt = u && u.input + u.cacheRead + u.cacheWrite;
    if (prompt > 0) cacheHitRate = 100 * u.cacheRead / prompt;
  }
  tokens.total = tokens.totalTokens = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const edits = new Map(view.entries.flatMap(e => (e.edits || []).map(edit => [edit.target, edit])));
  const sources = view.entries.flatMap(e => {
    const edit = edits.get(e.id), model = edit?.action === 'omit' ? [] : edit?.action === 'replace' ? edit.messages : e.model || [];
    return model.map(message => ({ entry: e.id, message }));
  });
  const messages = sources.map(s => s.message);
  const cut = view.entries.find(e => e.head !== undefined)?.id;
  const index = sources.findLastIndex(({ message: m, entry }) => (!cut || entry > cut) && m.role === 'assistant' && !['error', 'aborted'].includes(m.stopReason) && calculateContextTokens(m.usage) > 0);
  const legacyCut = entries.some(e => e.kind === 'imperfect.legacy' && e.data.entries.some(row => row.type === 'compaction')) && !entries.some(e => e.kind === 'pi.assistant' && e.model?.some(m => m.role === 'assistant' && !['error', 'aborted'].includes(m.stopReason) && calculateContextTokens(m.usage) > 0));
  const held = legacyCut || (cut && index < 0) ? null : index < 0 ? messages.reduce((n, m) => n + estimateMessageTokens(m), 0) : calculateContextTokens(messages[index].usage) + messages.slice(index + 1).reduce((n, m) => n + estimateMessageTokens(m), 0);
  return { usingSubscription, tokens, cost, cacheHitRate, usageReliable: !info.usageIncomplete, ...(model?.contextWindow > 0 ? { contextUsage: { tokens: held, contextWindow: model.contextWindow, percent: held === null ? null : 100 * held / model.contextWindow } } : {}) };
}
