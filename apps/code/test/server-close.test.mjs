import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createGueyServer } from '../../../system/server.mjs';

// The laptop, 19 Oct: an update restarted the server while the window held a connection open; the port shut but
// close() waited on that connection forever, and the window could not reach its desktop again.
test('closing does not wait on a browser connection that never finishes its request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'server-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = {
    events: new EventEmitter(),
    snapshot: () => ({ sessionId: 'x', cwd: root, busy: false, failed: null, messages: [], tabs: [] }),
    async command() { return {}; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: join(root, 'state'), runtime });
  const { port } = await app.listen();
  const held = connect(port, '127.0.0.1');
  await new Promise(done => held.once('connect', done));
  held.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n');   // the request is begun and never ended
  const ended = new Promise(done => held.once('close', done));
  await new Promise(done => setTimeout(done, 100));
  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 5000, `close took ${Date.now() - started} ms`);
  await ended;
});
