import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

test('the dock never falls back to the laptop when authenticated home metadata is missing', async () => {
  const paths = [];
  const f = await harnessFixture({ desk: true, machines: [{ id: 'laptop', self: true, reachable: true }], messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }], onBrowserLive(ws, req) { paths.push(req.url); } });
  try {
    const p = f.page;
    await p.locator('#entry-input').fill('keep laptop draft');
    await p.getByRole('button', { name: 'Open PC browser (Chromium)', exact: true }).click();
    await p.getByText(/Browser unavailable: Home browser computer unavailable/).first().waitFor();
    assert.deepEqual(paths, []);
    assert.equal(await p.locator('.wm-live, webview').count(), 0);
    assert.equal(await p.locator('#entry-input').inputValue(), 'keep laptop draft');
    await p.keyboard.press('Meta+Shift+B');
    assert.equal(await p.locator('webview').count(), 1, 'local shortcut is independent of home metadata');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
