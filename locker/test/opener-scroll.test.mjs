import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pOfPos, posOfP, TOTAL, scrollBlend } from '../../website/opener/scroll.mjs';
import { CONTACT, HOLD } from '../../website/opener/timeline.mjs';

test('equal scroll steps become progressively slower all the way to reachable contact', () => {
  let previous = Infinity;
  for (let i = 0; i < 60; i++) {
    const step = pOfPos(1 + 4.2 * (i + 1) / 60) - pOfPos(1 + 4.2 * i / 60);
    assert.ok(step > 0 && step < previous);
    previous = step;
  }
  assert.equal(posOfP(CONTACT), 5.2, '30% less scroll distance than six viewport heights');
  assert.equal(pOfPos(5.2), CONTACT);
  for (let i = 0; i <= 100; i++) {
    const x = i / 100;
    assert.ok(Math.abs(pOfPos(1 + 4.2 * x) - CONTACT * (1.75 * x - 0.75 * x * x)) < 1e-12, 'the same progressive curve compressed by 30%');
  }
  assert.equal(pOfPos(1 + TOTAL), HOLD);
});

test('follow-through settles in 80% of the original time, independently of frame rate', () => {
  const oldFrameResidual = 0.5;
  assert.equal(1 - scrollBlend(0.8 / 60), oldFrameResidual);
  assert.ok(Math.abs((1 - scrollBlend(1 / 60)) - oldFrameResidual ** 1.25) < 1e-12);
  assert.ok(Math.abs((1 - scrollBlend(1 / 120)) ** 2 - (1 - scrollBlend(1 / 60))) < 1e-12);
  assert.equal(scrollBlend(0), 0);
});

test('scroll and progress mappings are exact inverses including near contact and through the buffer', () => {
  for (let i = 0; i <= 1000; i++) {
    const p = HOLD * i / 1000;
    assert.ok(Math.abs(pOfPos(posOfP(p)) - p) < 1e-12);
  }
  assert.equal(pOfPos(-1), 0);
  assert.equal(posOfP(-1), 1);
});
