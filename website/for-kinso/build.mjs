// The build on kinso.computer, told to part 2 of Noah's words (script.mjs BEATS): mac/desktop.mjs's `script`. Every step
// lands on a word: the cursor takes an app from the Dock and lets go of it in Kinso's window as that word is said, and
// the product inside paints its part (launch.mjs, assembly). Until Noah records the voice-over its words are
// subtitles, read at PACE; with his recording and its word timings (script.mjs MEDIA) the same steps follow his voice.
import { BEATS, MEDIA } from './script.mjs?v=kinso-1';
import { createNarration, mediaURL } from './narration.mjs?v=kinso-1';
import { cueTime } from './timeline.mjs?v=kinso-1';
import { glowMenu, openCodeWindow } from '../mac/shell.mjs?v=kinso-install-1';
import { primeVideo } from '../media.mjs';

// Where in the window each kind of app goes: the conversation, the panel on the right, the sidebar on the left.
const MIDDLE = [.5, .5], PANEL = [.8, .42], SIDEBAR = [.09, .46];
// Home, under Files in the sidebar: where the film goes once it is a file (the panel on the right is the browser by then).
const FILES = [.06, .25];
// Each drag: the Dock app, the product's step it paints (launch.mjs ASSEMBLY), where it goes, and the word it lands on
// (the paragraph is the beat, 0-based; edge: the word's start or its end).
export const DRAGS = Object.freeze([
  { app: 'claude', build: 'claude', to: MIDDLE, on: { para: 1, word: 'Code', edge: 'end' } },
  { app: 'chatgpt', build: 'codex', to: MIDDLE, on: { para: 1, word: 'Codex', edge: 'end' } },
  { app: 'finder', build: 'files', to: PANEL, on: { para: 2, word: 'files.', edge: 'end' } },
  { app: 'safari', build: 'browser', to: PANEL, on: { para: 3, word: 'browser,', edge: 'end' } },
  { app: 'gmail', build: 'messages', to: SIDEBAR, on: { para: 4, word: 'Gmail,', edge: 'end' } },
  { app: 'linkedin', build: null, to: SIDEBAR, on: { para: 4, word: 'LinkedIn,', edge: 'end' } },
  { app: 'instagram', build: null, to: SIDEBAR, on: { para: 4, word: 'Instagram,', edge: 'end' } },
]);
// The other moments: the window opens (beat 1), the film becomes a file (6), the product is done and its browser shows
// the Kinso Computer page (8), the cursor lets go (9), Code is lit and opened (10).
export const MOMENTS = Object.freeze({
  open: { para: 0 },
  file: { para: 5, word: 'file', edge: 'end' },
  done: { para: 7 },
  page: { para: 7, word: 'thirty-nine' },
  letGo: { para: 8, word: 'real.', edge: 'end' },
  glow: { para: 9, word: 'Code' },
  code: { para: 9, word: 'Copy' },
});
const PICK_S = .55, CARRY_S = 1.1, MIN_CARRY_S = .7;

export function createKinsoBuild({ stage, film, reduced, media = MEDIA }) {
  const caption = document.createElement('p'); caption.className = 'kinso-caption'; caption.hidden = true;
  caption.setAttribute('aria-live', 'polite');
  const audio = media.voiceover?.audio ? document.createElement('audio') : null;
  if (audio) { audio.preload = 'auto'; audio.src = mediaURL(media.voiceover.audio); }
  const narration = createNarration({ paragraphs: BEATS.map(beat => beat.text), media: audio, words: media.voiceover?.words ?? null, caption });
  let beat = -1, stopped = false, primed = null;
  const when = spec => cueTime(narration.words, spec);
  const wait = async t => !stopped && await narration.at(t) && !stopped;
  const windowRect = api => api.localRect(api.frame);
  const into = (api, [u, v]) => { const r = windowRect(api); return { x: r.left + r.width * u, y: r.top + r.height * v }; };
  // An app from the Dock into the window, letting go on its word.
  async function drag(api, { app, build, to, on }) {
    const land = when(on);
    if (!await wait(land - CARRY_S - PICK_S)) return;
    const held = await api.pick(app);
    if (!held || stopped || api.stopped()) return;
    const target = into(api, to), t0 = Math.max(narration.time(), land - CARRY_S), t1 = Math.max(land, t0 + MIN_CARRY_S);
    const span = narration.span(t0, t1);
    await api.flight(held, target, span, 0, 1);
    if (!await span.done || api.stopped()) { held.ghost.remove(); return; }
    // The product paints in its own time; the voice does not wait for it.
    void api.drop(app, held.tile, held.ghost, target, build, false);
  }
  // Beat 1: the film steps back as Kinso's plain, empty window opens in the middle.
  async function open(api) {
    const win = stage.querySelector('.mac-window');
    void film.recede();
    stage.dataset.player = 'false';
    if (!reduced.matches) await win.animate([{ opacity: 0, transform: 'scale(.86)', transformOrigin: '50% 50%' }, { opacity: 1, transform: 'scale(1)', transformOrigin: '50% 50%' }],
      { duration: 560, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.catch(() => {});
  }
  return {
    // The apps the build folds into Kinso (desktop.mjs complete() takes them from the Dock when it is skipped).
    steps: [{ apps: DRAGS.map(drag => drag.app), trash: false }],
    caption,
    prime() { if (audio && !primed) primed = primeVideo(audio, { isCurrent: () => beat < 0 }).catch(() => { primed = null; }); },
    async play(api) {
      stage.append(caption);
      await narration.load();
      if (stopped) return;
      narration.play();
      beat = 0; api.step(0);
      if (!await wait(when(MOMENTS.open) - .4)) return;
      await open(api);
      for (const d of DRAGS) {
        if (stopped || api.stopped()) return;
        beat = d.on.para; api.step(beat);
        await drag(api, d);
      }
      // Beat 6: the launch video becomes a file in the Files panel.
      if (!await wait(when(MOMENTS.file) - 1.1)) return;
      beat = 5; api.step(5);
      const r = windowRect(api), home = into(api, FILES);
      await film.intoFiles({ x: home.x - 24, y: home.y - 13, width: 48, height: 27 });
      // Beat 7: the window settles; the cursor rests by it.
      beat = 6; api.step(6);
      void api.move(r.left + r.width * .62, r.top + r.height * .66, 1400);
      // Beat 8: the product is whole, and its browser shows the Kinso Computer page (US$39 a month).
      if (!await wait(when(MOMENTS.done))) return;
      beat = 7; api.step(7);
      void api.build('done');
      if (!await wait(when(MOMENTS.page))) return;
      stage.dispatchEvent(new CustomEvent('mac:shop', { bubbles: true }));
      // Beat 9: the cursor lets go; the computer is theirs.
      if (!await wait(when(MOMENTS.letGo))) return;
      beat = 8; api.step(8);
      const { x, y } = api.at();
      await api.move(x + 36, y - 60, 500);
      await api.onfinish?.();
      // Beat 10: Code in the menu bar, and its one command.
      if (!await wait(when(MOMENTS.glow))) return;
      beat = 9; api.step(9);
      glowMenu('code');
      if (!await wait(when(MOMENTS.code))) return;
      openCodeWindow();
      if (!await wait(narration.duration)) return;
      beat = 10; glowMenu('code', false);
      narration.stop();
    },
    stop() { stopped = true; narration.stop(); glowMenu('code', false); caption.hidden = true; },
    state: () => ({ beat, narration: narration.state() }),
  };
}
