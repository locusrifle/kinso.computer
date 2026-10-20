import test from 'node:test';
import assert from 'node:assert/strict';
import { mountVoice } from '../public/js/voice.js';

// No microphone, permission UI, upload or agent: a fresh session binds its
// fixture destination before the permission request can suspend the window.
function fixture(t) {
  const descriptors = new Map(['document', 'navigator', 'MediaRecorder', 'addEventListener'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  t.after(() => { for (const [k, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, k, descriptor); else delete globalThis[k]; } });
  const listeners = new Map(), errors = [];
  let permissions = 0;
  for (const [key, value] of Object.entries({
    document: { createElement: () => ({ dataset: {}, append() {}, setAttribute() {}, click() { this.onclick(); } }) },
    navigator: { mediaDevices: { getUserMedia: async () => { permissions++; throw new Error('fixture denied'); } } },
    MediaRecorder: class {}, addEventListener: (name, fn) => listeners.set(name, fn),
  })) Object.defineProperty(globalThis, key, { configurable: true, value });
  const make = captureTarget => mountVoice({ input: {}, send: async () => {}, captureTarget, fail: error => errors.push(error.message) });
  const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
  return { make, listeners, errors, permissions: () => permissions, settle };
}
test('fresh voice waits for its target, ignores a double press, and reports failed permission', async t => {
  const f = fixture(t);
  let release, captures = 0;
  const voice = f.make(() => { captures++; return new Promise(resolve => { release = resolve; }); });
  voice.button.click(); voice.button.click();
  assert.equal(captures, 1); assert.equal(f.permissions(), 0);
  assert.equal(voice.holding(), true);
  release({ tab: 'fixture' }); await f.settle();
  assert.equal(f.permissions(), 1); assert.equal(voice.holding(), false);
  assert.match(f.errors[0], /fixture denied/);
});
test('Escape while a fresh target is pending never asks for microphone permission', async t => {
  const f = fixture(t); let release;
  const voice = f.make(() => new Promise(resolve => { release = resolve; }));
  voice.button.click();
  let prevented = false;
  f.listeners.get('keydown')({ key: 'Escape', preventDefault() { prevented = true; } });
  release({ tab: 'fixture' }); await f.settle();
  assert.equal(prevented, true); assert.equal(f.permissions(), 0);
  assert.equal(voice.holding(), false); assert.deepEqual(f.errors, []);
});
test('failed materialization leaves the mic idle without a permission request', async t => {
  const f = fixture(t);
  const voice = f.make(() => Promise.reject(new Error('fixture cannot start')));
  voice.button.click(); await f.settle();
  assert.equal(f.permissions(), 0); assert.equal(voice.holding(), false);
  assert.deepEqual(f.errors, ['fixture cannot start']);
});
