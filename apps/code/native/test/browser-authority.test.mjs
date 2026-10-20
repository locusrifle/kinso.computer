import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';

// The local shortcut stays local; the dock explicitly watches the home PC.
const MACHINES = () => [{ id: 'laptop', self: true, reachable: true }, { id: 'pc', home: true, reachable: true }];

test('desktop window: Super+Shift+B opens its own browser, with an address bar, back, forward, reload and tabs', async () => {
  const paths = [], prompts = [];
  const f = await harnessFixture({ desk: true, viewport: { width: 1200, height: 900 }, machines: MACHINES(),
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }],
    onBrowserLive(ws, req) { paths.push(req.url); } });
  f.answer = command => { if (command.type === 'prompt') prompts.push(command); };
  try {
    const p = f.page;
    const address = p.locator('.wm-browser .gui-window-address');
    await p.locator('#entry-input').fill('keep draft on laptop');
    await p.keyboard.press('Meta+Shift+B');
    await p.locator('.wm-browser webview').waitFor({ state: 'attached' });
    assert.equal(await p.locator('.wm-browser webview').getAttribute('src'), 'about:blank');
    assert.equal(await address.evaluate(n => n === document.activeElement), true, 'the address waits to be typed');
    assert.equal(await address.getAttribute('placeholder'), 'Search or type an address');
    for (const name of ['Back', 'Forward', 'Reload']) assert.equal(await p.locator(`.wm-browser .gui-window-go[aria-label="${name}"]`).count(), 1, name);
    // Words are a search, an address is gone to; neither reaches the input bar.
    await p.keyboard.type('goats on mountains');
    await p.keyboard.press('Enter');
    assert.equal(await p.locator('.wm-browser webview').getAttribute('src'), 'https://www.google.com/search?q=goats%20on%20mountains');
    await address.fill('example.com');
    await address.press('Enter');
    assert.equal(await p.locator('.wm-browser webview').getAttribute('src'), 'https://example.com/');
    // Another tab (Ctrl+T), then the button and the key again: the browser
    // already open, as it is.
    await p.locator('#entry-input').focus();
    await p.keyboard.press('Control+t');
    assert.equal(await p.locator('.wm-browser webview').count(), 2);
    assert.equal(await p.locator('.wm-browser .browser-tab').count(), 2);
    await p.keyboard.press('Meta+Shift+B');
    await p.keyboard.press('Alt+Shift+B');
    await p.evaluate(() => keyFromWindow('browser'));
    await p.waitForTimeout(150);
    assert.equal(await p.locator('.wm-browser webview').count(), 2);
    // Never the home PC's browser, and nothing asked of it.
    assert.equal(await p.locator('.wm-live').count(), 0);
    assert.deepEqual(paths, []);
    assert.equal(await p.locator('#entry-input').inputValue(), 'keep draft on laptop');
    assert.deepEqual(prompts, []);
    assert.equal(await p.evaluate(() => harness.guiSnapshot().sessionId), 'thread-a');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('phone: the browser button shows the home PC\'s browser live, not the laptop session\'s', async () => {
  const paths = [], commands = [];
  const f = await harnessFixture({ hasTouch: true, viewport: { width: 390, height: 900 }, machines: MACHINES(),
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }],
    onBrowserLive(ws, req) {
      paths.push(req.url);
      ws.on('message', raw => {
        const command = JSON.parse(raw); commands.push(command);
        if (command.do === 'watch' || command.do === 'launch') ws.send(JSON.stringify({ tabs: [{ tab: 42, front: true, url: 'about:blank' }] }));
      });
    }
  });
  try {
    const p = f.page;
    await p.locator('#entry-input').fill('keep draft on phone');
    await p.getByRole('button', { name: 'Open PC browser (Chromium)', exact: true }).click();
    await p.locator('.wm-live .browser-tab').waitFor();
    f.sendFrom('', { type: 'browse', machine: 'laptop' });
    await p.waitForTimeout(100);
    await p.keyboard.press('Alt+Shift+B');
    await p.waitForTimeout(100);
    assert.equal(await p.locator('.wm-live').count(), 1);
    assert.equal(await p.locator('webview').count(), 0, 'no local browser');
    assert.deepEqual(paths, ['/peer/pc/browser/live']);
    assert.ok(commands.some(c => c.do === 'launch'));
    assert.ok(!commands.some(c => c.do === 'navigate'), 'no external navigation on launch');
    assert.equal(await p.locator('.wm-live .gui-window-address').inputValue(), '');
    await p.locator('.wm-live .gui-window-address').fill('example.com');
    await p.locator('.wm-live .gui-window-address').press('Enter');
    await p.waitForTimeout(100);
    assert.deepEqual(commands.find(c => c.do === 'navigate'), { do: 'navigate', url: 'https://example.com/', tab: 42 });
    assert.equal(await p.locator('#entry-input').inputValue(), 'keep draft on phone');
    assert.equal(await p.evaluate(() => harness.guiSnapshot().sessionId), 'thread-a');
    f.machines[1].reachable = false;
    const launches = commands.filter(c => c.do === 'launch').length;
    await p.getByRole('button', { name: 'Open PC browser (Chromium)', exact: true }).click();
    await p.getByText(/Browser unavailable:.*unavailable.*Try again/).first().waitFor();
    assert.equal(commands.filter(c => c.do === 'launch').length, launches);
    assert.equal(await p.locator('#entry-input').inputValue(), 'keep draft on phone');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
