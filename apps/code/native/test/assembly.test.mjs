import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAssembly, mountLaunchDrag, ASSEMBLY_STEPS } from '../public/js/assembly.js';
import { mountArrival, phoneByLaunch } from '../public/js/arrival.js';
import { prepareLaunchBrowser } from '../public/js/pages.js';

const SITE = 'https://imperfect.computer', NOAH = 'https://noah.imperfect.computer';
const KINSO = 'https://kinso.computer', KINSO_COMPUTER = 'https://computer.kinso.computer';
function fixture({ origin = NOAH, referrer = SITE, standalone = false, search = '', site = SITE } = {}) {
  const frames = [], messages = [], applied = [], listeners = new Map(), classes = new Set();
  const parent = { postMessage: (...args) => messages.push(args) };
  const win = { parent, location: { origin, search }, requestAnimationFrame: callback => frames.push(callback),
    getComputedStyle: () => ({ getPropertyValue: () => '38px' }),
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  if (standalone) win.parent = win;
  const root = { classList: { add: value => classes.add(value) }, dataset: {},
    setPointerCapture: id => { root.capture = id; }, hasPointerCapture: id => root.capture === id, releasePointerCapture: () => { root.capture = null; } };
  const doc = { referrer, documentElement: root, getElementById: () => ({}),
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const f = { win, doc, frames, messages, applied, classes, listeners, apply: step => applied.push(step) };
  f.send = (step, extra = {}) => listeners.get('message')?.({ origin: site, source: parent, data: { type: 'imperfect:assemble', step }, ...extra });
  f.paint = () => { for (let i = 0; i < 2; i++) for (const frame of frames.splice(0)) frame(); };
  return f;
}

test('assembly has exactly seven cumulative steps; acknowledgments follow two paints', () => {
  assert.deepEqual(ASSEMBLY_STEPS, ['bare', 'claude', 'codex', 'files', 'browser', 'messages', 'done']);
  const f = fixture(); const handle = mountAssembly(f);
  assert.ok(handle); assert.ok(f.classes.has('launch-framed'));
  for (const step of ASSEMBLY_STEPS) {
    f.send(step);
    assert.equal(f.applied.at(-1), step);
    const before = f.messages.length;
    for (const frame of f.frames.splice(0)) frame();
    assert.equal(f.messages.length, before);
    for (const frame of f.frames.splice(0)) frame();
    assert.deepEqual(f.messages.at(-1), [{ type: 'imperfect:assembled', step }, SITE]);
  }
  handle.dispose(); assert.equal(f.listeners.has('message'), false);
});

test('assembly refuses non-parent sources, non-exact origins, invalid steps and backward steps', () => {
  const f = fixture(); mountAssembly(f);
  for (const origin of ['https://evil.test', 'http://imperfect.computer', 'https://imperfect.computer.evil.test', 'null']) f.send('bare', { origin });
  f.send('bare', { source: {} });
  f.send('bare', { data: { type: 'other', step: 'bare' } });
  for (const step of [undefined, null, 0, 'unknown', 'BARE', {}, ['bare']]) f.send(step);
  assert.deepEqual(f.applied, []); assert.deepEqual(f.frames, []);
  f.send('codex'); f.send('bare'); f.send('claude'); f.paint();
  assert.deepEqual(f.applied, ['codex']);
  assert.deepEqual(f.messages, [[{ type: 'imperfect:assembled', step: 'codex' }, SITE]]);
});

test('skip goes directly to done; duplicates acknowledge but never reopen panes or replay steps', () => {
  const f = fixture(); mountAssembly(f);
  f.send('done'); f.paint(); f.send('bare'); f.send('done'); f.paint();
  assert.deepEqual(f.applied, ['done']);
  assert.equal(f.messages.length, 2);
  const advancing = fixture(); mountAssembly(advancing);
  advancing.send('bare'); advancing.send('browser'); advancing.paint();
  assert.deepEqual(advancing.messages, [[{ type: 'imperfect:assembled', step: 'browser' }, SITE]]);
});

test('private computers, standalone pages and unknown embedders have no assembly or drag listener', () => {
  for (const options of [{ origin: 'https://desktop.imperfect.computer' }, { referrer: 'https://evil.test' }, { standalone: true }]) {
    const f = fixture(options);
    assert.equal(mountAssembly(f), null); assert.equal(mountLaunchDrag(f), null);
    assert.equal(f.listeners.size, 0); assert.equal(f.classes.size, 0);
  }
});

test('the inert phone hint works only within the exact trusted launch boundary', () => {
  const f = fixture({ search: '?face=code&launch=phone' });
  assert.equal(phoneByLaunch(f.win, f.doc), true);
  assert.ok(mountAssembly(f)); assert.ok(f.classes.has('launch-phone')); assert.equal(f.classes.has('launch-framed'), false);
  assert.equal(mountLaunchDrag(f), null, 'a phone cannot drag the outer desktop window');
  f.send('done'); f.paint();
  assert.deepEqual(f.applied, ['done']);
  assert.deepEqual(f.messages, [[{ type: 'imperfect:assembled', step: 'done' }, SITE]]);
  for (const options of [{ standalone: true }, { origin: 'https://desktop.imperfect.computer' }, { referrer: 'https://evil.test' }, { referrer: 'https://imperfect.computer.evil.test/' }]) {
    const bad = fixture({ search: '?launch=phone', ...options });
    assert.equal(phoneByLaunch(bad.win, bad.doc), false);
    assert.equal(mountAssembly(bad), null);
  }
  for (const search of ['', '?launch=PHONE', '?launch=desktop', '?phone=true']) {
    const other = fixture({ search }); assert.equal(phoneByLaunch(other.win, other.doc), false);
  }
});

test('launch dragging is empty-top-band only, captured, exact-origin and pointer-scoped', () => {
  const f = fixture(); const handle = mountLaunchDrag(f);
  const event = (extra = {}) => ({ clientX: 230, clientY: 18, pointerId: 1, button: 0, target: { closest: () => null }, preventDefault() {}, ...extra });
  const down = f.listeners.get('pointerdown');
  down(event({ clientY: 60 })); down(event({ button: 2 })); down(event({ target: { closest: () => ({}) } }));
  assert.deepEqual(f.messages, []);
  down(event()); assert.equal(f.doc.documentElement.capture, 1);
  f.listeners.get('pointermove')(event({ pointerId: 2 }));
  f.listeners.get('pointermove')(event({ clientX: 250 }));
  f.listeners.get('pointerup')(event({ clientX: 260 }));
  f.listeners.get('lostpointercapture')(event());
  assert.deepEqual(f.messages, ['start', 'move', 'end'].map((phase, i) => [{ type: 'imperfect:window-drag', phase, x: [230, 250, 260][i], y: 18 }, SITE]));
  assert.equal(f.doc.documentElement.capture, null);
  handle.dispose(); assert.equal(f.listeners.size, 0);
});

test('web frames no longer mount the lock sky, including a refused WebGL loader', () => {
  let loaded = false;
  assert.equal(mountArrival(null, { load: () => { loaded = true; throw new Error('must not load'); } }), null);
  assert.equal(loaded, false);
});

test('assembly reuses one exact Google host and explicitly presents it, never an unrelated page', async () => {
  const calls = [];
  await prepareLaunchBrowser(async request => { calls.push(request); return { tabs: [{ tab: 1, url: 'https://google.com.evil.test' }, { tab: 4, url: 'https://www.google.com/search?q=hello' }] }; });
  assert.deepEqual(calls, [{ do: 'tabs' }, { do: 'front', tab: 4 }]);
});

test('assembly opens exactly one Google tab if absent, then reuses it on the next visit', async () => {
  const calls = [], tabs = [{ tab: 1, url: 'https://example.test' }];
  const ask = async request => { calls.push(request); if (request.do === 'tabs') return { tabs }; if (request.do === 'open') { const tab = { tab: 2, url: request.url }; tabs.push(tab); return tab; } return {}; };
  await prepareLaunchBrowser(ask); await prepareLaunchBrowser(ask);
  assert.deepEqual(calls, [{ do: 'tabs' }, { do: 'open', url: 'https://www.google.com' }, { do: 'front', tab: 2 }, { do: 'tabs' }, { do: 'front', tab: 2 }]);
});

test('browser failures remain failures, without an illustrated fallback', async () => {
  await assert.rejects(prepareLaunchBrowser(async () => { throw new Error('browser unavailable'); }), /unavailable/);
  await assert.rejects(prepareLaunchBrowser(async () => ({})), /tabs/);
  await assert.rejects(prepareLaunchBrowser(async () => ({ tabs: [], tab: null })), /tab/);
});

test('imperfect.computer skips Messages; kinso.computer frames Kinso\'s computer, paints Messages and says who it is for', () => {
  const plain = fixture(); mountAssembly(plain);
  for (const step of ['bare', 'claude', 'codex', 'files', 'browser', 'done']) { plain.send(step); plain.paint(); }
  assert.deepEqual(plain.applied, ['bare', 'claude', 'codex', 'files', 'browser', 'done']);
  assert.equal(plain.doc.documentElement.dataset.launchFor, undefined);
  const kinso = fixture({ origin: KINSO_COMPUTER, referrer: `${KINSO}/`, site: KINSO }); assert.ok(mountAssembly(kinso));
  for (const step of ASSEMBLY_STEPS) { kinso.send(step, { data: { type: 'imperfect:assemble', step, for: 'kinso' } }); kinso.paint(); }
  assert.deepEqual(kinso.applied, ASSEMBLY_STEPS);
  assert.deepEqual(kinso.messages.at(-1), [{ type: 'imperfect:assembled', step: 'done' }, KINSO]);
  assert.equal(kinso.doc.documentElement.dataset.launchFor, 'kinso');
  const other = fixture({ origin: KINSO_COMPUTER, referrer: `${KINSO}/`, site: KINSO }); mountAssembly(other);
  other.send('bare', { data: { type: 'imperfect:assemble', step: 'bare', for: 'someone-else' } });
  assert.deepEqual(other.applied, ['bare']); assert.equal(other.doc.documentElement.dataset.launchFor, undefined);
});
