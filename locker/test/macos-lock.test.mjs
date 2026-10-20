import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clockText, shakeAt } from '../../website/macos/lock.mjs';
import { geniePoint, stripMatrix } from '../../website/macos/genie.mjs';
import { MACOS, MEASUREMENTS, ease } from '../../website/macos/timings.mjs';
const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');

test('the local lock clock follows locale hour cycle, omits day period, and never includes a year', () => {
  const date = new Date(2026, 9, 19, 17, 4);
  assert.deepEqual(clockText(date, 'en-AU'), { date: 'Monday 19 October', time: '5:04' });
  assert.deepEqual(clockText(date, 'en-US'), { date: 'Monday, October 19', time: '5:04' });
  assert.equal(clockText(date, 'de-DE').time, '17:04');
  assert.equal(clockText(new Date(2026, 9, 19, 0, 1), 'en-US').time, '12:01');
  assert.equal(clockText(new Date(2026, 9, 19, 0, 1), 'en-GB').time, '0:01');
  assert.doesNotMatch(clockText(date, 'ar-EG').time, /[صم]/);
  assert.doesNotMatch(clockText(date, 'ja-JP').date, /2026/);
});
test('the refusal shakes around the field, settles exactly, and Reduce Motion removes displacement', () => {
  assert.equal(shakeAt(0), 0); assert.equal(Math.abs(shakeAt(MACOS.wrongMs)), 0);
  const x = Array.from({ length: 120 }, (_, i) => shakeAt(i / 119 * MACOS.wrongMs));
  assert.ok(Math.min(...x) < -5 && Math.max(...x) > 5);
  assert.ok(Math.max(...x.map(Math.abs)) <= MACOS.wrongTravel);
  for (const ms of [0, 30, 100, MACOS.wrongMs, 1000]) assert.equal(shakeAt(ms, true), 0);
});
test('the genie meets both rectangles exactly and its mesh never folds or produces nonfinite coordinates', () => {
  for (const from of [{ x: 160, y: 25, width: 1280, height: 796 }, { x: 240, y: 90, width: 1120, height: 630 }]) {
    for (const tile of [{ x: 1110, y: 838, width: 58, height: 36 }, { x: 550, y: 844, width: 48, height: 30 }]) {
      for (const u of [0, .5, 1]) for (const v of [0, .5, 1]) {
        assert.deepEqual(geniePoint(from, tile, u, v, 0), { x: from.x + from.width * u, y: from.y + from.height * v });
        assert.deepEqual(geniePoint(from, tile, u, v, 1), { x: tile.x + tile.width * u, y: tile.y + tile.height * v });
      }
      for (let t = 0; t <= 1; t += 1 / 60) {
        let y = -Infinity;
        for (let row = 0; row <= MACOS.genieSlices; row++) {
          const a = geniePoint(from, tile, 0, row / MACOS.genieSlices, t), b = geniePoint(from, tile, 1, row / MACOS.genieSlices, t);
          assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y) && a.y >= y && b.x > a.x); y = a.y;
        }
      }
      const a = geniePoint(from, tile, 0, .1, .3), b = geniePoint(from, tile, 0, .5, .3), centre = geniePoint(from, tile, 0, .3, .3);
      assert.ok(Math.abs(centre.x - (a.x + b.x) / 2) > .1, 'the sides curve; this is not an affine scale');
    }
  }
});
test('calibration records a source or admits an estimate for every value; easing has fixed endpoints', () => {
  for (const [key, [value, source]] of Object.entries(MEASUREMENTS)) { assert.ok(Number.isFinite(value), key); assert.ok(source.length > 20, key); }
  assert.equal(ease(0), 0); assert.equal(ease(1), 1); assert.ok(Math.abs(ease(.5) - .5) < 1e-6);
});
test('a projective strip maps all four corners without gaps between unequal row widths', () => {
  const points = [{ x: 10, y: 20 }, { x: 810, y: 20 }, { x: 50, y: 30 }, { x: 780, y: 30 }];
  const m = stripMatrix(...points, 800, 10);
  for (const [i, [x, y]] of [[0, 0], [800, 0], [0, 10], [800, 10]].entries()) {
    const w = m[3] * x + m[7] * y + m[15];
    assert.ok(Math.abs((m[0] * x + m[4] * y + m[12]) / w - points[i].x) < 1e-8);
    assert.ok(Math.abs((m[1] * x + m[5] * y + m[13]) / w - points[i].y) < 1e-8);
  }
});
test('native presentation remains count-only, and the keeper and authentication helpers are untouched', async () => {
  const lock = await read('desktop/lock/lock.mjs'), html = await read('desktop/lock/index.html');
  assert.doesNotMatch(html, /<(?:input|textarea)\b|contenteditable/i);
  assert.doesNotMatch(lock, /input\.value|addEventListener\(['"]key(?:down|up|press)['"]/i);
  assert.match(lock, /native: true/); assert.match(lock, /window\.lock =/);
  for (const word of ['ready', 'touch', 'box', 'idle', 'done']) assert.match(lock + await read('website/boot/sequence.mjs'), new RegExp(`['"]${word}['"]`));
  assert.match(await read('website/macos/genie.mjs'), /media\.localName === 'iframe'/);
  assert.match(await read('website/macos/genie.mjs'), /media\.replaceWith\(surrogate\)/);
});
