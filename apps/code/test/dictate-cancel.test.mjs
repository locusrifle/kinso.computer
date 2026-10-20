import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDictation } from '../../../system/dictate.mjs';
import { createTabHost } from '../native/tabs.mjs';
import { openUpload, receiveHttpUpload, uploadReference } from '../native/uploads.mjs';
import { noisePNG } from '../native/test/attachment-fixture.mjs';

async function fixture(t, agent, { holdReply = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dictate-cancel-'));
  const calls = [], requests = [];
  const admitted = Promise.withResolvers(), reply = Promise.withResolvers();
  let sessionId = 'captured-session', refuse = false;
  const runtime = {
    events: new EventEmitter(),
    snapshot: () => ({ cwd, sessionId, busy: false, messages: [] }),
    command: async (...args) => {
      if (refuse) throw new Error('admission temporarily unavailable');
      calls.push(args);
      return { accepted: true };
    },
    close: async () => {},
  };
  const host = await createTabHost({ firstTab: agent, stateDir: join(cwd, 'state'), sessionToken: 'cancel-test-only',
    claudeAvailable: () => true, createRuntime: () => runtime, createClaudeRuntime: () => runtime });
  const target = { cwd, referenceKey: 'cancel-test-only', tabId: 't1', sessionId, instanceId: host.snapshot().instanceId };
  const upload = Readable.from([noisePNG()]); upload.headers = {};
  const saved = await receiveHttpUpload(upload, { cwd, filename: 'photo.png' });
  const reference = await uploadReference(saved, target);
  const prompt = { tab: 't1', session: sessionId, requestId: 'same-recording', attachments: [{ kind: 'image', reference }] };
  const handle = createDictation({
    runtime: { snapshot: tab => host.snapshot(tab), command: async (...args) => {
      const result = await host.command(...args);
      admitted.resolve(result);
      if (holdReply) await reply.promise;
      return result;
    } },
    hear: async () => ({ text: 'spoken instruction' }), openAudio: async () => Readable.from(['recording']),
  });
  const server = createServer(async (req, res) => {
    const request = { closed: Promise.withResolvers(), finished: Promise.withResolvers() };
    requests.push(request);
    res.once('close', request.closed.resolve);
    try { await handle(req, res, '/dictate'); }
    finally { request.finished.resolve(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    reply.resolve();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await host.close();
    await rm(cwd, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { host, calls, requests, prompt, target, reference, admitted, reply,
    changeSession: () => { sessionId = 'replacement-session'; },
    refuse: value => { refuse = value; },
    rows: async () => JSON.parse(await readFile(join(cwd, 'state', 'open-tabs.json'), 'utf8')),
    send: signal => fetch(`${url}/dictate`, { method: 'POST', signal,
      headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ ...prompt, audio: 'recording' }) }),
  };
}

// Suspend the real resolver inside its first image read, after the bytes are
// read but before resize. No sleep/race against CPU speed, production test hook,
// paid model, or substitute resolver: scope validation and resize still run.
async function pausePreparation(t, f) {
  const { file } = await openUpload(f.reference, f.target);
  const prototype = Object.getPrototypeOf(file), original = prototype.readFile;
  await file.close();
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let first = true;
  const mock = t.mock.method(prototype, 'readFile', async function (...args) {
    const bytes = await original.apply(this, args);
    if (first) { first = false; started.resolve(); await release.promise; }
    return bytes;
  });
  t.after(() => { release.resolve(); mock.mock.restore(); });
  return { started: started.promise, release: release.resolve };
}

async function abortRequest(f, controller, sending) {
  controller.abort();
  await assert.rejects(sending, { name: 'AbortError' });
  await f.requests[0].closed.promise; // The owner has observed the disconnect.
}

function assertHarnessInput(f) {
  assert.equal(f.calls.length, 1);
  const [command, ...context] = f.calls[0];
  assert.deepEqual(context, [], 'request context never reaches the harness');
  assert.deepEqual(Object.keys(command).sort(), ['images', 'requestId', 'text', 'type']);
  assert.equal(command.requestId, f.prompt.requestId);
  assert.match(command.text, /^spoken instruction\n\n\[uploaded image original:/);
  assert.equal(command.images.length, 1);
  assert.deepEqual(Object.keys(command.images[0]).sort(), ['data', 'mimeType', 'type']);
}

for (const agent of ['pi', 'claude']) for (const held of [false, true]) {
  test(`${agent}: abort during image preparation prevents ${held ? 'handoff holding' : 'runtime admission'}; the same ID can retry`, { timeout: 20000 }, async t => {
    const f = await fixture(t, agent);
    const prep = await pausePreparation(t, f);
    const controller = new AbortController();
    const sending = f.send(controller.signal);
    await prep.started;
    // Fence can appear while preparation is suspended, not just beforehand.
    if (held) f.host.requestQuiesce();
    await abortRequest(f, controller, sending);
    prep.release();
    await f.requests[0].finished.promise;
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.host.snapshot().queue?.items ?? [], []);
    assert.ok((await f.rows()).every(row => !row.held?.length), 'cancelled input was not persisted');
    await f.host.resumeDelivery();
    assert.deepEqual(f.calls, [], 'resuming cannot deliver the cancelled input');

    const response = await f.send();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true, words: 'spoken instruction' });
    assertHarnessInput(f);
    if (agent === 'claude') {
      assert.equal((await f.send()).status, 200);
      assert.equal(f.calls.length, 1, 'cancelled attempts do not reserve IDs; admitted retries still deduplicate');
    }
  });

  test(`${agent}: cancellation after ${held ? 'durable handoff holding' : 'runtime submission'} does not withdraw accepted input`, { timeout: 20000 }, async t => {
    const f = await fixture(t, agent, { holdReply: true });
    if (held) f.host.requestQuiesce();
    const controller = new AbortController();
    const sending = f.send(controller.signal);
    const result = await f.admitted.promise;
    assert.equal(result.accepted, true);
    if (held) {
      assert.equal(result.queued, true);
      assert.deepEqual(f.calls, []);
      const [row] = await f.rows();
      assert.equal(row.held.length, 1);
      assert.deepEqual(Object.keys(row.held[0]).sort(), ['id', 'images', 'text']);
      assert.equal(row.held[0].id, f.prompt.requestId);
    }
    await abortRequest(f, controller, sending);
    f.reply.resolve();
    await f.requests[0].finished.promise;
    if (held) {
      assert.equal(f.host.snapshot().queue.items.length, 1, 'accepted held work remains accepted');
      // Even an already-cancelled request context cannot unaccept a held ID.
      assert.deepEqual(await f.host.command({ type: 'prompt', requestId: f.prompt.requestId }, 't1', { isCancelled: () => true }),
        { accepted: true, duplicate: true });
      await f.host.resumeDelivery();
      assert.ok((await f.rows()).every(row => !row.held?.length));
    }
    assertHarnessInput(f);
  });
}

for (const agent of ['pi', 'claude']) test(`${agent}: cancelled preparation cannot join an existing held backlog after handoff resumes`, { timeout: 20000 }, async t => {
  const f = await fixture(t, agent);
  f.host.requestQuiesce();
  await f.host.command({ type: 'prompt', text: 'already accepted', requestId: 'earlier' }, 't1');
  f.refuse(true);
  await f.host.resumeDelivery();
  assert.equal(f.host.snapshot().handoff.quiescing, false);
  assert.deepEqual(f.host.snapshot().queue.items.map(item => item.id), ['earlier']);
  const prep = await pausePreparation(t, f);
  const controller = new AbortController();
  const sending = f.send(controller.signal);
  await prep.started;
  await abortRequest(f, controller, sending);
  prep.release();
  await f.requests[0].finished.promise;
  assert.deepEqual(f.host.snapshot().queue.items.map(item => item.id), ['earlier']);
  assert.deepEqual((await f.rows())[0].held.map(item => item.id), ['earlier']);
  f.refuse(false);
  await f.host.resumeDelivery();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0].requestId, 'earlier', 'only previously accepted work is delivered');
});

test('session identity is still rechecked when image preparation finishes', { timeout: 20000 }, async t => {
  const f = await fixture(t, 'pi');
  const prep = await pausePreparation(t, f);
  const sending = f.send();
  await prep.started;
  f.changeSession();
  prep.release();
  const response = await sending;
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /Session changed while preparing attachments; nothing was sent/);
  assert.deepEqual(f.calls, []);
});
