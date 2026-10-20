import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { openUsage } from './fixtures/usage-controls.mjs';
import { aggregateUsage } from '../usage-history.mjs';

for (const width of [320, 390, 1200]) test(`sidebar opens readable usage without losing a draft at ${width}px`, async t => {
  const f = await harnessFixture({ desk: width === 1200, viewport: { width, height: 900 }, hasTouch: width < 500,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }] });
  t.after(() => f.close());
  f.answer = c => c.type === 'usage' ? [] : c.type === 'usage-history' ? { ...aggregateUsage([], { owner: 'fixture' }), historyCoverage: { complete: true } } : undefined;
  const page = f.page;
  await page.evaluate(() => localStorage.setItem('imperfect:usage-page:v1', JSON.stringify({ metric: 'graphs', period: 30 })));
  await page.locator('#entry-input').fill('keep the draft');
  await openUsage(page);
  const pane = page.locator('.usage-box');
  await pane.getByText('No recorded activity in this range.', { exact: true }).waitFor();
  assert.equal(await pane.isVisible(), true);
  if (width < 500) assert.equal(await page.locator('#session-rail').evaluate(n => n.classList.contains('collapsed')), true, 'usage dismisses the phone sheet');
  assert.equal(await pane.evaluate(n => n.scrollWidth <= n.clientWidth + 1), true);
  assert.equal(await page.locator('#entry-input').inputValue(), 'keep the draft');
  await pane.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  assert.equal(await pane.count(), 0);
  assert.equal(await page.locator('#entry-input').inputValue(), 'keep the draft');
  if (width < 500) {
    await page.evaluate(() => harness.showFiles());
    await page.waitForFunction(() => Math.abs(document.querySelector('.wm-files').getBoundingClientRect().x) < 1);
    // The strip's fold button leaves with the conversation. Drive the same
    // sidebar command directly to exercise its destination while Files is up.
    await page.evaluate(() => harness.toggleRail());
    await openUsage(page);
    await page.waitForFunction(() => Math.abs(document.querySelector('.usage-box').getBoundingClientRect().x) < 1);
    assert.equal(await pane.locator('.usage-back').evaluate(button => {
      const r = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), true, 'usage is reachable above the conversation, even when opened from Files');
    await pane.locator('.usage-back').click();
    assert.equal(await page.locator('#entry-input').inputValue(), 'keep the draft');
  }
  assert.deepEqual(f.errors, []);
});
