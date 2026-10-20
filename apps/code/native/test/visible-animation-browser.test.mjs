// What animates runs only while it can be seen (visible-animation.js), as
// T3 Code's visibleAnimation does: a session at work in a row scrolled out of
// the sidebar is held still, and runs again once scrolled back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

test('a working session scrolled out of the sidebar holds its spinner still, and runs again in view', async () => {
  const f = await harnessFixture({ desk: { mac: true }, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] }], viewport: { width: 1280, height: 600 } });
  const { page } = f;
  try {
    const tabs = Array.from({ length: 30 }, (_, i) => ({ ...f.tab.tabs[0], id: i ? `tab-${i}` : f.tab.tabs[0].id, sessionId: i ? `tab-${i}` : f.tab.tabs[0].sessionId, focused: i === 0, agent: i % 2 ? 'claude' : 'pi', status: 'working', prompt: `Session ${i + 1}` }));
    f.push({ ...f.tab, tabs });
    await page.waitForFunction(() => document.querySelectorAll('#session-rail .session-rail-item[data-state="working"]').length === 30);
    const play = () => page.evaluate(() => [...document.querySelectorAll('#session-rail .session-rail-item[data-state="working"]')].map(row => {
      const spinner = row.querySelector('.session-rail-state');
      return [row.textContent.trim(), getComputedStyle(spinner).animationPlayState];
    }));
    await page.waitForFunction(() => document.querySelector('#session-rail .session-rail-item[data-state="working"]:last-of-type .session-rail-state[data-out-of-view]'));
    let rows = await play();
    assert.deepEqual(rows[0].slice(1), ['running'], 'in view, it runs');
    assert.deepEqual(rows.at(-1).slice(1), ['paused'], 'scrolled out, it is held still');
    await page.evaluate(() => { const list = document.querySelector('#session-rail .session-rail-list'); list.scrollTop = list.scrollHeight; });
    await page.waitForFunction(() => document.querySelector('#session-rail .session-rail-item[data-state="working"] .session-rail-state[data-out-of-view]')
      && !document.querySelector('#session-rail .session-rail-item[data-state="working"]:last-of-type .session-rail-state[data-out-of-view]'));
    rows = await play();
    assert.deepEqual(rows[0].slice(1), ['paused']);
    assert.deepEqual(rows.at(-1).slice(1), ['running'], 'back in view, it runs again');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
