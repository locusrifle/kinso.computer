import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

test('native human reveal exposes the selected guest; agent front leaves viewport and draft alone', async t => {
  // About the scrolling layout's strip and the browser's place in it (a desk starts in focus).
  const fixture = await harnessFixture({ desk: true, layout: 'scrolling', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Fixture' }] }] });
  t.after(() => fixture.close());
  const p = fixture.page;
  await p.locator('#entry-input').fill('keep this draft');
  await p.evaluate(() => {
    browseFromWindow({ url: 'https://fixture.invalid/one', behind: true });
    browseFromWindow({ url: 'https://fixture.invalid/two', behind: true });
  });
  await p.waitForTimeout(600);
  const state = () => p.evaluate(() => ({ scroll: document.querySelector('.canvas-strip').scrollLeft, focus: document.activeElement?.id }));
  const before = await state();
  await p.evaluate(() => tabFromWindow({ id: 102, do: 'front' }));
  await p.waitForTimeout(300);
  assert.deepEqual(await state(), before);
  assert.equal(await p.locator('.browser-page.front webview').getAttribute('src'), 'https://fixture.invalid/two');
  await p.evaluate(() => tabFromWindow({ id: 101, do: 'reveal' }));
  await p.waitForFunction(() => {
    const pane = document.querySelector('.wm-browser').getBoundingClientRect();
    return pane.left >= -2 && pane.left < innerWidth && pane.right > 0;
  });
  assert.ok((await state()).scroll > before.scroll, 'the browser, right of the conversation and Files, came into view');
  assert.equal(await p.locator('.browser-page.front webview').getAttribute('src'), 'https://fixture.invalid/one');
  assert.equal(await p.locator('#entry-input').inputValue(), 'keep this draft');
  assert.deepEqual(fixture.errors, []);
});
