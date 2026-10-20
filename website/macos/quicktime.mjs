import { openShellWindow } from '../mac/shell.mjs?v=kinso-install-1';
import { waitForMedia, primeVideo, playVideo, firstVideoFrame } from '../media.mjs';
import { MACOS, animate, metrics, motionClock } from './timings.mjs?v=sequoia-4';
import { moviePicture } from './window-picture.mjs?v=sequoia-4';

const make = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const glyph = paths => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const GLYPHS = {
  play: glyph('<path d="M6 3v18l15-9z"/>'), pause: glyph('<path d="M6 3h4v18H6zm8 0h4v18h-4z"/>'),
  back: glyph('<path d="m12 5-11 7 11 7zm11 0-11 7 11 7z"/>'), forward: glyph('<path d="m1 5 11 7-11 7zm11 0 11 7-11 7z"/>'),
  volume: glyph('<path d="M2 9h4l6-5v16l-6-5H2z"/><g fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 8q4 4 0 8m3-11q7 7 0 14"/></g>'),
  airplay: glyph('<path d="m12 14 7 8H5z"/><path d="M5 17H2V3h20v14h-3" fill="none" stroke="currentColor" stroke-width="1.5"/>'),
  pip: glyph('<path d="M2 4h20v16H2z" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="11" y="11" width="10" height="8" rx="1"/>'),
  more: glyph('<path d="m5 5 7 7-7 7m7-14 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.5"/>'),
};
const stamp = seconds => { seconds = Math.max(0, Math.floor(seconds || 0)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };

export function createQuickTime({ stage, film, reduced, onended, onphase = () => {}, timeoutMs = 20000 }) {
  metrics();
  const video = make('video', 'quicktime-video'); video.id = 'quicktimeVideo'; video.playsInline = true; video.preload = 'auto'; video.src = film.url;
  video.setAttribute('aria-label', film.title);
  const body = make('div', 'quicktime-content'), hud = make('div', 'quicktime-hud'), top = make('div', 'quicktime-hud-top'), timeline = make('div', 'quicktime-timeline');
  const elapsed = make('output', '', '00:00'), remaining = make('output', '', '00:00');
  function button(label, icon, action, parent = top) {
    const el = make('button'); el.type = 'button'; el.setAttribute('aria-label', label); el.innerHTML = GLYPHS[icon]; el.addEventListener('click', action); parent.append(el); return el;
  }
  function range(label, max, value) { const el = make('input'); el.type = 'range'; el.min = '0'; el.max = String(max); el.value = String(value); el.setAttribute('aria-label', label); return el; }
  const volume = make('div', 'quicktime-volume'); top.append(volume);
  button('Mute', 'volume', () => { video.muted = !video.muted; }, volume);
  const loudness = range('Volume', 1, 1); loudness.step = '.01'; loudness.addEventListener('input', () => { video.volume = +loudness.value; video.muted = false; }); volume.append(loudness);
  button('Rewind', 'back', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
  const play = button('Pause', 'pause', () => video.paused ? resume() : video.pause()); play.className = 'quicktime-play';
  button('Fast-forward', 'forward', () => { video.playbackRate = video.playbackRate >= 8 ? 1 : video.playbackRate * 2; });
  const airplay = button('AirPlay', 'airplay', () => { try { if (video.webkitShowPlaybackTargetPicker) video.webkitShowPlaybackTargetPicker(); else video.remote?.prompt().catch(() => {}); } catch {} });
  airplay.disabled = !video.webkitShowPlaybackTargetPicker && !video.remote;
  const pip = button('Picture in Picture', 'pip', () => video.requestPictureInPicture?.().catch(() => {})); pip.disabled = !document.pictureInPictureEnabled;
  button('Playback speed', 'more', () => { video.playbackRate = video.playbackRate === 1 ? 1.5 : 1; });
  const seek = range('Playback position', 45, 0); seek.step = '.01'; seek.addEventListener('input', () => { if (Number.isFinite(video.duration)) video.currentTime = +seek.value; });
  timeline.append(elapsed, seek, remaining); hud.append(top, timeline);
  const error = make('div', 'quicktime-error'); error.hidden = true; error.setAttribute('role', 'status');
  const message = make('p'), retry = make('button', '', 'Retry'), proceed = make('button', '', 'Continue'); retry.type = proceed.type = 'button'; error.append(message, retry, proceed);
  body.append(video, hud, error);
  let win, prime = null, generation = 0, ending = false, cancelled = false, raf, lastPointer = 0, stall, wasPlaying = false;
  function preview() {
    const c = document.createElement('canvas'); c.width = 480; c.height = 270;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
    try { ctx.drawImage(video, 0, 0, c.width, c.height); } catch {}
    return c;
  }
  function prepare() {
    if (win) return win;
    const width = MACOS.windowWidth, height = width * 9 / 16;
    win = openShellWindow({ id: 'quicktime', appName: 'QuickTime Player', title: film.title, content: body, className: 'quicktime', width, height,
      x: (1600 - width) / 2, y: Math.max(40, (stage.offsetHeight - 90 - height) / 2),
      icon: new URL('./quicktime.webp', import.meta.url).href, preview, capture: () => moviePicture(win.element, video) });
    win.element.dataset.hud = 'true'; win.element.tabIndex = 0;
    win.element.addEventListener('pointermove', showHUD); win.element.addEventListener('pointerdown', showHUD);
    win.element.addEventListener('focusin', showHUD);
    win.element.addEventListener('keydown', event => {
      if (event.key === ' ' && !event.target.closest('button,input')) { event.preventDefault(); video.paused ? resume() : video.pause(); showHUD(); }
    });
    const close = win.close; win.close = () => { close(); video.pause(); finish(); return win; };
    win.minimize({ animate: false }); return win;
  }
  function showHUD() { lastPointer = motionClock(); if (win) win.element.dataset.hud = 'true'; }
  function update() {
    if (cancelled) return;
    if (win) {
      if (!video.paused && motionClock() - lastPointer > MACOS.hudHideMs / 1000 && !hud.matches(':focus-within')) win.element.dataset.hud = 'false';
      play.innerHTML = video.paused ? GLYPHS.play : GLYPHS.pause; play.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
      elapsed.value = stamp(video.currentTime); remaining.value = stamp(video.duration - video.currentTime);
      if (Number.isFinite(video.duration)) seek.max = String(video.duration); seek.value = String(video.currentTime);
    }
    raf = requestAnimationFrame(update);
  }
  async function resume() {
    const id = generation; error.hidden = true;
    try { video.muted = false; await playVideo(video, { timeoutMs }); if (id === generation) { onphase('quicktime'); showHUD(); } }
    catch (e) { if (id === generation) failed(e); }
  }
  function failed(e) {
    clearTimeout(stall); video.pause(); error.hidden = false; showHUD();
    const blocked = e?.name === 'NotAllowedError'; message.textContent = blocked ? 'Play with sound.' : 'The film is unavailable.';
    retry.textContent = blocked ? 'Play' : 'Retry'; onphase(blocked ? 'quicktime-blocked' : 'quicktime-error');
  }
  async function finish() {
    if (ending || cancelled) return; ending = true; ++generation; clearTimeout(stall); video.pause();
    if (win?.state === 'open') win.minimize();
    await win?.settled;
    if (!cancelled) { stage.dataset.player = 'false'; await onended?.(); }
  }
  video.addEventListener('ended', finish);
  video.addEventListener('error', () => { if (win && !cancelled && !ending) failed(); });
  const waiting = () => { if (!stall && win && !video.paused) stall = setTimeout(() => failed(), timeoutMs); };
  for (const type of ['waiting', 'stalled']) video.addEventListener(type, waiting);
  video.addEventListener('playing', () => { clearTimeout(stall); stall = null; });
  retry.addEventListener('click', () => { if (video.error) video.load(); resume(); }); proceed.addEventListener('click', finish);
  document.addEventListener('visibilitychange', () => {
    if (!win || ending || cancelled) return;
    if (document.hidden) { wasPlaying = !video.paused; video.pause(); }
    else if (wasPlaying) { wasPlaying = false; resume(); }
  });
  return {
    video, prepare,
    // Called synchronously by the password submit, before the locker request.
    prime() { prime ||= primeVideo(video, { isCurrent: () => !win && !cancelled }).catch(() => { prime = null; }); return prime; },
    async play() {
      prepare(); const id = ++generation; cancelled = false; ending = false; onphase('quicktime-loading');
      showHUD(); cancelAnimationFrame(raf); update();
      await animate(MACOS.restoreDelayMs, () => {}).finished;
      if (id !== generation) return;
      try {
        await waitForMedia(video, { timeoutMs });
        if (id !== generation) return;
        win.restore(); await win.settled;
        if (id !== generation) return;
        video.volume = 1; video.muted = false; await playVideo(video, { timeoutMs }); await firstVideoFrame(video);
        if (id === generation) { onphase('quicktime'); showHUD(); }
      } catch (e) {
        if (id !== generation) return;
        win.restore(); await win.settled; failed(e);
      }
    },
    stop() { cancelled = true; ++generation; clearTimeout(stall); cancelAnimationFrame(raf); video.pause(); if (win) win.close(); stage.dataset.player = 'false'; },
    state: () => ({ window: win?.state ?? null, time: video.currentTime, paused: video.paused, muted: video.muted, hud: win?.element.dataset.hud === 'true', ending }),
  };
}
