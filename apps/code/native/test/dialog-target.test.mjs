import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createGueyServer } from '../../../../system/server.mjs';

test('a dialog response after focus changed reaches only the original tab; replaced and missing targets are refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-dialog-target-'));
  const calls = [], tabs = [{ id: 'a', sessionId: 'session-a' }, { id: 'b', sessionId: 'session-b' }];
  const runtime = {
    events: new EventEmitter(),
    snapshot: (id = 'a') => ({ sessionId: tabs.find(t => t.id === id)?.sessionId, tabs: tabs.map(t => ({ ...t, focused: t.id === id })), messages: [], busy: false, streaming: false }),
    command: async (c, id) => { calls.push([c, id]); return c.type === 'snapshot' ? runtime.snapshot(id) : {}; },
    close: async () => {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime, product: 'imperfect' });
  let ws;
  try {
    const { port } = await app.listen();
    ws = new WebSocket(`ws://127.0.0.1:${port}/pi`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    let seq = 0;
    const send = fields => new Promise(resolve => {
      const id = String(++seq);
      const on = raw => { const m = JSON.parse(raw); if (m.type === 'response' && m.id === id) { ws.off('message', on); resolve(m); } };
      ws.on('message', on); ws.send(JSON.stringify({ ...fields, id }));
    });
    assert.equal((await send({ type: 'tab-focus', tabId: 'b' })).success, true);
    const response = { type: 'dialog', dialogId: 'ask-a', expectedTabId: 'a', expectedSessionId: 'session-a', value: 'yes' };
    assert.equal((await send(response)).success, true);
    assert.equal(calls.at(-1)[1], 'a');
    assert.equal((await send({ type: 'snapshot' })).data.sessionId, 'session-b', 'answering A does not focus it');
    const before = calls.length;
    tabs[0].sessionId = 'replacement';
    assert.equal((await send(response)).success, false);
    tabs.shift();
    assert.equal((await send(response)).success, false);
    assert.equal(calls.length, before, 'neither stale response was dispatched');
  } finally {
    ws?.terminate(); await app.close(); await rm(root, { recursive: true, force: true });
  }
});
