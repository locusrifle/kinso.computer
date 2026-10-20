import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harnessFixture } from './fixtures/harness-page.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { themeCss } from '../../../../system/theme.mjs';
import { testTheme } from './fixtures/theme.mjs';

test('context percentage presentation is deleted, not hidden', async () => {
  for (const path of ['index.html', 'js/harness.js', 'css/imperfect.css', 'css/guey.css', 'css/entry-terminal.css']) {
    const source = await readFile(new URL(`../public/${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /entry-context|contextChip|footerLeft/, path);
  }
});

test('model and backend effort share a clean line without context, at phone and desktop sizes', { timeout: 120000 }, async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    for (const theme of ['black', 'light-chalk']) for (const phone of [false, true]) {
      const f = await harnessFixture({ browser, desk: !phone, hasTouch: phone,
        viewport: phone ? { width: 390, height: 550 } : { width: 1200, height: 900 },
        themeCSS: themeCss(await testTheme(theme)),
        messages: [{ role: 'user', content: 'Keep the input bar simple.' },
          { role: 'assistant', content: [{ type: 'text', text: 'The model and thinking effort stay on one line, with the original harness mark.' }] }] });
      const page = f.page;
      try {
        // Remove only the fixture's fixed terminal/screen sizing: measure the production layout.
        await page.evaluate(() => {
          const style = [...document.querySelectorAll('style')].find(s => s.textContent.startsWith('#harness-reach'));
          style.textContent = '#harness-reach{display:none}';
        });
        const sizes = phone ? [{ width: 390, height: 200 }, { width: 390, height: 460 },
          { width: 430, height: 200 }, { width: 430, height: 460 }, { width: 390, height: 550 }] : [{ width: 1200, height: 900 }];
        for (const viewport of sizes) {
          await page.setViewportSize(viewport);
          for (const agent of ['pi', 'claude']) for (const long of [false, true]) {
            const name = agent === 'pi' ? (long ? 'GPT-6 Luna with an exceptionally long model caption for ellipsis' : 'GPT-6 Luna') : 'Opus 5.5';
            // Claude's canonical model caption is deliberately short; a long Pi name exercises the shared layout.
            const next = { ...f.tab, agent, level: 'medium', busy: false, stats: { contextUsage: { contextWindow: 200000, percent: 2 } },
              model: agent === 'pi' ? { provider: 'fixture', id: 'gpt-6-luna', name } : { provider: 'claude-agent', id: 'claude-opus-5-5' },
              tabs: [{ ...f.tab.tabs[0], agent, status: 'idle' }] };
            f.push(next);
            await page.waitForFunction(name => document.querySelector('.entry-model-name').textContent === name
              && document.querySelector('#entry-thinking').textContent === '· medium', name);
            const geometry = await page.evaluate(() => {
              const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
              const caption = document.querySelector('.entry-model-name');
              return { caption: rect('.entry-model-name'), effort: rect('#entry-thinking'), right: rect('.entry-status-right'),
                bar: rect('.entry-status'), model: rect('#entry-pi-label'), ellipsis: getComputedStyle(caption).textOverflow,
                truncated: caption.scrollWidth > caption.clientWidth,
                controls: [...document.querySelectorAll('.session-actions button, .session-actions label')].filter(b => b.getBoundingClientRect().width > 0).map(b => {
                  const r = b.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }) };
            });
            const key = `${theme}/${phone}/${viewport.width}x${viewport.height}/${agent}/${long}`;
            assert.ok(Math.abs(geometry.caption.y - geometry.effort.y) < 1, `${key}: matching text tops`);
            assert.ok(Math.abs(geometry.caption.bottom - geometry.effort.bottom) < 1, `${key}: matching text bottoms/baseline`);
            assert.ok(geometry.caption.width > 0 && geometry.effort.width > 0, `${key}: both visible`);
            assert.ok(geometry.model.right <= geometry.effort.x && geometry.effort.right <= geometry.right.x, `${key}: no overlap`);
            assert.ok(geometry.bar.bottom <= viewport.height && geometry.bar.y >= 0, `${key}: bar fits viewport`);
            for (const control of geometry.controls) {
              assert.ok(control.x >= geometry.effort.right && control.right <= viewport.width && control.y >= 0 && control.bottom <= viewport.height
                && Math.abs((control.y + control.bottom) / 2 - (geometry.effort.y + geometry.effort.bottom) / 2) < 1, `${key}: dock fits on same row ${JSON.stringify({ control, bar: geometry.bar, effort: geometry.effort })}`);
            }
            assert.equal(geometry.ellipsis, 'ellipsis');
            if (agent === 'pi' && long) assert.equal(geometry.truncated, true, `${key}: long captions truncate in the shared bounded composer`);
            else if (!phone) assert.equal(geometry.truncated, false, `${key}: desktop captions fit`);
            // On a phone the newly named harness and Send share this same row
            // with effort. A short caption may also ellipsize, but its full
            // model and harness must remain available on the picker button.
            assert.ok((await page.locator('#entry-pi-label').getAttribute('title')).includes(name), `${key}: full model is accessible`);
            assert.equal(await page.locator('#entry-context').count(), 0);
            assert.doesNotMatch(await page.locator('.entry-status-left').textContent(), /%|API|subscription/i);
            assert.equal(await page.evaluate(() => harness.guiSnapshot().sessionId), 'thread-a');
          }
        }
        // The model button and the existing post-model effort selector still work.
        f.answer = command => {
          if (command.type === 'models') return [{ provider: 'fixture', id: 'gpt-6-luna', name: 'GPT-6 Luna', engine: 'pi' }];
          if (command.type === 'level' && !command.level) return { current: 'medium', available: ['low', 'medium', 'high'] };
          if (command.type === 'level' && command.level) f.push({ ...f.tab, level: command.level });
        };
        f.push({ ...f.tab, agent: 'pi', model: { provider: 'fixture', id: 'gpt-6-luna', name: 'GPT-6 Luna' }, tabs: [{ ...f.tab.tabs[0], agent: 'pi' }] });
        await page.waitForFunction(() => document.querySelector('.entry-model-name').textContent === 'GPT-6 Luna');
        if (phone && theme === 'black' && process.env.HARNESS_CAPTION_PREVIEW) await page.screenshot({ path: process.env.HARNESS_CAPTION_PREVIEW });
        await page.locator('#entry-input').fill('a draft stays here');
        await page.locator('#entry-pi-label').click();
        await page.locator('#entry-dialog .entry-dialog-option', { hasText: 'GPT-6 Luna' }).click();
        await page.locator('#entry-dialog .entry-dialog-option', { hasText: 'high' }).click();
        await page.waitForFunction(() => document.querySelector('#entry-thinking').textContent === '· high');
        assert.equal(await page.locator('#entry-input').inputValue(), 'a draft stays here');
        assert.ok(f.commands.some(c => c.type === 'level' && c.level === 'high'));
        f.push({ ...f.tab, level: 'off' });
        await page.waitForFunction(() => document.querySelector('#entry-thinking').textContent === '');
        assert.equal(f.commands.some(c => c.type === 'prompt'), false);
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  } finally { await browser.close(); }
});
