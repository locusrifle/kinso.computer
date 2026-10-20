import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createDictation } from '../../../system/dictate.mjs';
import { mountVoice } from '../native/public/js/voice.js';

const dictationHandler = options => createDictation({ openAudio: async prompt => Readable.from([Buffer.from(prompt.audio)]), ...options });

const IMAGE = { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' };

// The tab host, as far as a dictation reaches it: one tab, idle or working.
// A working session takes a prompt as steering, as the runtimes do.
function host({ busy = false } = {}) {
  const prompts = [];
  const runtime = {
    snapshot: () => ({ sessionId: 'session-1', tabs: [{ id: 'tab-1', sessionId: 'session-1', focused: true }] }),
    command: async (command, tab) => { prompts.push({ command, tab }); return busy ? { accepted: true, queued: true } : { accepted: true }; },
  };
  return { runtime, prompts };
}

// What the computer hears in a recording, and what it was handed.
function ears(words) {
  const heard = [];
  return { heard, hear: async audio => { const parts = []; for await (const part of audio) parts.push(part); heard.push(Buffer.concat(parts).toString()); if (words instanceof Error) throw words; return { text: words }; } };
}

async function serve(t, handle) {
  const server = createServer(async (req, res) => { if (!await handle(req, res, new URL(req.url, 'http://x').pathname)) res.writeHead(404).end(); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// The window's request: the recording and which session it is for.
function dictation(url, prompt, audio = 'a recording') {
  return fetch(`${url}/dictate`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ ...prompt, audio }) });
}

test('a dictation is heard here and sent to the session in view as the person\'s message, after what was in the bar', async t => {
  const { runtime, prompts } = host();
  const { heard, hear } = ears(' turn the porch light off ');
  const url = await serve(t, dictationHandler({ runtime, hear }));
  const res = await dictation(url, { tab: 'tab-1', session: 'session-1', text: 'about the house\n\n[uploaded file: /home/n/plan.pdf]', images: [IMAGE], requestId: 'r-1' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: true, words: 'turn the porch light off' });
  assert.deepEqual(heard, ['a recording']);
  assert.deepEqual(prompts, [{ tab: 'tab-1', command: { type: 'prompt', text: 'about the house\n\n[uploaded file: /home/n/plan.pdf]\n\nturn the porch light off', images: [IMAGE], requestId: 'r-1', expectedTabId: 'tab-1', expectedSessionId: 'session-1' } }]);
});

test('a session that is working takes the dictation as steering, as a typed message', async t => {
  const { runtime, prompts } = host({ busy: true });
  const url = await serve(t, dictationHandler({ runtime, hear: ears('and then the tests').hear }));
  const res = await dictation(url, { tab: 'tab-1', session: 'session-1', requestId: 'r-3' });
  assert.deepEqual(await res.json(), { accepted: true, queued: true, words: 'and then the tests' });
  // Never steering: the runtime queues it after the turn.
  assert.equal(prompts[0].command.behavior, undefined);
});

test('nothing heard, unreadable audio or a session gone: nothing is sent, and the window is told', async t => {
  const { runtime, prompts } = host();
  const silent = await serve(t, dictationHandler({ runtime, hear: ears('   ').hear }));
  let res = await dictation(silent, { tab: 'tab-1', session: 'session-1' });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /no words were heard.*nothing was sent/);
  const broken = await serve(t, dictationHandler({ runtime, hear: ears(new Error('could not read that audio')).hear }));
  res = await dictation(broken, { tab: 'tab-1', session: 'session-1' });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /could not read that audio/);
  const unavailable = await serve(t, dictationHandler({ runtime, hear: ears(Object.assign(new Error('ffmpeg is not available to the voice service on this computer; install ffmpeg'), { status: 503 })).hear }));
  res = await dictation(unavailable, { tab: 'tab-1', session: 'session-1', text: 'do not send only the typed part' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /ffmpeg is not available/);
  const moved = await serve(t, dictationHandler({ runtime, hear: ears('hello').hear }));
  res = await dictation(moved, { tab: 'tab-1', session: 'another-session' });
  assert.equal(res.status, 409);
  res = await fetch(`${moved}/dictate`, { method: 'POST', body: new FormData() });
  assert.equal(res.status, 403);
  assert.deepEqual(prompts, []);
});

// The mic, in a window: a recording that was not sent stays, to try again.
function fakeWindow(t) {
  const saved = { document: globalThis.document, navigator: globalThis.navigator, MediaRecorder: globalThis.MediaRecorder, addEventListener: globalThis.addEventListener };
  const node = () => ({ dataset: {}, attrs: {}, append() {}, setAttribute(key, value) { this.attrs[key] = value; } });
  const keys = [];
  globalThis.document = { createElement: node };
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } }, configurable: true });
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    start() {}
    stop() { this.ondataavailable({ data: new Blob(['spoken words'], { type: 'audio/webm' }) }); this.onstop(); }
  };
  globalThis.addEventListener = (name, fn) => { if (name === 'keydown') keys.push(fn); };
  t.after(() => {
    globalThis.document = saved.document;
    Object.defineProperty(globalThis, 'navigator', { value: saved.navigator, configurable: true });
    globalThis.MediaRecorder = saved.MediaRecorder;
    globalThis.addEventListener = saved.addEventListener;
  });
  return { escape: () => { const event = { key: 'Escape', preventDefault() { this.prevented = true; } }; for (const fn of keys) fn(event); return event; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the mic sends its recording; if nothing was sent it keeps it, and pressing it again tries again', async t => {
  const { escape } = fakeWindow(t);
  const sent = [], failed = [];
  let refuse = true;
  const voice = mountVoice({ input: {}, fail: error => failed.push(error.message), send: async recording => { sent.push(recording); if (refuse) throw new Error('no words were heard in the recording; nothing was sent'); } });
  voice.button.onclick(); await settle();
  assert.equal(voice.button.dataset.state, 'recording');
  voice.button.onclick(); await settle();
  assert.equal(sent.length, 1);
  assert.equal(voice.button.dataset.state, 'kept');
  assert.match(failed[0], /^Send not confirmed: no words were heard.*Press the mic to try again\.$/);
  refuse = false;
  voice.button.onclick(); await settle();
  assert.equal(sent.length, 2);
  assert.equal(sent[1], sent[0], 'the same recording, tried again');
  assert.equal(voice.button.dataset.state, 'idle');
  // Esc lets a kept recording go.
  refuse = true;
  voice.button.onclick(); await settle(); voice.button.onclick(); await settle();
  assert.equal(voice.button.dataset.state, 'kept');
  assert.equal(escape().prevented, true);
  assert.equal(voice.button.dataset.state, 'idle');
});

test('a missing decoder keeps the exact recording for retry without capturing again', async t => {
  fakeWindow(t);
  const sent = [], failed = [];
  const voice = mountVoice({ input: {}, fail: error => failed.push(error.message), send: async recording => {
    sent.push(recording);
    if (sent.length === 1) throw new Error('ffmpeg is not available to the voice service on this computer; install ffmpeg');
  } });
  voice.button.onclick(); await settle();
  voice.button.onclick(); await settle();
  assert.equal(voice.button.dataset.state, 'kept');
  assert.equal(voice.holding(), true);
  assert.match(failed[0], /Send not confirmed: ffmpeg is not available.*Press the mic to try again/);
  voice.button.onclick(); await settle();
  assert.equal(sent[1], sent[0]);
  assert.equal(await sent[1].text(), 'spoken words');
  assert.equal(voice.button.dataset.state, 'idle');
  assert.equal(voice.holding(), false);
});

test('the composer sends only uploaded audio/attachment references to the captured execution owner', async () => {
  const source = await readFile(new URL('../native/public/js/harness.js', import.meta.url), 'utf8');
  const dictate = source.slice(source.indexOf('async function dictate('), source.indexOf('/* ---------------------------------------------------------- the cursor */'));
  assert.match(dictate, /postUpload\(recording/);
  assert.match(dictate, /useUpload\('dictate', \{ \.\.\.prompt, audio: held.audio \}/);
  assert.doesNotMatch(dictate, /new FormData|fetch\('\/dictate'/);
  assert.match(dictate, /restoreFailedPrompt\(removedText, removed, key\)/);
});


test('cancelling a dictation while it is being heard never submits a later prompt', async t => {
  const { runtime, prompts } = host();
  let hearing, finish;
  const started = new Promise(resolve => { hearing = resolve; });
  const words = new Promise(resolve => { finish = resolve; });
  const url = await serve(t, dictationHandler({ runtime, hear: async () => { hearing(); await words; return { text: 'cancelled speech' }; } }));
  const controller = new AbortController();
  const sending = fetch(`${url}/dictate`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ tab: 'tab-1', session: 'session-1', audio: 'recording' }), signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(sending, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 30));
  finish();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(prompts, []);
});
