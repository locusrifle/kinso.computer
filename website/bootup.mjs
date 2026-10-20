// One contact sound and one picture clock, shared by the website and the lock.
// PEAK is the recording's measured loudest moment: the start of the 10ms frame containing the decoded sample maximum
// (5.69025s); quantisation error is 0.25ms, well below one rendered frame. The bubble bursts at BURST, Noah's mark.
import { FPS, DURATION, PEAK_FRAME, CHANNELS, ACCENTS } from './bootup-envelope.mjs';
export { FPS, DURATION, PEAK_FRAME, CHANNELS, ACCENTS };
export const PEAK = PEAK_FRAME / FPS;
// The burst: the moment the bubble opens and the stars are born, in seconds after the touch. Noah set it by ear and
// eye in his timer (~/workbench/bootup/shine-timer/, 12 Oct), a little before the recording's loudest moment (PEAK).
// Everything that means "the bubble bursts" follows it: the reveal, the stars' birth and twist, the word.
export const BURST = 5.367;
// The hits the bubble leaps on: the recording's clear accents (4 dB over the 150 ms before them) and its loud ones
// (3 dB, at two thirds of the recording's peak or more), from the seed's onset to the burst.
export const HITS = Object.freeze(ACCENTS.filter(([t, jump, loud]) => t >= 0.35 && t <= BURST && (jump >= 4 || (jump >= 3 && loud >= 2 / 3))).map(([t]) => t));
export const URLS = ['assets/sound/bootup.webm', 'assets/sound/bootup.m4a'].map(p => new URL(p, import.meta.url).href);
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
export function envelope(t) {
  if (t < 0 || t >= DURATION) return { peak: 0, energy: 0, loud: 0, transient: 0 };
  const f = t * FPS, i = Math.floor(f), u = f - i;
  return Object.fromEntries(Object.entries(CHANNELS).map(([k, a]) => [k, a[i] + ((a[i + 1] ?? a[i]) - a[i]) * u]));
}
// The bubble rests at half its old size and leaps to the full size on every hit: a 45 ms attack that overshoots,
// then a loose spring back (it dips a little below rest before settling), with a shudder of its edge and a jolt
// of its wobble's phase. The last hit before the burst does not spring back: the bubble holds and swells on into
// the burst. base: rest as a share of the full size; over: the overshoot past full; swell: the kick at the burst.
export const BUBBLE = Object.freeze({ base: 0.5, rise: 0.045, over: 0.08, freq: 2.2, damp: 0.45, shake: 1.6, shudder: 0.09, jolt: 1.1, swell: 1.2 });
const W = 2 * Math.PI * BUBBLE.freq, WD = W * Math.sqrt(1 - BUBBLE.damp ** 2), Q = BUBBLE.damp / Math.sqrt(1 - BUBBLE.damp ** 2);
const spring = s => Math.exp(-BUBBLE.damp * W * s) * (Math.cos(WD * s) + Q * Math.sin(WD * s)); // 1 -> 0, at rest
const last = t => { let i = -1; while (i + 1 < HITS.length && HITS[i + 1] <= t) i++; return i; };
const TOP = 1 + BUBBLE.over, FROM = [];
// kick: 0 at rest, 1 at the full size. Each hit starts from wherever the last one left it; after the last, it builds.
export function kickAt(t) {
  const i = last(t); if (i < 0) return 0;
  const s = t - HITS[i];
  if (s < BUBBLE.rise) return FROM[i] + (TOP - FROM[i]) * (1 - (1 - s / BUBBLE.rise) ** 3);
  if (i === HITS.length - 1) return TOP + (BUBBLE.swell - TOP) * smooth((s - BUBBLE.rise) / Math.max(1e-3, BURST - HITS[i] - BUBBLE.rise));
  return TOP * spring(s - BUBBLE.rise);
}
for (let i = 0; i < HITS.length; i++) FROM.push(i ? kickAt(HITS[i] - 1e-9) : 0);
function shudderAt(t) {
  const i = last(t); if (i < 0) return 0;
  const s = t - HITS[i];
  return s < 0.02 ? s / 0.02 : Math.exp(-(s - 0.02) / BUBBLE.shudder);
}
const joltAt = t => { let j = 0; for (const h of HITS) { if (h > t) break; j += 1 - (1 - Math.min(1, (t - h) / 0.08)) ** 3; } return j * BUBBLE.jolt; };
// Radius in units of the small bubble. No oscillating synthetic beat: swells, the hits' leaps and the edge's
// agitation all come from the recording.
export function bubbleMotion(t, open = 0.8) {
  const a = envelope(t), ex = 1 - (1 - clamp((t - BURST) / open)) ** 5;
  const onset = smooth((t - 0.35) / 0.22), kick = kickAt(t);
  const full = onset * (0.32 + 0.92 * a.loud + 0.20 * a.energy + 0.18 * a.transient);
  const radius = full * (BUBBLE.base + (1 - BUBBLE.base) * kick);
  return { ...a, kick, full, radius, ex,
    wob: (0.8 + 1.55 * a.energy + 0.65 * a.transient + BUBBLE.shake * shudderAt(t)) * (1 - ex) + ex,
    // Integrated energy, precomputed below: movement slows in quiet passages; each hit jolts it on.
    wt: movementAt(t) + joltAt(t), done: t >= BURST + open };
}
const movement = [0];
for (let i = 0; i < CHANNELS.energy.length; i++) movement.push(movement[i] + (1 + 8 * CHANNELS.energy[i] + 5 * CHANNELS.transient[i]) / FPS);
function movementAt(t) {
  const f = Math.max(0, Math.min(movement.length - 1, t * FPS)), i = Math.floor(f);
  return movement[i] + ((movement[i + 1] ?? movement[i]) - movement[i]) * (f - i);
}

// WebKitGTK's local-file loader may refuse Fetch even when the host allows local resources.
// XHR uses the same file-access permission; it never broadens that permission.
async function audioResponse(url) {
  try { const response = await globalThis.fetch(url); if (response.ok) return response; } catch {}
  if (!url.startsWith('file:') || !globalThis.XMLHttpRequest) return { ok: false };
  return new Promise(resolve => {
    const request = new XMLHttpRequest();
    request.open('GET', url); request.responseType = 'arraybuffer'; request.timeout = 10000;
    request.onload = () => resolve({ ok: !!request.response, arrayBuffer: async () => request.response });
    request.onerror = request.ontimeout = () => resolve({ ok: false });
    request.send();
  });
}
const webkit = /AppleWebKit/.test(globalThis.navigator?.userAgent || '') && !/Chrome|Chromium/.test(globalThis.navigator?.userAgent || '');

// Decode ahead of contact, including an AAC fallback for Safari/WebKit. A gesture
// resumes the context without playing any sound. Failure is deliberately silent.
// If decode/resume is late, do not start late: run the same envelope silently.
export function createPlayer({ clock = () => performance.now() / 1000, fixed = () => false,
  Context = globalThis.AudioContext || globalThis.webkitAudioContext, urls = webkit ? [...URLS].reverse() : URLS, fetcher = audioResponse, limit = 3000 } = {}) {
  let context = null, buffer = null, source = null, origin = null, contact = null, finished = false, gain = null, muted = false, generation = 0;
  try { if (Context) { context = new Context(); gain = context.createGain(); gain.connect(context.destination); } } catch {}
  const load = (async () => {
    if (!context) return false;
    for (const url of urls) try {
      const response = await fetcher(url); if (!response.ok) continue;
      buffer = await context.decodeAudioData(await response.arrayBuffer()); return true;
    } catch {}
    return false;
  })();
  // A decoder that never answers (WebKitGTK without GStreamer's decodebin) must not hold the
  // lock or the site forever: after `limit` ms we go on silently (Noah's laptop lock, 15 Oct).
  let timer;
  const ready = Promise.race([load, new Promise(resolve => { timer = setTimeout(resolve, limit, false); })]);
  load.finally(() => clearTimeout(timer));
  function prime() { try { return context?.resume()?.catch(() => {}); } catch {} }
  function start(at = clock()) {
    stop(); contact = at; finished = false;
    const id = generation;
    if (fixed()) return false; // stepped QA/films mux the recording independently
    const launch = (offset = Math.max(0, clock() - at)) => {
      if (id !== generation || source || !buffer || context?.state !== 'running' || offset > 0.1) return false;
      try {
        source = context.createBufferSource(); source.buffer = buffer; source.connect(gain || context.destination);
        origin = context.currentTime - offset; source.start(context.currentTime, offset);
        source.onended = () => { if (id === generation) finished = true; };
        return true;
      } catch { source = null; origin = null; return false; }
    };
    if (context?.state === 'running') return launch(0);
    prime()?.then(() => launch());
    return false;
  }
  function elapsed(now = clock()) {
    if (contact === null) return 0;
    if (!fixed() && origin !== null && context?.state === 'running' && !finished) return Math.max(0, context.currentTime - origin);
    return Math.max(0, now - contact);
  }
  function stop() { generation++; try { source?.stop(); } catch {} source = null; origin = null; contact = null; }
  function bind(target = globalThis) {
    for (const type of ['pointerdown', 'keydown', 'touchend']) target.addEventListener(type, prime, { passive: true });
  }
  function setMuted(value) { muted = Boolean(value); if (gain) gain.gain.value = muted ? 0 : 1; }
  return { ready, prime, start, elapsed, stop, bind, setMuted, get audible() { return !muted && origin !== null && !finished && context?.state === 'running'; } };
}
