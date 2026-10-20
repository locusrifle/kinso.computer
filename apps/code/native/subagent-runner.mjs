import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { claim, privateJSON, terminal } from './subagent.mjs';
import { createRuntime } from './runtime.mjs';
import { context } from './durable-session.mjs';
import { credentialValues, redactor } from '../../../system/memory.mjs';

const PAID = /^(?:OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_CODE_|AWS_|AZURE_|GOOGLE_|GCLOUD_|CCR_|PI_)|(?:API_KEY|AUTH_TOKEN|BEARER_TOKEN|BASE_URL)$/;
export function subscriptionEnv(env = process.env, agentDir) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) if (key !== 'IMPERFECT_SUBAGENT' && !PAID.test(key)) clean[key] = value;
  return { ...clean, IMPERFECT_SUBAGENT: '1', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
}
const RULES = 'You are a noninteractive delegated worker. Nobody can answer questions; work only on the assigned task. Do not delegate, ship, restart services, spend extra money, use sudo, touch a phone, or delete unrelated work. Report changes, checks, limits and choices in a concise final answer. Do not print credentials.';
export function instructions(cwd, limit = 256 * 1024) {
  const dirs = [];
  for (let dir = cwd; ; dir = dirname(dir)) { dirs.unshift(dir); if (dirname(dir) === dir) break; }
  let text = RULES;
  for (const dir of dirs) try { text += `\n\nContents of ${join(dir, 'AGENTS.md')}:\n${readFileSync(join(dir, 'AGENTS.md'), 'utf8')}`; } catch {}
  return text.slice(0, limit);
}
export function subscriptionConfig(agentDir) {
  try {
    const config = JSON.parse(readFileSync(join(agentDir, 'models.json'), 'utf8'));
    if (config?.providers && Object.hasOwn(config.providers, 'openai-codex')) return 'Sol workers require the built-in openai-codex provider; remove its models.json overrides';
  } catch (error) { if (error.code !== 'ENOENT') return 'Could not verify Pi models.json for subscription-only Sol'; }
  return '';
}

// The unit IS the worker. No Pi CLI child, JSON progress parser, duplicate
// stdout accounting or auth-check subprocess. Durable owns the run and ingress;
// systemd still owns the execution environment and its lifetime.
export async function runWorker(path, { makeRuntime = createRuntime, makeModels = options => ModelRuntime.create(options), env = process.env, signals = process, redact: suppliedRedact, timeoutMs = 115 * 60 * 1000 } = {}) {
  const statePath = join(path, 'state.json'), state = JSON.parse(readFileSync(statePath, 'utf8'));
  // An old CLI runner may still own this task. Observe its unit/result; never
  // adopt its prompt as a new Durable run, even before its claim was written.
  if (terminal(state.status) || state.runtime !== 'durable-1.2.0') return null;
  const agentDir = state.agentDir || join(env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'data', 'agent');
  if (!claim(path, 'runner')) {
    const holder = readFileSync(join(path, 'claim'), 'utf8');
    if (holder !== 'runner' || state.runtime !== 'durable-1.2.0') return null;
  }
  const redact = suppliedRedact || redactor([...(await credentialValues(agentDir, ['auth.json', 'models.json'])), ...(await credentialValues(join(env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'credentials')))]);
  let runtime, timer, cancelled = false;
  const stop = () => { cancelled = true; void runtime?.command({ type: 'abort' }); };
  signals.once('SIGTERM', stop); signals.once('SIGINT', stop);
  const settle = result => {
    privateJSON(state.resultPath, result);
    privateJSON(statePath, { ...JSON.parse(readFileSync(statePath, 'utf8')), status: result.status, endedAt: new Date().toISOString(), summary: result.status === 'done' ? 'Final report ready' : result.error.slice(0, 200) });
    return result;
  };
  const failure = (error, launched = state.status === 'running') => settle({ engine: 'pi', runtime: 'durable-1.2.0', status: cancelled ? 'cancelled' : 'failed', error: redact(String(error)).slice(0, 65536), output: '', usage: launched ? null : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, usageReliable: !launched, models: {} });
  try {
    if (state.engine !== 'pi') return failure('Legacy workers are reconciled, not relaunched');
    if (!Number.isFinite(Date.parse(state.startedAt)) || Date.now() - Date.parse(state.startedAt) >= timeoutMs) return failure('Worker lifetime expired', state.status === 'running');
    const refusal = subscriptionConfig(agentDir);
    if (refusal) return failure(refusal);
    const models = await makeModels({ authPath: join(agentDir, 'auth.json'), modelsPath: null, modelsStorePath: join(agentDir, 'models-store.json'), allowModelNetwork: false });
    if (!models.isUsingSubscription('openai-codex')) return failure('GPT-6.1 Sol requires ChatGPT OAuth; workers never fall back to an API key, model or provider');
    if (cancelled) return failure('Worker cancelled');
    const sessionDir = join(path, 'session'); mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const existing = readdirSync(sessionDir).filter(name => name.endsWith('.sqlite'));
    if (existing.length > 1) return failure('Worker has ambiguous durable history; refusing a fresh run');
    runtime = await makeRuntime({ cwd: state.cwd, agentDir, sessionDir, sessionPath: state.sessionPath || (existing[0] && join(sessionDir, existing[0])), serviceOptions: {
      modelRuntime: models, worker: true, resume: false, shellEnv: subscriptionEnv(env, agentDir),
      settingsManager: SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', defaultThinkingLevel: state.thinking || 'high', retry: { enabled: true } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, systemPrompt: instructions(state.cwd) },
    } });
    privateJSON(statePath, { ...state, runtime: 'durable-1.2.0', status: 'running', sessionPath: runtime.snapshot().sessionFile });
    // A worker may never wait for the person or adopt machine tools. Its tools
    // are only read/bash/edit/write; uncertain effects allow inspection/reporting,
    // not more effects. A done receipt means a report, not verified implementation.
    runtime.events.on('change', () => { if (runtime.snapshot().ui.dialogs.length) stop(); });
    const remaining = timeoutMs - Math.max(0, Date.now() - Date.parse(state.startedAt));
    timer = setTimeout(stop, Math.max(0, remaining)); timer.unref?.();
    if (cancelled) { await runtime.command({ type: 'abort' }); return failure('Worker cancelled', true); }
    const ack = await runtime.command({ type: 'prompt', requestId: `worker-task:${state.id}`, text: readFileSync(join(path, 'prompt.md'), 'utf8') });
    const receipt = await runtime.session().harness.submission(ack.submissionId, context);
    const settled = await receipt.wait(context);
    await runtime.session().conversation.waitForIdle(context);
    if (cancelled) return failure('Worker cancelled or uncertain action needs review', true);
    const snap = runtime.snapshot(), answer = snap.messages.findLast(m => m.role === 'assistant' && m.stopReason === 'stop');
    if (settled.status !== 'done') return failure(`Worker submission ${settled.reason || settled.status}${settled.detail ? `: ${settled.detail}` : ''}`, true);
    if (!answer) return failure('Worker ended without a final answer', true);
    const output = redact(answer.content.filter(b => b.type === 'text').map(b => b.text).join('\n'));
    if (!output.trim()) return failure('Worker ended without a non-empty final report', true);
    const categories = ['input', 'output', 'cacheRead', 'cacheWrite'];
    const reportedModels = {};
    for (const message of snap.messages.filter(m => m.role === 'assistant' && m.usage)) {
      const id = message.responseModel || message.model;
      const counts = reportedModels[id] ??= { provider: message.provider, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const key of categories) counts[key] += message.usage[key] || 0;
    }
    // A killed request can have incurred usage before any response was recorded.
    // Summaries also lack authoritative response-model metadata. Neither is zero.
    const usageReliable = state.status !== 'running' && !snap.messages.some(m => m.role === 'compactionSummary') && categories.every(key => Object.values(reportedModels).reduce((sum, u) => sum + u[key], 0) === snap.stats.tokens[key]);
    return settle({ engine: 'pi', runtime: 'durable-1.2.0', status: 'done', error: '', output: output.slice(0, 65536), truncated: output.length > 65536, model: { provider: answer.provider, id: answer.responseModel || answer.model }, models: reportedModels, usage: usageReliable ? snap.stats.tokens : null, usageReliable });
  } catch (error) { return failure(error?.message || 'Worker failed', Boolean(runtime)); }
  finally { clearTimeout(timer); signals.removeListener('SIGTERM', stop); signals.removeListener('SIGINT', stop); await runtime?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runWorker(process.argv[2]).catch(() => { process.exitCode = 1; });
