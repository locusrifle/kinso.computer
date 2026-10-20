import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function registry() {
  const source = await readFile(new URL('../public/js/pi-card.js', import.meta.url), 'utf8');
  // Each registry gets the desktop bridge before module evaluation, just as
  // preload supplies it in Electron. No real keyboard or window is used.
  return import(`data:text/javascript,${encodeURIComponent("const navigator = { platform: 'Linux' }; const globalThis = { imperfectDesk: {} };\n" + source)}#${Math.random()}`);
}
function target() {
  const handlers = [];
  return { addEventListener(_type, fn) { handlers.push(fn); },
    send(code, key, fields = {}) {
      let used = false;
      const event = { code, key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: true, ...fields,
        preventDefault() { used = true; }, stopPropagation() {} };
      for (const fn of handlers) fn(event);
      return used;
    } };
}

test('named physical codes require the same semantic key, including synthetic Super+l on Escape', async () => {
  const { registerKeyBinding } = await registry();
  const keys = target(); let calls = 0;
  for (const code of ['Escape', 'Backspace', 'Delete', 'Enter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    registerKeyBinding({ code, mod: true, target: keys, handler() { calls++; } });
    assert.equal(keys.send(code, 'l'), false, code);
    assert.equal(keys.send(code, code), true, code);
  }
  assert.equal(calls, 9);
});

test('letter shortcuts stay physical on every keyboard layout, closing ones included', async () => {
  const { registerKeyBinding } = await registry();
  const keys = target(); let closes = 0, layouts = 0, aborts = 0;
  registerKeyBinding({ code: 'KeyW', mod: true, target: keys, handler() { closes++; } });
  registerKeyBinding({ code: 'KeyC', ctrl: true, target: keys, handler() { aborts++; } });
  registerKeyBinding({ code: 'KeyL', mod: true, target: keys, handler() { layouts++; } });
  keys.send('KeyW', 'w'); keys.send('KeyW', 'ц');
  keys.send('KeyL', 'д');
  keys.send('KeyC', 'с', { metaKey: false, ctrlKey: true });
  assert.deepEqual({ closes, layouts, aborts }, { closes: 2, layouts: 1, aborts: 1 });
});
