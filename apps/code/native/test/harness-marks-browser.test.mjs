import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { testTheme } from './fixtures/theme.mjs';

// Fixture snapshots only: the brand identifies the app, words identify billing's harness.
test('the brand mark precedes model and harness, moves only at work, and survives snapshots', async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const theme of ['black', 'light-chalk']) for (const phone of [false, true]) {
      const f = await harnessFixture({ browser, desk: !phone, hasTouch: phone,
        viewport: phone ? { width: 412, height: 915 } : { width: 1200, height: 900 },
        themeCSS: themeCss(await testTheme(theme)), messages: [{ role: 'assistant', content: 'Ready.' }] });
      try {
        const { page } = f, mark = page.locator('#entry-pi-label .brand-mark');
        for (const agent of ['pi', 'claude']) for (const working of [false, true]) {
          const name = agent === 'claude' ? 'Opus 5.5' : 'GPT-6 Astra';
          const next = { ...f.tab, agent, busy: working, model: { id: agent === 'claude' ? 'claude-opus-5-5' : 'gpt-6-astra', name }, tabs: [{ ...f.tab.tabs[0], agent, status: working ? 'working' : 'idle' }] };
          f.push(next);
          await page.waitForFunction(({ working, name }) => document.querySelector('#entry-pi-label .brand-mark').classList.contains('mark-working') === working && document.querySelector('.entry-model-name').textContent === name, { working, name });
          assert.equal(await mark.getAttribute('data-brand'), 'imperfect');
          assert.equal(await mark.getAttribute('aria-hidden'), 'true');
          assert.equal(await page.locator('.entry-harness-name').textContent(), agent === 'claude' ? 'Claude Code' : 'Pi');
          const geometry = await mark.evaluate(mark => { const r = mark.getBoundingClientRect(), text = mark.nextElementSibling.getBoundingClientRect(); return { width: parseFloat(getComputedStyle(mark).width), gap: text.left - r.right, visible: text.width > 0, animation: getComputedStyle(mark).animationName }; });
          assert.equal(geometry.width, 16);
          assert.ok(geometry.gap > 0 && geometry.visible);
          assert.equal(geometry.animation !== 'none', working);
          await mark.evaluate(mark => { mark.dataset.retained = 'yes'; });
          f.push({ ...next });
          await page.waitForTimeout(50);
          assert.equal(await mark.getAttribute('data-retained'), 'yes');
          await page.emulateMedia({ reducedMotion: 'reduce' });
          assert.equal(await mark.evaluate(mark => getComputedStyle(mark).animationName), 'none');
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          if (!phone) assert.equal(await page.locator('#session-rail .session-rail-logo').count(), 0);
        }
        assert.deepEqual(f.errors, []);
        assert.equal(f.commands.some(c => c.type === 'prompt'), false);
      } finally { await f.close(); }
    }
  } finally { await browser.close(); }
});
