import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { serve } from '../../tools/gui-preview.mjs';

// A restart that brings a new build reloads every open window by itself
// (site.js followSurfaceRelease), even after a prompt was refused, as one is
// while a restart waits; the refused words come back in the input bar.
test('a new build reloads the window, even after a refused prompt; its words and its request id are kept', async () => {
  const { server, sockets, port } = await serve(':root { --pi-accent: #4f8cff; }', { empty: true });
  // Prompts are refused, the way a handoff refuses them.
  const ids = [];
  sockets.on('connection', socket => {
    const send = socket.send.bind(socket);
    socket.prependListener('message', raw => { try { const m = JSON.parse(raw); socket.asked = m.type; if (m.type === 'prompt') ids.push(m.requestId); } catch {} });
    socket.send = (raw, ...rest) => {
      const message = JSON.parse(raw);
      if (message.type === 'response' && socket.asked === 'prompt') return send(JSON.stringify({ type: 'response', id: message.id, success: false, error: 'Machine handoff pending; send again once it resumes' }), ...rest);
      return send(raw, ...rest);
    };
  });
  const look = build => { for (const ws of sockets.clients) ws.send(JSON.stringify({ type: 'look', data: { theme: 'x', rev: 'r1', build } })); };
  const until = async check => {
    const end = Date.now() + 30000;
    while (!check()) { assert.ok(Date.now() < end, 'expected transport event arrives'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  let browser;
  try {
    browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    let loads = 0;
    page.on('load', () => { loads += 1; });
    await page.goto(`http://127.0.0.1:${port}/?face=code`);
    await page.waitForFunction(() => document.querySelector('#entry-input'));
    await until(() => sockets.clients.size === 1);
    look('first');
    await page.waitForFunction(() => sessionStorage.getItem('imperfect.surface-code-revision') === 'first');
    await page.locator('#entry-input').fill('hello there');
    await page.keyboard.press('Enter');
    await until(() => ids.length === 1);
    await page.waitForFunction(() => document.querySelector('#entry-input').value === 'hello there');
    // Revision storage changes in the old document before reload commits.
    // An already-loaded document makes waitForLoadState return immediately;
    // arm the actual next load before publishing the new build instead.
    const reloaded = page.waitForEvent('load', { timeout: 60000 });
    look('second');
    await reloaded;
    await page.waitForFunction(() => sessionStorage.getItem('imperfect.surface-code-revision') === 'second');
    await page.waitForFunction(() => document.querySelector('#entry-input'));
    assert.equal(loads, 2, 'the window reloaded once for the new build');
    assert.equal(await page.locator('#entry-input').inputValue(), 'hello there', 'the refused words are still there');
    // Sent again after the reload, it is the same prompt: it cannot arrive twice.
    await page.keyboard.press('Enter');
    await until(() => ids.length === 2);
    await page.waitForFunction(() => document.querySelector('#entry-input').value === 'hello there');
    assert.equal(ids.length, 2);
    assert.equal(ids[1], ids[0], 'the same request id after the reload');
  } finally {
    try { await browser?.close(); }
    finally {
      for (const socket of sockets.clients) socket.terminate();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
});
