import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

// The initial, unanimated look and a new animated look can be in flight
// together. Hold both responses so their completion order is deterministic.
test('an initial theme load cannot remove the next theme before it loads', { timeout: 120000 }, async () => {
  let first, second;
  const f = await harnessFixture({ site: true, messages: [{ role: 'assistant', content: 'Ready.' }], handleRequest: async (req, res, path) => {
    if (path !== '/theme.css') return false;
    res.setHeader('Content-Type', 'text/css');
    const rev = new URL(req.url, 'http://fixture').searchParams.get('r');
    if (rev === 'one') first = res;
    else if (rev === 'two') second = res;
    else res.end('body{--theme-order:0}');
    return true;
  } });
  const p = f.page;
  const until = async check => {
    const end = Date.now() + 30000;
    while (!check()) { assert.ok(Date.now() < end, 'stylesheet request arrives'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    await p.evaluate(() => {
      const native = document.startViewTransition.bind(document);
      document.startViewTransition = update => native(() => { window.themeUpdateStarted = true; return update(); });
      dispatchEvent(new CustomEvent('imperfect-look', { detail: { rev: 'one' } }));
      dispatchEvent(new CustomEvent('imperfect-look', { detail: { rev: 'two' } }));
    });
    await until(() => first);
    await p.waitForFunction(() => window.themeUpdateStarted, null, { polling: 20 });
    first.end('body{--theme-order:1}');
    // Poll with timers: a ViewTransition freezes rendering while its update
    // waits for the second stylesheet, so RAF is deliberately unavailable.
    await p.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--theme-order').trim() === '1', null, { polling: 20 });
    await until(() => second);
    second.end('body{--theme-order:2}');
    await p.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--theme-order').trim() === '2'
      && document.querySelectorAll('link#theme-css').length === 1, null, { polling: 20 });
    assert.equal(await p.evaluate(() => getComputedStyle(document.body).getPropertyValue('--theme-order').trim()), '2');
    assert.deepEqual(f.errors, []);
  } finally {
    if (first && !first.writableEnded) first.end();
    if (second && !second.writableEnded) second.end();
    await f.close();
  }
});
