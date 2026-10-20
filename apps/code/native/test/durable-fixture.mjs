import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createRuntime } from '../runtime.mjs';
import { withAbortSignal } from '@earendil-works/chord/context';
import { context } from '../durable-session.mjs';
export { context };
export const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export function answer(model, content = [{ type: 'text', text: 'ok' }], reason = 'stop') { return { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: reason, usage }; }
export async function fixture(t, options = {}) {
  const dir = options.dir || await mkdtemp(join(tmpdir(), 'durable-test-'));
  let runtime;
  t.after(async () => { await runtime?.close(); if (!options.dir) await rm(dir, { recursive: true, force: true }); });
  const models = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), allowModelNetwork: false });
  models.isUsingSubscription = provider => provider === 'openai-codex';
  models.checkAuth = async () => true;
  let count = 0;
  const seen = [];
  models.streamSimple = (model, transcript, opts) => {
    seen.push(transcript); count++;
    const response = Promise.resolve(options.respond?.(model, transcript, count, opts) ?? answer(model));
    return { async *[Symbol.asyncIterator]() { const message = await response; yield { type: 'done', reason: message.stopReason, message }; }, result: () => response };
  };
  const serviceOptions = { modelRuntime: models, settingsManager: SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', compaction: { enabled: false }, retry: { enabled: false } }), resourceLoaderOptions: { noExtensions: true, noContextFiles: true, noThemes: true, noPromptTemplates: true }, ...options.serviceOptions };
  runtime = await createRuntime({ cwd: dir, agentDir: join(dir, 'agent'), sessionDir: join(dir, 'sessions'), ...options, serviceOptions });
  return { runtime, dir, models, seen, idle: async () => { await runtime.session().conversation.waitForIdle(context); await new Promise(resolve => setImmediate(resolve)); } };
}
export async function invokeTool(runtime, name, args, signal = new AbortController().signal) {
  const tool = typeof name === 'object' ? name : runtime.session().registry.snapshot().tools().findLast(row => row.tool.name === name)?.tool;
  if (!tool) throw new Error(`No tool ${name}`);
  return tool.execute(args, { taskId: `fixture-${name}`, callId: `fixture-${name}`, commit: (fn, ctx) => runtime.session().conversation.commit(fn, ctx), memo: async (_name, candidate) => typeof candidate === 'object' ? candidate : undefined }, withAbortSignal(signal, context));
}
export async function until(predicate, tries = 300) { for (let n = 0; n < tries; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out waiting for fixture'); }
