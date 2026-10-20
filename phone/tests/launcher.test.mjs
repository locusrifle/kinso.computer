import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rgbaOf } from './png.mjs';

const res = path => new URL(`../app/src/main/res/${path}`, import.meta.url);
const densities = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]];

test('J06 foreground and themed alpha mask fit Android\'s adaptive safe circle at every density', async () => {
  for (const [density, scale] of densities) {
    const { width, height, alpha } = rgbaOf(await readFile(res(`mipmap-${density}/ic_launcher_foreground.png`)));
    const mask = rgbaOf(await readFile(res(`mipmap-${density}/ic_launcher_monochrome.png`)));
    assert.deepEqual([width, height], [108 * scale, 108 * scale], density);
    assert.deepEqual([mask.width, mask.height], [width, height]);
    const centre = width / 2, radius = 33 * scale;
    let top = height, bottom = 0, outside = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      assert.equal(mask.alpha(x, y), alpha(x, y), 'monochrome keeps every cutout');
      if (!alpha(x, y)) continue;
      assert.deepEqual(mask.pixel(x, y).slice(0, 3), [255, 255, 255]);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      if (Math.hypot(x + 0.5 - centre, y + 0.5 - centre) > radius) outside++;
    }
    assert.equal(outside, 0, `${density}: nothing outside the safe circle`);
    assert.ok((bottom - top + 1) / scale > 40, `${density}: readable foreground height`);
  }
  for (const shape of ['ic_launcher', 'ic_launcher_round']) {
    for (const version of [26, 33]) {
      const icon = await readFile(res(`mipmap-anydpi-v${version}/${shape}.xml`), 'utf8');
      assert.match(icon, /<foreground android:drawable="@mipmap\/ic_launcher_foreground"/);
      assert.match(icon, /<background android:drawable="@color\/ic_launcher_background"/);
      if (version === 33) assert.match(icon, /<monochrome android:drawable="@mipmap\/ic_launcher_monochrome"/);
      else assert.doesNotMatch(icon, /monochrome/);
    }
  }
  assert.match(await readFile(res('values/ic_launcher_background.xml'), 'utf8'), /<color name="ic_launcher_background">#000000<\/color>/);
});

test('legacy launcher bitmaps have opaque backing and correct density sizes', async () => {
  for (const [density, scale] of densities) for (const shape of ['ic_launcher', 'ic_launcher_round']) {
    const icon = rgbaOf(await readFile(res(`mipmap-${density}/${shape}.png`)));
    assert.deepEqual([icon.width, icon.height], [48 * scale, 48 * scale]);
    for (let y = 0; y < icon.height; y++) for (let x = 0; x < icon.width; x++) assert.equal(icon.alpha(x, y), 255);
  }
  const manifest = await readFile(new URL('../app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher_round"/);
});
