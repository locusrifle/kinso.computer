// What the server checks before running a command, and the answer a turn reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createGueyServer } from '../../../../system/server.mjs';
import { staleCommandError, tabCloseBusyError } from '../public/js/session-logic.js';

test('busy tab-close without closeConfirmed is rejected at the server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-voice-busy-close-'));
  let ran = 0;
  const events = new EventEmitter();
  const runtime = {
    events,
    snapshot: () => ({ sessionId: 'here', tabs: [{ id: 't1', focused: true, sessionId: 'here', busy: false }, { id: 't2', sessionId: 'other', busy: true }], messages: [], busy: false, streaming: false, failed: null }),
    async command() { ran += 1; return { ok: true }; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime, product: 'imperfect' });
  try {
    const addr = await app.listen();
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const reply = () => new Promise(resolve => {
      const on = raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'response') { ws.off('message', on); resolve(msg); }
      };
      ws.on('message', on);
    });
    const wait = reply();
    ws.send(JSON.stringify({ id: 'c1', type: 'tab-close', tabId: 't2', expectedTabId: 't2', expectedSessionId: 'other' }));
    const denied = await wait;
    assert.equal(denied.success, false);
    assert.match(denied.error, /busy/);
    assert.equal(ran, 0);
    const wait2 = reply();
    ws.send(JSON.stringify({ id: 'c2', type: 'tab-close', tabId: 't2', expectedTabId: 't2', expectedSessionId: 'other', closeConfirmed: true }));
    const ok = await wait2;
    assert.equal(ok.success, true);
    assert.equal(ran, 1);
    ws.close();
  } finally {
    await app.close(); await rm(root, { recursive: true, force: true });
  }
});

test('stale commands and busy closes', () => {
  assert.equal(staleCommandError({ type: 'prompt', expectedSessionId: 'a' }, { sessionId: 'b' }), 'session changed');
  assert.equal(staleCommandError({ type: 'queue-take', latest: true, expectedSessionId: 'a' }, { sessionId: 'b' }), 'session changed');
  assert.equal(staleCommandError({ type: 'queue-take', queueId: 'q1', expectedTabId: 't1' }, { tabs: [{ id: 't2', focused: true }] }), 'session changed');
  assert.equal(staleCommandError({ type: 'queue-take', queueId: 'q1', expectedSessionId: 'a', expectedTabId: 't1' }, { sessionId: 'a', tabs: [{ id: 't1', focused: true }] }), null);
  assert.equal(staleCommandError({ type: 'prompt', expectedSessionId: 'a', expectedTabId: 't1' }, { sessionId: 'a', tabs: [{ id: 't1', focused: true }] }), null);
  assert.equal(staleCommandError({ type: 'tab-close', tabId: 't2', expectedTabId: 't1' }, {}), 'session changed');
  assert.equal(staleCommandError({ type: 'tab-focus', tabId: 't2', expectedTabId: 't2', expectedSessionId: 'old' }, { tabs: [{ id: 't2', sessionId: 'new' }] }), 'session changed');
  assert.equal(tabCloseBusyError({ type: 'tab-close', tabId: 't2' }, { tabs: [{ id: 't2', busy: true }] }), 'tab is busy');
  assert.equal(tabCloseBusyError({ type: 'tab-close', tabId: 't2', closeConfirmed: true }, { tabs: [{ id: 't2', busy: true }] }), null);
});

test('stale expected session rejects prompt without dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guey-voice-stale-'));
  let ran = 0;
  const events = new EventEmitter();
  const runtime = {
    events,
    snapshot: () => ({ sessionId: 'here', tabs: [{ id: 't1', focused: true, sessionId: 'here' }], messages: [], busy: false, streaming: false, failed: null }),
    async command() { ran += 1; return { accepted: true }; },
    async close() {},
  };
  const app = await createGueyServer({ port: 0, host: '127.0.0.1', stateDir: root, runtime, product: 'imperfect' });
  try {
    const addr = await app.listen();
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/pi`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const reply = await new Promise(resolve => {
      ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'response' && msg.id === '1') resolve(msg);
      });
      ws.send(JSON.stringify({ id: '1', type: 'prompt', text: 'hi', expectedSessionId: 'elsewhere', expectedTabId: 't1' }));
    });
    assert.equal(reply.success, false);
    assert.match(reply.error, /session changed/);
    assert.equal(ran, 0);
    ws.close();
  } finally {
    await app.close(); await rm(root, { recursive: true, force: true });
  }
});
