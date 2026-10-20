import test from 'node:test';
import assert from 'node:assert/strict';
import { postUpload } from '../public/js/uploads.js';

test('HTTP uploads require captured owner/session, route remote owners through the peer without changing captured headers', async () => {
  const original = globalThis.XMLHttpRequest;
  const sent = [];
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.headers = {}; sent.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(file) { this.file = file; }
    abort() { this.onabort?.(); }
  };
  try {
    const file = { name: 'example.txt', size: 8 };
    await assert.rejects(postUpload(file, { sessionId: 'same' }), /owner required/);
    assert.equal(sent.length, 0);
    const context = { owner: 'local', servingOwner: 'local', sessionId: 'captured' };
    const promise = postUpload(file, context);
    context.owner = 'remote'; context.sessionId = 'different';
    assert.equal(sent[0].url, '/upload');
    assert.equal(sent[0].headers['X-Session-Id'], 'captured');
    sent[0].status = 200; sent[0].responseText = '{"path":"/fixture/example.txt","reference":{"name":"saved"}}'; sent[0].onload();
    assert.deepEqual(await promise, { path: '/fixture/example.txt', reference: { name: 'saved' } });
    const remote = postUpload(file, { owner: 'remote', servingOwner: 'local', tabId: 't1', sessionId: null, instanceId: 'host' });
    assert.equal(sent[1].url, '/peer/remote/upload');
    assert.equal(sent[1].headers['X-Tab-Id'], 't1');
    assert.equal(sent[1].headers['X-Instance-Id'], 'host');
    sent[1].status = 200; sent[1].responseText = '{"reference":{"name":"saved"}}'; sent[1].onload(); await remote;
    const outdated = postUpload(file, { owner: 'remote', servingOwner: 'local', sessionId: 'captured' });
    sent[2].status = 200; sent[2].responseText = '{"path":"/old/example.txt"}'; sent[2].onload();
    await assert.rejects(outdated, /update imperfect on the session computer/);
    const controller = new AbortController();
    const aborted = postUpload(file, { owner: 'local', servingOwner: 'local', sessionId: 'captured', signal: controller.signal });
    controller.abort(); await assert.rejects(aborted, { name: 'AbortError' });
  } finally { globalThis.XMLHttpRequest = original; }
});
