import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { fixture, serve } from '../../tools/gui-preview.mjs';

// An answer arriving is drawn into one article kept between updates: the
// paragraphs already finished stay the same nodes, the words are let out a
// few per frame, it is laid out in full (no stand-in height), and the view
// stays at the bottom in the frame they are drawn.
for (const phone of [false, true]) test(`${phone ? 'phone' : 'desk'}: a streamed answer flows in without moving the page`, { timeout: 120000 }, async () => {
  const { server, sockets, port } = await serve('');
  const base = fixture();
  const whole = partial => ({ ...base, busy: true, streaming: true, partial,
    messages: [...Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} with enough words to wrap a line or two in the column` })), { role: 'user', content: 'go' }] });
  const answer = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${'flowing words '.repeat(14)}`).join('\n\n');
  let socket;
  sockets.on('connection', s => { socket = s; });
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: phone ? 390 : 1200, height: 800 }, hasTouch: phone });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(30000);
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.waitForFunction(() => document.querySelector('#entry-output .gui-message'));
    const send = text => socket.send(JSON.stringify({ type: 'snapshot', data: whole({ role: 'assistant', content: [{ type: 'text', text }] }) }));
    send(answer.slice(0, 400));
    await page.waitForFunction(() => document.querySelector('.gui-live p'));
    const first = await page.evaluate(() => { window.liveArticle = [...document.querySelectorAll('article.gui-live')].at(-1); window.firstLine = window.liveArticle.querySelector('p'); return getComputedStyle(window.liveArticle).contentVisibility; });
    assert.equal(first, 'visible');
    await page.evaluate(() => {
      const out = document.querySelector('#entry-output');
      window.samples = [];
      const ch = new MessageChannel();
      ch.port1.onmessage = () => window.samples.push({ chars: out.textContent.length, gap: out.scrollHeight - out.clientHeight - out.scrollTop });
      const tick = () => { ch.port2.postMessage(0); if (!window.stopSampling) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    // Pace the producer by observed drawn frames, not 50 ms wall sleeps:
    // under load the socket and reveal frames can otherwise fall far behind.
    for (let at = 460; at < answer.length + 60; at += 60) {
      const before = await page.evaluate(() => ({ count: window.samples.length, chars: document.querySelector('#entry-output').textContent.length }));
      send(answer.slice(0, at));
      await page.waitForFunction(({ count, chars }) => window.samples.slice(count).some(sample => sample.chars > chars), before);
    }
    // Reaching the final heading is not enough: wait for every word to be
    // revealed, including its last paragraph, and sampled after layout.
    const expected = answer;
    await page.waitForFunction(expected => [...document.querySelectorAll('article.gui-live p')].map(p => p.textContent).join('\n\n') === expected, expected);
    await page.waitForFunction(() => window.samples.at(-1)?.chars === document.querySelector('#entry-output').textContent.length);
    const result = await page.evaluate(() => {
      window.stopSampling = true;
      const article = [...document.querySelectorAll('article.gui-live')].at(-1);
      return { same: article === window.liveArticle, firstKept: window.firstLine.isConnected, text: article.textContent, samples: window.samples };
    });
    assert.ok(result.same, 'one article for the whole answer');
    assert.ok(result.firstKept, 'a finished paragraph is not drawn again');
    assert.equal(result.text, expected.replaceAll('\n\n', ''), 'the complete answer is drawn');
    const steps = result.samples.map((s, i) => i ? s.chars - result.samples[i - 1].chars : 0).filter(d => d > 0);
    assert.ok(steps.length > 30, `words let out over many frames (${steps.length})`);
    assert.ok(Math.max(...result.samples.map(s => s.gap)) <= 2, 'the view stays at the bottom in every painted frame');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
