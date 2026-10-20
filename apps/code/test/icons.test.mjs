import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGueyServer } from '../../../system/server.mjs';
import { rgbaOf } from '../../../phone/tests/png.mjs';

const file = path => readFile(new URL(`../../../${path}`, import.meta.url));
const destinations = ['apps/code/native/public', 'locker/public/store', 'website'];

test('the master is the exact transparent J06; the old artwork generator cannot overwrite app icons', async () => {
  const png = await file('tools/assets/goat-head/goat-head.png');
  assert.equal(createHash('sha256').update(png).digest('hex'), '2d831ff1d4ac0dd2b80538321de11eca7063eb686313ae616fe88cf798e452b7');
  const master = rgbaOf(png);
  assert.deepEqual([master.width, master.height], [1024, 1024]);
  assert.equal(master.alpha(0, 0), 0);
  let transparent = 0, visible = 0;
  for (let y = 0; y < master.height; y++) for (let x = 0; x < master.width; x++) {
    if (master.alpha(x, y)) visible++; else transparent++;
  }
  assert.ok(visible > 100000 && transparent > 100000, 'ink and cutouts survive');
  const old = (await file('tools/goat.mjs')).toString();
  assert.doesNotMatch(old, /out\([^\n]*(?:favicon|apple-touch|ic_launcher|\/goat\.png)/);
});

test('all web surfaces share adaptive SVG, ICO fallback, PWA and apple icons with safe bounds', async () => {
  const svg = await file('tools/assets/goat-head/favicon.svg');
  assert.match(svg.toString(), /prefers-color-scheme:dark/);
  assert.doesNotMatch(svg.toString(), /<(?:rect|image|script)\b/);
  for (const root of destinations) {
    assert.deepEqual(await file(`${root}/favicon.svg`), svg);
    const ico = await file(`${root}/favicon.ico`);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 3);
    assert.deepEqual([ico[6], ico[22], ico[38]], [16, 32, 48]);
    const manifest = JSON.parse(await file(`${root}/manifest.webmanifest`));
    assert.equal(manifest.start_url, '/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.deepEqual(manifest.icons.map(i => [i.sizes, i.purpose]), [['192x192', 'any'], ['192x192', 'maskable'], ['512x512', 'any'], ['512x512', 'maskable']]);
    for (const { src, sizes, purpose, type } of manifest.icons) {
      assert.equal(type, 'image/png');
      const image = rgbaOf(await file(root + src));
      const size = Number(sizes.split('x')[0]);
      assert.deepEqual([image.width, image.height], [size, size]);
      let ink = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const [r, g, b, a] = image.pixel(x, y);
        assert.equal(a, 255, 'neutral backing, never accidental transparency');
        if (r + g + b === 0) continue;
        ink++;
        if (purpose === 'maskable') assert.ok(Math.hypot(x + .5 - size / 2, y + .5 - size / 2) <= size * .4, 'all ink in guaranteed maskable circle');
      }
      assert.ok(ink > size * size * .05, 'readable ink area');
    }
    const apple = rgbaOf(await file(`${root}/apple-touch-icon.png`));
    assert.deepEqual([apple.width, apple.height], [180, 180]);
    assert.deepEqual(apple.pixel(0, 0), [0, 0, 0, 255]);
  }
  for (const path of ['apps/code/native/public/index.html', 'website/index.html', 'website/host.html', 'website/rent.html', 'locker/public/store/buy.html', 'locker/public/store/thanks.html']) {
    const html = (await file(path)).toString();
    for (const name of ['favicon.svg', 'favicon.ico', 'manifest.webmanifest', 'apple-touch-icon.png']) assert.ok(html.includes(`href="/${name}"`), `${path}: ${name}`);
  }
});

test('the actual app server serves the manifest and icons with correct MIME and favicon CSS policy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'imperfect-icon-server-'));
  const runtime = { events: new EventEmitter(), snapshot: () => ({ sessionId: 'icons', cwd: root, messages: [] }), command: async () => ({}), close: async () => {} };
  const app = await createGueyServer({ port: 0, stateDir: root, runtime });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const { port } = await app.listen();
  const origin = `http://127.0.0.1:${port}`;
  for (const [path, type] of [['/favicon.svg', 'image/svg+xml'], ['/favicon.ico', 'image/x-icon'], ['/manifest.webmanifest', 'application/manifest+json'], ['/icon-192.png', 'image/png'], ['/icon-512.png', 'image/png'], ['/icon-maskable-512.png', 'image/png'], ['/apple-touch-icon.png', 'image/png']]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), type, path);
    if (path === '/favicon.svg') assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await file('apps/code/native/public' + path));
  }
});
