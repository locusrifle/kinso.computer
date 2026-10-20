import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { launchChromium } from '../../../../tools/test-browser.mjs';

test('the native page and website use the same icon and PWA files, not generated copies', async () => {
  for (const name of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png', 'manifest.webmanifest']) {
    assert.equal(await realpath(new URL('../public/' + name, import.meta.url)), await realpath(new URL('../../../../website/' + name, import.meta.url)), name);
  }
});

// An isolated SVG fixture, never a person's browser profile or running app.
test('J06 SVG favicon switches ink with system scheme and has no opaque background', async t => {
  const svg = await readFile(new URL('../public/favicon.svg', import.meta.url));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    res.end(svg);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await launchChromium({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ colorScheme: 'light' });
  await page.goto(`http://127.0.0.1:${server.address().port}/favicon.svg`);
  const inks = () => page.evaluate(() => Object.fromEntries(['fur', 'horns'].map(name => [name, getComputedStyle(document.querySelector('.' + name)).fill])));
  assert.deepEqual(await inks(), { fur: 'rgb(17, 17, 17)', horns: 'rgb(43, 43, 43)' });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.deepEqual(await inks(), { fur: 'rgb(255, 255, 255)', horns: 'rgb(212, 212, 212)' });
  await page.emulateMedia({ colorScheme: 'light' });
  assert.deepEqual(await inks(), { fur: 'rgb(17, 17, 17)', horns: 'rgb(43, 43, 43)' });
  assert.deepEqual(await page.evaluate(() => ({ paths: document.querySelectorAll('path').length, backdrop: document.querySelectorAll('rect,image').length, background: getComputedStyle(document.documentElement).backgroundColor })), { paths: 2, backdrop: 0, background: 'rgba(0, 0, 0, 0)' });
});
