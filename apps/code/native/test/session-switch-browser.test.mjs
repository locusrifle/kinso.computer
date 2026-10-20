import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { fixture, serve, fixtureResponse } from '../../tools/gui-preview.mjs';

const until = async (check, why) => {
  const end = Date.now() + 15000;
  while (!check()) { assert.ok(Date.now() < end, why); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function observeProtocol(page) {
  await page.addInitScript(() => {
    const Native = WebSocket;
    window.fixtureProtocol = { warm: [], focuses: [] };
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        const sent = new Map();
        this.send = raw => { const c = JSON.parse(raw); sent.set(c.id, c.type); return super.send(raw); };
        this.addEventListener('message', event => {
          const m = JSON.parse(event.data);
          if (m.type === 'tab-snapshot') fixtureProtocol.warm.push(m.tabId);
          if (m.type === 'response' && sent.get(m.id) === 'tab-focus') fixtureProtocol.focuses.push(m);
        });
        window.fixtureSocket = this;
      }
    };
  });
}
// The same ordered socket proves preceding key-generated commands arrived;
// absence assertions do not depend on an arbitrary transport sleep.
const barrier = page => page.evaluate(() => new Promise((resolve, reject) => {
  const ws = window.fixtureSocket, id = `fixture-barrier-${Math.random()}`;
  const timer = setTimeout(() => { ws.removeEventListener('message', heard); reject(new Error('fixture barrier timed out')); }, 15000);
  const heard = event => { const m = JSON.parse(event.data); if (m.type === 'response' && m.id === id) { clearTimeout(timer); ws.removeEventListener('message', heard); resolve(); } };
  ws.addEventListener('message', heard); ws.send(JSON.stringify({ type: 'fixture-barrier', id }));
}));

for (const phone of [false, true]) test(`${phone ? 'phone waits' : 'local desktop switches immediately'} with delayed focus and rapid selections`, { timeout: 90000 }, async () => {
  const { server, sockets, port } = await serve('');
  const calls = [], pending = [];
  const whole = id => {
    const data = fixture();
    data.sessionId = id;
    data.tabs = [...data.tabs, { ...data.tabs[1], id: 'third', sessionId: 'third', name: 'Third task' }].map(tab => ({ ...tab, focused: tab.id === id }));
    data.messages = Array.from({ length: 300 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${id} message ${i} — some conversation text` }));
    data.busy = false; data.streaming = false;
    return data;
  };
  sockets.removeAllListeners('connection');
  sockets.on('connection', socket => {
    socket.removeAllListeners('message');
    socket.send(JSON.stringify({ type: 'snapshot', data: whole('mirror') }));
    socket.on('message', raw => {
      const c = JSON.parse(raw); calls.push(c);
      const respond = data => socket.send(JSON.stringify({ type: 'response', id: c.id, success: true, data }));
      if (c.type === 'tab-focus') { pending.push(error => error ? socket.send(JSON.stringify({ type: 'response', id: c.id, success: false, error })) : respond({ snapshot: whole(c.tabId) })); return; }
      respond(fixtureResponse(c));
      if (c.type === 'hello' && c.kind === 'desktop') for (const id of ['other', 'third']) socket.send(JSON.stringify({ type: 'tab-snapshot', tabId: id, data: whole(id) }));
    });
  });
  let browser;
  try {
    // A phone's browser is a phone's from its first paint, as harness-page.mjs pins it: the launcher's
    // fine pointer (a desktop's) can otherwise win the touch emulation race on the first renderer.
    browser = await launchChromium({ headless: true, args: ['--no-sandbox', ...(phone
      ? ['--blink-settings=primaryHoverType=1,availableHoverTypes=1,primaryPointerType=2,availablePointerTypes=2'] : [])] });
    const page = await browser.newPage({ viewport: { width: phone ? 390 : 1200, height: 900 }, hasTouch: phone });
    page.setDefaultTimeout(15000);
    await observeProtocol(page);
    let acknowledgements = 0;
    const acknowledge = async error => {
      await until(() => pending.length === 1, `one focus request arrived: ${JSON.stringify(calls)}`);
      pending.shift()(error);
      await page.waitForFunction(n => fixtureProtocol.focuses.length === n, ++acknowledgements);
      await frames(page);
    };
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.waitForFunction(() => document.querySelector('#entry-output')?.textContent.includes('mirror message 299'));
    if (!phone) await page.waitForFunction(() => ['other', 'third'].every(id => fixtureProtocol.warm.includes(id)));
    await frames(page);
    await page.locator('#entry-input').fill('draft for mirror');
    const click = id => page.evaluate(id => {
      const start = performance.now();
      document.querySelector(`[data-tab-id="${id}"] .session-rail-open`).click();
      return { ms: performance.now() - start, text: document.querySelector('#entry-output').textContent, dull: document.querySelector('#entry-output').classList.contains('entry-switching') };
    }, id);
    await page.evaluate(() => { window.keptNode = document.querySelector('#entry-output').firstChild; });
    const first = await click('other');
    assert.equal(first.dull, phone, JSON.stringify({ errors, calls }));
    assert.ok(first.text.includes(`${phone ? 'mirror' : 'other'} message 299`));
    if (!phone) console.log(`300-message cached switch: ${first.ms.toFixed(1)}ms before focus response`);
    const rapid = await click('third');
    assert.ok(rapid.text.includes(`${phone ? 'mirror' : 'third'} message 299`));
    await until(() => pending.length === 1, 'first focus request arrived');
    assert.equal(pending.length, 1, JSON.stringify({ errors, calls }));
    await acknowledge();
    await until(() => pending.length === 1, 'superseding focus request arrived');
    assert.equal(pending.length, 1, JSON.stringify({ errors, calls }));
    if (!phone) assert.ok((await page.locator('#entry-output').textContent()).includes('third message 299'), 'superseded acknowledgement must not flash an older tab');
    await acknowledge();
    await page.waitForFunction(() => !document.querySelector('#entry-output').classList.contains('entry-switching') && document.querySelector('#entry-output').textContent.includes('third message 299'));
    await click('mirror');
    await acknowledge();
    await page.waitForFunction(() => document.querySelector('#entry-output').textContent.includes('mirror message 299'));
    assert.equal(await page.locator('#entry-input').inputValue(), 'draft for mirror');
    if (!phone) assert.equal(await page.evaluate(() => window.keptNode === document.querySelector('#entry-output').firstChild), true, 'settled transcript nodes survive switching');
    assert.equal(calls.filter(c => c.type === 'snapshot').length, 0, 'focus response contains the snapshot');
    if (!phone) {
      await frames(page);
      await click('other');
      await until(() => pending.length === 1, 'unconfirmed focus request arrived');
      await page.locator('#entry-input').fill('must not reach an unconfirmed session');
      await page.locator('#entry-input').press('Enter');
      await barrier(page);
      assert.equal(calls.some(c => c.type === 'prompt'), false, 'pending focus cannot send a prompt');
      await acknowledge('Focus rejected');
      await page.locator('#entry-input').press('Enter');
      await barrier(page);
      assert.equal(calls.some(c => c.type === 'prompt'), false, 'failed focus cannot send to the previous selection');
      await click('mirror');
      await acknowledge();
      assert.equal(await page.locator('#entry-input').inputValue(), 'draft for mirror');
    }
    assert.deepEqual(errors, []);
    if (!phone && process.env.SWITCH_SCREENSHOT) await page.screenshot({ path: process.env.SWITCH_SCREENSHOT });
  } finally {
    await browser?.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});

test('a press on a tab lands while agents stream', { timeout: 90000 }, async () => {
  const { server, sockets, port } = await serve('');
  const calls = [];
  let tick = 0;
  sockets.on('connection', socket => socket.on('message', raw => calls.push(JSON.parse(raw))));
  // An update every frame or so, as a working agent sends them: new words, a new revision.
  const stream = setInterval(() => {
    tick++;
    const data = fixture();
    data.partial = { role: 'assistant', content: [{ type: 'text', text: 'word '.repeat(tick) }] };
    data.tabs = data.tabs.map(tab => ({ ...tab, revision: tick }));
    for (const socket of sockets.clients) socket.send(JSON.stringify({ type: 'snapshot', data }));
  }, 15);
  let browser;
  try {
    browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.waitForSelector('[data-tab-id="other"] .session-rail-open');
    const button = await page.locator('[data-tab-id="other"] .session-rail-open').elementHandle();
    const before = tick;
    await until(() => tick >= before + 10, 'ten streaming updates sent');
    await page.waitForFunction(n => document.querySelector('#entry-output')?.textContent.includes('word '.repeat(n).trim()), before + 10);
    const kept = await button.evaluate(node => node.isConnected);
    assert.equal(kept, true, 'an update that changes nothing on the rail leaves its buttons alone');
    const box = await page.locator('[data-tab-id="other"] .session-rail-open').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // This duration is the input under test, not a readiness wait.
    await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
    await until(() => calls.some(c => c.type === 'tab-focus' && c.tabId === 'other'), 'held click focus request arrived');
    assert.ok(calls.some(c => c.type === 'tab-focus' && c.tabId === 'other'), 'a held click enters the tab');
    assert.deepEqual(errors, []);
  } finally {
    clearInterval(stream);
    await browser?.close(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
