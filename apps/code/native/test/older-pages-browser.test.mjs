import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { fixture, serve, fixtureResponse } from '../../tools/gui-preview.mjs';

// The window holds the newest part of a long conversation and fetches the
// rest a page at a time as the reader scrolls up (server.mjs, harness.js).
const say = (id, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i % 2 ? `${id} answer ${i}\n\nwith a second paragraph` : `${id} asks ${i}` });
const PAGE = 60;

test('scrolling up fetches older pages in order, keeps the place, and drops stale answers', { timeout: 30000 }, async () => {
  const { server, sockets, port } = await serve('');
  const calls = [], older = [];
  const conversation = { mirror: Array.from({ length: 600 }, (_, i) => say('mirror', i)), other: Array.from({ length: 600 }, (_, i) => say('other', i)) };
  const snapshot = id => {
    const data = fixture();
    data.sessionId = id;
    data.tabs = data.tabs.map(tab => ({ ...tab, focused: tab.id === id }));
    const all = conversation[id];
    data.messages = all.slice(all.length - PAGE); data.messagesFrom = all.length - PAGE;
    data.busy = false; data.streaming = false; data.partial = null;
    return data;
  };
  let live = null;
  sockets.removeAllListeners('connection');
  sockets.on('connection', socket => {
    live = socket;
    socket.send(JSON.stringify({ type: 'snapshot', data: snapshot('mirror') }));
    socket.on('message', raw => {
      const c = JSON.parse(raw); calls.push(c);
      const respond = (data, error) => socket.send(JSON.stringify({ type: 'response', id: c.id, success: !error, data, error }));
      if (c.type === 'tab-focus') return respond({ snapshot: snapshot(c.tabId) });
      if (c.type === 'messages-before') {
        older.push((error = null) => {
          const from = Math.max(0, c.before - PAGE);
          respond(error ? null : { sessionId: c.sessionId, from, messages: conversation[c.sessionId].slice(from, c.before) }, error);
        });
        return;
      }
      respond(fixtureResponse(c));
    });
  });
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.waitForFunction(() => document.querySelector('#entry-output')?.textContent.includes('mirror answer 599'));
    await page.waitForTimeout(200);
    const shown = () => page.$$eval('#entry-output .gui-message', nodes => nodes.map(node => Number(node.textContent.match(/(?:asks|answer) (\d+)/)?.[1])));
    const numbers = await shown();
    assert.deepEqual(numbers, Array.from({ length: PAGE }, (_, i) => 540 + i), 'only the newest part is drawn');
    assert.equal(older.length, 0, 'nothing older is asked for while the reader is at the bottom');

    // To the top: the page before is asked for; the place stays where it was.
    await page.evaluate(() => { const out = document.querySelector('#entry-output'); out.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); out.scrollTop = 0; });
    await page.waitForFunction(() => true);
    await page.waitForTimeout(100);
    assert.equal(older.length, 1, JSON.stringify(calls.filter(c => c.type === 'messages-before')));
    assert.equal(calls.filter(c => c.type === 'messages-before').at(-1).before, 540);
    // A new message arrives while the page is on its way.
    conversation.mirror.push(say('mirror', 600));
    live.send(JSON.stringify({ type: 'snapshot', data: { ...snapshot('mirror'), messages: undefined, messagesFrom: undefined, messagesBase: 600, messagesTail: [conversation.mirror[600]] } }));
    await page.waitForTimeout(100);
    const anchor = () => page.evaluate(() => {
      // The first below the conversation's top padding: an older message may
      // show a sliver in the padding once it is drawn above.
      const out = document.querySelector('#entry-output'), box = out.getBoundingClientRect(), top = box.top + parseFloat(getComputedStyle(out).paddingTop);
      const node = [...out.querySelectorAll('.gui-message')].find(node => node.getBoundingClientRect().bottom > top + 1);
      // Its bottom: the message first in the view gains a rule above it once another is drawn before it.
      return { text: node.textContent, top: node.getBoundingClientRect().bottom - box.top };
    });
    const before = await anchor();
    older.shift()();
    await page.waitForFunction(() => document.querySelector('#entry-output').textContent.includes('mirror asks 480'));
    const after = await anchor();
    assert.equal(after.text, before.text, 'the message at the top of the view is still there');
    assert.ok(Math.abs(after.top - before.top) < 2, JSON.stringify({ before, after }));
    assert.deepEqual(await shown(), Array.from({ length: 121 }, (_, i) => 480 + i), 'in order, nothing twice, nothing missing');

    // Another page is asked for, and the reader switches before it comes:
    // the answer belongs to a session no longer in view, and is dropped.
    await page.evaluate(() => { document.querySelector('#entry-output').scrollTop = 0; });
    await page.waitForTimeout(100);
    assert.equal(older.length, 1);
    await page.keyboard.press('Alt+2');
    await page.waitForFunction(() => document.querySelector('#entry-output').textContent.includes('other answer 599'));
    older.shift()();
    await page.waitForTimeout(200);
    const text = await page.locator('#entry-output').textContent();
    assert.equal(text.includes('mirror'), false, 'a stale page never lands in another session');
    assert.deepEqual(await shown(), Array.from({ length: PAGE }, (_, i) => 540 + i));

    // A page that fails is asked for again.
    await page.evaluate(() => { const out = document.querySelector('#entry-output'); out.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); out.scrollTop = 0; });
    await page.waitForTimeout(100);
    assert.equal(older.length, 1);
    older.shift()('Owner not connected');
    await page.waitForFunction(() => true);
    const retried = Date.now();
    while (!older.length && Date.now() - retried < 3000) await page.waitForTimeout(50);
    assert.equal(older.length, 1, 'the failed page is asked for again');
    older.shift()();
    await page.waitForFunction(() => document.querySelector('#entry-output').textContent.includes('other asks 480'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
  }
});
