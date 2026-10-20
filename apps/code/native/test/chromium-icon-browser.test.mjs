import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { themeCss } from '../../../../system/theme.mjs';
import { harnessFixture } from './fixtures/harness-page.mjs';

// Rasterise the actual mark with its computed colour. Transparent seams must
// reveal the composer's background, not paint an assumed black/white surface.
async function pixels(icon) {
  return icon.evaluate(async n => {
    const svg = n.cloneNode(true);
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    // Sample the mark's original coordinate grid independently of dock size.
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
    svg.style.color = getComputedStyle(n).color;
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${btoa(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 24;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(0, 0, 24, 24).data];
  });
}
const at = (pixels, x, y) => pixels.slice((y * 24 + x) * 4, (y * 24 + x + 1) * 4);
const rgba = hex => [...hex.slice(1).match(/../g).map(n => parseInt(n, 16)), 255];

async function shots(page, button, name) {
  if (!process.env.CHROMIUM_SHOTS) return;
  await mkdir(process.env.CHROMIUM_SHOTS, { recursive: true });
  await page.screenshot({ path: `${process.env.CHROMIUM_SHOTS}/${name}.png`, fullPage: true });
  await button.screenshot({ path: `${process.env.CHROMIUM_SHOTS}/${name}-icon.png` });
}

test('composer icon set inherits every built-in and custom accent on live theme swaps', { timeout: 120000 }, async () => {
  const dir = new URL('../themes/', import.meta.url);
  const themes = await Promise.all((await readdir(dir)).filter(name => name.endsWith('.json')).sort().map(async name => ({
    id: name.replace(/\.json$/, ''), ...JSON.parse(await readFile(new URL(name, dir), 'utf8')),
  })));
  themes.push({ id: 'custom', background: '#082333', foreground: '#e9faff', accent: '#29d9c8' });
  let css = themeCss(themes[0]);
  const f = await harnessFixture({ site: true, messages: [{ role: 'assistant', content: 'Ready.' }], handleRequest: async (_req, res, path) => {
    if (path !== '/theme.css') return false;
    res.setHeader('Content-Type', 'text/css'); res.end(css); return true;
  } });
  try {
    const p = f.page, icon = p.locator('.entry-chromium'), button = p.locator('.entry-browser');
    await icon.evaluate(n => { window.originalChromium = n; });
    const geometry = await icon.innerHTML();
    for (const theme of themes) {
      css = themeCss(theme);
      f.send({ type: 'look', data: { rev: `chromium-${theme.id}` } });
      await p.waitForFunction(rev => document.querySelector('link#theme-css')?.getAttribute('href') === `/theme.css?r=${rev}`
        && document.querySelectorAll('link#theme-css').length === 1, `chromium-${theme.id}`);
      await p.waitForFunction(accent => {
        const n = document.querySelector('.entry-chromium');
        const rgb = accent.slice(1).match(/../g).map(n => parseInt(n, 16));
        return getComputedStyle(n).color === `rgb(${rgb.join(', ')})`;
      }, theme.accent);
      assert.equal(await icon.evaluate(n => n === window.originalChromium), true, 'restyles the existing mark');
      assert.equal(await icon.innerHTML(), geometry, 'theme changes no geometry');
      const expected = rgba(theme.accent), image = await pixels(icon);
      const colours = await p.locator('.session-actions svg').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).color));
      assert.equal(colours.length, 4);
      assert.ok(colours.every(colour => colour === `rgb(${expected.slice(0, 3).join(', ')})`), `${theme.id}: all four glyphs use theme ink`);
      for (const [x, y] of [[11, 11], [11, 3], [5, 16], [18, 16]]) {
        assert.deepEqual(at(image, x, y), expected, `${theme.id}: centre and all three blades use the accent`);
      }
      const gaugeImage = await pixels(p.locator('.entry-usage svg'));
      for (const [x, y] of [[12, 2], [2, 12], [16, 7], [11, 10]]) {
        const pixel = at(gaugeImage, x, y);
        // Antialiased curve pixels can round by one channel after alpha premultiplication.
        assert.ok(pixel.slice(0, 3).every((v, i) => Math.abs(v - expected[i]) <= 1), `${theme.id}: gauge arc, needle and hub use theme ink`);
        assert.ok(pixel[3] >= 240, `${theme.id}: near-opaque stroke at ${x},${y} (SVG curve antialiasing)`);
      }
      for (const [x, y] of [[0, 0], [8, 8], [18, 3]]) {
        assert.equal(at(gaugeImage, x, y)[3], 0, `${theme.id}: gauge face and arc gap stay transparent`);
      }
      assert.equal(at(image, 8, 8)[3], 0, `${theme.id}: transparent centre ring`);
      assert.equal(at(image, 0, 0)[3], 0, `${theme.id}: no painted background`);
      assert.ok(at(image, 18, 6)[3] < 200, `${theme.id}: open blade seam`);
      assert.equal(await icon.evaluate(n => n.getAnimations({ subtree: true }).length), 0);
      await shots(p, button, `live-${theme.id}-1200`);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const theme of ['black', 'light-chalk']) for (const width of [320, 390, 1200]) {
  test(`static Chromium launcher renders and opens PC browser: ${theme} ${width}`, async () => {
    const palette = JSON.parse(await readFile(new URL(`./fixtures/themes/${theme}.json`, import.meta.url), 'utf8'));
    const paths = [];
    // The dock's browser button is the scrolling layout's (in focus the panel's switch opens the browser).
    const f = await harnessFixture({ desk: true, layout: 'scrolling', machines: [{ id: 'pc', self: true, home: true, reachable: true }], onBrowserLive: (ws, req) => {
      paths.push(req.url);
      ws.on('message', () => ws.send(JSON.stringify({ tabs: [{ tab: 1, front: true, url: 'about:blank' }] })));
    }, themeCSS: themeCss(palette), viewport: { width, height: 900 }, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready' }] }] });
    try {
      const p = f.page;
      const button = p.getByRole('button', { name: 'Open PC browser (Chromium)', exact: true }), icon = button.locator('.entry-chromium');
      assert.equal(await button.getAttribute('title'), 'Browser (Chromium) · PC browser');
      assert.equal(await button.innerText(), '');
      assert.equal(await icon.getAttribute('aria-hidden'), 'true');
      assert.equal(await icon.locator('path').count(), 3);
      assert.equal(await icon.locator('circle').count(), 1);
      assert.equal(await p.locator('.entry-portal, .portal-hole, .portal-veil, .portal-spark').count(), 0);
      assert.deepEqual(await button.evaluate(n => [n.offsetWidth, n.offsetHeight]), [34, 34]);
      assert.deepEqual(await icon.evaluate(n => [n.getBoundingClientRect().width, n.getBoundingClientRect().height]), [14, 14]);
      const box = await button.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, 'button fits even at 320px');
      for (const selector of ['.entry-usage', '.entry-voice[data-state]', '#entry-plus']) {
        const control = p.locator(selector), bounds = await control.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `${selector} fits at ${width}px`);
        assert.deepEqual([bounds.width, bounds.height], [34, 34], 'unchanged hit targets');
        const size = selector === '#entry-plus' ? 11.2 : 14;
        const rendered = await control.locator('svg').evaluate(n => [n.getBoundingClientRect().width, n.getBoundingClientRect().height]);
        assert.ok(rendered.every(value => Math.abs(value - size) < 0.02), `70% glyph size: ${rendered}`);
      }
      assert.equal(await button.evaluate(n => getComputedStyle(n).webkitTapHighlightColor), 'rgba(0, 0, 0, 0)');
      assert.equal(await icon.evaluate(n => getComputedStyle(n).pointerEvents), 'none');
      assert.equal(await icon.evaluate(n => n.getAnimations({ subtree: true }).length), 0, 'no portal motion');
      const before = await pixels(icon);
      await p.waitForTimeout(120);
      assert.deepEqual(await pixels(icon), before, 'normal mode is still');
      await p.emulateMedia({ reducedMotion: 'reduce' });
      assert.deepEqual(await pixels(icon), before, 'reduced motion keeps the same mark');
      await shots(p, button, `${theme}-${width}`);
      await p.locator('#entry-input').fill('keep this draft');
      await button.focus();
      assert.equal(await button.evaluate(n => getComputedStyle(n).outlineStyle), 'solid');
      await p.keyboard.press('Enter');
      await p.locator('.wm-live .browser-tab').waitFor({ state: 'attached' });
      await button.click();
      assert.equal(await p.locator('.wm-live').count(), 1, 'click reuses the PC browser');
      assert.ok(paths.length > 0 && paths.every(path => path === '/browser/live'), 'still watches the home PC');
      assert.equal(await p.locator('webview').count(), 0, 'dock never opens a local webview');
      assert.equal(await p.locator('#entry-input').inputValue(), 'keep this draft');
      await p.keyboard.press('Meta+Shift+B');
      await p.keyboard.press('Alt+Shift+B');
      assert.equal(await p.locator('webview').count(), 1, 'local browser shortcut remains independent');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
