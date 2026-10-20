// The film window on kinso.computer's desktop: a plain window, no title bar and no way to close it, that pops up in the
// middle once the Mac is unlocked and plays Noah on camera (part 1), then the launch video. Without a recording, part 1
// is black with its words as subtitles, read aloud at PACE, and the launch video is a plain five-second slot.
// Then the build (build.mjs) takes over: the film steps back as Kinso's window opens (recede), and later becomes a file
// in Files (intoFiles). It is macos/launch.mjs's player: prime, prepare, play, stop, state.
import { MEDIA, OPENER, LAUNCH_SLOT_S } from './script.mjs?v=kinso-1';
import { createNarration, mediaURL } from './narration.mjs?v=kinso-1';
import { primeVideo } from '../media.mjs';

export const FILM_SIZE = Object.freeze({ width: 1120, height: 630 });
const make = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Noah (20 Oct): the film came out of the Dock a little fast; it now pops up a second after the desktop shows.
const SETTLE_MS = 1000;

export function createKinsoFilm({ stage, reduced, onphase = () => {}, onended, media = MEDIA }) {
  const el = make('section', 'kinso-film'); el.dataset.segment = 'none'; el.hidden = true;
  el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Noah, on camera');
  const video = make('video', 'kinso-film-video'); video.playsInline = true; video.preload = 'auto'; video.hidden = true;
  const caption = make('p', 'kinso-film-caption'); caption.hidden = true;
  const slot = make('div', 'kinso-film-slot'); slot.hidden = true;
  slot.append(make('p', '', 'Launch video'), make('i'));
  const blocked = make('button', 'kinso-film-play', 'Play with sound'); blocked.type = 'button'; blocked.hidden = true;
  el.append(video, caption, slot, blocked);
  const opener = mediaURL(media.opener?.video ?? media.opener), launch = mediaURL(media.launch?.video ?? media.launch);
  let generation = 0, segment = 'none', narration = null, primed = null, resumeBlocked = null, placed = false;
  function place() {
    if (placed) return; placed = true;
    const { width, height } = FILM_SIZE;
    Object.assign(el.style, { left: `${(1600 - width) / 2}px`, top: `${Math.max(40, (stage.offsetHeight - 90 - height) / 2)}px`, width: `${width}px`, height: `${height}px` });
  }
  function prepare() { if (!el.isConnected) stage.append(el); place(); }
  const set = name => { segment = name; el.dataset.segment = name; };
  // Sound needs the unlock's own press (Safari): the recordings are primed in it.
  function prime() {
    if (primed || (!opener && !launch)) return primed;
    video.src = opener || launch;
    primed = primeVideo(video, { isCurrent: () => segment === 'none' }).catch(() => { primed = null; });
    return primed;
  }
  // A video to its end; refused sound asks for a press, a failed file moves on.
  function playVideo(url, id) {
    return new Promise(resolve => {
      video.hidden = false; caption.hidden = true;
      if (!video.src.endsWith(url)) video.src = url;
      const finish = () => { video.removeEventListener('ended', finish); video.removeEventListener('error', finish); resolve(); };
      video.addEventListener('ended', finish); video.addEventListener('error', finish);
      const start = () => { video.muted = false; video.currentTime = 0;
        Promise.resolve(video.play()).then(() => { blocked.hidden = true; onphase('kinso-film'); }, error => {
          if (id !== generation) return;
          if (error?.name === 'NotAllowedError') { blocked.hidden = false; resumeBlocked = start; onphase('kinso-film-blocked'); } else finish();
        });
      };
      start();
    });
  }
  blocked.addEventListener('click', () => { blocked.hidden = true; resumeBlocked?.(); });
  async function playOpener(id) {
    set('opener');
    if (opener) {
      // Subtitles over the recording too, if its words' timings are given.
      if (media.opener?.words) { narration = createNarration({ paragraphs: OPENER, media: video, words: media.opener.words, caption }); await narration.load(); }
      const done = playVideo(opener, id); narration?.play(); await done; narration?.stop(); return;
    }
    // Part 1 as subtitles on black, until Noah records it.
    video.hidden = true;
    narration = createNarration({ paragraphs: OPENER, caption });
    narration.play(); onphase('kinso-film');
    await narration.at(narration.duration);
    narration.stop();
  }
  async function playLaunch(id) {
    set('launch');
    if (launch) { caption.hidden = true; await playVideo(launch, id); return; }
    video.hidden = true; caption.hidden = true; slot.hidden = false;
    const bar = slot.querySelector('i');
    bar.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: LAUNCH_SLOT_S * 1000, easing: 'linear', fill: 'forwards' });
    await sleep(LAUNCH_SLOT_S * 1000);
  }
  // The window's own pop, as macOS opens one: from a little smaller, quickly.
  function pop() {
    el.hidden = false;
    if (reduced.matches) return Promise.resolve();
    return el.animate([{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.catch(() => {});
  }
  return {
    element: el, video,
    prime, prepare,
    async play() {
      prepare(); const id = ++generation; onphase('kinso-film-loading');
      await sleep(reduced.matches ? 0 : SETTLE_MS);
      if (id !== generation) return;
      await pop();
      await playOpener(id); if (id !== generation) return;
      await playLaunch(id); if (id !== generation) return;
      set('ended'); onphase('kinso-film-ended');
      await onended?.();
    },
    // The build begins: the film steps back and goes, as Kinso's empty window opens in front of it.
    recede() {
      el.dataset.place = 'behind'; try { video.pause(); } catch {}
      if (reduced.matches) { el.style.opacity = '0'; return Promise.resolve(); }
      return el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.7)' }], { duration: 520, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }).finished.catch(() => {});
    },
    // "Even the video you just watched is only a file now": it comes forward, small, then shrinks into `tile` (Home,
    // under Files in the sidebar, in Mac points) along a short arc, as a file dropped there.
    async intoFiles(tile, { comeBack = 520, file = 760 } = {}) {
      for (const a of el.getAnimations()) a.cancel();
      const width = 480, height = width * FILM_SIZE.height / FILM_SIZE.width;
      const left = Math.max(tile.x + 180, (1600 - width) / 2 - 120), top = Math.max(60, tile.y - 40);
      Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, opacity: '' });
      el.dataset.place = 'front';
      if (reduced.matches) { el.hidden = true; el.dataset.place = 'filed'; return; }
      await el.animate([{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'scale(1)' }], { duration: comeBack, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.catch(() => {});
      const k = tile.width / width, dx = tile.x + tile.width / 2 - (left + width / 2), dy = tile.y + tile.height / 2 - (top + height / 2);
      await el.animate([
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${dx * .55}px, ${dy * .55 - 40}px) scale(${(1 + k) * .45})`, opacity: 1, offset: .55 },
        { transform: `translate(${dx}px, ${dy}px) scale(${k})`, opacity: 0 },
      ], { duration: file, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' }).finished.catch(() => {});
      el.hidden = true; el.dataset.place = 'filed';
    },
    hide() { el.hidden = true; },
    stop() { ++generation; narration?.stop(); try { video.pause(); } catch {} el.hidden = true; stage.dataset.player = 'false'; },
    state: () => ({ segment, recorded: { opener: Boolean(opener), launch: Boolean(launch) }, narration: narration?.state() ?? null, place: el.dataset.place ?? null, hidden: el.hidden }),
  };
}
