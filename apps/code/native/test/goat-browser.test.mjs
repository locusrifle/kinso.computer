import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

for (const phone of [false, true]) test(`${phone ? 'phone' : 'desktop'}: the folded strip identifies tabs; the sidebar names them without marks`, async () => {
  const f = await harnessFixture({ layout: 'scrolling', viewport: { width: phone ? 390 : 1200, height: 850 }, hasTouch: phone,
    messages: [{ role: 'assistant', content: 'Ready.' }] });
  try {
    const { page } = f;
    const tabs = Array.from({ length: 12 }, (_, i) => ({ ...f.tab.tabs[0], id: `tab-${i}`, sessionId: `thread-${i}`, focused: i === 0, agent: i % 2 ? 'claude' : 'pi', status: i < 2 ? 'working' : 'idle', prompt: `Session ${i + 1}` }));
    f.push({ ...f.tab, sessionId: 'thread-0', tabs });
    await page.waitForFunction(() => document.querySelectorAll('.session-rail-item[data-tab-id]').length === 12);
    await page.locator('#entry-input').fill('preserve draft');
    const expected = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
    if (phone) assert.equal(await page.locator('#session-rail.collapsed .session-rail-logo').count(), 12);
    else assert.deepEqual(await page.locator('.session-rail-number').allTextContents(), expected);
    await page.getByRole('button', { name: 'show the agents', exact: true }).click();
    assert.equal(await page.locator('#session-rail .session-rail-logo, #session-rail .session-rail-number').count(), 0);
    assert.equal(await page.locator('#session-rail .session-rail-asked').first().textContent(), 'Session 1');
    await page.getByRole('button', { name: 'collapse the agents', exact: true }).click();
    if (!phone) assert.deepEqual(await page.locator('.session-rail-number').allTextContents(), expected);
    assert.equal(await page.locator('#entry-input').inputValue(), 'preserve draft');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
