import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shineSilver, metalSilver } from '../../website/wordmark.mjs';
import { BURST, bubbleMotion } from '../../website/bootup.mjs';
import { soundMotion } from '../../website/bubble-sound.mjs';
import { revealAt } from '../../website/reveal.mjs';

const read = path => readFile(new URL('../../website/' + path, import.meta.url), 'utf8');

test('the rim is the wordmark\'s brushed-metal silver (its middle, 0.78 of the ink), opaque, one colour', async () => {
  assert.equal(metalSilver(), 'rgba(199,199,199,1)', 'the website ink is white: #c7c7c7');
  assert.equal(metalSilver('#d4d4d4'), 'rgba(165,165,165,1)', 'themed locks follow their ink');
  assert.equal(shineSilver(), 'rgba(255,255,255,1)', 'the light passing over it is unchanged');
  assert.match(await read('wordmark.mjs'), /g.addColorStop\(0\.5, metalSilver\(ink\)\)/, 'the letters and the rim share one silver');
  assert.match(await read('wordmark.mjs'), /g.addColorStop\(o, shineSilver\(ink, a \* k\)\)/);
  assert.match(await read('boot/sequence.mjs'), /rimPath.style.stroke = metalSilver\(INK\)/);
  const css = await read('boot/sequence.css');
  assert.match(css, /\.rim path \{ fill: none; stroke-width: 3\.5; stroke-opacity: 1; \}/);
  assert.doesNotMatch(css.match(/\.rim path \{[^}]+\}/)[0], /gradient|filter|url\(/);
});

test('one shared half-width rim at rest and on every sound hit, without a legacy or dynamic thickness override', async () => {
  const css = await read('boot/sequence.css');
  const width = Number(css.match(/\.rim path \{[^}]*stroke-width:\s*([\d.]+)/)[1]);
  assert.equal(width, 7 / 2, 'halve the original 7 CSS px');
  for (const path of ['style.css', 'opener/style.css', 'sequence.css']) {
    assert.doesNotMatch(await read(path), /\.rim path\s*\{/, `${path}: no second rim paint/width`);
  }
  assert.doesNotMatch(await read('boot/sequence.mjs'), /strokeWidth|stroke-width/, 'sound deforms the path, never overrides the shared width');
  assert.match(await read('sequence.css'), /@import url\('\.\/boot\/sequence\.css(?:\?[^']+)?'\)/, 'website uses the shared width');
  const lock = await readFile(new URL('../../desktop/lock/index.html', import.meta.url), 'utf8');
  assert.match(lock, /href="boot\/sequence\.css(?:\?[^"]+)?"/, 'native lock uses the same width');
  assert.doesNotMatch(await readFile(new URL('../../desktop/lock/lock.css', import.meta.url), 'utf8'), /stroke-width|strokeWidth/);
});

test('the rim is opaque through growth, sound hits and opening; radius and ripples still follow the recording', () => {
  const view = { at: [512, 320], width: 1024, height: 640, grow: 1.5 };
  for (const motion of [bubbleMotion, soundMotion]) {
    for (let tau = 0; tau < BURST + 0.8; tau += 0.01) {
      const b = revealAt(tau, { ...view, motion }), sound = motion(tau, 0.8);
      assert.equal(b.rim, 1, `${tau}: never multiply the silver by a fade or sound brightness`);
      for (const key of ['radius', 'wt', 'wob', 'fine', 'ripples', 'ex', 'done']) assert.deepEqual(b[key], sound[key], key);
      if (tau < BURST) assert.equal(b.R, b.small * sound.radius);
    }
  }
});
