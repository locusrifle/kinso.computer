import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';

// Only synthetic credentials. Intercept the real provider at its HTTP boundary,
// not Durable's model selection: this proves the subscription route survives.
test('Durable uses existing Pi ChatGPT OAuth, effort and session affinity without API-key fallback', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-oauth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentials = new InMemoryCredentialStore();
  const access = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`;
  await credentials.modify('openai-codex', async () => ({ type: 'oauth', access, refresh: 'fixture-not-a-refresh-token', expires: Date.now() + 3600000 }));
  const models = await ModelRuntime.create({ credentials, authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), allowModelNetwork: false });
  assert.equal(models.isUsingSubscription('openai-codex'), true);
  const requests = [];
  const original = models.streamSimple.bind(models);
  models.streamSimple = (model, transcript, options) => original(model, transcript, { ...options, transport: 'sse', fetch: async (url, init) => {
    const headers = new Headers(init.headers);
    const bytes = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body) : init.body;
    requests.push({ url: String(url), headers, body: JSON.parse(typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString()) });
    const item = { type: 'message', id: 'fixture-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'subscription works', annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: 'fixture-response' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'subscription works' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
  t.after(() => harness.close(context));
  const root = await harness.root(context, { agent: { model: { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }, thinkingLevel: 'high' } });
  const settled = await (await root.submit({ type: 'input', content: 'hello', requestId: 'oauth-proof' }, context)).wait(context);
  assert.equal(settled.status, 'done', JSON.stringify(settled));
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/chatgpt\.com\/backend-api\/codex\/responses$/);
  assert.equal(requests[0].headers.get('authorization') === `Bearer ${access}`, true);
  assert.equal(requests[0].headers.get('chatgpt-account-id'), 'fixture-account');
  assert.equal(requests[0].body.model, 'gpt-6.1-sol');
  assert.equal(requests[0].body.reasoning.effort, 'high');
  assert.ok(requests[0].body.prompt_cache_key);
  const answer = await root.commit(tx => tx.entry(settled.answer), context);
  assert.equal(answer.model[0].content[0].text, 'subscription works');
});
