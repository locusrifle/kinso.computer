import test from 'node:test';
import assert from 'node:assert/strict';
import { initialLayout, LAYOUT_CHOICE, LAYOUTS } from '../public/js/layout-choice.js';

test('choices use a new key so an older saved layout cannot override focus', () => {
  assert.equal(LAYOUT_CHOICE, 'imperfect.layout-choice.v2');
  const stored = new Map([['imperfect.layout-choice', 'dwindle']]);
  assert.equal(initialLayout(stored.get(LAYOUT_CHOICE), null, true), 'focus');
});
test('browser reloads saved before browser focus default to focus, not their automatic old layout', () => {
  for (const old of [null, 'scrolling', 'dwindle', 'focus', 'invalid']) assert.equal(initialLayout(null, old), 'focus');
});
test('explicit new choices persist; native reloads may restore a version-checked layout', () => {
  for (const choice of LAYOUTS) {
    assert.equal(initialLayout(choice, 'focus'), choice);
    assert.equal(initialLayout(null, choice, true), choice);
  }
  assert.equal(initialLayout('invalid', 'scrolling'), 'focus');
  assert.equal(initialLayout('dwindle', 'scrolling', true), 'dwindle');
});
