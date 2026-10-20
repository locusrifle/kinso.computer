import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { fixture, fixtureResponse, serve } from '../../tools/gui-preview.mjs';

// Choosing text in the conversation (Noah, 19 Oct: "really difficult to
// select text in imperfect without autoselecting everything"): a drag keeps
// what it chose (the input bar no longer takes the keys mid-drag), and a drag
// that goes past the text it began in chooses up to the nearest point of that
// text, never the messages after it or the window beside it (choose-text.js).
const ANSWER = n => `Answer ${n}: the quick brown fox jumps over the lazy dog, and then it keeps running across the whole field until evening comes.`;

async function open(t) {
  const { server, sockets, port } = await serve('');
  const data = { ...fixture(), messages: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i % 2 ? [{ type: 'text', text: ANSWER(i) }] : `Question ${i}: where does the fox go after it jumps?` })) };
  sockets.removeAllListeners('connection');
  sockets.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'snapshot', data }));
    socket.on('message', raw => {
      const c = JSON.parse(raw);
      socket.send(JSON.stringify({ type: 'response', id: c.id, success: true, data: c.type === 'snapshot' ? data : fixtureResponse(c) }));
    });
  });
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  t.after(async () => {
    await browser.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
  });
  // A laptop's window: the conversation with Files beside it.
  const page = await browser.newPage({ viewport: { width: 1472, height: 920 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/?face=code`);
  await page.waitForFunction(() => document.querySelectorAll('#entry-output .gui-message').length >= 8);
  await page.waitForTimeout(500);
  return { page, errors };
}

// The left edge of a letter of Answer 3 (edges, not middles: headless
// Chromium starts no drag from a letter's exact middle, on any page).
const letter = (page, at) => page.evaluate(at => {
  const p = [...document.querySelectorAll('#entry-output .gui-message p')].find(node => node.textContent.startsWith('Answer 3'));
  const range = document.createRange(); range.setStart(p.firstChild, at); range.setEnd(p.firstChild, at + 1);
  const box = range.getBoundingClientRect(), text = p.getBoundingClientRect();
  return { x: box.left + 1, y: box.top + box.height / 2, line: box.height, right: text.right };
}, at);

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) { await page.mouse.move(from.x + (to.x - from.x) * i / 16, from.y + (to.y - from.y) * i / 16); await page.waitForTimeout(20); }
  // What is seen while still dragging.
  const during = await page.evaluate(() => getSelection().toString());
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => ({ chosen: getSelection().toString(), keys: document.activeElement?.id || document.activeElement?.tagName }));
  return { during, ...after };
}

test('a drag inside a message chooses just those words and keeps them', async t => {
  const { page, errors } = await open(t);
  const chosen = await drag(page, await letter(page, 10), await letter(page, 31));
  assert.equal(chosen.chosen, 'the quick brown fox j');
  assert.notEqual(chosen.keys, 'entry-input', 'the input bar took the keys and the choice was lost');
  // Copied as chosen.
  await page.keyboard.press('Control+c');
  assert.equal(await page.evaluate(() => getSelection().toString()), 'the quick brown fox j');
  assert.deepEqual(errors, []);
});

test('a drag past the end of a line or into the next window stays in that text', async t => {
  const { page, errors } = await open(t);
  const start = await letter(page, 14);
  const pastLine = await drag(page, start, { x: start.right + 40, y: start.y });
  assert.equal(pastLine.during, 'quick brown fox jumps over the lazy dog, and then it keeps running across the whole ');
  assert.equal(pastLine.chosen, pastLine.during);
  await page.evaluate(() => getSelection().removeAllRanges());
  const intoFiles = await drag(page, start, { x: 1460, y: start.y + start.line * 1.5 });
  assert.equal(intoFiles.chosen.replace(/\s+/g, ' ').trim(), ANSWER(3).slice(14));
  for (const outside of ['Question 4', 'Answer 5', 'This computer', 'items']) assert.ok(!intoFiles.during.includes(outside), `the drag reached "${outside}"`);
  assert.deepEqual(errors, []);
});

test('a click that chooses nothing still gives the keys to the input bar', async t => {
  const { page, errors } = await open(t);
  await page.evaluate(() => document.activeElement?.blur());
  const at = await letter(page, 20);
  await page.mouse.click(at.x, at.y);
  await page.waitForFunction(() => document.activeElement?.id === 'entry-input');
  // A double click chooses a word, and keeps it.
  await page.mouse.dblclick(at.x + 2, at.y);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => getSelection().toString().trim()), 'brown');
  assert.deepEqual(errors, []);
});
