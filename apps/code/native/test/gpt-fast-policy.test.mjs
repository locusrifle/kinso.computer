import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createRuntime } from '../runtime.mjs';
import { context } from '../durable-session.mjs';
import { gptFastPayload, withGPTFastMode } from '../gpt-fast-policy.mjs';

const openai = { id: 'gpt-5.5', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1' };
const codex = { ...openai, provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' };

test('priority is a non-mutating default only for GPT on direct OpenAI Responses/Codex', () => {
  const payload = { model: openai.id, reasoning: { effort: 'high' } };
  for (const model of [openai, codex, { ...openai, baseUrl: codex.baseUrl }]) {
    assert.deepEqual(gptFastPayload(payload, model), { ...payload, service_tier: 'priority' });
  }
  for (const model of [
    { ...openai, id: 'o3' }, { ...openai, provider: 'openrouter' },
    { ...openai, provider: 'azure-openai-responses' }, { ...openai, provider: 'github-copilot' },
    { ...openai, api: 'openai-completions' }, { ...codex, api: 'openai-responses' },
    { ...openai, baseUrl: 'https://proxy.example/v1' },
    { ...openai, baseUrl: 'https://api.openai.com.example/v1' },
    { ...openai, baseUrl: 'http://api.openai.com/v1' },
    { ...openai, baseUrl: 'https://api.openai.com:1234/v1' },
    { ...openai, baseUrl: 'https://user@api.openai.com/v1' }, undefined,
  ]) assert.equal(gptFastPayload(payload, model), payload);
  for (const value of [null, 'json', [], undefined]) assert.equal(gptFastPayload(value, openai), value);
  for (const tier of ['default', 'auto', 'flex', 'priority', null]) {
    const explicit = { ...payload, service_tier: tier };
    assert.equal(gptFastPayload(explicit, openai), explicit);
  }
  assert.deepEqual(payload, { model: openai.id, reasoning: { effort: 'high' } });
});

test('public stream wrapper preserves options, async payload hooks, and explicit typed opt-outs', async () => {
  let seen, calls = 0;
  const stream = withGPTFastMode((model, context, options) => { seen = { model, context, options }; return 'stream'; });
  const context = {}, signal = new AbortController().signal;
  const options = { signal, reasoning: 'high', onPayload: async payload => { calls++; return { ...payload, marker: true }; } };
  assert.equal(stream(openai, context, options), 'stream');
  assert.equal(seen.context, context);
  assert.equal(seen.options.signal, signal);
  assert.equal(seen.options.reasoning, 'high');
  assert.deepEqual(await seen.options.onPayload({}, openai), { marker: true, service_tier: 'priority' });
  assert.equal(calls, 1);
  assert.equal(Object.hasOwn(options, 'serviceTier'), false);
  for (const serviceTier of ['default', 'auto', 'flex']) {
    stream(openai, context, { serviceTier });
    assert.deepEqual(await seen.options.onPayload({}, openai), { service_tier: serviceTier });
  }
  stream(openai, context, { onPayload: payload => { payload.service_tier = 'default'; } });
  assert.deepEqual(await seen.options.onPayload({}, openai), { service_tier: 'default' });
  stream(openai, context, { onPayload: () => ({ service_tier: 'flex' }) });
  assert.deepEqual(await seen.options.onPayload({}, openai), { service_tier: 'flex' });
  stream(openai, context, {});
  const proxyPayload = {};
  assert.equal(await seen.options.onPayload(proxyPayload, { ...openai, baseUrl: 'https://proxy.example/v1' }), proxyPayload);
  const other = { ...openai, provider: 'anthropic' };
  stream(other, context, options);
  assert.equal(seen.options, options, 'unsupported providers receive the original options, without any new hook or flag');
});

// Only synthetic auth and a fetch stub reach Pi. These tests exercise its real
// provider serializer/parser and SDK lifecycle without networking or charges.
const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.test`;
function response(body, id) {
  const item = { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Test summary.', annotations: [] }] };
  const events = [
    { type: 'response.created', response: { id: `resp_${id}`, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Test summary.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `resp_${id}`, status: 'completed', output: [item], service_tier: body.service_tier ?? 'default', usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), 'gpt-fast-'));
  const models = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  models.checkAuth = async () => ({ type: 'api_key', source: 'fixture' });
  models.isUsingSubscription = provider => provider === 'openai-codex';
  models.hasConfiguredAuth = () => true;
  models.getAuth = async () => ({ auth: { apiKey: token } });
  models.getAvailable = async () => models.getModels();
  const requests = [];
  const streamSimple = models.streamSimple.bind(models);
  models.streamSimple = (model, context, options) => streamSimple(model, context, {
    ...options, transport: 'sse', maxRetries: 0,
    onPayload: async (payload, model) => { const result = await options?.onPayload?.(payload, model); return explicitTier === undefined ? result : { ...(result || payload), service_tier: explicitTier }; },
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      const bytes = headers.get('content-encoding') === 'zstd' ? zlib.zstdDecompressSync(init.body) : init.body;
      const body = JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString());
      requests.push({ url: String(url), body });
      return response(body, requests.length);
    },
  });
  const settings = SettingsManager.inMemory({ defaultProvider: provider, defaultModel: 'gpt-6-astra', defaultThinkingLevel: 'high', cacheWarming: 'off', compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1024 }, retry: { enabled: false } });
  let explicitTier;
  const runtime = await createRuntime({ cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), serviceOptions: {
    modelRuntime: models, settingsManager: settings,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true },
  } });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { runtime, requests, models, setTier: tier => { explicitTier = tier; } };
}

for (const provider of ['openai', 'openai-codex']) test(`${provider}: real outgoing payload across a model switch and compaction`, async t => {
  const { runtime: r, requests, models, setTier } = await fixture(t, provider);
  const send = async () => {
    await r.command({ type: 'prompt', text: 'A synthetic request for fast-mode verification.' });
    await r.session().conversation.waitForIdle(context);
    assert.equal(r.snapshot().messages.at(-1).stopReason, 'stop');
    return requests.at(-1).body;
  };
  const initial = await send();
  assert.equal(initial.service_tier, 'priority');
  assert.equal(initial.reasoning.effort, 'high');
  assert.match(requests.at(-1).url, provider === 'openai' ? /^https:\/\/api\.openai\.com\// : /^https:\/\/chatgpt\.com\//);
  setTier('default');
  assert.equal((await send()).service_tier, 'default', 'existing extension opt-out wins');
  setTier(undefined);
  const other = models.getModels('openai').find(model => model.id === 'o3');
  assert.ok(other);
  await r.command({ type: 'model', provider: other.provider, modelId: other.id });
  assert.equal(Object.hasOwn(await send(), 'service_tier'), false, 'non-GPT model switch disables the default');
  await r.command({ type: 'model', provider, modelId: 'gpt-6-astra' });
  assert.equal((await send()).service_tier, 'priority');
  const count = requests.length;
  const compact = await r.session().conversation.compact(undefined, context);
  await r.session().harness.waitForTask(compact, context);
  assert.ok(requests.length > count, 'compaction sends an actual summary request');
  for (const request of requests.slice(count)) assert.equal(request.body.service_tier, 'priority');
  assert.ok(r.snapshot().messages.some(message => message.role === 'compactionSummary'));
  assert.equal((await send()).service_tier, 'priority');
  assert.equal(r.snapshot().level, 'high');
});
