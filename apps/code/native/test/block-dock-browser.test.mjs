import test from 'node:test';
import assert from 'node:assert/strict';
import { harnessFixture, PNG } from './fixtures/harness-page.mjs';
import { readFile } from 'node:fs/promises';
import { themeCss } from '../../../../system/theme.mjs';
import { launchChromium } from '../../../../tools/test-browser.mjs';

const originalPlus = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z" fill="currentColor"/></svg>';
const paths = {
  // The dictation icon is a waveform (speaking), stroked rather than filled.
  mic: 'M3 8.5v3M6.5 6v8M10 3v14M13.5 6v8M17 8.5v3',
  attach: 'M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z',
};
test('Paseo CircleGauge and the waveform mic keep labels, boxes, usage and original attachment glyph', async () => {
  const f = await harnessFixture({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }] });
  try {
    const p = f.page;
    await p.waitForTimeout(450); // Let the whole-window entrance settle.
    for (const [kind, selector] of Object.entries({ usage: '.entry-usage', mic: '.entry-voice:not(.entry-usage)', attach: '#entry-plus' })) {
      const n = p.locator(selector);
      if (kind !== 'usage') {
        assert.equal(await n.locator('svg path').getAttribute('d'), paths[kind]);
        if (kind === 'mic') assert.equal(await n.locator('svg').getAttribute('stroke'), 'currentColor');
        else assert.equal(await n.locator('svg path').getAttribute('fill'), 'currentColor');
      }
      const size = kind === 'attach' ? 11.2 : 14;
      const rendered = await n.locator('svg').evaluate(n => [n.getBoundingClientRect().width, n.getBoundingClientRect().height]);
      assert.ok(rendered.every(value => Math.abs(value - size) < 0.02), `70% glyph size: ${rendered}`);
      assert.deepEqual(await n.evaluate(n => [n.offsetWidth, n.offsetHeight]), [34, 34]);
    }
    for (const path of ['index.html', 'js/harness.js']) {
      assert.ok((await readFile(new URL(`../public/${path}`, import.meta.url), 'utf8')).includes(originalPlus), `${path}: exact original plus source`);
    }
    const originalPlusDOM = await p.evaluate(svg => {
      const span = document.createElement('span'); span.innerHTML = svg; return span.firstChild.outerHTML;
    }, originalPlus);
    assert.equal(await p.locator('#entry-plus svg').evaluate(n => n.outerHTML), originalPlusDOM);
    // Exact Lucide 1.50.0 circle-gauge.svg, not a hand-drawn approximation.
    const gauge = p.locator('.entry-usage svg');
    assert.deepEqual(await gauge.evaluate(n => ({
      attrs: ['viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'aria-hidden', 'focusable'].map(a => n.getAttribute(a)),
      children: [...n.children].map(c => [c.tagName, [...c.attributes].map(a => [a.name, a.value])]),
    })), {
      attrs: ['0 0 24 24', 'none', 'currentColor', '2', 'round', 'round', 'true', 'false'],
      children: [
        ['path', [['d', 'M15.6 2.7a10 10 0 1 0 5.7 5.7']]],
        ['circle', [['cx', '12'], ['cy', '12'], ['r', '2']]],
        ['path', [['d', 'M13.4 10.6 19 5']]],
      ],
    });
    assert.equal(await gauge.evaluate(n => n.getAnimations({ subtree: true }).length), 0);
    assert.equal(await p.locator('.entry-voice:not(.entry-usage)').getAttribute('aria-label'), 'Speak a prompt');
    assert.equal(await p.locator('#entry-plus').getAttribute('for'), 'entry-files');
    await p.getByRole('button', { name: 'Usage', exact: true }).click();
    assert.equal(await p.getByRole('button', { name: 'Usage', exact: true }).getAttribute('aria-expanded'), 'true');
    await p.getByRole('button', { name: 'Usage', exact: true }).click();
    await p.locator('#entry-files').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
    await p.waitForFunction(() => document.querySelector('#entry-plus').classList.contains('has-files'));
    assert.equal(await p.locator('#entry-plus span').innerText(), '1');
    assert.equal(await p.locator('#entry-plus').getAttribute('aria-label'), 'pixel.png');
    assert.equal(await p.locator('#entry-plus svg').count(), 0);
    // Pending chips are intentionally hidden; invoke the existing removal handler.
    await p.locator('#entry-pending button[aria-label="remove pixel.png"]').dispatchEvent('click');
    assert.equal(await p.locator('#entry-plus svg').evaluate(n => n.outerHTML), originalPlusDOM, 'removing files restores the exact original SVG');
    assert.equal(await p.locator('#entry-plus').getAttribute('aria-label'), 'attach');
    const before = await p.locator('.entry-voice:not(.entry-usage) svg').evaluate(n => n.outerHTML);
    f.push({ ...f.tab, busy: true });
    await p.waitForTimeout(80);
    assert.equal(await p.locator('.entry-voice:not(.entry-usage) svg').evaluate(n => n.outerHTML), before);
    const mic = p.locator('.entry-voice:not(.entry-usage)');
    await mic.evaluate(n => { n.dataset.state = 'hearing'; });
    assert.equal(await mic.evaluate(n => getComputedStyle(n).animationName), 'entry-voice-pulse');
    await p.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await mic.evaluate(n => getComputedStyle(n).animationName), 'none');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('dock glyphs and gaps stay at 70% across screen sizes and DPRs, with touch targets intact', { timeout: 120000 }, async () => {
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const deviceScaleFactor of [1, 1.5, 2, 3]) for (const width of [320, 390, 768, 1200, 2560]) {
      const f = await harnessFixture({
        browser: { newPage: options => browser.newPage({ ...options, deviceScaleFactor }) },
        viewport: { width, height: 900 }, hasTouch: width <= 768,
        messages: [{ role: 'assistant', content: 'Ready.' }],
      });
      try {
        const geometry = await f.page.locator('.session-actions').evaluate(dock => ({
          dpr: devicePixelRatio, gap: parseFloat(getComputedStyle(dock).gap),
          controls: [...dock.querySelectorAll('button, label')].map(control => {
            const box = control.getBoundingClientRect(), svg = control.querySelector('svg'), icon = svg.getBoundingClientRect();
            return { target: [box.width, box.height], size: [icon.width, icon.height], attach: control.id === 'entry-plus', vector: svg.namespaceURI === 'http://www.w3.org/2000/svg', x: box.x, right: box.right };
          }),
        }));
        assert.equal(geometry.dpr, deviceScaleFactor);
        assert.equal(geometry.gap, 4.2);
        assert.equal(geometry.controls.length, 4);
        for (const control of geometry.controls) {
          assert.deepEqual(control.target, [34, 34], 'hit areas stay above 32px, including on touch');
          assert.ok(control.x >= 0 && control.right <= width, 'each target fits the viewport');
          assert.ok(control.vector, 'SVG stays resolution-independent');
          const size = control.attach ? 11.2 : 14;
          assert.ok(control.size.every(value => Math.abs(value - size) < 0.02), `${width}px @${deviceScaleFactor}: ${control.size}`);
        }
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  } finally { await browser.close(); }
});

test('the mic retains recording, sending, retry and escape states', async () => {
  const f = await harnessFixture({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }] });
  try {
    const result = await f.page.evaluate(async () => {
      const original = globalThis.MediaRecorder;
      const getUserMedia = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
      globalThis.MediaRecorder = class {
        static isTypeSupported() { return true; }
        start() {}
        stop() { this.ondataavailable({ data: new Blob(['audio'], { type: 'audio/webm' }) }); this.onstop(); }
      };
      try {
        const { mountVoice } = await import('/js/voice.js');
        let reject;
        const mic = mountVoice({ input: document.querySelector('#entry-input'), send: () => new Promise((_, no) => { reject = no; }) });
        document.querySelector('.session-actions').append(mic.button);
        const states = [], glyph = mic.button.querySelector('svg').outerHTML;
        const idleWidth = mic.button.offsetWidth;
        mic.button.click(); await new Promise(r => setTimeout(r)); states.push(mic.button.dataset.state);
        const clock = mic.button.querySelector('.entry-voice-clock').textContent;
        const wider = mic.button.offsetWidth > idleWidth;
        const label = mic.button.getAttribute('aria-label');
        mic.button.click(); states.push(mic.button.dataset.state);
        reject(new Error('test')); await new Promise(r => setTimeout(r)); states.push(mic.button.dataset.state);
        dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); states.push(mic.button.dataset.state);
        const unchanged = glyph === mic.button.querySelector('svg').outerHTML;
        const clearedClock = mic.button.querySelector('.entry-voice-clock').textContent;
        mic.button.remove(); return { states, unchanged, clock, wider, label, clearedClock };
      } finally { globalThis.MediaRecorder = original; navigator.mediaDevices.getUserMedia = getUserMedia; }
    });
    assert.deepEqual(result, { states: ['recording', 'hearing', 'kept', 'idle'], unchanged: true, clock: '0:00', wider: true,
      label: 'Stop and send (Esc cancels)', clearedClock: '' });
  } finally { await f.close(); }
});

for (const theme of ['black', 'light-chalk']) test(`recording clock and all four controls fit a 320px composer: ${theme}`, async () => {
  const palette = JSON.parse(await readFile(new URL(`./fixtures/themes/${theme}.json`, import.meta.url), 'utf8'));
  const f = await harnessFixture({ themeCSS: themeCss(palette), viewport: { width: 320, height: 844 },
    messages: [{ role: 'assistant', content: 'Ready.' }] });
  try {
    const p = f.page, mic = p.locator('.entry-voice[data-state]');
    await p.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
      globalThis.MediaRecorder = class {
        static isTypeSupported() { return true; }
        start() {}
        stop() { this.ondataavailable({ data: new Blob(['audio'], { type: 'audio/webm' }) }); this.onstop(); }
      };
    });
    await p.locator('#entry-input').fill('keep this draft');
    await mic.focus(); await p.keyboard.press('Enter');
    await p.waitForFunction(() => document.querySelector('.entry-voice[data-state]').dataset.state === 'recording');
    assert.equal(await mic.locator('.entry-voice-clock').innerText(), '0:00');
    assert.equal(await mic.getAttribute('aria-label'), 'Stop and send (Esc cancels)');
    assert.equal(await mic.evaluate(n => getComputedStyle(n).color), await p.evaluate(() => getComputedStyle(document.body).getPropertyValue('--theme-bright').trim()).then(hex => {
      const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16)); return `rgb(${rgb.join(', ')})`;
    }));
    for (const selector of ['.entry-usage', '.entry-browser', '.entry-voice[data-state]', '#entry-plus']) {
      const bounds = await p.locator(selector).boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320, `${selector} stays inside recording composer`);
      assert.equal(bounds.height, 34);
    }
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => document.querySelector('.entry-voice[data-state]').dataset.state === 'idle');
    assert.equal(await mic.locator('.entry-voice-clock').textContent(), '');
    assert.equal(await p.locator('#entry-input').inputValue(), 'keep this draft');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
