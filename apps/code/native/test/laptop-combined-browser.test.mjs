import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

test('the browser on the right takes the keys and the view at once, full-window restores them, and drafts survive', async () => {
  const f = await harnessFixture({ desk: true, viewport: { width: 1536, height: 900 }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Combined review' }] }] });
  const p = f.page;
  const strip = () => p.evaluate(() => document.querySelector('.canvas-strip').scrollLeft);
  try {
    await p.locator('.wm-files').waitFor();
    await p.evaluate(() => browseFromWindow({ url: 'https://combined.example/', behind: true }));
    await p.waitForFunction(() => !document.querySelector('.wm-moving'));
    await p.locator('#entry-input').fill('my unsent draft');
    assert.equal(await strip(), 0, 'opened behind, out of sight on the right');
    const max = await p.evaluate(() => { const n = document.querySelector('.canvas-strip'); return n.scrollWidth - n.clientWidth; });
    assert.ok(max > 0);
    const first = await p.evaluate(() => {
      keyFromWindow('next');
      return { left: document.querySelector('.canvas-strip').scrollLeft, active: document.activeElement.localName };
    });
    assert.deepEqual(first, { left: max, active: 'webview' }, 'the keys and the view move together, in the same moment');
    await p.waitForTimeout(60);
    assert.equal(await strip(), max, 'nothing slides afterwards');
    await p.evaluate(() => keyFromWindow('fullWindow'));
    await p.locator('.wm-full-window').waitFor();
    const full = await p.locator('.wm-browser').boundingBox();
    assert.deepEqual(full, { x: 0, y: 0, width: 1536, height: 900 });
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('.wm-full-window'));
    assert.equal(await strip(), max, 'restoration returns to the saved view');
    assert.equal(await p.locator('#entry-input').inputValue(), 'my unsent draft');
    await p.evaluate(() => keyFromWindow('previous'));
    assert.equal(await p.locator('.entry-screen.wm-focused').count(), 1, 'the conversation, out of sight, past Files');
    assert.equal(await strip(), 0);
    assert.equal(await p.evaluate(() => document.activeElement.id), 'entry-input');
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.evaluate(() => keyFromWindow('next'));
    assert.equal(await strip(), max, 'reduced motion: the same, at once');
    assert.equal(await p.locator('.wm-browser webview').count(), 1);
    assert.equal(await p.locator('#entry-input').inputValue(), 'my unsent draft');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
