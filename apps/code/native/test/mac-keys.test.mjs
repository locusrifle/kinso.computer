// On a Mac imperfect's window keys are held with Option; Cmd is the Mac's own
// (desktop/electron/keys.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deskModifier, modifierKey, windowKey } from '../../../../desktop/electron/keys.mjs';

const down = (code, more = {}) => ({ type: 'keyDown', code, key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code, alt: false, control: false, meta: false, shift: false, ...more });

test('a Mac\'s window is held with Option; anywhere else with Super', () => {
  assert.equal(deskModifier('darwin'), 'alt');
  assert.equal(deskModifier('linux'), 'meta');
});

test('Option is the window\'s key on a Mac, and Cmd stays the Mac\'s', () => {
  const mac = { alias: true, mod: 'alt' };
  assert.equal(windowKey(down('KeyW', { alt: true }), mac), 'close');
  assert.equal(windowKey(down('ArrowRight', { alt: true, shift: true }), mac), 'along');
  assert.equal(windowKey(down('Digit2', { alt: true }), mac), 'session2');
  // Cmd+W, Cmd+V, Cmd+Left are the Mac's: closing, pasting, the line's start.
  for (const code of ['KeyW', 'KeyV', 'ArrowLeft', 'KeyF']) assert.equal(windowKey(down(code, { meta: true }), mac), '');
  assert.equal(windowKey(down('KeyW', { alt: true, meta: true }), mac), '');
  assert.equal(modifierKey({ type: 'keyDown', code: 'AltLeft', key: 'Alt' }, mac), 'hold');
  assert.equal(modifierKey({ type: 'keyUp', code: 'AltRight', key: 'Alt' }, mac), 'release');
  assert.equal(modifierKey({ type: 'keyDown', code: 'MetaLeft', key: 'Meta' }, mac), '');
});

test('Linux keeps Super, with Alt only where it is the alias', () => {
  assert.equal(windowKey(down('KeyW', { meta: true })), 'close');
  assert.equal(windowKey(down('KeyW', { alt: true }), { alias: false }), '');
  assert.equal(modifierKey({ type: 'keyDown', code: 'MetaLeft', key: 'Meta' }), 'hold');
});
