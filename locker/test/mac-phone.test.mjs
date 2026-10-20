import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhone } from '../../website/mac/phone.mjs';

const SITE = 'https://noah.imperfect.computer';
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture(t, reduced = false) {
  const listeners = new Map(), messages = [], events = [], attrs = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value: (type, fn) => listeners.set(type, fn) });
  t.after(() => previous ? Object.defineProperty(globalThis, 'addEventListener', previous) : delete globalThis.addEventListener);
  const classes = () => { const set = new Set(); return { add: s => set.add(s), remove: s => set.delete(s), contains: s => set.has(s) }; };
  const fallback = {}, clock = {};
  const device = { hidden: true, dataset: {}, classList: classes(), offsetWidth: 414,
    querySelector: selector => selector === '.phone-clock' ? clock : fallback,
    setAttribute: (key, value) => { device[key] = value; } };
  const frameListeners = new Map();
  let navigations = 0;
  const frame = { contentWindow: { postMessage: (...args) => messages.push(args) },
    addEventListener: (type, fn) => frameListeners.set(type, fn),
    getAttribute: key => attrs.get(key), setAttribute: (key, value) => attrs.set(key, value),
    set src(value) { navigations++; attrs.set('src', value); } };
  const appWindow = { style: { transform: 'translateY(3px)' }, classList: classes() };
  const phone = createPhone({ stage: { dispatchEvent: event => events.push(event) }, appWindow, device, frame, reduced: { matches: reduced } });
  t.after(() => phone.reset());
  const send = (type, extra = {}) => listeners.get('message')({ source: frame.contentWindow, origin: SITE, data: { type, step: 'done' }, ...extra });
  return { phone, frame, appWindow, device, clock, fallback, messages, events, send, frameListeners, navigations: () => navigations };
}

test('a phone navigation reuses only the verified origin, never a second ticket', t => {
  const f = fixture(t);
  assert.equal(f.phone.state().loaded, false);
  f.phone.prepare(SITE + '/door/ticket?ticket=must-not-be-reused');
  assert.equal(f.frame.getAttribute('src'), SITE + '/?face=code&launch=phone');
  assert.equal(f.device.hidden, false, 'transparent parking permits genuine product paint frames');
  assert.equal(f.device['aria-hidden'], 'true');
  assert.equal(f.frame.inert, true);
  f.phone.prepare(SITE); f.phone.prepare('https://other.example');
  assert.equal(f.navigations(), 1);
  assert.deepEqual(f.messages, []);
});

test('phone readiness and done acknowledgments require this exact frame and origin', t => {
  const f = fixture(t); f.phone.prepare(SITE);
  f.send('imperfect:assembled');
  assert.equal(f.phone.state().ready, false, 'an acknowledgment alone is not authentication');
  for (const extra of [{ source: {} }, { origin: 'null' }, { origin: 'http://noah.imperfect.computer' }, { origin: SITE + '.evil.test' }]) f.send('imperfect:demo-ready', extra);
  assert.equal(f.phone.state().verified, false); assert.deepEqual(f.messages, []);
  f.send('imperfect:demo-ready');
  assert.equal(f.phone.state().verified, true);
  assert.deepEqual(f.messages, [[{ type: 'imperfect:assemble', step: 'done' }, SITE]]);
  f.send('imperfect:assembled', { data: { type: 'imperfect:assembled', step: 'browser' } });
  assert.equal(f.phone.state().ready, false);
  f.send('imperfect:assembled');
  assert.equal(f.phone.state().ready, true); assert.equal(f.fallback.hidden, true);
  assert.equal(f.frame.inert, true, 'verified pixels do not enable any phone input');
  f.frameListeners.get('load')(); f.frameListeners.get('load')();
  assert.equal(f.phone.state().verified, false); assert.equal(f.phone.state().ready, false);
  f.send('imperfect:assembled'); assert.equal(f.phone.state().ready, false, 'navigation revokes old acknowledgments');
});

test('unverified phone documents remain hidden behind an honest unavailable message', t => {
  const f = fixture(t); f.phone.prepare(SITE);
  assert.equal(f.device.dataset.ready, 'false'); assert.equal(f.frame.getAttribute('aria-hidden'), 'true');
  assert.equal(f.fallback.hidden, false);
  f.send('imperfect:demo-ready'); f.send('imperfect:assembled');
  f.frameListeners.get('error')();
  assert.equal(f.phone.state().ready, false); assert.equal(f.fallback.hidden, false);
});

test('the phone holds the genuine view through the voice, then returns the exact desktop transform', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.phone.prepare(SITE); f.send('imperfect:demo-ready'); f.send('imperfect:assembled');
  let endVoice; const done = new Promise(resolve => { endVoice = resolve; });
  const motion = f.phone.exhibit({ done });
  assert.equal(f.appWindow.style.transform, 'translateY(3px) translateX(-320px)');
  assert.equal(f.device.dataset.shown, 'true');
  t.mock.timers.tick(600); await flush();
  assert.deepEqual(f.events.map(event => event.detail.phase), ['shown']);
  assert.equal(f.phone.state().showing, true);
  endVoice(); await flush();
  t.mock.timers.tick(999); await flush(); assert.equal(f.device.dataset.shown, 'true');
  t.mock.timers.tick(1); await flush(); assert.equal(f.device.dataset.shown, 'exit');
  t.mock.timers.tick(600); await flush(); await motion;
  assert.equal(f.appWindow.style.transform, 'translateY(3px)');
  assert.equal(f.appWindow.classList.contains('phone-travel'), false);
  assert.equal(f.device.dataset.shown, 'false'); assert.equal(f.device['aria-hidden'], 'true');
  assert.equal(f.phone.state().returned, true);
  assert.deepEqual(f.events.map(event => event.detail.phase), ['shown', 'returned']);
  assert.ok(f.events.every(event => event.detail.ready && typeof event.detail.at === 'number'));
  assert.equal(f.navigations(), 1, 'window actions do not navigate the genuine phone document either');
});

test('skip aborts either slide or hold without stranding a translated desktop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); f.phone.prepare(SITE);
  const motion = f.phone.exhibit({ done: new Promise(() => {}) });
  t.mock.timers.tick(600); await flush();
  f.phone.reset(); await flush(); await motion;
  assert.equal(f.appWindow.style.transform, 'translateY(3px)');
  assert.equal(f.device.dataset.shown, 'false'); assert.equal(f.device['aria-hidden'], 'true');
  assert.equal(f.appWindow.classList.contains('phone-travel'), false);
  assert.equal(f.device.classList.contains('phone-moving'), false);
  assert.equal(f.navigations(), 1);
});

test('reduced motion opens no phone frame and presents no phone beat', async t => {
  const f = fixture(t, true); f.phone.prepare(SITE);
  await f.phone.exhibit({ done: Promise.resolve() });
  assert.equal(f.navigations(), 0); assert.equal(f.phone.state().played, false);
  assert.equal(f.device.hidden, true); assert.equal(f.appWindow.style.transform, 'translateY(3px)');
});

test('phone addresses preserve the primary HTTPS / loopback-only security rule', t => {
  const f = fixture(t);
  for (const origin of ['http://external.example', 'https://user:password@noah.imperfect.computer', 'javascript:alert(1)']) {
    assert.throws(() => f.phone.prepare(origin)); assert.equal(f.navigations(), 0);
  }
  f.phone.prepare('http://127.0.0.1:45678');
  assert.equal(f.frame.getAttribute('src'), 'http://127.0.0.1:45678/?face=code&launch=phone');
});
