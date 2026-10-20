import test from 'node:test';
import assert from 'node:assert/strict';
import { all, none, pick, step } from '../public/js/workbench-selection.js';

const picked = selection => [...selection.picked].sort((a, b) => a - b);

test('a click selects one; Ctrl+click adds or removes one; clicking nothing clears', () => {
  let s = pick(none(), 2);
  assert.deepEqual(picked(s), [2]);
  s = pick(s, 5);
  assert.deepEqual(picked(s), [5], 'a plain click replaces');
  s = pick(s, 1, { toggle: true });
  s = pick(s, 7, { toggle: true });
  assert.deepEqual(picked(s), [1, 5, 7]);
  s = pick(s, 5, { toggle: true });
  assert.deepEqual(picked(s), [1, 7], 'Ctrl+click on a selected item removes it');
  assert.equal(s.anchor, 5, 'and it is where the next Shift range starts');
  assert.deepEqual(picked(pick(s, -1)), []);
});

test('Shift+click selects the range from the last clicked item, either way', () => {
  let s = pick(none(), 3);
  s = pick(s, 6, { range: true });
  assert.deepEqual(picked(s), [3, 4, 5, 6]);
  s = pick(s, 1, { range: true });
  assert.deepEqual(picked(s), [1, 2, 3], 'the range is from the anchor, not the last end');
  s = pick(s, 8, { toggle: true });
  s = pick(s, 10, { range: true });
  assert.deepEqual(picked(s), [8, 9, 10], 'Ctrl+click moves the anchor');
  s = pick(pick(none(), 0), 2, { toggle: true });
  s = pick(s, 4, { range: true, toggle: true });
  assert.deepEqual(picked(s), [0, 2, 3, 4], 'Ctrl+Shift adds the range to what is there');
  assert.deepEqual(picked(pick(none(), 4, { range: true })), [4], 'with nothing clicked yet, Shift+click is a click');
});

test('arrows move the cursor; Shift+arrows grow and shrink the range; Ctrl+A selects all', () => {
  let s = step(none(), 1, 10);
  assert.deepEqual(picked(s), [0], 'the first arrow selects the first item');
  s = step(s, 1, 10, { range: true });
  s = step(s, 1, 10, { range: true });
  assert.deepEqual(picked(s), [0, 1, 2]);
  s = step(s, -1, 10, { range: true });
  assert.deepEqual(picked(s), [0, 1], 'Shift+arrow back shrinks it');
  s = step(s, 4, 10, { range: true });
  assert.deepEqual(picked(s), [0, 1, 2, 3, 4, 5], 'a row down in the grid');
  s = step(s, 99, 10, { range: true });
  assert.equal(s.cursor, 9, 'held at the last item');
  s = step(s, -1, 10);
  assert.deepEqual(picked(s), [8], 'a plain arrow is one item again');
  s = all(s, 10);
  assert.equal(s.picked.size, 10);
  assert.equal(s.cursor, 8);
  assert.deepEqual(picked(all(none(), 0)), []);
  assert.deepEqual(step(none(), 1, 0), none(), 'an empty folder has nothing to select');
});
