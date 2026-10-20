// Real systemd environment and Durable storage; synthetic provider only.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { runWorker } from '../../subagent-runner.mjs';
const path = process.argv[2], marker = join(path, 'mock-request-started');
await runWorker(path, { redact: String, makeModels: async options => {
  const models = await ModelRuntime.create(options);
  models.isUsingSubscription = provider => provider === 'openai-codex';
  models.streamSimple = (model, _transcript, options) => {
    const stream = new AssistantMessageEventStream();
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', content: [{ type: 'text', text: 'synthetic durable report' }] };
    const mode = process.env.FAKE_DURABLE_MODE;
    if (mode === 'hang' || (mode === 'recover' && !existsSync(marker))) {
      writeFileSync(marker, 'mock transport only');
      options.signal.addEventListener('abort', () => stream.push({ type: 'error', reason: 'aborted', error: { ...message, content: [], stopReason: 'aborted' } }), { once: true });
    } else stream.push({ type: 'done', reason: 'stop', message });
    return stream;
  };
  return models;
} });
