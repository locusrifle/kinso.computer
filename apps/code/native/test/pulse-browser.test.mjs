import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';

// Health evidence belongs to agents, not a status line or a diagnostic panel
// in the person's conversation. Backend doctor/incident tests remain separate.
test('system monitoring stays out of the conversation on desktop and phone', { timeout: 120000 }, async t => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  for (const width of [1200, 390]) for (const id of ['black', 'light-chalk']) {
    const css = themeCss(JSON.parse(await readFile(new URL(`./fixtures/themes/${id}.json`, import.meta.url))));
    const requests = [];
    const f = await harnessFixture({ browser, site: true, themeCSS: css, hasTouch: width < 500,
      viewport: { width, height: 900 },
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready to make something.' }] }],
      machines: [{ id: 'pc', name: 'desktop', reachable: true, self: true }],
      handleRequest: async (req, res, path) => {
        if (!path.endsWith('/pulse.json')) return false;
        requests.push(path);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ summary: { state: 'crit', reason: 'A background check needs an agent.' } }));
        return true;
      },
    });
    try {
      assert.equal(await f.page.locator('.pulse-status, .pulse-box').count(), 0);
      assert.equal(await f.page.getByRole('button', { name: /Open Pulse/ }).count(), 0);
      assert.equal(await f.page.getByRole('dialog', { name: 'Pulse', exact: true }).count(), 0);
      await f.page.locator('#entry-input').fill('my draft stays mine');
      await f.page.clock.install();
      await f.page.clock.fastForward(120000);
      assert.deepEqual(requests, [], `${width} ${id}: the UI must not poll diagnostics`);
      assert.equal(await f.page.locator('#entry-input').inputValue(), 'my draft stays mine');
      assert.equal(await f.page.locator('#entry-input').evaluate(n => n.inert), false);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});
