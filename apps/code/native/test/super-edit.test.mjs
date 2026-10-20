import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { editCommand, installEditing } from '../../../../desktop/electron/edit.mjs';
import { windowKey } from '../../../../desktop/electron/keys.mjs';

const input = (code, more = {}) => ({ type: 'keyDown', code, meta: true, control: false, alt: false, shift: false, ...more });
const commands = { KeyC: 'copy', KeyV: 'paste', KeyX: 'cut', KeyA: 'selectAll', KeyZ: 'undo' };

test('Super editing is exact: Ctrl, Alt, extra Shift, Mac and non-Super MOD are untouched', () => {
  for (const [code, command] of Object.entries(commands)) {
    assert.equal(editCommand(input(code)), command);
    assert.equal(editCommand(input(code, { type: 'keyUp' })), command);
    for (const extra of [{ meta: false }, { control: true }, { alt: true }, { meta: false, control: true }, { meta: false, alt: true }, { type: 'char' }]) {
      assert.equal(editCommand(input(code, extra)), '');
    }
    assert.equal(editCommand(input(code, { shift: true })), code === 'KeyZ' ? 'redo' : '');
    assert.equal(editCommand(input(code), { platform: 'darwin' }), '');
    assert.equal(editCommand(input(code), { mod: 'alt' }), '');
    assert.equal(editCommand(input(code), { mod: 'other' }), '');
  }
  assert.equal(editCommand(input('KeyQ')), '');
});

test('every new WebContents is covered, presses execute once and releases are consumed without DOM delivery', () => {
  const app = new EventEmitter();
  installEditing(app, { platform: 'linux', mod: 'meta' });
  for (const kind of ['host', 'webview', 'popup', 'WebContentsView']) {
    const contents = new EventEmitter(), called = [];
    for (const command of [...Object.values(commands), 'redo']) contents[command] = () => called.push(command);
    app.emit('web-contents-created', {}, contents);
    for (const [code, command] of Object.entries(commands)) {
      for (const type of ['keyDown', 'keyUp']) {
        let consumed = 0;
        contents.emit('before-input-event', { preventDefault: () => consumed++ }, input(code, { type }));
        assert.equal(consumed, 1, kind);
      }
      assert.equal(called.at(-1), command);
    }
    assert.equal(called.length, 5);
    contents.emit('before-input-event', { preventDefault: () => assert.fail('Ctrl must reach the renderer') }, input('KeyC', { meta: false, control: true }));
  }
});

test('history moved off Super+V, but Option+V on a Mac stays as it was', () => {
  assert.equal(windowKey(input('KeyV')), '');
  assert.equal(windowKey(input('KeyV', { shift: true })), 'clipboard');
  assert.equal(windowKey(input('KeyV', { meta: false, alt: true }), { mod: 'alt' }), 'clipboard');
  assert.equal(windowKey(input('KeyV', { meta: false, alt: true, shift: true }), { mod: 'alt' }), '');
});

test('pi-card teaches all native editing keys only for Super, without adding renderer handlers', async () => {
  const source = await readFile(new URL('../public/js/pi-card.js', import.meta.url), 'utf8');
  for (const [desk, platform, expected] of [[{ mod: 'meta' }, 'Linux', 6], [{ mod: 'alt' }, 'MacIntel', 0], [null, 'Linux', 0]]) {
    const context = { navigator: { platform }, imperfectDesk: desk, window: { addEventListener: () => assert.fail('native editing must not register DOM handlers') } };
    vm.runInNewContext(source.replaceAll('export ', '') + '\nglobalThis.keys = activeKeyBindings();', context);
    assert.equal(context.keys.length, expected);
    if (expected) assert.deepEqual(Array.from(context.keys, ({ label, description }) => `${label} ${description}`), [
      'Super+C copy', 'Super+V paste', 'Super+X cut', 'Super+A select all', 'Super+Z undo', 'Super+Shift+Z redo',
    ]);
  }
});

test('production main installs editing before creating any window', async () => {
  const main = await readFile(new URL('../../../../desktop/electron/main.mjs', import.meta.url), 'utf8');
  assert.ok(main.indexOf('installEditing(app, { mod: MOD })') < main.indexOf('app.whenReady()'));
});
