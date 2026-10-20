import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PEAK, BURST, PEAK_FRAME, FPS, CHANNELS, ACCENTS, HITS, BUBBLE, kickAt, bubbleMotion, createPlayer, envelope } from '../../website/bootup.mjs';
import { WORDMARK, LETTERING, HOLD, SHINE, WORD, FIELD_IN, wordmarkAt, placeWordmark } from '../../website/wordmark.mjs';
import { REVEAL, revealAt } from '../../website/reveal.mjs';

test('the recording keeps its measured peak; everything that bursts follows Noah\'s BURST', () => {
  assert.equal(PEAK_FRAME, CHANNELS.peak.indexOf(Math.max(...CHANNELS.peak)));
  assert.equal(PEAK, PEAK_FRAME / FPS); assert.equal(envelope(PEAK).peak, 1); // the audio's own loudest moment
  assert.equal(BURST, 5.367); assert.ok(BURST < PEAK); // Noah's mark, 12 Oct
  assert.equal(REVEAL.breathe, BURST); assert.equal(REVEAL.length, BURST + REVEAL.open); assert.equal(REVEAL.fade, BURST);
  const view = { at: [512, 320], width: 1024, height: 640 };
  for (const t of [0, .35, .7, 1.4, 3.2, 5.2, BURST - 1e-9, BURST, PEAK, PEAK + .2]) {
    const b = revealAt(t, view);
    assert.equal(b.pop, t >= BURST); assert.ok(Number.isFinite(b.R) && Number.isFinite(b.wob));
  }
  assert.equal(bubbleMotion(BURST - 1e-9).ex, 0); assert.ok(bubbleMotion(BURST + 0.1).ex > 0);
  assert.equal(bubbleMotion(BURST + REVEAL.open - 1e-9).done, false); assert.equal(bubbleMotion(BURST + REVEAL.open).done, true);
  assert.equal(wordmarkAt(-1e-9).on, false); assert.equal(wordmarkAt(0).on, true); assert.equal(wordmarkAt(BURST - 1e-9).formed, 1);
  assert.ok(Math.abs(WORDMARK.condense - (SHINE.start - BURST)) < 1e-12 && Math.abs(WORDMARK.condense - 0.643) < 1e-9);
});
test('site and lock call one reveal and one burst implementation, with no private choreography', async () => {
  const src = await readFile(new URL('../../website/boot/sequence.mjs', import.meta.url), 'utf8');
  assert.match(src, /revealAt\(tau,/); assert.match(src, /reveal\.mjs/);
  assert.match(src, /macos-wallpaper/); assert.doesNotMatch(src, /holdSeed/);
  assert.doesNotMatch(src, /const REVEAL|const PACE|const pulse|const chatter/);
  for (const path of ['website/intro/intro.mjs', 'desktop/lock/lock.mjs']) {
    const host = await readFile(new URL('../../' + path, import.meta.url), 'utf8');
    assert.match(host, /boot\/sequence\.mjs/);
    assert.doesNotMatch(host, /revealAt|contactBurst|createPainting/);
  }
});
function audio(state = 'running') {
  let instance, starts = [];
  class Context {
    constructor() { instance = this; this.state = state; this.currentTime = 40; this.destination = {}; }
    decodeAudioData() { return Promise.resolve({}); }
    resume() { return this.state === 'running' ? Promise.resolve() : Promise.reject(new Error('blocked')); }
    createBufferSource() { return { connect() {}, start(...args) { starts.push(args); }, stop() {} }; }
  }
  return { Context, get instance() { return instance; }, starts };
}
const fetcher = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
test('priming plays nothing; contact starts once from zero and picture follows audio, not wall time', async () => {
  const a = audio(); let wall = 10;
  const p = createPlayer({ Context: a.Context, clock: () => wall, fetcher });
  await p.ready; await p.prime(); assert.equal(a.starts.length, 0);
  assert.equal(p.start(), true); assert.deepEqual(a.starts, [[40, 0]]);
  wall = 100; a.instance.currentTime += PEAK;
  assert.ok(Math.abs(p.elapsed() - PEAK) < 1e-9); assert.equal(p.audible, true);
});
test('blocked or undecodable audio is silently identical on the wall clock; fixed QA never makes sound', async () => {
  for (const fixed of [false, true]) {
    const a = audio(fixed ? 'running' : 'suspended'); let wall = 0;
    const p = createPlayer({ Context: a.Context, clock: () => wall, fixed: () => fixed, fetcher });
    await p.ready; assert.equal(p.start(), false); await Promise.resolve();
    wall = PEAK; assert.equal(p.elapsed(), PEAK); assert.equal(p.audible, false); assert.deepEqual(a.starts, []);
  }
  let wall = 0;
  const p = createPlayer({ Context: null, clock: () => wall });
  assert.equal(await p.ready, false); p.start(); wall = PEAK; assert.equal(p.elapsed(), PEAK);
});

test('a decoder that never answers gives up after its limit, so the lock still starts (silently)', async () => {
  const a = audio('suspended'); let wall = 0;
  const p = createPlayer({ Context: a.Context, clock: () => wall, limit: 20,
    fetcher: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }) });
  a.instance.decodeAudioData = () => new Promise(() => {});
  assert.equal(await p.ready, false); assert.equal(p.start(), false);
  wall = PEAK; assert.equal(p.elapsed(), PEAK); assert.deepEqual(a.starts, []);
});

test('an autoplay-enabled suspended context resumes at contact without a page gesture; decode falls through both formats', async () => {
  const a = audio('suspended'), tried = [];
  const p = createPlayer({ Context: a.Context, clock: () => 0, urls: ['bootup.m4a', 'bootup.webm'],
    fetcher: async url => { tried.push(url); return { ok: true, arrayBuffer: async () => url }; } });
  a.instance.decodeAudioData = async bytes => { if (bytes.endsWith('.m4a')) throw new Error('codec missing'); return {}; };
  a.instance.resume = async () => { a.instance.state = 'running'; };
  assert.equal(await p.ready, true); assert.deepEqual(tried, ['bootup.m4a', 'bootup.webm']);
  p.start(); await new Promise(r => setImmediate(r));
  assert.deepEqual(a.starts, [[40, 0]]); assert.equal(p.audible, true);
});
test('local-file audio can decode through XHR when WebKit refuses Fetch', async () => {
  const fetch = globalThis.fetch, XHR = globalThis.XMLHttpRequest, opened = [];
  try {
    globalThis.fetch = async () => { throw new Error('file scheme unsupported'); };
    globalThis.XMLHttpRequest = class {
      open(method, url) { opened.push([method, url]); }
      send() { this.response = new ArrayBuffer(1); queueMicrotask(() => this.onload()); }
    };
    const a = audio(), p = createPlayer({ Context: a.Context, urls: ['file:///bootup.m4a', 'file:///bootup.webm'] });
    assert.equal(await p.ready, true); assert.deepEqual(opened, [['GET', 'file:///bootup.m4a']]);
  } finally { globalThis.fetch = fetch; if (XHR) globalThis.XMLHttpRequest = XHR; else delete globalThis.XMLHttpRequest; }
});

test('late or cancelled resumes never play a detached contact sound', async () => {
  for (const cancelled of [false, true]) {
    const a = audio('suspended'); let now = 0, resume;
    const p = createPlayer({ Context: a.Context, clock: () => now, fetcher });
    await p.ready;
    a.instance.resume = () => new Promise(ok => { resume = () => { a.instance.state = 'running'; ok(); }; });
    p.start(); if (cancelled) p.stop(); else now = 0.2;
    resume(); await new Promise(r => setImmediate(r));
    assert.equal(a.starts.length, 0); assert.equal(p.audible, false);
  }
});

test('the hits are the recording\'s own accents, stored as data', () => {
  assert.ok(ACCENTS.length > 20 && ACCENTS.every(a => a.length === 3 && a.every(Number.isFinite)));
  for (let i = 1; i < ACCENTS.length; i++) assert.ok(ACCENTS[i][0] > ACCENTS[i - 1][0]);
  // one line picks them: clear (4 dB) or loud (3 dB at two thirds of the peak), from the seed to the burst
  assert.deepEqual(HITS, ACCENTS.filter(([t, db, loud]) => t >= 0.35 && t <= BURST && (db >= 4 || (db >= 3 && loud >= 2 / 3))).map(([t]) => t));
  assert.ok(HITS.length >= 12 && HITS[0] >= 0.35 && HITS.at(-1) <= BURST, String(HITS));
  // the recording's accents after Noah's burst are no longer hits
  for (const t of [5.44, 5.68]) assert.ok(ACCENTS.some(a => a[0] === t) && !HITS.includes(t), `${t}s comes after the burst`);
  assert.equal(HITS.at(-1), 5.15);
  for (const t of [0.39, 1.18, 1.95, 2.375, 2.86, 3.455, 4.015, 4.32]) assert.ok(HITS.includes(t), `the clear hit at ${t}s`);
});

test('the bubble rests at half its round-1 size and leaps to the full size on every hit', () => {
  assert.equal(BUBBLE.base, 0.5);
  const round1 = t => { const a = envelope(t), u = Math.max(0, Math.min(1, (t - 0.35) / 0.22)); return u * u * (3 - 2 * u) * (0.32 + 0.92 * a.loud + 0.20 * a.energy + 0.18 * a.transient); };
  let rested = 0;
  for (let t = 0.36; t < HITS[0]; t += 0.005) assert.equal(bubbleMotion(t).radius, bubbleMotion(t).full * 0.5); // before any hit: exactly half
  for (let t = 0.6; t < BURST; t += 0.01) {
    const b = bubbleMotion(t);
    assert.ok(Math.abs(b.full - round1(t)) < 1e-12);
    assert.ok(Math.abs(b.radius - b.full * (0.5 + 0.5 * b.kick)) < 1e-12);
    if (Math.abs(b.kick) < 0.02) { rested++; assert.ok(Math.abs(b.radius / b.full - 0.5) < 0.011, `${t}`); }
  }
  assert.ok(rested > 20, 'it spends real time at rest');
  for (const h of HITS) {
    let top = 0, at = 0;
    for (let t = h; t < Math.min(h + 0.12, h === HITS.at(-1) ? h + BUBBLE.rise : Infinity); t += 0.001) { const k = kickAt(t); if (k > top) { top = k; at = t - h; } }
    assert.ok(top >= 1 && top <= 1 + BUBBLE.over + 1e-9, `hit ${h}: ${top}`); // full size, overshooting a little
    assert.ok(at <= BUBBLE.rise + 0.002, `hit ${h} is violent: full in ${at}s`);
    assert.ok(kickAt(h - 1e-6) < 0.9, `hit ${h} starts below full`);
    if (h + 0.02 < BURST) { const b = bubbleMotion(h + 0.02); assert.ok(b.wob - (0.8 + 1.55 * b.energy + 0.65 * b.transient) > 0.95 * BUBBLE.shake, `hit ${h} spikes the wobble`); }
    assert.ok(bubbleMotion(h + 0.08).wt - bubbleMotion(h - 1e-6).wt >= 0.9 * BUBBLE.jolt, `hit ${h} jolts the wobble on`);
  }
  // and falls back: within 0.4s of a lone hit it is back near rest
  assert.ok(Math.abs(kickAt(HITS[0] + 0.45)) < 0.1 && HITS[1] > HITS[0] + 0.45);
});

test('after its last hit the bubble builds into the burst, never idling or shrinking', () => {
  const h = HITS.at(-1);
  let last = -Infinity;
  for (let t = h + BUBBLE.rise; t <= BURST; t += 0.002) { const k = kickAt(t); assert.ok(k >= last - 1e-12, `${t}: ${k}`); last = k; }
  assert.ok(Math.abs(kickAt(BURST) - BUBBLE.swell) < 1e-9 && BUBBLE.swell > 1 + BUBBLE.over);
  const at = t => bubbleMotion(t).radius, tops = HITS.slice(0, -1).map(x => at(x + BUBBLE.rise));
  assert.ok(at(BURST - 1e-6) > Math.max(...tops), `bigger at the burst (${at(BURST - 1e-6)}) than at any earlier hit (${Math.max(...tops)})`);
});

test('the wordmark is already there from the contact: whole and unlit through the bubble, lit once by the shine', () => {
  assert.match(LETTERING.src, /assets\/wordmark\/imperfect-spiky\.png$/);
  // The bubble is a portal onto the wallpaper and the word: the word is whole the moment the bubble appears.
  for (const t of [0, 1 / 60, 3, BURST - 1e-6, BURST, WORD.whole]) {
    const w = wordmarkAt(t); assert.deepEqual([w.on, w.formed, w.opacity, w.blur, w.scale], [true, 1, 1, 0, 1], `${t}: whole`);
  }
  for (const t of [0, 3, BURST]) assert.equal(wordmarkAt(t).shine, null, `${t}: unlit until the shine`);
  assert.ok(wordmarkAt(SHINE.start).shine, 'lit as the band reaches its first letter');
  assert.ok(Math.abs(WORD.whole - SHINE.start) < 1e-12, 'its hold counts from the shine');
  assert.equal(wordmarkAt(-1e-6).on, false); assert.equal(wordmarkAt(undefined).on, false); // no contact, no word
  assert.deepEqual(wordmarkAt(1, { still: true }), { on: true, formed: 1, opacity: 1, blur: 0, scale: 1, shine: null });
  assert.deepEqual(wordmarkAt(BURST + 1, { still: true }), { on: true, formed: 1, opacity: 1, blur: 0, scale: 1, shine: null });
});

test('the shine is two moments: its centre on the first letter at SHINE.start, on the last at SHINE.end', () => {
  assert.deepEqual({ ...SHINE }, { start: 6.01, end: 6.493 }); // Noah's marks
  assert.ok(SHINE.start > BURST && SHINE.end > SHINE.start && SHINE.end + WORDMARK.after < WORD.out);
  const at = t => wordmarkAt(t).shine, span = SHINE.end - SHINE.start;
  assert.equal(at(SHINE.start - WORDMARK.band * span - 1e-6), null, 'no light until a band short of the first letter');
  assert.ok(Math.abs(at(SHINE.start).at) < 1e-9 && at(SHINE.start).strength === 1, 'on the first letter, at full');
  assert.ok(Math.abs(at(SHINE.end - 1e-9).at - 1) < 1e-6, 'on the last');
  let last = -Infinity;
  for (let t = SHINE.start - WORDMARK.band * span + 1e-6; t < SHINE.end + WORDMARK.after; t += 0.005) { const s = at(t); assert.ok(s.at > last && s.strength <= 1); last = s.at; }
  assert.ok(at(SHINE.end + WORDMARK.after / 2).strength < 1, 'then it fades');
  assert.equal(at(SHINE.end + WORDMARK.after), null);
});

test('the word holds HOLD seconds once whole, then fades and is gone before the field', () => {
  assert.equal(HOLD, 2);
  assert.ok(Math.abs(WORD.out - (WORD.whole + HOLD)) < 1e-12 && Math.abs(WORD.gone - (WORD.out + WORDMARK.fade)) < 1e-12);
  assert.ok(Math.abs(WORD.out - 8.01) < 1e-9 && Math.abs(WORD.gone - 8.61) < 1e-9 && WORDMARK.fade === 0.6 && FIELD_IN === 0.5);
  for (const still of [false, true]) {
    for (let t = WORD.whole; t <= WORD.out; t += 0.05) assert.equal(wordmarkAt(t, { still }).opacity, 1, `${t}: held`);
    let last = 1;
    for (let i = 1; i < 60; i++) { const t = WORD.out + i * WORDMARK.fade / 60, o = wordmarkAt(t, { still }).opacity; assert.ok(o < last && o > 0, `${t}: fading`); last = o; }
    for (const t of [WORD.gone, WORD.gone + 1, 60]) assert.deepEqual([wordmarkAt(t, { still }).on, wordmarkAt(t, { still }).opacity], [false, 0]);
  }
});

test('the word stands at the very centre of any screen', () => {
  for (const [vw, vh] of [[1920, 1080], [1024, 640], [390, 844], [2560, 1080]]) {
    const [x, y, w, h] = placeWordmark(vw, vh);
    assert.ok(Math.abs(x + w / 2 - vw / 2) < 1e-9 && Math.abs(y + h / 2 - vh / 2) < 1e-9, `${vw}x${vh}`);
    assert.ok(x > 0 && y > 0 && Math.abs(w / h - LETTERING.size[0] / LETTERING.size[1]) < 1e-9);
  }
});
