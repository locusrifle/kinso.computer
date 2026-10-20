import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { demoAddress, isDemoReady, waitForMedia, primeVideo, playVideo, fadeDuration, preloadDue } from '../../website/media.mjs';
import { config } from '../../website/launch-config.mjs';
import { BURST, PEAK, bubbleMotion, createPlayer } from '../../website/bootup.mjs';
import { WORD, SHINE, wordmarkAt, placeWordmark } from '../../website/wordmark.mjs';
import { revealAt } from '../../website/reveal.mjs';
import { soundMotion, kickAt as soundKick, HITS as SOUND_HITS, HITS2 } from '../../website/bubble-sound.mjs';
import { bubblePath } from '../../website/bubble.mjs';
import { bubblePath as pathBefore } from './fixtures/bubble-before-sound.mjs';
import * as revealBefore from './fixtures/reveal-before-sound.mjs';
import { filmRect, ASPECT } from '../../website/film.mjs';
import { GOAT, MASS, goatTimes, goatAt, opticalWordmark, placeGoat } from '../../website/intro/goat.mjs';
import { workbenchOf } from '../../website/lock.mjs';
import { INTRO, STEPS, VOICE_RATE, SCREEN } from '../../website/mac/desktop.mjs';
import { mountAssembly, mountLaunchDrag, ASSEMBLY_STEPS } from '../../apps/code/native/public/js/assembly.js';
import { phoneByLaunch } from '../../apps/code/native/public/js/arrival.js';
import { frameDragAllowed, WINDOW_DEFAULT, DESKTOP_BAND } from '../../website/mac/shell.mjs';
import { detectOS } from '../public/store/shop-platform.mjs';
import { launchShopURL, mountLaunchOpen, prepareLaunchShop } from '../../apps/code/native/public/js/launch-open.js';
import { VARIANTS } from '../../website/variant.mjs';
import { MACOS } from '../../website/macos/timings.mjs';
const read = path => readFile(new URL('../../website/' + path, import.meta.url), 'utf8');
// Check responsibilities, not line breaks or the exact prose of comments between functions.
function functionSource(text, name) {
  const match = text.match(new RegExp(`^([ \\t]*)(?:async )?function ${name}\\(`, 'm'));
  assert.ok(match, `${name} exists`);
  const rest = text.slice(match.index);
  const firstLine = rest.split('\n')[0];
  if (firstLine.trimEnd().endsWith('}')) return firstLine;
  const end = rest.indexOf(`\n${match[1]}}\n`);
  assert.ok(end >= 0, `${name} has a body`);
  return rest.slice(0, end + match[1].length + 2);
}
function assertBefore(text, first, second, message) {
  const a = text.indexOf(first), b = text.indexOf(second);
  assert.ok(a >= 0 && b >= 0 && a < b, message);
}
// Read the measured M4A movie duration without requiring ffprobe in the test environment.
function m4aDurationMs(bytes) {
  function atom(type, from = 0, to = bytes.length) {
    for (let at = from; at + 8 <= to;) {
      const size = bytes.readUInt32BE(at);
      assert.ok(size >= 8 && at + size <= to, 'valid M4A atom');
      if (bytes.toString('ascii', at + 4, at + 8) === type) return { from: at + 8, to: at + size };
      at += size;
    }
    assert.fail(`M4A contains ${type}`);
  }
  const moov = atom('moov'), mvhd = atom('mvhd', moov.from, moov.to), at = mvhd.from;
  const version = bytes[at];
  assert.ok(version === 0 || version === 1, 'supported movie header');
  const scale = bytes.readUInt32BE(at + (version === 1 ? 20 : 12));
  const ticks = version === 1 ? Number(bytes.readBigUInt64BE(at + 24)) : bytes.readUInt32BE(at + 16);
  assert.ok(scale > 0 && ticks > 0, 'a measured, nonempty voice');
  return ticks / scale * 1000;
}

class Video extends EventTarget {
  readyState = 0; volume = 1; muted = false; currentTime = 10; paused = true; error = null;
  calls = [];
  play() { this.calls.push('play'); this.paused = false; return Promise.resolve(); }
  pause() { this.calls.push('pause'); this.paused = true; }
}

test('same contact, burst, shine, hold/fade as the lock', () => {
  assert.equal(BURST, 5.367); assert.ok(PEAK > BURST);
  assert.deepEqual(SHINE, { start: 6.01, end: 6.493 });
  assert.ok(Math.abs(WORD.gone - 8.61) < 1e-9);
  assert.equal(wordmarkAt(-.001).on, false); assert.equal(wordmarkAt(BURST - .001).formed, 1, 'there through the bubble');
  assert.equal(wordmarkAt(SHINE.start).formed, 1);
  assert.equal(wordmarkAt(8.01).opacity, 1);
  assert.equal(wordmarkAt(WORD.gone).on, false);
  assert.equal(wordmarkAt(BURST, { still: true }).shine, null);
  for (const tau of [0, .35, 2, 5, BURST, BURST + .8]) {
    const b = revealAt(tau, { at: [195, 400], width: 390, height: 844 });
    assert.ok(Number.isFinite(b.R)); assert.equal(b.pop, tau >= BURST);
  }
  assert.equal(bubbleMotion(BURST + .8).done, true);
});
test('wordmark stays centred on desktop and portrait', () => {
  for (const [w, h] of [[1920,1080],[390,844],[844,390]]) {
    const [x,y,mw,mh] = placeWordmark(w,h);
    assert.equal(x + mw / 2, w / 2); assert.equal(y + mh / 2, h / 2);
  }
});
test('shared boot has no lock login or bridge; calls shared renderers', async () => {
  const text = await read('boot/sequence.mjs');
  assert.doesNotMatch(text, /window\.lock|window\.webkit|S\.typed|S\.yes|function drawBox|function showDots/);
  for (const call of ['revealAt(tau,', 'wordmarkAt(tau,', "tell('complete')"]) assert.ok(text.includes(call));
  assert.match(text, /if \(tau < WORD\.gone\) return/);
});
test('static page keeps PWA/icon additions, has no old marketing/cards or fake app', async () => {
  const text = await read('index.html');
  for (const file of ['favicon.ico', 'favicon.svg', 'manifest.webmanifest', 'apple-touch-icon.png']) {
    assert.ok(text.includes('/' + file)); await access(new URL('../../website/' + file, import.meta.url));
  }
  assert.match(text, /<iframe id="computer"/);
  assert.match(text, /<video id="film"[^>]*playsinline/);
  assert.match(text, /<h1 id="launchHeading" class="sr-only">imperfect: launch film and live computer<\/h1>/);
  assert.match(text, /<a class="keyboard-skip" id="skip" href="#computer">Skip to the computer<\/a>/);
  assert.match(text, /<div id="lockScreen" hidden>/);
  const view = await read('macos/lock.mjs');
  assert.match(view, /input.type = 'password'/);
  assert.match(view, /input.autocomplete = 'current-password'/);
  assert.match(view, /input.enterKeyHint = 'go'/);
  assert.match(view, /submit.type = 'submit'/);
  assert.match(view, /form.addEventListener\('submit'/);
  const pictures = text.match(/<img\b[^>]*>/g);
  const pointer = '<img class="mac-cursor" src="mac/cursor.png" alt="" aria-hidden="true">';
  assert.deepEqual(pictures.filter(img => img !== pointer), ['<img class="goat" id="goat" alt="" aria-hidden="true" decoding="async" hidden>'], 'only the goat and pointer are authored pictures; the shell creates the Dock');
  assert.equal(pictures.filter(img => img === pointer).length, 1, 'one pointer');
  assert.equal([...text.matchAll(/<iframe\b/g)].length, 2, 'only the real desktop and inert phone product documents');
  assert.match(text, /<iframe id="phoneComputer"[^>]*\binert\b/);
  assert.doesNotMatch(text, /mac\/app(?:\.html|\/)|browser-page|caption/);
  assert.doesNotMatch(text, /id="power"|Power on/, 'no power button');
  assert.doesNotMatch(text, /noah\.imperfect\.computer|\/door\/ticket/, 'no computer\'s address in the page: the locker gives it after the unlock');
  assert.doesNotMatch(text, /launchControls|id="own"|id="mute"|id="pause"|id="replay"/, 'no controls bar');
  assert.doesNotMatch(text, /AUD 40|AUD 400|offer-grid|painting-pair|hero-copy|srcdoc=|checkout\.stripe\.com/);
});
test('a boot framing change is versioned through every public module edge', async () => {
  const html = await read('index.html');
  const entry = html.match(/src="launch\.mjs\?v=([^"&]+)"/);
  assert.ok(entry, 'the HTML revalidates and selects a fresh launch entry');
  // The film and boot can have different revision keys; every changed edge still needs its own fresh URL.
  for (const [file, versionedImport] of [
    ['launch.mjs', /import\('\.\/intro\/intro\.mjs\?v=[^']+'\)/],
    ['intro/intro.mjs', /from '\.\.\/boot\/sequence\.mjs\?v=[^']+'/],
    ['boot/sequence.mjs', /from '\.\.\/opener\/framing\.mjs\?v=[^']+'/],
  ]) {
    assert.match(await read(file), versionedImport, `${file} must select the fresh boot dependency, not a cached unversioned module`);
  }
});
test('safe configurable real-app URL; no keys in URL or script/data protocols', () => {
  assert.equal(demoAddress('https://noah.imperfect.computer').origin, 'https://noah.imperfect.computer');
  assert.equal(demoAddress('http://localhost:4321').hostname, 'localhost');
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'https://a:b@example.test', 'http://example.test']) assert.throws(() => demoAddress(value));
});
test('production requires the exact real-product readiness handshake and origin', () => {
  assert.equal('demoUrl' in config, false, 'no computer in the page: the locker answers the unlock with it');
  assert.equal(config.demoReadyType, 'imperfect:demo-ready');
});
test('the locker\'s answer opens Noah\'s computer only with a plain https (or loopback) address', () => {
  const url = 'https://noah.imperfect.computer/door/ticket?t=a.b';
  assert.deepEqual(workbenchOf({ ok: true, workbench: { id: 'noah', url } }), { id: 'noah', url });
  assert.equal(workbenchOf({ ok: true, workbench: { id: 'x', url: 'http://localhost:4321/' } }).url, 'http://localhost:4321/');
  for (const answer of [null, {}, { ok: false }, { ok: true }, { ok: 'yes', workbench: { id: 'x', url } }, { ok: true, workbench: { id: 1, url } },
    ...['javascript:alert(1)', 'data:text/html,x', 'http://example.test', 'https://a:b@example.test', 'not a url'].map(bad => ({ ok: true, workbench: { id: 'x', url: bad } }))]) assert.equal(workbenchOf(answer), null);
});
test('ready handshake must match both source and exact origin/type', () => {
  const frame = { contentWindow: {} }, url = new URL('https://noah.imperfect.computer');
  const event = { source: frame.contentWindow, origin: url.origin, data: { type: 'imperfect:demo-ready' } };
  assert.equal(isDemoReady(event, frame, url, 'imperfect:demo-ready'), true);
  for (const patch of [{ source: {} }, { source: null }, { origin: 'https://evil.test' },
    { origin: 'https://sub.noah.imperfect.computer' }, { origin: 'https://noah.imperfect.computer:444' },
    { origin: 'http://noah.imperfect.computer' }, { origin: 'null' }, { data: { type: 'load' } }, { data: null }]) {
    assert.equal(isDemoReady({ ...event, ...patch }, frame, url, 'imperfect:demo-ready'), false);
  }
  assert.equal(isDemoReady(event, frame, url, null), false);
});
test('waitForMedia handles cached frame and fresh frame', async () => {
  const v = new Video(); v.readyState = 2; await waitForMedia(v);
  v.readyState = 0; const ready = waitForMedia(v); v.readyState = 2; v.dispatchEvent(new Event('loadeddata')); await ready;
});
test('waitForMedia error, timeout, cancellation never strand transitions', async () => {
  const v = new Video(); const p = waitForMedia(v); v.dispatchEvent(new Event('error')); await assert.rejects(p, /could not load/);
  await assert.rejects(waitForMedia(v, { timeoutMs: 1 }), /too long/);
  const abort = new AbortController(); const cancelled = waitForMedia(v, { signal: abort.signal }); abort.abort(); await assert.rejects(cancelled, { name: 'AbortError' });
  await assert.rejects(waitForMedia(v, { signal: abort.signal }), { name: 'AbortError' });
});
test('initial gesture primes same element MUTED, parks at zero, restores audio state', async () => {
  const v = new Video(); const primed = primeVideo(v);
  assert.equal(v.muted, true); assert.equal(v.volume, 1); assert.deepEqual(v.calls, ['play']);
  await primed;
  assert.deepEqual(v.calls, ['play','pause']); assert.equal(v.currentTime, 0); assert.equal(v.muted, false);
  v.muted = true; await primeVideo(v); assert.equal(v.muted, true, 'already muted stays muted');
});
test('stale primer cannot pause or rewind actual film after skip/replay', async () => {
  const v = new Video(); let resolve;
  v.play = () => new Promise(ok => { resolve = ok; });
  let current = true; const p = primeVideo(v, { isCurrent: () => current }); current = false;
  v.muted = false; v.volume = 1; v.currentTime = 4; resolve(); await p;
  assert.deepEqual(v.calls, []); assert.equal(v.currentTime, 4); assert.equal(v.volume, 1); assert.equal(v.muted, false);
});
test('blocked primer and play report rejection; playback is time-bounded and cancellable', async () => {
  const v = new Video(); v.play = () => Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
  await assert.rejects(primeVideo(v), { name: 'NotAllowedError' }); assert.equal(v.volume, 1); assert.equal(v.muted, false);
  await assert.rejects(playVideo(v), { name: 'NotAllowedError' });
  v.play = () => new Promise(() => {});
  await assert.rejects(playVideo(v, { timeoutMs: 1 }), /did not start/);
  const abort = new AbortController(); const p = playVideo(v, { signal: abort.signal }); abort.abort();
  await assert.rejects(p, { name: 'AbortError' });
});
test('mute gain does not change contact/envelope clock; failed audio still advances silently', async () => {
  let audio, gain, now = 0, starts = 0;
  class Context {
    constructor() { audio = this; this.state = 'running'; this.currentTime = 40; this.destination = {}; }
    createGain() { return gain = { gain: { value: 1 }, connect() {} }; }
    decodeAudioData() { return Promise.resolve({}); }
    resume() { return Promise.resolve(); }
    createBufferSource() { return { connect() {}, stop() {}, start() { starts++; } }; }
  }
  const sound = createPlayer({ Context, clock: () => now, fetcher: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }) });
  await sound.ready; await sound.prime(); assert.equal(starts, 0);
  sound.setMuted(true); sound.start(); audio.currentTime += 2;
  assert.equal(gain.gain.value, 0); assert.equal(sound.elapsed(), 2); assert.equal(sound.audible, false);
  sound.setMuted(false); assert.equal(gain.gain.value, 1); assert.equal(sound.elapsed(), 2); assert.equal(sound.audible, true);
  const silent = createPlayer({ Context: null, clock: () => now }); await silent.ready; silent.start(); now = BURST;
  assert.equal(silent.elapsed(), BURST); assert.equal(silent.audible, false);
});
test('reduced motion removes inter-screen fades', () => {
  assert.equal(fadeDuration(true, 650), 0); assert.equal(fadeDuration(false, 650), 650);
});

// ---- Film-to-product handoff: hidden real-product preload and painted assembly, with no document swap.
const ranges = list => ({ length: list.length, start: i => list[i][0], end: i => list[i][1] });
const playingAt = (currentTime, list, patch = {}) => ({ paused: false, ended: false, readyState: 4, currentTime, duration: 129.742, buffered: ranges(list), ...patch });
test('preload waits for ~10 s of actual playback and a buffer cushion, never during startup, pause or starvation', () => {
  const opts = { afterS: 10, aheadS: 15 };
  assert.equal(preloadDue(playingAt(0, [[0, 129.742]]), opts), false, 'not at startup, even fully buffered');
  assert.equal(preloadDue(playingAt(9.99, [[0, 129.742]]), opts), false);
  assert.equal(preloadDue(playingAt(10, [[0, 129.742]]), opts), true);
  assert.equal(preloadDue(playingAt(12, [[0, 129.742]], { paused: true }), opts), false, 'paused (button, hidden tab) never counts');
  assert.equal(preloadDue(playingAt(12, [[0, 129.742]], { ended: true }), opts), false);
  assert.equal(preloadDue(playingAt(12, [[0, 129.742]], { readyState: 2 }), opts), false, 'starving film keeps the network');
  assert.equal(preloadDue(playingAt(12, [[0, 18]]), opts), false, 'only 6 s buffered ahead');
  assert.equal(preloadDue(playingAt(12, [[0, 27]]), opts), true, '15 s buffered ahead');
  assert.equal(preloadDue(playingAt(12, [[0, 5], [11.8, 40]]), opts), true, 'the range holding the playhead counts');
  assert.equal(preloadDue(playingAt(12, [[0, 11], [20, 129.742]]), opts), false, 'a hole at the playhead does not');
  assert.equal(preloadDue(playingAt(120, [[0, 129.6]]), opts), true, 'buffered through the end of a short remainder');
  assert.equal(preloadDue(playingAt(12, [[0, 40]], { duration: NaN }), opts), true, 'unknown duration uses the cushion');
  assert.equal(preloadDue(playingAt(12, [[0, 129.742]], { buffered: undefined }), opts), false);
});
test('launch config: no film for now (the v8 trailer is archived), 10 s preload, 1.2 s handoff that reduced motion makes instant', () => {
  assert.equal(config.videoUrl, null, 'no film: the unlock goes straight to the Mac');
  assert.equal(config.cuesUrl, undefined, 'no hyperdrive cues without a film');
  assert.equal(config.unlockMs, 600); assert.equal('powerMs' in config, false); assert.equal(config.scrollHint, true); assert.equal(config.hintAfterMs, 4000);
  assert.equal(fadeDuration(true, config.unlockMs), 0);
  assert.equal(config.preloadAfterS, 10); assert.equal(config.preloadAheadS, 15);
  assert.equal(config.handoffMs, 1200); assert.equal(config.fadeMs, 650); assert.equal(config.demoTimeoutMs, 15000);
  assert.equal(fadeDuration(true, config.handoffMs), 0); assert.equal(fadeDuration(false, config.handoffMs), 1200);
});
test('film lifts only after real bare assembly; one document is presented without a swap', async () => {
  const text = await read('launch.mjs'), show = functionSource(text, 'showMac');
  assert.match(text, /createMac\(\{[^}]*onstage:\s*assemble[^}]*onfinish:\s*finishMac/);
  assert.match(text, /video\.addEventListener\('ended',\s*\(\)\s*=>\s*\{[^}]*phase === 'film'[^}]*showMac\(\)/);
  assertBefore(show, "waitForAssembly('bare'", 'await mac.reveal()', 'real product paints before the film lifts');
  assertBefore(show, 'await mac.reveal()', 'mac.play()', 'the blind lifts before the build starts');
  assert.match(show, /visible\(filmScreen,\s*false\)/);
  assert.doesNotMatch(show, /visible\(demoScreen,\s*true\)|revealLive\(/);
  const finish = functionSource(text, 'finishMac'), reveal = functionSource(text, 'revealLive');
  assert.match(finish, /ending\s*=\s*true/);
  assert.doesNotMatch(finish, /grow|delay|fade|frame\.src\s*=/);
  assertBefore(finish, 'mac.finish()', 'endingReady = true', 'only the completed build enables interactivity');
  const present = functionSource(text, 'presentBuild');
  assert.match(present, /!demoVerified\s*\|\|\s*!paintedStep/);
  assert.match(present, /demoScreen\.inert = !endingReady/);
  assert.match(present, /mac\.present\(true\)/);
  assert.match(reveal, /!endingReady\s*\|\|\s*!demoVerified\s*\|\|\s*paintedStep !== 'done'/);
  assert.match(reveal, /presentBuild\(\)/);
  assert.match(reveal, /mac\.live\(true\)/);
  assert.equal([...text.matchAll(/visible\(demoScreen,\s*true\)/g)].length, 1, 'one guarded presentation path');
  assert.equal([...text.matchAll(/demoVerified\s*=\s*true/g)].length, 1, 'only the exact handshake verifies');
  const request = functionSource(text, 'requestDemo'), preload = functionSource(text, 'preloadDemo');
  assert.match(preload, /phase !== 'film'\s*\|\|\s*document\.hidden\s*\|\|\s*stallTimer !== null/);
  assert.match(preload, /preloadDue\(video,/);
  assert.match(preload, /requestDemo\(\)/);
  assert.match(request, /await remembered\(\)/, 'refresh the short-lived ticket just before navigation');
  assert.match(request, /bench\?\.id !== workbench\.id/, 'refresh cannot switch computers');
  assert.match(request, /frame\.src\s*=\s*demo\.href/);
  assert.doesNotMatch(preload + request, /visible\(demoScreen,\s*true\)|demoVerified\s*=\s*true|revealLive\(/);
  assert.equal([...text.matchAll(/frame\.src\s*=/g)].length, 1, 'only initial load or explicit retry can navigate the existing iframe');
  assert.doesNotMatch(text + await read('mac/desktop.mjs') + await read('mac/phone.mjs'), /srcdoc|app\.html|replaceChild|replaceWith|frame\.remove\(|append\(frame\)/, 'never replace, detach or simulate either real app');
  const shell = await read('mac/shell.mjs');
  assert.doesNotMatch(shell, /frame\.(?:src\s*=|remove\(|replaceWith\()|appWindow\.(?:remove\(|replaceChildren\(|replaceWith\()|(?:append|prepend|replaceChildren)\(frame\)/, 'closing, minimizing, zooming and restoring must preserve the same iframe document');
});
test('unreachable computers have an honest live error and explicit Retry, never a fake preview', async () => {
  const text = await read('launch.mjs'), mac = await read('mac/desktop.mjs'), html = await read('index.html');
  assert.match(functionSource(text, 'finishMac'), /if\s*\(demoVerified && paintedStep === 'done'\)\s*revealLive\(\);\s*else\s*\{\s*mac\.offline\(\)/);
  assert.match(text, /\$\('macRetry'\)\.addEventListener\('click',\s*\(\)\s*=>\s*requestDemo\(\)\)/);
  assert.match(html, /class="mac-offline"[^>]*role="status"[^>]*hidden/);
  assert.match(html, /Your computer is not available yet\./);
  assert.match(html, /id="macRetry"[^>]*>Try again<\/button>/);
  assert.doesNotMatch(html, /preview is still here|app\.html|srcdoc/);
  assert.match(functionSource(mac, 'offline'), /\.hidden\s*=\s*false/);
  assert.doesNotMatch(functionSource(mac, 'setLive') + functionSource(mac, 'present'), /\.src\s*=|\.remove\(/);
});
test('the new phone voice joins the seven unchanged measured goat lines at .8 speed', async () => {
  const lines = [INTRO, ...STEPS], manifest = JSON.parse(await read('mac/sounds/voice.json'));
  const originals = lines.filter(line => !line.phone);
  assert.deepEqual(lines.map(s => s.text), [
    "This is a Mac. And this is imperfect. Let's build it.", 'Drop in Claude Code.', 'Then ChatGPT.', 'Your files.', 'And a browser.',
    "And it's on your phone.", "Now that software is one sentence away, you don't need apps other people made.", "It's yours.",
  ]);
  assert.equal(manifest.voice, 'VMXigKbZ87s0JTqCj2sl');
  assert.equal(manifest.lines.length, 8);
  assert.deepEqual(STEPS.map(s => s.build ?? null), ['claude', 'codex', 'files', 'browser', null, null, 'done']);
  assert.deepEqual(STEPS.map(s => s.apps ?? []), [['claude'], ['chatgpt'], ['finder'], ['safari'], [], ['final-cut', 'imovie', 'notes'], []]);
  assert.equal(STEPS[4].phone, true); assert.equal(STEPS[5].trash, true);
  assert.equal(STEPS[4].voice, 'mac/sounds/line-phone.m4a');
  assert.equal(VOICE_RATE, .8);
  assert.deepEqual(originals.map(line => line.durationMs), [4720, 1680, 1840, 1200, 1120, 4720, 1120], 'the original seven recordings keep their measured timings');
  assert.deepEqual(originals.map(line => line.voice), Array.from({ length: 7 }, (_, i) => `mac/sounds/line-${i}.m4a`));
  assert.deepEqual(originals.map(line => manifest.lines.find(row => row.voice === line.voice)?.speechEndMs), [4800, 1760, 1920, 1040, 1120, 4800, 1120], 'the seven original voice records are unchanged');
  const hashes = [
    '726f227f57ae4970712d82a4f6d78319ba8ebc12aa01a09f4e537c250e17062b',
    '2cc37343cfdc98712ccc7ac247b7c32e96175a211c663fd1786748ee3152512e',
    '3f9707a39ea3fdef923e7bafd05a3f3fba9bfb0f18c4c23cf3ba24ec87736b46',
    'c676fdf6541bbba9fd873e852ebadef08ead01c2809e3d604c2ab6bd3db80275',
    '40021685ce92a38fc860202c77e55ce3867952e69db996f3497afb1a38ae95fd',
    'cd3ea93a493c11803d485dba5d3bbcd84591603a34ca10af1ae9d16f1a4cdac6',
    'cb089676bc1186ed4efca775f33d0f598a74f51df1216ccd4af887a5ba28bb86',
  ];
  for (const [i, line] of originals.entries()) {
    const bytes = await readFile(new URL('../../website/' + line.voice, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hashes[i], `${line.voice}: original recording is byte-for-byte unchanged`);
  }
  let total = 0;
  for (const line of lines) {
    const measured = m4aDurationMs(await readFile(new URL('../../website/' + line.voice, import.meta.url)));
    assert.ok(Math.abs(line.durationMs - measured) < 2, `${line.voice}: ${line.durationMs} ms matches its actual ${measured} ms audio`);
    const record = manifest.lines.find(row => row.voice === line.voice);
    assert.equal(record?.text, line.text);
    assert.equal(record?.durationMs, line.durationMs);
    total += measured / VOICE_RATE;
  }
  assert.ok(total > 22000 && total < 28000, `${total} ms of speech leaves room for travel and a brief phone beat`);
  assert.deepEqual((await readdir(new URL('../../website/mac/sounds/', import.meta.url))).filter(n => /^line-.*\.m4a$/.test(n)).sort(), lines.map(line => line.voice.split('/').at(-1)).sort());
  const mac = await read('mac/desktop.mjs');
  assert.match(mac, /voicePlayer\.playbackRate\s*=\s*VOICE_RATE/);
  const sound = functionSource(mac, 'sound');
  assert.match(sound, /addEventListener\('ended'/);
  assert.match(sound, /voicePlayer\.currentTime\s*\*\s*1000\s*\/\s*line\.durationMs/, 'flight follows the audio clock, not a second unsynchronised timer');
  assert.match(sound, /line\.durationMs\s*\/\s*VOICE_RATE/, 'silent failure uses the same slowed duration');
  assertBefore(functionSource(mac, 'intoWindow'), 'await spoken.done', 'drop(', 'the option lands when the actual voice ends');
});
test('the native 1600x900 desktop is uniformly contained; only the separate phone frame uses phone layout', async () => {
  assert.deepEqual(SCREEN, { w: 1600, h: 900 });
  assert.deepEqual(WINDOW_DEFAULT, { x: 160, y: 25, width: 1280, height: 796 });
  assert.deepEqual(DESKTOP_BAND, { x: 0, y: 25, width: 1600, height: 796 });
  const css = await read('mac/desktop.css'), mac = await read('mac/desktop.mjs'), sequence = await read('sequence.css');
  assert.match(css, /\.mac-window\s*\{[^}]*left:\s*160px;[^}]*top:\s*25px;[^}]*width:\s*1280px;[^}]*height:\s*796px/);
  assert.match(await read('mac/shell.css'), /\.mac \.shell-dock\s*\{[^}]*height:\s*72px;[^}]*bottom:\s*6px/);
  assert.match(await read('mac/phone.css'), /#phoneComputer\s*\{[^}]*width:\s*390px;[^}]*height:\s*844px;[^}]*pointer-events:\s*none/);
  assert.match(css, /\.mac\.screen\s*\{[^}]*left:\s*50%;[^}]*top:\s*50%;[^}]*width:\s*1600px;[^}]*height:\s*900px/);
  assert.match(css, /transform:\s*translate\(-50%,\s*-50%\) scale\(var\(--scale\)\)/);
  assert.match(functionSource(mac, 'fit'), /Math\.min\(innerWidth\s*\/\s*SCREEN\.w,\s*innerHeight\s*\/\s*SCREEN\.h\)/);
  assert.doesNotMatch(css, /max-width:|max-height:|orientation:|stage-phone|data-grown|\.mac\[data-live="true"\]/);
  assert.match(css, /\.mac-window \.demo\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*transition:\s*none/);
  assert.match(css, /\.mac-window \.demo iframe\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*transform:\s*none;[^}]*pointer-events:\s*auto/);
  assert.match(functionSource(mac, 'localRect'), /stage\.width\s*\/\s*SCREEN\.w/);
  assert.match(sequence, /@media \(prefers-reduced-motion: reduce\) \{ :root \{ --fade: 0ms; --handoff: 0ms; --unlock: 0ms; \}/);
});

// Small event/DOM doubles exercise the actual parent protocol without a browser
// or a connection to Noah's computer. Only rendering/media dependencies are stubbed.
class Signals {
  listeners = new Map();
  addEventListener(type, fn) { const rows = this.listeners.get(type) || new Set(); rows.add(fn); this.listeners.set(type, rows); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn(event); }
  dispatchEvent(event) { this.emit(event.type, event); return true; }
}
class ElementDouble extends Signals {
  dataset = {}; style = { transform: '', setProperty(name, value) { this[name] = value; } }; attributes = {}; inert = true; hidden = true; textContent = '';
  classList = { add() {}, remove() {} };
  children = new Map();
  querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new ElementDouble()); return this.children.get(selector); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return name === 'src' ? this.src : this.attributes[name] ?? null; }
  focus() { this.focused = true; }
  pause() {} load() {} blur() {}
}
// film: a configured film (none is, now): the same machinery, with its own address and cues.
const FILM = { videoUrl: 'https://imperfect.computer/media/film.mp4?v=0123abcd', cuesUrl: 'https://imperfect.computer/media/cues.json?v=0123abcd' };
async function parentHarness({ reduced = false, film = false, site = 'imperfect' } = {}) {
  const elements = new Map(), signals = new Signals(), posts = [], timers = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, new ElementDouble()); return elements.get(id); };
  let bench = null, now = 0, timerID = 0, navigations = 0, src, phoneSrc, phoneNavigations = 0, ticketRequests = 0, lockOptions;
  const frame = el('computer'), phoneFrame = el('phoneComputer'), phonePosts = [];
  const video = el('film'), videoCalls = [], fetched = [], phases = [];
  video.play = () => { videoCalls.push(video.muted ? 'play muted' : 'play'); video.paused = false; return Promise.resolve(); };
  video.pause = () => { videoCalls.push('pause'); video.paused = true; };
  signals.addEventListener('imperfect:sequence', event => phases.push(event.detail.phase));
  frame.contentWindow = { postMessage(data, origin) { posts.push({ data: JSON.parse(JSON.stringify(data)), origin }); } };
  phoneFrame.contentWindow = { postMessage(data, origin) { phonePosts.push({ data: JSON.parse(JSON.stringify(data)), origin }); } };
  Object.defineProperty(frame, 'src', { get: () => src, set(value) { src = value; navigations++; } });
  Object.defineProperty(phoneFrame, 'src', { get: () => phoneSrc, set(value) { phoneSrc = value; phoneNavigations++; } });
  const macCalls = [], mac = {};
  for (const name of ['prime', 'prepare', 'reveal', 'play', 'finish', 'present', 'live', 'offline']) mac[name] = (...args) => { macCalls.push([name, ...args]); };
  let callbacks, shopOptions;
  mac.complete = () => callbacks.onstage('done');
  mac.state = () => ({});
  const context = vm.createContext({
    console, URL, AbortController, CustomEvent, config: film ? { ...config, ...FILM } : config, demoAddress, isDemoReady, preloadDue, fadeDuration,
    waitForMedia, primeVideo, playVideo, firstVideoFrame: async () => {},
    // The unlock's desktop and QuickTime film (macos/launch.mjs) end, as the real one does, in showMac (onfinish).
    createMacLaunch: options => ({ prime() {}, stop() {}, state: () => ({}), enter() { options.onfinish?.(); } }),
    createLock: options => { lockOptions = options; return { state: 'locked', show() {}, checking() {}, wrong() {}, open() {}, leave() {}, hide() {} }; },
    remembered: async () => { ticketRequests++; return bench; }, unlock: async () => bench,
    createMac: options => { callbacks = options; return mac; }, initShell() {}, initShop(options) { shopOptions = options; }, setTrash() {}, setDockIcon() {},
    // imperfect.computer's page (website/variant.mjs); kinso.computer's own pieces are never loaded here.
    variant: VARIANTS[site], MACOS,
    createFilmLayer: () => ({ stop() {}, start() {}, state: () => ({}), mode: 'plain' }),
    performance: { now: () => ++now }, matchMedia: () => ({ matches: reduced, addEventListener() {} }),
    location: { href: 'https://imperfect.computer/' },
    fetch: async url => { fetched.push(String(url)); return { ok: false }; },
    setTimeout: fn => { const id = ++timerID; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    document: Object.assign(new Signals(), { getElementById: el, querySelector: el, body: el('body'), documentElement: el('root'), hidden: false }),
    addEventListener: signals.addEventListener.bind(signals), dispatchEvent: signals.dispatchEvent.bind(signals),
  });
  context.window = context;
  const text = (await read('launch.mjs')).replace(/^import .*;\n/gm, '').replace(/import\('\.\/intro\/intro\.mjs[^']*'\)/, 'new Promise(() => {})')
    .replace(/await import\('\.\/for-kinso\/site\.mjs[^']*'\)/, 'null');
  const phoneSource = (await read('mac/phone.mjs')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(phoneSource + '\n' + text + '\nwindow.unit = { opened, requestDemo, assemble, finishMac, openComputer, gaveUp };', context);
  await Promise.resolve(); await Promise.resolve();
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    el, frame, phoneFrame, posts, phonePosts, macCalls, timers, api: context.unit, video, videoCalls, fetched, phases, settle,
    // The opener gives way to the lock; then the visitor presses (the gesture) and the locker says yes.
    async unlock() { context.unit.gaveUp(); lockOptions.onsubmit('password'); await settle(); },
    state: () => JSON.parse(JSON.stringify(context.__launch())), navigations: () => navigations, lockOptions: () => lockOptions,
    phoneNavigations: () => phoneNavigations, ticketRequests: () => ticketRequests,
    phone: spoken => callbacks.onphone(spoken),
    requestShop: url => shopOptions.open(url),
    setBench(value) { bench = value; },
    message(data, patch = {}) { signals.emit('message', { data, source: frame.contentWindow, origin: 'https://noah.imperfect.computer', ...patch }); },
    phoneMessage(data, patch = {}) { signals.emit('message', { data, source: phoneFrame.contentWindow, origin: 'https://noah.imperfect.computer', ...patch }); },
  };
}
const ticket = { id: 'noah', url: 'https://noah.imperfect.computer/door/ticket?t=unit-only' };
async function loadedParent(options) {
  const h = await parentHarness(options); h.setBench(ticket); h.api.opened(ticket); await h.api.requestDemo(); return h;
}

test('parent assembly requires the exact live source/origin and ready type, then monotonic painted acknowledgments', async () => {
  const h = await loadedParent();
  assert.equal(h.navigations(), 1); assert.equal(h.el('demoScreen').dataset.visible, 'false');
  for (const patch of [{ source: {} }, { source: null }, { origin: 'null' }, { origin: 'http://noah.imperfect.computer' },
    { origin: 'https://sub.noah.imperfect.computer' }, { origin: 'https://noah.imperfect.computer:444' }, { origin: 'https://evil.test' }]) {
    h.message({ type: 'imperfect:demo-ready' }, patch); h.message({ type: 'imperfect:assembled', step: 'bare' }, patch);
  }
  for (const type of ['load', 'ready', 'imperfect:assembled', 'imperfect:assemble']) h.message({ type, step: 'bare' });
  assert.equal(h.state().demoVerified, false); assert.equal(h.posts.length, 0);
  h.frame.emit('load');
  assert.equal(h.state().demoVerified, false, 'load is not the handshake');
  h.message({ type: 'imperfect:demo-ready' });
  assert.deepEqual(h.posts, [{ data: { type: 'imperfect:assemble', step: 'bare' }, origin: 'https://noah.imperfect.computer' }]);
  assert.equal(h.el('demoScreen').dataset.visible, 'false', 'ready without painted bare is not visible');
  h.message({ type: 'imperfect:assembled', step: 'done' });
  assert.equal(h.state().assembly.painted, null, 'unsolicited future acknowledgment is rejected');
  h.message({ type: 'imperfect:assembled', step: 'bare' });
  assert.equal(h.el('demoScreen').dataset.visible, 'true'); assert.equal(h.el('demoScreen').inert, true);
  const waiting = h.api.assemble('claude');
  for (const patch of [{ source: {} }, { origin: 'https://evil.test' }]) h.message({ type: 'imperfect:assembled', step: 'claude' }, patch);
  h.message({ type: 'imperfect:assemble', step: 'claude' });
  h.message({ type: 'imperfect:assembled', step: 'codex' });
  assert.equal(h.state().assembly.painted, 'bare');
  h.message({ type: 'imperfect:assembled', step: 'claude' }); assert.equal(await waiting, true);
  const count = h.posts.length;
  assert.equal(await h.api.assemble('bare'), false); assert.equal(await h.api.assemble('kinso'), false);
  assert.equal(h.posts.length, count);
  h.message({ type: 'imperfect:assembled', step: 'bare' });
  assert.equal(h.state().assembly.painted, 'claude', 'late paint cannot regress');
  const done = h.api.assemble('done'); h.message({ type: 'imperfect:assembled', step: 'done' }); await done;
  await h.api.finishMac();
  assert.equal(h.state().phase, 'demo'); assert.equal(h.el('demoScreen').inert, false);
  assert.equal(h.navigations(), 1, 'bare through done never swaps or reloads the frame');
  assert.ok(h.state().assembly.history.every(row => row.paintedAt >= row.sentAt));
});

test('the parent loads the phone only after primary authentication, never spends another ticket, and isolates both handshakes', async () => {
  const h = await loadedParent(), requests = h.ticketRequests();
  assert.equal(h.phoneNavigations(), 0, 'the primary cookie must be established before phone navigation');
  h.message({ type: 'imperfect:demo-ready' }, { source: {} }); assert.equal(h.phoneNavigations(), 0);
  h.message({ type: 'imperfect:demo-ready' });
  assert.equal(h.phoneNavigations(), 1);
  assert.equal(h.phoneFrame.src, 'https://noah.imperfect.computer/?face=code&launch=phone');
  assert.equal(h.ticketRequests(), requests, 'the second document uses the existing origin cookie, not remembered/unlock again');
  const primaryPosts = h.posts.length;
  h.phoneMessage({ type: 'imperfect:assembled', step: 'done' });
  assert.equal(h.state().phone.ready, false);
  h.phoneMessage({ type: 'imperfect:demo-ready' }, { source: h.frame.contentWindow, origin: 'https://evil.test' });
  assert.equal(h.state().phone.verified, false);
  h.phoneMessage({ type: 'imperfect:demo-ready' });
  assert.deepEqual(h.phonePosts, [{ data: { type: 'imperfect:assemble', step: 'done' }, origin: 'https://noah.imperfect.computer' }]);
  assert.equal(h.posts.length, primaryPosts, 'phone readiness cannot resend or advance primary assembly');
  h.phoneMessage({ type: 'imperfect:assembled', step: 'done' }, { source: h.frame.contentWindow });
  assert.equal(h.state().phone.ready, false);
  h.phoneMessage({ type: 'imperfect:assembled', step: 'done' });
  assert.equal(h.state().phone.ready, true);
  assert.equal(h.state().assembly.painted, null, 'a phone paint can never stand in for the desktop paint');
  h.message({ type: 'imperfect:assembled', step: 'bare' });
  const done = h.api.assemble('done'); h.message({ type: 'imperfect:assembled', step: 'done' }); await done; await h.api.finishMac();
  assert.equal(h.el('demoScreen').inert, false); assert.equal(h.phoneFrame.inert, true, 'done enables only the desktop document');
  assert.equal(h.navigations(), 1); assert.equal(h.phoneNavigations(), 1); assert.equal(h.ticketRequests(), requests);
  assert.ok([...h.posts, ...h.phonePosts].every(row => row.data.type === 'imperfect:assemble'), 'the parent never sends tab-new or prompt commands to either document');
});

test('the minimal Shop bridge carries the visitor OS rather than the hosted computer OS', async () => {
  const source = (await read('shop.mjs')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(source + '\nglobalThis.shopURL = visitorShopURL; globalThis.shopInit = initShop;', context);
  assert.equal(context.shopURL({ platform: 'MacIntel' }, '?for=kinso'), 'https://kinso.computer/kinso/', 'a link made for Kinso stays on its concept site');
  assert.equal(context.shopURL({ platform: 'MacIntel' }, '?for=elsewhere'), 'https://imperfect.computer/shop?os=mac', 'an unknown company is the plain Shop');
  for (const [visitor, os] of [
    [{ platform: 'MacIntel' }, 'mac'], [{ userAgentData: { platform: 'macOS' } }, 'mac'],
    [{ platform: 'Linux x86_64' }, 'linux'], [{ platform: 'Win32' }, 'windows'],
    [{ userAgent: 'Mozilla/5.0 (iPhone)' }, 'mobile'], [{ platform: 'MacIntel', maxTouchPoints: 5 }, 'mobile'],
    [{ userAgentData: { platform: 'Android', mobile: true } }, 'mobile'],
  ]) {
    assert.equal(context.shopURL(visitor), `https://imperfect.computer/shop?os=${os}`);
    assert.equal(detectOS(visitor), os, 'the independent launch bridge and public store agree on visitor OS names');
  }
  const win = new Signals(), calls = []; win.navigator = { platform: 'MacIntel' };
  const bridge = context.shopInit({ win, restore: () => calls.push('restore'), open: url => calls.push(url) });
  win.emit('mac:shop');
  assert.deepEqual(calls, ['restore'], 'the main window restores before sending into its product');
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['restore', 'https://imperfect.computer/shop?os=mac']);
  bridge.dispose(); win.emit('mac:shop'); await new Promise(setImmediate);
  assert.equal(calls.length, 2, 'disposing the bridge removes the menu handler');
});

test('Shop opens only in the authenticated primary product after done, never in the phone or another window', async () => {
  const h = await loadedParent();
  const url = 'https://imperfect.computer/shop?os=mac';
  const opens = () => h.posts.filter(row => row.data.type === 'imperfect:open');
  h.frame.emit('load');
  h.requestShop(url); await new Promise(setImmediate);
  assert.equal(opens().length, 0, 'an unverified primary cannot receive Shop');
  h.phoneMessage({ type: 'imperfect:demo-ready' });
  h.phoneMessage({ type: 'imperfect:assembled', step: 'done' });
  await new Promise(setImmediate);
  assert.equal(opens().length, 0, 'phone authentication and paint cannot authorise primary browser commands');
  h.message({ type: 'imperfect:demo-ready' });
  h.message({ type: 'imperfect:assembled', step: 'bare' });
  h.requestShop(url); await new Promise(setImmediate);
  assert.equal(opens().length, 0, 'bare is not the finished interactive product');
  const done = h.api.assemble('done'); h.message({ type: 'imperfect:assembled', step: 'done' }); await done;
  await h.api.finishMac(); await new Promise(setImmediate);
  const before = opens().length, phonePosts = h.phonePosts.length;
  await h.requestShop(url);
  assert.equal(opens().length, before + 1);
  assert.deepEqual(opens().at(-1), { data: { type: 'imperfect:open', url }, origin: 'https://noah.imperfect.computer' });
  await h.requestShop(url);
  assert.equal(opens().length, before + 2, 'each explicit menu request can foreground the same Shop tab');
  assert.equal(h.phonePosts.length, phonePosts, 'Shop never sends an open command to the inert phone document');
  assert.equal(h.navigations(), 1, 'Shop does not replace or reload the authenticated product iframe');
  h.frame.emit('load');
  const previous = opens().length;
  h.requestShop(url); await new Promise(setImmediate);
  assert.equal(opens().length, previous, 'navigation revokes permission to open Shop until readiness and done are earned again');
});

test('live navigation/error revokes readiness; Retry reauthenticates the same frame and cannot switch computers', async () => {
  const h = await loadedParent(), sameFrame = h.frame;
  h.frame.emit('load'); h.message({ type: 'imperfect:demo-ready' }); h.message({ type: 'imperfect:assembled', step: 'bare' });
  h.frame.emit('load');
  assert.equal(h.state().demoVerified, false); assert.equal(h.state().assembly.painted, null);
  assert.equal(h.el('demoScreen').dataset.visible, 'false');
  h.message({ type: 'imperfect:assembled', step: 'bare' }); assert.equal(h.state().assembly.painted, null);
  await h.api.finishMac(); assert.ok(h.macCalls.some(([name]) => name === 'offline'));
  h.frame.emit('error'); assert.equal(h.el('demoScreen').dataset.visible, 'false');
  h.el('macRetry').emit('click'); await new Promise(setImmediate);
  assert.equal(h.navigations(), 2); assert.equal(h.el('computer'), sameFrame);
  assert.equal(h.state().demoVerified, false, 'retry navigation must earn a fresh handshake and paint');
  h.setBench({ ...ticket, id: 'someone-else' }); await h.api.requestDemo();
  assert.equal(h.navigations(), 2, 'remembered cookie cannot redirect a ticket to a different computer');
});

test('a verified document with a timed-out done paint exposes live Retry instead of silently stranding the build', async () => {
  const h = await loadedParent();
  h.message({ type: 'imperfect:demo-ready' }); h.message({ type: 'imperfect:assembled', step: 'bare' });
  const waiting = h.api.assemble('done');
  [...h.timers.values()].at(-1)();
  assert.equal(await waiting, false, 'simulate the bounded assembly timeout, not a failed origin check');
  await h.api.finishMac();
  assert.ok(h.macCalls.some(([name]) => name === 'offline'), 'missing done paint needs the honest Retry fallback even when ready was verified');
  assert.notEqual(h.state().phase, 'demo');
  h.message({ type: 'imperfect:assembled', step: 'done' });
  assert.equal(h.state().phase, 'demo', 'a late authenticated paint recovers on the same document');
  assert.equal(h.navigations(), 1);
});

test('keyboard skip requests done on the same frame, while reduced motion starts with done', async () => {
  const h = await loadedParent();
  h.message({ type: 'imperfect:demo-ready' });
  let prevented = false;
  h.el('skip').emit('click', { preventDefault() { prevented = true; } });
  await Promise.resolve();
  assert.equal(prevented, true); assert.equal(h.state().assembly.desired, 'done');
  assert.equal(h.posts.at(-1).data.step, 'done');
  h.message({ type: 'imperfect:assembled', step: 'done' });
  await new Promise(setImmediate);
  assert.equal(h.state().phase, 'demo'); assert.equal(h.navigations(), 1);
  const reduced = await loadedParent({ reduced: true });
  reduced.message({ type: 'imperfect:demo-ready' });
  assert.equal(reduced.posts[0].data.step, 'done');
  assert.equal(reduced.phoneNavigations(), 0, 'reduced motion never loads the unused phone document');
  const initiallySkipped = await loadedParent();
  initiallySkipped.el('skip').emit('click', { preventDefault() {} });
  initiallySkipped.message({ type: 'imperfect:demo-ready' });
  assert.equal(initiallySkipped.posts[0].data.step, 'done');
  initiallySkipped.message({ type: 'imperfect:assembled', step: 'done' });
  await new Promise(setImmediate);
  assert.equal(initiallySkipped.state().phase, 'demo');
  assert.equal(initiallySkipped.phoneNavigations(), 0, 'an initial skip does not load the unused phone document');
});

const built = h => h.macCalls.map(([name]) => name).filter(name => ['reveal', 'play'].includes(name));
test('with no film the unlock goes straight to the Mac: nothing downloaded or primed, the product asked for at once, the sky kept until the Mac rises', async () => {
  const h = await parentHarness(); h.setBench(ticket); h.el('introScreen').hidden = false;
  assert.equal(h.video.src, undefined, 'the video is given no film, so nothing is downloaded'); assert.deepEqual(h.fetched, [], 'and no cues');
  await h.unlock();
  assert.deepEqual(h.phases, ['ready', 'unlocking', 'mac'], 'no film phases');
  assert.deepEqual(h.videoCalls, [], 'the press primes no film'); assert.ok(h.macCalls.some(([name]) => name === 'prime'), 'only the build voices');
  assert.equal(h.navigations(), 1, 'the real product is asked for at once');
  assert.equal(h.el('introScreen').hidden, false, 'the sky stays while it loads'); assert.deepEqual(built(h), [], 'the Mac waits for the real product');
  assert.equal(h.el('prompt').hidden, true); assert.equal(h.el('action').hidden, true, 'no Play film button');
  h.message({ type: 'imperfect:demo-ready' });
  assert.deepEqual(h.posts.map(row => row.data.step), ['bare']); assert.equal(h.phoneNavigations(), 1, 'the phone beat is prepared, as after the film');
  h.message({ type: 'imperfect:assembled', step: 'bare' }); await h.settle();
  assert.deepEqual(built(h), ['reveal', 'play'], 'then the Mac rises and the build begins');
  assert.equal(h.el('introScreen').hidden, true, 'the sky goes with the curtain');
  assert.equal(h.navigations(), 1); assert.equal(h.state().demoPreloadAt, null); assert.deepEqual(h.videoCalls, []);
  assert.match(functionSource(await read('launch.mjs'), 'showMac'), /intro\?\.quiet\(\);[^\n]*setPhase\('mac'\)/, 'the opener\'s sound ends at the unlock, where the film began');
  const reduced = await parentHarness({ reduced: true }); reduced.setBench(ticket); await reduced.unlock();
  assert.equal(reduced.state().phase, 'mac'); reduced.message({ type: 'imperfect:demo-ready' });
  assert.deepEqual(reduced.posts.map(row => row.data.step), ['done'], 'reduced motion: the finished computer'); assert.equal(reduced.phoneNavigations(), 0);
  reduced.message({ type: 'imperfect:assembled', step: 'done' }); await reduced.settle();
  assert.deepEqual(built(reduced), ['reveal', 'play']); assert.deepEqual(reduced.videoCalls, []);
  const skipped = await parentHarness(); skipped.setBench(ticket);
  skipped.el('skip').emit('click', { preventDefault() {} }); await skipped.unlock();
  skipped.message({ type: 'imperfect:demo-ready' }); skipped.message({ type: 'imperfect:assembled', step: 'done' }); await skipped.settle();
  assert.deepEqual(skipped.phases, ['ready', 'unlocking', 'mac', 'demo'], 'skipped: straight to the finished computer');
  assert.equal(skipped.phoneNavigations(), 0); assert.ok(!skipped.videoCalls.some(call => call.startsWith('play')));
});

async function phoneHarness({ reduced = false } = {}) {
  let now = 0, nextTimer = 0, src, navigations = 0;
  const signals = new Signals(), stage = new ElementDouble(), device = new ElementDouble(), frame = new ElementDouble(), appWindow = new ElementDouble();
  const timers = new Map(), posts = [], events = [];
  appWindow.style.transform = 'translateY(7px)';
  frame.contentWindow = { postMessage(data, origin) { posts.push({ data: JSON.parse(JSON.stringify(data)), origin }); } };
  Object.defineProperty(frame, 'src', { get: () => src, set(value) { src = value; navigations++; } });
  stage.addEventListener('imperfect:phone', event => events.push(JSON.parse(JSON.stringify(event.detail))));
  const context = vm.createContext({ URL, CustomEvent, AbortController, demoAddress, isDemoReady,
    performance: { now: () => now }, addEventListener: signals.addEventListener.bind(signals),
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id), stage, device, frame, appWindow, reduced: { matches: reduced },
  });
  const text = (await read('mac/phone.mjs')).replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(text + '\nglobalThis.phone = createPhone({ stage, device, frame, appWindow, reduced });', context);
  return { phone: context.phone, stage, device, frame, appWindow, posts, events,
    navigations: () => navigations,
    message(data, patch = {}) { signals.emit('message', { data, source: frame.contentWindow, origin: 'https://noah.imperfect.computer', ...patch }); },
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn();
        for (let i = 0; i < 6; i++) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 6; i++) await Promise.resolve();
    },
  };
}

test('the real phone frame reuses the primary origin cookie and earns its own exact-source ready and done paint', async () => {
  const h = await phoneHarness();
  h.phone.prepare('https://noah.imperfect.computer');
  assert.equal(h.frame.src, 'https://noah.imperfect.computer/?face=code&launch=phone');
  assert.equal(new URL(h.frame.src).searchParams.has('t'), false, 'no second ticket or credential in the phone URL');
  assert.equal(h.frame.inert, true);
  h.frame.emit('load');
  h.message({ type: 'imperfect:assembled', step: 'done' });
  assert.equal(h.phone.state().ready, false, 'paint before the exact ready handshake cannot enable the phone');
  for (const patch of [{ source: {} }, { source: null }, { origin: 'null' }, { origin: 'https://evil.test' },
    { origin: 'http://noah.imperfect.computer' }, { origin: 'https://sub.noah.imperfect.computer' }, { origin: 'https://noah.imperfect.computer:444' }]) {
    h.message({ type: 'imperfect:demo-ready' }, patch);
    h.message({ type: 'imperfect:assembled', step: 'done' }, patch);
  }
  assert.equal(h.phone.state().verified, false); assert.equal(h.posts.length, 0);
  h.message({ type: 'imperfect:demo-ready' });
  assert.deepEqual(h.posts, [{ data: { type: 'imperfect:assemble', step: 'done' }, origin: 'https://noah.imperfect.computer' }]);
  for (const step of ['bare', 'browser', 'phone', null]) h.message({ type: 'imperfect:assembled', step });
  assert.equal(h.phone.state().ready, false);
  h.message({ type: 'imperfect:assembled', step: 'done' }, { source: {} });
  assert.equal(h.phone.state().ready, false);
  h.message({ type: 'imperfect:assembled', step: 'done' });
  assert.equal(h.phone.state().ready, true); assert.equal(h.frame.inert, true, 'paint never enables input in the phone');
  h.phone.prepare('https://noah.imperfect.computer'); assert.equal(h.navigations(), 1, 'exhibiting it again reuses the same authenticated document');
  h.frame.emit('load');
  assert.equal(h.phone.state().verified, false); assert.equal(h.phone.state().ready, false);
  h.message({ type: 'imperfect:assembled', step: 'done' }); assert.equal(h.phone.state().ready, false, 'navigation revokes readiness');
  h.message({ type: 'imperfect:demo-ready' }); h.message({ type: 'imperfect:assembled', step: 'done' });
  h.frame.emit('error'); assert.equal(h.phone.state().ready, false, 'network errors expose the honest fallback');
});

test('the phone slides for 600 ms each way, holds until its voice plus one second, and exactly restores the desktop', async () => {
  const h = await phoneHarness(), original = h.appWindow.style.transform, sameFrame = h.frame;
  let finishVoice;
  const spoken = { done: new Promise(resolve => { finishVoice = resolve; }) };
  const exhibit = h.phone.exhibit(spoken);
  assert.equal(h.appWindow.style.transform, original + ' translateX(-320px)');
  await h.tick(599); assert.equal(h.events.length, 0);
  await h.tick(1); assert.deepEqual(h.events.map(row => [row.phase, row.at]), [['shown', 600]]);
  await h.tick(1300); assert.equal(h.events.length, 1, 'a still-playing voice cannot be cut off');
  finishVoice(); await h.tick(0);
  await h.tick(999); assert.equal(h.device.dataset.shown, 'true');
  await h.tick(1); assert.equal(h.device.dataset.shown, 'exit'); assert.equal(h.appWindow.style.transform, original);
  await h.tick(599); assert.equal(h.events.length, 1);
  await h.tick(1); await exhibit;
  assert.deepEqual(h.events.map(row => [row.phase, row.at]), [['shown', 600], ['returned', 3500]]);
  assert.equal(h.appWindow.style.transform, original); assert.equal(h.device.dataset.shown, 'false');
  assert.equal(h.phone.state().returned, true); assert.equal(h.frame, sameFrame); assert.equal(h.navigations(), 0, 'sliding never reloads or attaches another product');
});

test('skip during the phone slide or voice hold restores immediately; reduced motion never loads or slides it', async () => {
  for (const skipAt of [300, 800]) {
    const h = await phoneHarness(), original = h.appWindow.style.transform;
    const exhibit = h.phone.exhibit({ done: new Promise(() => {}) });
    await h.tick(skipAt); const before = h.events.length;
    h.phone.reset(); await h.tick(0); await exhibit;
    assert.equal(h.appWindow.style.transform, original); assert.equal(h.device.dataset.shown, 'false');
    await h.tick(5000); assert.equal(h.events.length, before, 'cancelled slide/hold cannot publish late shown/returned events');
  }
  const reduced = await phoneHarness({ reduced: true }), original = reduced.appWindow.style.transform;
  reduced.phone.prepare('https://noah.imperfect.computer');
  await reduced.phone.exhibit({ done: Promise.resolve() });
  assert.equal(reduced.navigations(), 0); assert.equal(reduced.events.length, 0);
  assert.equal(reduced.phone.state().played, false); assert.equal(reduced.appWindow.style.transform, original);
});

test('product assembly is framed-only, cumulative, exact-origin/source, and acknowledges only after two frames', () => {
  function product({ origin = 'https://noah.imperfect.computer', referrer = 'https://imperfect.computer/', standalone = false, search = '' } = {}) {
    const classes = [], win = new Signals(), doc = { referrer, documentElement: { classList: { add(name) { classes.push(name); } } } }, frames = [], posts = [], applied = [];
    win.location = { origin, search }; win.parent = standalone ? win : { postMessage: (data, target) => posts.push({ data, target }) };
    win.requestAnimationFrame = fn => frames.push(fn);
    const mount = mountAssembly({ win, doc, apply: step => applied.push(step) });
    return { win, doc, classes, mount, posts, applied, frame() { for (const fn of frames.splice(0)) fn(); },
      send(step, patch = {}) { win.emit('message', { source: win.parent, origin: 'https://imperfect.computer', data: { type: 'imperfect:assemble', step }, ...patch }); } };
  }
  assert.deepEqual([...ASSEMBLY_STEPS], ['bare', 'claude', 'codex', 'files', 'browser', 'messages', 'done']);
  for (const options of [{ standalone: true }, { origin: 'https://private.test' }, { referrer: 'https://evil.test/' }, { referrer: 'https://imperfect.computer.evil.test/' }]) {
    const p = product(options); assert.equal(p.mount, null); p.send('done'); assert.deepEqual(p.applied, []);
  }
  const p = product();
  for (const patch of [{ source: {} }, { source: null }, { origin: 'null' }, { origin: 'http://imperfect.computer' }, { origin: 'https://sub.imperfect.computer' },
    { origin: 'https://imperfect.computer:444' }, { data: { type: 'imperfect:assembled', step: 'bare' } }, { data: null }]) p.send('bare', patch);
  for (const step of ['s-live', 'kinso', -1, {}, null]) p.send(step);
  assert.deepEqual(p.applied, []);
  for (const step of ASSEMBLY_STEPS) {
    p.send(step); assert.equal(p.posts.length, p.applied.length - 1);
    p.frame(); assert.equal(p.posts.length, p.applied.length - 1, 'not before the second animation frame');
    p.frame(); assert.deepEqual(p.posts.at(-1), { data: { type: 'imperfect:assembled', step }, target: 'https://imperfect.computer' });
    p.send('bare');
  }
  assert.deepEqual(p.applied, [...ASSEMBLY_STEPS], 'late messages never reapply or regress the product');
  const phone = product({ search: '?face=code&launch=phone' });
  assert.deepEqual(phone.classes, ['launch-phone'], 'the real phone layout does not receive the desktop launch inset');
  assert.equal(phoneByLaunch(phone.win, phone.doc), true);
  assert.equal(mountLaunchDrag({ win: phone.win, doc: phone.doc }), null, 'the phone cannot drag the desktop window');
  phone.send('done', { source: {} }); phone.send('done', { origin: 'https://evil.test' });
  assert.deepEqual(phone.applied, []);
  phone.send('done'); phone.frame(); assert.equal(phone.posts.length, 0); phone.frame();
  assert.deepEqual(phone.applied, ['done']);
  assert.deepEqual(phone.posts, [{ data: { type: 'imperfect:assembled', step: 'done' }, target: 'https://imperfect.computer' }]);
  for (const options of [{ standalone: true }, { origin: 'https://private.test' }, { referrer: 'https://evil.test/' }]) {
    const untrusted = product({ ...options, search: '?launch=phone' });
    assert.equal(phoneByLaunch(untrusted.win, untrusted.doc), false, 'a query parameter cannot cross the trusted launch boundary');
    assert.deepEqual(untrusted.classes, []);
  }
  assert.deepEqual(p.classes, ['launch-framed'], 'the primary document remains a native desktop');
  const skip = product(); skip.send('done'); skip.frame(); skip.frame();
  assert.deepEqual(skip.applied, ['done'], 'done first simply shows the completed product');
  skip.send('files'); skip.frame(); skip.frame(); assert.equal(skip.posts.length, 1);
  const superseded = product(); superseded.send('bare'); superseded.send('codex'); superseded.frame(); superseded.frame();
  assert.deepEqual(superseded.posts.map(row => row.data.step), ['codex'], 'superseded paint cannot claim an earlier appearance');
  superseded.mount.dispose(); superseded.send('done'); assert.deepEqual(superseded.applied, ['bare', 'codex']);
});

const officialShop = 'https://imperfect.computer/shop';
const invalidShopURLs = [null, {}, 1, '', '/shop', 'http://imperfect.computer/shop', 'https://evil.test/shop',
  'https://imperfect.computer.evil.test/shop', 'https://sub.imperfect.computer/shop',
  'https://imperfect.computer:443/shop', 'https://imperfect.computer:444/shop',
  'https://user@imperfect.computer/shop', 'https://user:pass@imperfect.computer/shop',
  `${officialShop}/`, `${officialShop}/thanks`, `${officialShop}#`, `${officialShop}#install`, `${officialShop}?`,
  `${officialShop}?os=`, `${officialShop}?os=macos`, `${officialShop}?os=phone`, `${officialShop}?os=MAC`,
  `${officialShop}?os=mac&os=mac`, `${officialShop}?os=mac&os=linux`, `${officialShop}?x=mac`, `${officialShop}?os=mac&x=1`,
  `${officialShop}?%6fs=mac`, `${officialShop}?os=%6dac`, ` ${officialShop}`, `${officialShop}\n`,
  'https://imperfect.computer/other/../shop', 'javascript:alert(1)', 'data:text/html,shop'];
test('the product accepts only the exact official Shop URL and at most one validated visitor OS', () => {
  assert.equal(launchShopURL(officialShop), officialShop);
  for (const os of ['mac', 'linux', 'windows', 'mobile']) assert.equal(launchShopURL(`${officialShop}?os=${os}`), `${officialShop}?os=${os}`);
  for (const url of invalidShopURLs) assert.equal(launchShopURL(url), null, `reject ${String(url)}`);
});

test('Shop messages require the exact framed parent, a finished primary document and a valid URL; phone never mounts them', async () => {
  function product({ origin = 'https://noah.imperfect.computer', referrer = 'https://imperfect.computer/', standalone = false, search = '' } = {}) {
    const win = new Signals(), doc = { referrer }, opened = [];
    let ready = false, release;
    win.location = { origin, search }; win.parent = standalone ? win : {};
    const mount = mountLaunchOpen({ win, doc, canOpen: () => ready,
      open: url => { opened.push(url); return new Promise(resolve => { release = resolve; }); } });
    return { mount, opened, ready: () => { ready = true; }, release: () => release?.(),
      send(url = officialShop, patch = {}) { win.emit('message', { source: win.parent, origin: 'https://imperfect.computer', data: { type: 'imperfect:open', url }, ...patch }); } };
  }
  for (const options of [{ standalone: true }, { origin: 'https://private.test' }, { referrer: 'https://evil.test/' },
    { referrer: 'https://imperfect.computer.evil.test/' }, { search: '?face=code&launch=phone' }]) {
    const p = product(options); assert.equal(p.mount, null); p.ready(); p.send(); await new Promise(setImmediate); assert.deepEqual(p.opened, []);
  }
  const p = product();
  p.send(); await new Promise(setImmediate); assert.deepEqual(p.opened, [], 'the parent cannot open a browser before primary done');
  p.ready();
  for (const patch of [{ source: {} }, { source: null }, { origin: 'null' }, { origin: 'http://imperfect.computer' },
    { origin: 'https://sub.imperfect.computer' }, { origin: 'https://imperfect.computer:444' },
    { data: null }, { data: { type: 'imperfect:opened', url: officialShop } }]) p.send(officialShop, patch);
  for (const url of invalidShopURLs) p.send(url);
  await new Promise(setImmediate); assert.deepEqual(p.opened, [], 'invalid messages cannot reach the browser transport');
  p.send(`${officialShop}?os=mac`); p.send(`${officialShop}?os=mac`);
  await new Promise(setImmediate); assert.deepEqual(p.opened, [`${officialShop}?os=mac`], 'a pending open is not duplicated');
  p.release(); await new Promise(setImmediate);
  p.send(); await new Promise(setImmediate); assert.deepEqual(p.opened, [`${officialShop}?os=mac`, officialShop], 'a later menu click can foreground it again');
  p.release(); await new Promise(setImmediate); p.mount.dispose(); p.send(); await new Promise(setImmediate);
  assert.equal(p.opened.length, 2, 'disposed document handlers cannot open anything');
});

test('Shop reuses the real browser tabs/open/front transport, including an existing receipt tab', async () => {
  const calls = [], tabs = [{ tab: 101, url: 'https://www.google.com/' }], remember = { tab: null };
  const ask = async command => {
    calls.push({ ...command });
    if (command.do === 'tabs') return { tabs };
    if (command.do === 'open') {
      let tab = tabs.find(tab => tab.tab === command.tab);
      if (!tab) { tab = { tab: 102 }; tabs.push(tab); }
      tab.url = command.url; return { ...tab };
    }
    if (command.do === 'front') return { ok: true };
    assert.fail(`unexpected browser command ${command.do}`);
  };
  assert.equal(await prepareLaunchShop(ask, `${officialShop}?os=mac`, remember), 102);
  assert.deepEqual(calls, [{ do: 'tabs' }, { do: 'open', url: `${officialShop}?os=mac` }, { do: 'front', tab: 102 }]);
  calls.length = 0;
  await prepareLaunchShop(ask, `${officialShop}?os=mac`, remember);
  assert.deepEqual(calls, [{ do: 'tabs' }, { do: 'front', tab: 102 }], 'reopening only foregrounds the one existing Shop tab');
  tabs[1].url = `${officialShop}/thanks?session=cs_test_unit&os=mac`;
  calls.length = 0;
  await prepareLaunchShop(ask, `${officialShop}?os=linux`, { tab: null });
  assert.deepEqual(calls, [{ do: 'tabs' }, { do: 'open', url: `${officialShop}?os=linux`, tab: 102 }, { do: 'front', tab: 102 }], 'a receipt tab is reused, not accumulated');
  assert.equal(tabs.length, 2); assert.equal(tabs[0].url, 'https://www.google.com/');
  calls.length = 0;
  await assert.rejects(prepareLaunchShop(ask, 'https://evil.test/shop'), /Only the public Shop/);
  assert.deepEqual(calls, [], 'URL validation happens before any browser request');
  await assert.rejects(prepareLaunchShop(async () => ({ tabs: null }), officialShop), /tabs/);
  await assert.rejects(prepareLaunchShop(async () => ({ tabs: [{ tab: -1, url: officialShop }] }), officialShop), /tab/);
});

test('window-drag messages require the actual iframe document, exact origin, finite coordinates and a known phase', () => {
  const frame = { contentWindow: {}, getAttribute: () => ticket.url };
  const valid = { source: frame.contentWindow, origin: 'https://noah.imperfect.computer', data: { type: 'imperfect:window-drag', phase: 'start', x: 80, y: 20 } };
  assert.equal(frameDragAllowed(valid, frame), true);
  for (const phase of ['start', 'move', 'end']) assert.equal(frameDragAllowed({ ...valid, data: { ...valid.data, phase } }, frame), true);
  for (const patch of [{ source: {} }, { origin: 'null' }, { origin: 'https://sub.noah.imperfect.computer' }, { origin: 'https://evil.test' },
    ...[{ type: 'imperfect:assembled' }, { phase: 'resize' }, { x: NaN }, { x: Infinity }, { y: '20' }, { x: 100001 }].map(data => ({ data: { ...valid.data, ...data } }))]) {
    assert.equal(frameDragAllowed({ ...valid, ...patch }, frame), false);
  }
  for (const src of ['', 'javascript:alert(1)', 'data:text/html,x']) assert.equal(frameDragAllowed(valid, { ...frame, getAttribute: () => src }, 'https://imperfect.computer/'), false);
});

async function desktopHarness({ width = 1600, height = 900, reduced = false } = {}) {
  let now = 0;
  const ledger = [], scale = Math.min(width / 1600, height / 900), left = (width - 1600 * scale) / 2, top = (height - 900 * scale) / 2;
  const rect = (x, y, w, h) => ({ left: left + x * scale, top: top + y * scale, width: w * scale, height: h * scale });
  const make = () => Object.assign(new ElementDouble(), {
    classList: { add() {} }, remove() {}, cloneNode: () => make(),
    animate: () => ({ finished: Promise.resolve() }),
  });
  const frame = make(), cursor = make(), offline = make(), shield = make(), screen = make(), tiles = new Map();
  frame.getBoundingClientRect = () => rect(160, 25, 1280, 796);
  screen.getBoundingClientRect = () => rect(0, 0, 1600, 900);
  const names = ['finder', 'safari', 'claude', 'chatgpt', 'imperfect', 'final-cut', 'imovie', 'notes', 'trash'];
  for (const [i, name] of names.entries()) {
    const tile = make(), icon = make(); icon.getBoundingClientRect = () => rect(220 + i * 80, 820, 64, 64);
    tile.querySelector = () => icon; tile.classList.add = value => ledger.push({ type: 'consume', name, value, at: now }); tiles.set(name, tile);
  }
  screen.querySelector = selector => selector === '#computer' ? frame : selector === '.mac-cursor' ? cursor : selector === '.mac-offline' ? offline : selector === '.mac-build-shield' ? shield : tiles.get(selector.match(/data-app="([^"]+)"/)?.[1]);
  screen.querySelectorAll = () => []; screen.append = () => {};
  screen.addEventListener('imperfect:drop', event => ledger.push({ type: 'event', ...event.detail }));
  class AudioDouble extends Signals {
    time = 0; ended = false;
    set currentTime(value) { this.time = value; this.ended = false; }
    get currentTime() {
      const duration = [INTRO, ...STEPS].find(line => line.voice === this.src)?.durationMs / 1000;
      this.time = Math.min(duration, this.time + duration / 20);
      if (this.time >= duration && !this.ended) { this.ended = true; queueMicrotask(() => this.emit('ended')); }
      return this.time;
    }
    play() {
      ledger.push({ type: this.src.endsWith('drag-to-trash.m4a') ? 'sound' : 'voice', src: this.src, rate: this.playbackRate, at: now });
      // Spoken flights advance on their own audio-clock reads; the intro/end
      // have no flight and finish independently, as a media element would.
      if (this.src === INTRO.voice || this.src === STEPS.at(-1).voice || STEPS.find(line => line.voice === this.src)?.phone) queueMicrotask(() => this.emit('ended'));
      return Promise.resolve();
    }
    pause() {}
  }
  const context = vm.createContext({ Audio: AudioDouble, CustomEvent, innerWidth: width, innerHeight: height,
    performance: { now: () => now }, addEventListener() {},
    requestAnimationFrame: fn => queueMicrotask(() => { now += 1000; fn(now); }),
    setTimeout: () => 1, clearTimeout() {}, document: { createElement: make, body: make() },
  });
  vm.runInContext((await read('mac/desktop.mjs')).replace(/^export /gm, '') + '\nglobalThis.makeMac = createMac;', context);
  let mac;
  mac = context.makeMac({ screen, curtain: make(), reduced: { matches: reduced },
    onstage: step => ledger.push({ type: 'stage', step, at: now }),
    ontrash: items => ledger.push({ type: 'trash', items: [...items], at: now }),
    onphone: async spoken => { ledger.push({ type: 'phone', reset: !spoken, at: now }); await spoken?.done; },
    onfinish: () => { ledger.push({ type: 'finish', at: now }); mac.finish(); },
  });
  return { mac, ledger, screen, frame, cursor, scale };
}

test('each real drop plays exactly one sound and sends its step in the same task, with three separate Trash drops', async () => {
  const h = await desktopHarness(); h.mac.prepare(); await h.mac.play();
  const events = h.ledger.filter(row => row.type === 'event'), sounds = h.ledger.filter(row => row.type === 'sound');
  assert.deepEqual(events.map(row => [row.name, row.step, Boolean(row.trash)]), [
    ['claude', 'claude', false], ['chatgpt', 'codex', false], ['finder', 'files', false], ['safari', 'browser', false],
    ['final-cut', null, true], ['imovie', null, true], ['notes', null, true],
  ]);
  assert.equal(sounds.length, events.length, 'one existing drop sound per physical drop, no extras');
  for (const [i, event] of events.entries()) {
    assert.equal(sounds[i].at, event.at, `${event.name}: sound on the drop frame`);
    if (event.step) {
      const stage = h.ledger.find(row => row.type === 'stage' && row.step === event.step);
      assert.equal(stage.at, event.at, `${event.name}: product protocol in the same task as the sound`);
      const index = h.ledger.indexOf(sounds[i]); assert.equal(h.ledger[index + 1], stage, 'no asynchronous hold between drop sound and protocol');
    }
  }
  assert.deepEqual(h.ledger.filter(row => row.type === 'stage').map(row => row.step), ['bare', 'claude', 'codex', 'files', 'browser', 'done']);
  assert.deepEqual(h.ledger.filter(row => row.type === 'voice').map(row => row.src), [INTRO, ...STEPS].map(row => row.voice));
  assert.ok(h.ledger.filter(row => row.type === 'voice').every(row => row.rate === .8));
  assert.deepEqual(h.ledger.filter(row => row.type === 'trash').map(row => row.items), [['final-cut'], ['final-cut', 'imovie'], ['final-cut', 'imovie', 'notes']]);
  const phoneIndex = h.ledger.findIndex(row => row.type === 'phone' && !row.reset);
  const browserIndex = h.ledger.findIndex(row => row.type === 'event' && row.step === 'browser');
  const trashIndex = h.ledger.findIndex(row => row.type === 'event' && row.trash);
  assert.ok(browserIndex < phoneIndex && phoneIndex < trashIndex, 'the phone is a narration beat after the browser and before Trash, not a product assembly step');
  assert.equal(h.ledger.filter(row => row.type === 'phone' && !row.reset).length, 1);
  assert.equal(h.ledger.at(-1).type, 'finish');
  assert.equal(h.mac.state().finished, true); assert.equal(h.cursor.hidden, true);
  assert.deepEqual([...h.mac.state().absorbed], ['claude', 'chatgpt', 'finder', 'safari']);
  assert.deepEqual([...h.mac.state().trashed], ['final-cut', 'imovie', 'notes']);
});

test('portrait and landscape phones keep native pointer/drop geometry and the same iframe', async () => {
  for (const [width, height] of [[1600, 900], [390, 844], [844, 390]]) {
    const h = await desktopHarness({ width, height }), frame = h.frame;
    h.mac.prepare(); assert.equal(Number(h.screen.style['--scale']), h.scale);
    await h.mac.play();
    const event = h.ledger.find(row => row.type === 'event' && row.name === 'claude');
    const left = (width - 1600 * h.scale) / 2, top = (height - 900 * h.scale) / 2;
    assert.ok(Math.abs((event.x - left) / h.scale - (160 + 1280 * .47)) < 1e-8);
    assert.ok(Math.abs((event.y - top) / h.scale - (25 + 796 * .48)) < 1e-8);
    assert.equal(h.frame, frame); assert.equal(h.frame.src, undefined, 'the desktop choreographer never navigates the product');
  }
});

test('Trash flights land even when audio advances beyond the next boundary during pointer travel', async () => {
  const text = await read('mac/desktop.mjs');
  for (const [from, to] of [[1, 2 / 3], [1, 1]]) {
    const frames = [], points = [];
    const context = vm.createContext({
      requestAnimationFrame: fn => frames.push(fn), point: (x, y) => points.push([x, y]),
      clamp: x => Math.max(0, Math.min(1, x)), x: 0, y: 0, stopped: false,
    });
    vm.runInContext(functionSource(text, 'flight') + '\nglobalThis.fly = flight;', context);
    let resolved = false;
    context.fly({ ghost: { remove() {} }, carry() {} }, { x: 100, y: 200 }, { over: true, progress: () => 1 }, from, to).then(() => { resolved = true; });
    for (let i = 0; i < 4 && frames.length; i++) frames.shift()();
    await Promise.resolve();
    assert.equal(resolved, true, `completed audio interval ${from}..${to} cannot loop forever`);
    assert.ok(points.length && points.every(pair => pair.every(Number.isFinite)), 'a completed interval cannot send the cursor to NaN coordinates');
    assert.deepEqual(points.at(-1), [100, 200]);
  }
});

test('an initial keyboard skip completes the same desktop without phone narration, slides or drops', async () => {
  const h = await desktopHarness(), frame = h.frame;
  await h.mac.complete(); await h.mac.play();
  assert.deepEqual(h.ledger.filter(row => row.type === 'stage').map(row => row.step), ['done']);
  assert.equal(h.ledger.filter(row => ['voice', 'sound', 'event'].includes(row.type)).length, 0);
  assert.equal(h.ledger.filter(row => row.type === 'phone' && !row.reset).length, 0);
  assert.equal(h.mac.state().finished, true); assert.equal(h.frame, frame); assert.equal(frame.src, undefined);
});

test('reduced-motion desktop completes directly to done without voices, drops or intermediate steps', async () => {
  const h = await desktopHarness({ reduced: true }); await h.mac.play();
  assert.deepEqual(h.ledger.filter(row => row.type === 'stage').map(row => row.step), ['done']);
  assert.equal(h.ledger.filter(row => ['voice', 'sound', 'event'].includes(row.type)).length, 0);
  assert.equal(h.ledger.filter(row => row.type === 'phone' && !row.reset).length, 0, 'reduced motion never exhibits the phone');
  assert.equal(h.mac.state().finished, true); assert.equal(h.cursor.hidden, true);
});

// ---- The film over the galaxy, its hyperdrive, power and scroll, the black hole in the bubble.
test('the packed film\'s 4:3 picture is contained and centred in any (safe) area', () => {
  for (const area of [{ left: 0, top: 0, width: 1024, height: 640 }, { left: 0, top: 0, width: 390, height: 844 }, { left: 47, top: 0, width: 750, height: 369 }, { left: 0, top: 0, width: 250, height: 390 }]) {
    const r = filmRect(area);
    assert.ok(Math.abs(r.width / r.height - ASPECT) < 1e-9);
    assert.ok(r.width <= area.width + 1e-9 && r.height <= area.height + 1e-9);
    assert.ok(Math.abs(r.width - area.width) < 1e-9 || Math.abs(r.height - area.height) < 1e-9, 'meets two edges');
    assert.ok(Math.abs(r.x + r.width / 2 - (area.left + area.width / 2)) < 1e-9 && Math.abs(r.y + r.height / 2 - (area.top + area.height / 2)) < 1e-9, 'centred');
  }
});
test('the opener waits for scroll, then the lock gesture primes the film and build voices before asking the locker', async () => {
  const launch = await read('launch.mjs'), intro = await read('boot/sequence.mjs'), lock = await read('macos/lock.mjs');
  // lock.mjs calls onsubmit inside the submit event (Enter, the keyboard's Go, the arrow).
  assert.match(lock, /form\.addEventListener\('submit', event => \{[\s\S]*?onsubmit\(input\.value\);/);
  const press = launch.slice(launch.indexOf('const lock = createLock('), launch.indexOf('function opened('));
  assert.match(press, /onsubmit:\s*password =>\s*\{\s*if \(phase !== 'ready'\) return;\s*gesture\(\);\s*setPhase\('unlocking'\);/);
  assertBefore(press, 'gesture()', 'unlock(password)', 'the gesture before the locker is asked');
  assert.match(press, /if \(!bench\)\s*\{\s*setPhase\('ready'\);\s*lock\.wrong\(\);/, 'a wrong password: the field says so, nothing else');
  assert.match(press, /opened\(bench\);\s*lock\.open\(\);\s*afterLock\(\)/, 'a correct password enters the desktop/player seam');
  assert.match(functionSource(launch, 'afterLock'), /macLaunch\.enter/);
  const gesture = functionSource(launch, 'gesture');
  assert.match(gesture, /intro\?\.prime\(\);/); assert.match(gesture, /primeVideo\(video,\s*\{\s*isCurrent:/);
  assert.match(gesture, /mac\.prime\(\)/, 'the build voices share the password activation');
  const start = functionSource(launch, 'startOpener'), showLock = functionSource(launch, 'showLock');
  assert.match(start, /intro\.start\(\{\s*auto:\s*false\s*\}\)/);
  assert.match(showLock, /if\s*\(!openerDone\s*\|\|\s*!lockChecked/, 'neither credentials nor a remembered unlock skip the word/goat opener');
  const completed = launch.slice(launch.indexOf("addEventListener('imperfect:intro'"), launch.indexOf('const FILMING'));
  assert.match(completed, /type === 'complete'[\s\S]*openerDone\s*=\s*true;[\s\S]*showLock\(\)/, 'the completed opener reveals the lock');
  assert.match(intro, /prime\(\) \{ sound\.prime\(\); \},/, 'the boot sound\'s AudioContext resumed');
  assert.match(launch, /intro\.start\(\{ auto: false \}\)/);
  assert.match(intro, /start\(\{ auto = true \} = \{\}\) \{ if \(S\.started \|\| suspended\) return; S\.started = true; sound\.prime\(\); if \(auto\) approach\(\); else wake\(\); \}/);
  assert.match(intro, /sound\.start\(t\); soundAt = t;/, 'the boot sound starts at the touch');
  assert.match(intro, /quiet\(\) \{ quieted = true; sound\.setMuted\(true\);/, 'and stops where the film begins');
  assert.match(launch, /if \(type === 'complete' && \['intro', 'contact'\]\.includes\(phase\)\)/);
  assert.doesNotMatch(launch + lock, /\.noah\.imperfect\.computer|door\/ticket|scrypt|=== password|password ===/, 'no workbench and no password check in the page: the locker has them');
});
test('scrolling and swiping go both ways until the touch, as the lock\'s do; from the touch they stay together', async () => {
  const intro = await read('boot/sequence.mjs');
  const move = intro.slice(intro.indexOf('function move(px)'), intro.indexOf('\n}\n', intro.indexOf('function move(px)')));
  assert.match(move, /S\.scrolled = clamp\(S\.scrolled \+ px \* 5 \/ innerHeight, 0, TOUCH - 1\);/, 'back as far as apart, forward as far as the touch, in screens (a resize keeps the place)');
  assert.doesNotMatch(intro, /oneWay/);
  assert.match(intro, /bindLockScroll\(\{ active: \(\) => S\.started && S\.phase === 'scene' && !S\.auto/, 'only before the touch');
});
test('the retained goat asset has its old timing; the macOS lock now follows the word directly', async () => {
  const T = goatTimes(), still = goatTimes({ still: true });
  assert.equal(T.from, WORD.gone, 'it starts as the word has gone');
  assert.ok(Math.abs(T.whole - T.from - GOAT.in) < 1e-9 && Math.abs(T.out - T.whole - 1.5) < 1e-9 && Math.abs(T.gone - T.out - GOAT.out) < 1e-9);
  assert.ok(Math.abs(T.gone - WORD.gone - 3.3) < 1e-9, 'the goat holds the opener for another 3.3 s before the lock');
  assert.ok(Math.abs(still.gone - WORD.gone - 2.1) < 1e-9, 'reduced motion: a short plain fade each way');
  assert.equal(goatAt(WORD.gone - .01).on, false); assert.equal(goatAt(T.gone).on, false);
  assert.deepEqual(goatAt((T.whole + T.out) / 2), { on: true, opacity: GOAT.peak, scale: 1, blur: 0 });
  for (const tau of [T.from, T.from + GOAT.in / 2, T.out])
    assert.deepEqual(goatAt(tau), { on: true, opacity: GOAT.peak, scale: 1, blur: 0 }, `${tau}: cut in whole, no fade in`);
  const fading = [T.out + GOAT.out / 4, T.out + GOAT.out / 2, T.gone - 1e-3].map(tau => goatAt(tau).opacity);
  assert.ok(fading[0] < GOAT.peak && fading[1] < fading[0] && fading[2] < fading[1] && fading[2] < 0.01, `then a calm fade out: ${fading}`);
  assert.deepEqual(goatAt(still.from + GOAT.still / 2, { still: true }), { on: true, opacity: GOAT.peak, scale: 1, blur: 0 }, 'reduced motion the same');
  const intro = await read('boot/sequence.mjs');
  assert.match(intro, /if \(tau < WORD\.gone\) return;\n\s*S.phase = 'ready';/, 'the new lock follows the word immediately');
  assert.doesNotMatch(intro + await read('launch.mjs'), /129\.7/, 'nothing depends on the film\'s length');
  // The lightest web version of the J06 mark: one webp, trimmed to its ink, 640 px tall.
  const webp = await readFile(new URL('../../website/intro/goat-j06.webp', import.meta.url));
  assert.equal(webp.toString('latin1', 0, 4) + webp.toString('latin1', 8, 16), 'RIFFWEBPVP8X');
  assert.deepEqual([webp.readUIntLE(24, 3) + 1, webp.readUIntLE(27, 3) + 1], GOAT.size);
  assert.ok(webp.length < 60_000, `${webp.length} bytes`);
});
test('the word and the goat stand on their ink\'s mass, not their box: the word 2.7 % of its ink right of where it was', async () => {
  for (const [w, h] of [[1920, 1080], [1024, 640], [390, 844], [844, 390]]) {
    const box = placeWordmark(w, h), [x, y, mw, mh] = opticalWordmark(box);
    assert.ok(Math.abs(x + mw / 2 + MASS.wordmark[0] * mw - w / 2) < 1e-9, 'the word\'s mass on the centre line');
    assert.ok(Math.abs((x - box[0]) / mw - 0.02658) < 1e-9 && y === box[1] && mw === box[2] && mh === box[3], 'moved right only');
    const [gx, gy, gw, gh] = placeGoat(w, h, [x, y, mw, mh]);
    assert.ok(Math.abs(gx + gw / 2 + MASS.goat[0] * gw - w / 2) < 1e-9 && Math.abs(gy + gh / 2 + MASS.goat[1] * gh - h / 2) < 1e-9, 'the goat\'s mass at the middle');
    assert.ok(Math.abs(gh - GOAT.height * mh) < 1e-9 && Math.abs(gw / gh - GOAT.size[0] / GOAT.size[1]) < 1e-9);
  }
  const wordmark = await read('wordmark.mjs');
  assert.doesNotMatch(wordmark, /goat|MASS|optical/i, 'wordmark.mjs (shared with the OS lock) is as it was');
});
test('reveal motion stays unchanged apart from the opaque silver rim, without star effects', async () => {
  const views = [{ at: [512, 320], width: 1024, height: 640 }, { at: [195, 400], width: 390, height: 844, scale: 0.4 }, { at: [960, 620], width: 1920, height: 1080 }];
  let n = 0;
  for (const view of views) for (let tau = 0; tau < 6.4; tau += 0.0137) {
    const now = revealAt(tau, view), then = revealBefore.revealAt(tau, view);
    assert.deepEqual(now, { ...then, rim: 1 }, `only rim opacity changes at ${tau.toFixed(4)}`);
    const path = pathBefore(...view.at, Math.max(0.01, then.R), then.wt, then.wob);
    assert.equal(bubblePath(...view.at, Math.max(0.01, now.R), now.wt, now.wob), path, `bubblePath at ${tau.toFixed(4)}`);
    assert.equal(bubblePath(...view.at, Math.max(0.01, now.R), now.wt, now.wob, now), path, 'the lock\'s own motion has no ripples or grain');
    n++;
  }
  assert.ok(n > 1000);
  const bootup = await read('bootup.mjs');
  assert.doesNotMatch(bootup, /bootup-sound|bubble-sound|HITS2/, 'bootup.mjs keeps the lock\'s mapping and imports nothing new');
});
test('the website\'s bubble follows the sound (opt-in): it peaks on the 12 hits, stays 0.46-1.11 of its size, shines, and opens by 6.167 s', async () => {
  assert.deepEqual(SOUND_HITS, HITS2.filter(([t, , kind]) => t <= BURST && kind < 2).map(([t]) => t));
  assert.equal(SOUND_HITS.length, 12);
  for (const h of SOUND_HITS) {
    let top = -1, when = 0;
    for (let t = h - 0.03; t <= h + 0.03; t += 0.0005) { const k = soundKick(t); if (k > top) { top = k; when = t; } }
    assert.ok(Math.abs(when - h) <= 0.001, `the leap peaks on the hit at ${h} s (${((when - h) * 1000).toFixed(1)} ms)`);
    assert.ok(soundMotion(h).radius >= 1.2 * soundMotion(h - 0.02).radius, `and it shows: ${h} s`);
    assert.ok(soundMotion(h + 0.05).ripples.length > 0, `a ripple runs round the rim after ${h} s`);
  }
  let lo = Infinity, hi = -Infinity, last = -1;
  for (let t = SOUND_HITS[0]; t <= BURST; t += 0.001) { const r = soundMotion(t).radius; lo = Math.min(lo, r); hi = Math.max(hi, r); }
  assert.ok(lo >= 0.45 && hi <= 1.12, `between the first hit and the burst: ${lo.toFixed(3)}..${hi.toFixed(3)}`);
  for (let t = 0; t < BURST + 1; t += 0.001) {
    const m = soundMotion(t, 0.8);
    assert.ok(m.shine >= 0 && m.shine <= 1 && m.kick >= 0 && m.kick <= 1);
    if (t <= BURST) assert.equal(m.ex, 0); else assert.ok(m.ex >= last - 1e-12, 'the opening never closes');
    last = m.ex;
  }
  assert.equal(soundMotion(BURST + 0.8 - 1e-9).done, false); assert.equal(soundMotion(BURST + 0.8).done, true); assert.equal(soundMotion(BURST + 0.8).ex, 1);
  assert.deepEqual(soundMotion(BURST + 0.8).ripples, []);
  // through revealAt: the sound's radius and touch glow; the silver rim stays opaque
  const view = { at: [512, 320], width: 1024, height: 640, grow: 1.5 };
  for (const tau of [0.4, 1.19, 3, 4.33, 5.2]) {
    const b = revealAt(tau, { ...view, motion: soundMotion }), m = soundMotion(tau, 0.8), plain = revealAt(tau, view);
    assert.ok(Math.abs(b.R - b.small * m.radius) < 1e-9 && b.shine === m.shine);
    assert.ok(Math.abs(b.glow - plain.glow * (0.8 + 0.2 * m.shine)) < 1e-12);
    assert.equal(b.rim, 1);
  }
  const intro = await read('boot/sequence.mjs');
  assert.match(intro, /import \{ soundMotion \} from '\.\.\/bubble-sound\.mjs';/);
  assert.match(intro, /revealAt\(tau, \{[^}]*motion: soundMotion \}\)/, 'the launch page draws the sound\'s bubble');
  assert.match(intro, /bubblePath\([^;]*, b\.wt, b\.wob, b\);/, 'and passes its ripples and grain to the rim');
  // (The world page, which drew the lock's own bubble, is gone; the lock's is checked as it was above.)
});

test('kinso.computer asks for its password on every visit; a remembered unlock never skips its lock', async () => {
  const kinso = await parentHarness({ site: 'kinso' });
  kinso.setBench(ticket);
  await kinso.settle();
  assert.equal(kinso.ticketRequests(), 0, 'no remembered unlock is asked for on load');
  assert.equal(kinso.state().lock.unlocked, false, 'the lock still waits for the password');
  await kinso.unlock();
  assert.equal(kinso.state().lock.unlocked, true, 'the password opens it');
  const imperfect = await parentHarness();
  imperfect.setBench(ticket);
  await imperfect.settle();
  assert.equal(imperfect.ticketRequests(), 1, 'imperfect.computer still remembers its unlock');
});
