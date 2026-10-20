// Presentation only. The native session-lock keeper consumes ALL keys and authenticates
// through PAM. Its bridge sends counts/check/results, never a password to this page.
import { createSequence } from '../../website/boot/sequence.mjs?v=kinso-lift-2';
import { mountLock } from '../../website/macos/lock.mjs?v=kinso-lift-2';
import { MACOS, ease } from '../../website/macos/timings.mjs?v=sequoia-4';
import { BURST } from '../../website/bootup.mjs';

const query = new URLSearchParams(location.search);
const hex = (name, fallback) => /^[0-9a-f]{6}$/i.test(query.get(name) || '') ? '#' + query.get(name) : fallback;
const IDLE = Number(query.get('idle')) > 0 ? Number(query.get('idle')) : 60;
const EPOCH = Number(query.get('epoch')) > 0 ? Number(query.get('epoch')) : Date.now() / 1000;
const clock = () => window.__lockClock ?? performance.now() / 1000;
const profile = window.__lockProfile;
const native = window.webkit?.messageHandlers?.imperfect;
const tell = msg => {
  if (['ready', 'touch', 'box', 'idle'].includes(msg.split(':')[0])) profile?.mark(msg.split(':')[0]);
  try { native?.postMessage(msg); } catch {}
  window.__lockSaid = [...(window.__lockSaid || []), msg];
};
const box = document.getElementById('box');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const view = mountLock({ screen: box, native: true, clock, reduced, date: () => new Date((window.__lockWall ?? Date.now() / 1000) * 1000) });
const dotsEl = view.dots;
const S = { phase: 'scene', typed: 0, checking: false, wrong: null, yes: false, heard: clock(), keyAt: -1, outAt: null, done: false };
const boot = createSequence({
  clock, fixed: () => window.__lockClock !== undefined,
  wall: () => window.__lockWall ?? Date.now() / 1000, epoch: EPOCH,
  bg: hex('bg', '#000000'), ink: hex('ink', '#ffffff'), profile,
  onMove: heard, keepAlive: () => S.phase !== 'scene',
  tell(msg) {
    if (msg === 'complete') {
      if (S.yes || S.phase === 'leaving') return;
      S.phase = 'box'; S.heard = clock(); view.show({ focus: false }); box.style.opacity = '1'; showDots();
      if (S.checking) view.checking(); tell('box');
    } else if (msg !== 'move') tell(msg);
  },
  onFrame(t, state) {
    // Preserve the fast path for an already-authenticated person: no password field,
    // and never release before the burst settles. Only PAM's yes can enter this path.
    if (S.yes && S.phase !== 'leaving' && state.pop !== null && state.tau >= BURST + 0.8) leave();
    view.render(t);
    if (S.phase === 'leaving') boot.intro.arrival(ease((t - S.outAt) * 1000 / (reduced.matches ? MACOS.reduceMs : MACOS.unlockMs)));
    if (S.phase === 'box') {
      drawBox(t);
      if (t - S.heard > IDLE && !S.checking) goBack();
    } else if (S.phase === 'leaving' && (t - S.outAt) * 1000 >= (reduced.matches ? MACOS.reduceMs : MACOS.unlockMs) && !state.burst && !S.done) {
      S.done = true; tell('done');
    }
  },
});
function heard() { S.heard = clock(); }
window.lock = {
  key(count = S.typed + 1) {
    heard(); S.keyAt = clock(); S.typed = Math.max(0, Math.floor(Number(count) || 0)); S.wrong = null;
    boot.intro.approach(); view.edit(S.typed);
  },
  clear() { S.typed = 0; S.wrong = null; view.edit(0); },
  check() { heard(); S.checking = true; view.checking(); },
  answer(ok) {
    heard(); S.checking = false;
    if (ok) { S.yes = true; if (S.phase === 'box') leave(); else boot.intro.approach(); return; }
    S.wrong = { at: clock(), count: S.typed }; S.typed = 0; view.wrong();
  },
  nudge(screens) { heard(); boot.intro.nudge(screens); },
};
function showDots() { if (!S.wrong) view.setCount(S.typed); }
function drawBox(t) { if (S.wrong && view.state === 'idle') S.wrong = null; }
function leave() {
  S.phase = 'leaving'; S.outAt = clock(); view.open(); view.leave(); boot.intro.marks(false);
}
function goBack() {
  S.phase = 'scene'; S.typed = 0; S.checking = false; S.wrong = null;
  view.hide(); view.edit(0); tell('idle'); boot.intro.reset();
}
for (const type of ['wheel', 'touchstart', 'pointerdown']) addEventListener(type, () => { if (S.phase === 'box') heard(); }, { passive: true });
window.__lock = () => {
  const st = boot.intro.state();
  return { ...st, phase: S.phase === 'scene' ? st.phase === 'ready' ? 'box' : st.phase : S.phase,
    typed: S.typed, dots: dotsEl.children.length, checking: S.checking, yes: S.yes,
    gl: st.mode, burst: !!st.burst, entrances: [], box: !box.hidden && +box.style.opacity,
    sky: getComputedStyle(document.getElementById('sky')).visibility, said: window.__lockSaid || [] };
};
boot.ready.then(() => {
  boot.intro.start({ auto: false });
  if (S.typed || S.yes) boot.intro.approach();
}).catch(e => { window.__lockError = String(e.message || e); console.error(e); });
