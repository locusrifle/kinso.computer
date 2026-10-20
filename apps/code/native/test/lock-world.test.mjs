import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = path => readFileSync(new URL('../../../../' + path, import.meta.url), 'utf8');
const src = read('desktop/lock/lock.mjs'), sequence = read('website/boot/sequence.mjs');
const html = read('desktop/lock/index.html');
test('both hosts import one boot, with centred touch, sound ripples, wallpaper portal and clean-cut marks', () => {
  assert.match(src, /import \{ createSequence \} from '\.\.\/\.\.\/website\/boot\/sequence\.mjs(?:\?v=[^']+)?'/);
  assert.match(read('website/intro/intro.mjs'), /import \{ createSequence \} from '\.\.\/boot\/sequence\.mjs(?:\?v=[^']+)?'/);
  assert.match(sequence, /frameOf\(vw, vh, box, \{ centred: true \}\)/);
  assert.match(sequence, /motion: soundMotion/);
  assert.match(sequence, /macos-wallpaper/);
  assert.match(sequence, /markState = m.on && marksOn \? m/);
  assert.match(sequence, /if \(tau < WORD\.gone\) return/);
  assert.doesNotMatch(sequence, /createScene|createAir|stars|galaxy|warpOf/);
  assert.equal((html.match(/<canvas\b/g)||[]).length, 2);
  for (const id of ['glow','rimPath','goat']) assert.ok(html.includes(`id="${id}"`));
  assert.doesNotMatch(html, /feGaussianBlur/);
  assert.match(src, /mountLock\(\{ screen: box, native: true/);
});
test('the world remains a count-only native keeper presentation, never a password input', () => {
  assert.doesNotMatch(html, /<(?:input|textarea)\b|contenteditable/i);
  assert.doesNotMatch(src + sequence, /addEventListener\(['"](?:keydown|keypress|keyup)['"]/);
  assert.match(src, /key\(count = S\.typed \+ 1\)/);
  assert.match(src, /tell\('idle'\)/); assert.match(src, /tell\('done'\)/);
  assert.match(src, /if \(S\.yes &&/);
  assert.match(src, /messageHandlers\?\.imperfect/);
});
