import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync, zstdDecompressSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { PREVIEW_BYTES, compactRequestImages, withCompactRequestImages } from '../request-images.mjs';
import { createRuntime } from '../runtime.mjs';
import { context } from '../durable-session.mjs';

// A PNG of noise, which no encoder shrinks: as heavy as a real picture.
function noisePNG(width, height) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), randomBytes(width * 3)])));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const heavy = () => ({ type: 'image', data: 'A'.repeat(PREVIEW_BYTES + 1), mimeType: 'image/png' });
const small = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
function history() {
  return { systemPrompt: 'sys', messages: [
    { role: 'user', content: [{ type: 'text', text: 'look' }, heavy()] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/p.png' } }] },
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'Read /p.png' }, heavy(), small], isError: false },
  ] };
}
const fakeResize = calls => async (bytes, mimeType, options) => {
  calls.push({ size: bytes.length, mimeType, options });
  return { data: 'SMALL', mimeType: 'image/jpeg', width: 1, height: 1 };
};

test('oversized tool-result pictures go as previews, copy-on-write; attachments, small pictures and ids stay', async () => {
  const context = history(), before = structuredClone(context), calls = [];
  const sent = await compactRequestImages(context, { resize: fakeResize(calls) });
  assert.deepEqual(context, before, 'the caller\'s messages are not changed');
  assert.equal(sent.systemPrompt, 'sys');
  assert.equal(sent.messages[0], context.messages[0], 'the person\'s own attachment is sent exactly');
  assert.equal(sent.messages[1], context.messages[1]);
  const result = sent.messages[2];
  assert.equal(result.toolCallId, 'c1');
  assert.deepEqual(result.content.map(b => b.type), ['text', 'image', 'text', 'image']);
  assert.equal(result.content[0].text, 'Read /p.png');
  assert.deepEqual(result.content[1], { type: 'image', data: 'SMALL', mimeType: 'image/jpeg' });
  assert.match(result.content[2].text, /JPEG preview.*transparency.*original file is unchanged/);
  assert.equal(result.content[3], small);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { maxBytes: PREVIEW_BYTES });
  await compactRequestImages(context, { resize: fakeResize(calls) });
  assert.equal(calls.length, 1, 'each picture is made smaller once, not on every request');
  const light = { messages: [context.messages[1]] };
  assert.equal(await compactRequestImages(light, { resize: fakeResize(calls) }), light, 'nothing heavy: the same context');
});

test('a picture that cannot be made smaller is still sent, and a stopped request is not held up', async () => {
  for (const resize of [async () => null, async () => { throw new Error('bad picture'); }, async () => ({ data: 'A'.repeat(PREVIEW_BYTES + 2), mimeType: 'image/jpeg' })]) {
    const context = history();
    const sent = await compactRequestImages(context, { resize });
    assert.equal(sent.messages[2].content[1], context.messages[2].content[1]);
  }
  const stop = new AbortController(); stop.abort();
  const calls = [], context = history();
  const sent = await compactRequestImages(context, { signal: stop.signal, resize: fakeResize(calls) });
  assert.equal(calls.length, 0);
  assert.equal(sent.messages[2].content[1], context.messages[2].content[1]);
});

test('the stream wrapper passes model and options through untouched', async () => {
  let seen;
  const signal = new AbortController().signal, options = { signal, reasoning: 'high', onPayload: () => {} };
  const stream = withCompactRequestImages((model, context, opts) => { seen = { model, context, opts }; return 'stream'; }, { resize: fakeResize([]) });
  const model = { id: 'claude', provider: 'anthropic' }, context = history();
  assert.equal(await stream(model, context, options), 'stream');
  assert.equal(seen.model, model);
  assert.equal(seen.opts, options);
  assert.equal(seen.context.messages[2].content[1].data, 'SMALL');
});

// An old session written with full-size pictures, opened as a session is, and
// a real Pi Codex request built from it with only the network stubbed.
test('an existing heavy session is sent small, and its file stays byte for byte', async t => {
  const root = await mkdtemp(join(tmpdir(), 'request-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sm = SessionManager.create(root, join(root, 'sessions'));
  const pictures = Array.from({ length: 4 }, () => noisePNG(640, 640));
  sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'make pictures' }], timestamp: 1 });
  pictures.forEach((data, i) => {
    sm.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: `call_${i}`, name: 'generate_image', arguments: { prompt: `p${i}` } }], api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-6-astra', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: 2 + i });
    sm.appendMessage({ role: 'toolResult', toolCallId: `call_${i}`, toolName: 'generate_image', content: [{ type: 'text', text: `Made the picture, saved as PNG at /pictures/${i}.png.` }, { type: 'image', data, mimeType: 'image/png' }], isError: false, timestamp: 2 + i });
  });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }], api: 'openai-codex-responses', provider: 'openai-codex', model: 'gpt-6-astra', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 9 });
  const file = sm.getSessionFile();
  const original = await readFile(file);

  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.test`;
  const models = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  models.checkAuth = async () => ({ type: 'api_key', source: 'fixture' });
  models.isUsingSubscription = provider => provider === 'openai-codex';
  models.hasConfiguredAuth = () => true;
  models.getAuth = async () => ({ auth: { apiKey: token } });
  models.getAvailable = async () => models.getModels();
  const bodies = [];
  const streamSimple = models.streamSimple.bind(models);
  models.streamSimple = (model, context, options) => streamSimple(model, context, {
    ...options, transport: 'sse', maxRetries: 0,
    fetch: async (_url, init) => {
      const raw = new Headers(init.headers).get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body) : Buffer.from(init.body);
      bodies.push(raw.toString());
      const item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Seen.', annotations: [] }] };
      const events = [
        { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Seen.' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } },
      ];
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const settings = SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6-astra', cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await createRuntime({ cwd: root, agentDir: join(root, 'agent'), sessionDir: join(root, 'sessions'), sessionPath: file, serviceOptions: {
    modelRuntime: models, settingsManager: settings,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true },
  } });
  t.after(() => runtime.close());
  const attached = noisePNG(320, 320);
  await runtime.command({ type: 'prompt', text: 'and now?', images: [{ type: 'image', data: attached, mimeType: 'image/png' }] });
  await runtime.session().conversation.waitForIdle(context);
  assert.equal(runtime.snapshot().messages.at(-1).stopReason, 'stop');

  const body = bodies.at(-1);
  const historic = pictures.reduce((sum, data) => sum + data.length, 0);
  assert.ok(historic > 4 * PREVIEW_BYTES);
  for (const data of pictures) assert.equal(body.includes(data), false, 'no full-size historic picture is sent');
  assert.ok(body.includes(attached), 'the person\'s attachment is sent exactly');
  assert.equal((body.match(/data:image\/jpeg;base64,/g) ?? []).length, pictures.length, 'every picture is still seen, as a preview');
  for (let i = 0; i < pictures.length; i++) assert.ok(body.includes(`/pictures/${i}.png`) && body.includes(`call_${i}`));
  assert.ok(body.length < attached.length + pictures.length * PREVIEW_BYTES + 200_000, `request is ${body.length} bytes`);
  const after = await readFile(file);
  assert.deepEqual(after, original, 'the entire original stays byte-identical');
});

test('tool pictures enforce the preview cap, including resizer failure or an oversized answer', async () => {
  const { pictureForModel } = await import('../request-images.mjs');
  const small = Buffer.from('small');
  const resize = async () => { throw new Error('cannot resize'); };
  assert.equal((await pictureForModel(small, 'image/png', { resize })).block.data, small.toString('base64'));
  assert.equal(await pictureForModel(Buffer.alloc(PREVIEW_BYTES), 'image/png', { resize }), null);
  assert.equal(await pictureForModel(small, 'image/png', { resize: async () => ({ data: 'x'.repeat(PREVIEW_BYTES + 1) }) }), null);
  const preview = await pictureForModel(small, 'image/png', { resize: async () => ({ data: 'small', mimeType: 'image/jpeg', wasResized: true, width: 20, height: 10 }) });
  assert.equal(preview.block.mimeType, 'image/jpeg');
  assert.match(preview.note, /20x10 preview/);
});
