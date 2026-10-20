// One spoken part as a clock: Noah's recording when there is one (its own time), else his words read at PACE in real
// time. Its words show as subtitles in `caption`, and things are timed to it: at(t) resolves once the part reaches t,
// span(t0, t1) is a stretch of it (the build's flights follow its progress, mac/desktop.mjs). Hidden, it pauses.
import { speak, align, heardWords, captions, captionAt } from './timeline.mjs?v=kinso-1';

const clamp = x => Math.max(0, Math.min(1, x));
const site = new URL('../', import.meta.url);
export const mediaURL = path => (path ? new URL(path, site).href : null);

// paragraphs: the part's words. media: an <audio>/<video> that is the recording, or null. words: the recording's word
// timings (the JSON's URL), or null. rate: a test's speed-up of the read-aloud clock.
export function createNarration({ paragraphs, media = null, words = null, caption = null, rate = () => globalThis.__kinsoRate ?? 1 }) {
  let script = speak(paragraphs), lines = captions(script.words), loading = null;
  let playing = false, stopped = false, base = 0, since = 0, fallback = !media, raf = 0, hiddenPause = false, shown = '';
  const waiters = new Set();
  // The recording's timings; without them a recording plays with no subtitles and its words read at PACE for cues.
  function load() {
    loading ||= (async () => {
      if (!words) { if (media) lines = []; return; }
      try {
        const recorded = await (await fetch(mediaURL(words), { cache: 'no-cache' })).json();
        script = align(paragraphs, recorded); lines = captions(heardWords(recorded, script));
      } catch { if (media) lines = []; }
    })();
    return loading;
  }
  const now = () => performance.now() / 1000;
  function time() {
    if (!fallback && media) return media.currentTime;
    return base + (playing ? (now() - since) * rate() : 0);
  }
  function show(text) {
    if (!caption || text === shown) return;
    shown = text; caption.textContent = text; caption.hidden = !text;
  }
  function tick() {
    raf = 0;
    const t = time();
    show(stopped ? '' : captionAt(lines, t)?.text ?? '');
    for (const w of [...waiters]) if (stopped || t >= w.t) { waiters.delete(w); w.resolve(!stopped); }
    if (!stopped && ((playing && t < script.duration + 2) || waiters.size)) raf = requestAnimationFrame(tick);
  }
  const wake = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(tick); };
  // A recording that cannot play (refused sound, a missing file) leaves its words to the read-aloud clock from here.
  function toFallback() {
    if (fallback) return;
    base = media ? media.currentTime || 0 : base; since = now(); fallback = true;
    try { media?.pause(); } catch {}
    if (!words) lines = captions(script.words);
  }
  media?.addEventListener('error', () => { if (playing) toFallback(); });
  media?.addEventListener('ended', () => { if (!fallback) { base = media.currentTime; since = now(); fallback = true; } });
  document.addEventListener('visibilitychange', () => {
    if (stopped || !playing && !hiddenPause) return;
    if (document.hidden) { pause(); hiddenPause = true; } else if (hiddenPause) { hiddenPause = false; play(); }
  });
  function pause() {
    if (!playing) return;
    base = time(); playing = false;
    if (!fallback) media.pause();
  }
  function play() {
    if (stopped) return Promise.resolve(false);
    playing = true; since = now();
    wake();
    if (fallback) return Promise.resolve(true);
    media.muted = false;
    return Promise.resolve(media.play()).then(() => true, () => { toFallback(); return false; });
  }
  return {
    load,
    get duration() { return script.duration; },
    get words() { return script.words; },
    get recorded() { return !fallback; },
    time, play, pause,
    async start() { await load(); return play(); },
    at(t) {
      if (stopped || time() >= t) return Promise.resolve(!stopped);
      return new Promise(resolve => { waiters.add({ t, resolve }); wake(); });
    },
    // A stretch of the part, as the build's flights read a spoken line: done when it is over, progress 0..1.
    span(t0, t1) {
      const done = this.at(t1);
      return { done, get over() { return stopped || time() >= t1; }, progress: () => (t1 > t0 ? clamp((time() - t0) / (t1 - t0)) : 1) };
    },
    stop() {
      stopped = true; playing = false; cancelAnimationFrame(raf); raf = 0;
      try { if (media && !fallback) media.pause(); } catch {}
      show('');
      for (const w of waiters) w.resolve(false);
      waiters.clear();
    },
    state: () => ({ time: +time().toFixed(2), duration: script.duration, playing, stopped, recorded: !fallback, caption: shown }),
  };
}
