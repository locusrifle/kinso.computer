import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { themeCss } from '../../../../system/theme.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = ['guey', 'entry-terminal', 'imperfect']
  .map(name => read(`../public/css/${name}.css`)).join('\n');
test('face alpha and opaque text', async () => {
  const browser = await launchChromium({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    const theme = themeCss({ background: '#223344', panel: '#112233', foreground: '#eeeeee', accent: '#abcdef' });
    await page.setContent(`<style>${css}\n${theme}\n:root { --theme-bar-bg: #345678; }</style>
      <body class="imperfect guey-tui">
        <section class="code-face"><figure id="entry-terminal">
          <div class="entry-screen"><div id="entry-dialog"><p class="entry-line">Text</p></div></div>
          <div id="entry-input-zone"><textarea>Input</textarea></div><div class="entry-status">Status</div>
        </figure></section>
      </body>`);
    const background = selector => page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor);
    {
      assert.equal(await background('.code-face'), 'rgb(52, 86, 120)', 'imperfect backing remains solid, including on blur');
      assert.equal(await background('#entry-terminal'), 'rgb(52, 86, 120)', 'opaque terminal is not faded a second time');
      for (const selector of ['.entry-line', 'textarea', '.entry-status']) {
        assert.deepEqual(await page.locator(selector).evaluate(el => {
          const opacities = [];
          for (; el; el = el.parentElement) opacities.push(getComputedStyle(el).opacity);
          return [...new Set(opacities)];
        }), ['1'], `${selector} and ancestors retain full element opacity`);
      }
    }
    await page.evaluate(() => document.documentElement.style.setProperty('--theme-bar-bg', '#654321'));
    for (const selector of ['.code-face', '#entry-terminal']) {
      assert.equal(await background(selector), 'rgb(101, 67, 33)', 'focused surfaces follow live bar colour');
    }
  } finally { await browser.close(); }
});
