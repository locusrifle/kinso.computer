import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { launchChromium } from '../../../../tools/test-browser.mjs';
import { themeCss } from '../../../../system/theme.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = ['guey', 'entry-terminal', 'imperfect'].map(name => read(`../public/css/${name}.css`)).join('\n');
for (const phone of [false, true]) test(`surface palette, separators and the folded dock (${phone ? 'phone' : 'desktop'})`, async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: phone ? 390 : 1440, height: 900 }, isMobile: phone, hasTouch: phone });
    const theme = themeCss({ background: '#223344', panel: '#112233', foreground: '#eeeeee', accent: '#abcdef' });
    const html = `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${theme}\n:root { --theme-bar-bg: #345678; }</style><body class="imperfect guey-tui"><section><figure id="entry-terminal"><div class="entry-screen"><pre class="transcript-code">code</pre><section id="entry-dialog" class="writing"></section></div><div id="entry-input-zone"></div><div class="entry-status"><div class="entry-status-line"><span class="entry-status-left">model</span><span class="entry-status-right"><span class="session-actions"></span></span></div></div></figure></section></body>`;
    // Chromium 152 can lose touch emulation on the initial about:blank document:
    // setContent then reports a fine pointer and maxTouchPoints=0 indefinitely.
    // Navigate like the real app instead of polling for a CSS width to change.
    await page.route('http://surface.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://surface.test/');
    assert.deepEqual(await page.evaluate(() => ({
      coarse: matchMedia('(pointer: coarse)').matches, touch: navigator.maxTouchPoints > 0,
    })), { coarse: phone, touch: phone }, 'browser input capabilities match the fixture');
    await page.addScriptTag({ content: `
      const button = (className, text = '') => Object.assign(document.createElement('button'), { className, textContent: text });
      document.querySelector('.session-actions').append(button('entry-voice'), Object.assign(document.createElement('span'), { textContent: '+' }));` });
    assert.equal(await page.locator('#entry-terminal').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(52, 86, 120)');
    for (const selector of ['#entry-terminal', '#entry-input-zone', '.entry-status']) {
      assert.deepEqual(await page.locator(selector).evaluate(el => [getComputedStyle(el).borderTopWidth, getComputedStyle(el).borderBottomWidth]), [selector === '.entry-status' ? '1px' : '0px', '0px']);
    }
    const separator = await page.locator('#entry-input-zone').evaluate(el => {
      const style = getComputedStyle(el, '::before');
      return {
        content: style.content, border: style.borderTopWidth, color: style.borderTopColor,
        column: style.gridColumn, row: style.gridRow, align: style.alignSelf,
        pointerEvents: style.pointerEvents, width: parseFloat(style.width),
        zoneWidth: el.getBoundingClientRect().width,
      };
    });
    assert.equal(separator.content, 'none', 'no divider between the two composer rows');
    const sharedRule = await page.locator('.entry-status').evaluate(el => ({ color: getComputedStyle(el).borderTopColor, width: el.getBoundingClientRect().width }));
    assert.equal(sharedRule.color, 'rgb(171, 205, 239)');
    assert.ok(Math.abs(sharedRule.width - separator.zoneWidth) < 1, 'one divider spans the whole composer');
    const button = page.locator('.entry-voice');
    assert.equal(await button.isVisible(), true, 'every control in the input bar shows, with nothing to unfold');
    if (phone) {
      assert.equal(await button.evaluate(el => el.getBoundingClientRect().width), 34);
    }
    await page.evaluate(() => document.documentElement.style.setProperty('--theme-bar-bg', '#654321'));
    assert.equal(await page.locator('#entry-terminal').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(101, 67, 33)');

    // Workbench is imperfect's panel, on the same ground as imperfect's window.
    await page.setContent(`<style>${theme}\n${read('../public/css/workbench.css')}\n:root { --theme-bar-bg: #345678; }</style><body><section class="workbench">files</section></body>`);
    assert.equal(await page.locator('.workbench').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(52, 86, 120)');
    await page.evaluate(() => document.documentElement.style.setProperty('--theme-bar-bg', '#654321'));
    assert.equal(await page.locator('.workbench').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(101, 67, 33)');
  } finally { await browser.close(); }
});
