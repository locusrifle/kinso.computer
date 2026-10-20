import { grid, bindHarnessKeys, registerKeyBinding, activeKeyBindings, MOD } from './pi-card.js';
import { mountGueyPi } from './harness.js';
import { mountArrival } from './arrival.js';
import { notifyDemoReady } from './demo-ready.js';
import { mountLaunchDrag } from './assembly.js';
import { turn } from './turn.js';

const byId = id => document.getElementById(id);
const input = byId('entry-input');

// imperfect is the window: the conversation is its first window, from the
// start (index.html), and what it opens tiles beside it (windows.js).
const canvas = byId('canvas');

function resizeGrid() {
  grid();
  dispatchEvent(new CustomEvent('imperfect:gridchange'));
}

// A keyboard is the person's decision on a phone.
//
// On a desk handing the caret back costs nothing: close a dialog, close the
// sheet, step to imperfect, and you carry on typing where you were. On a touch
// surface every one of those handovers throws half the screen away and fills
// it with keys nobody asked for -- and stepping between windows or opening
// imperfect did it too, so the keyboard came and went with the layout rather than
// with any intention. The composer is only focused for you where focusing it
// costs nothing. On a phone it waits to be touched, and the only thing that
// opens the keyboard is a finger on the field itself.
const handsOnKeys = () => !matchMedia('(pointer: coarse)').matches && !document.querySelector('.usage-open');
const focusComposer = (node = input) => { if (handsOnKeys()) node.focus(); };

// And that is enforced here rather than trusted to every caller: on a touch
// surface a text field takes focus only when the finger that went down landed
// on that field. Anything else -- a tap on the transcript, a session opening,
// a dialog arriving -- is refused before the keyboard can rise.
const TYPED = 'textarea, input:not([type=button], [type=checkbox], [type=radio], [type=submit], [type=range], [type=file], [type=color]), [contenteditable=""], [contenteditable="true"]';
const onTouch = () => Boolean(globalThis.ImperfectPhone) || matchMedia('(pointer: coarse)').matches;
let touched = null;
document.addEventListener('pointerdown', event => { touched = event.target.closest?.(TYPED) ?? null; }, true);
// A streamed website has no local DOM field to tap. Authorize only its
// invisible keyboard bridge, after a trusted tap on that same page picture.
// Snapshots, scrolling and background autofocus cannot grant this exception.
document.addEventListener('browser-field-gesture', event => {
  const { field, gesture } = event.detail ?? {};
  const view = gesture?.target?.closest?.('.browser-live-view');
  if (gesture?.isTrusted && gesture.type === 'pointerup' && view?.contains(field) && field?.matches('textarea.browser-live-keyboard, input.browser-live-keyboard[type=password]')) touched = field;
});
const refused = node => Boolean(node.closest?.('.entry-screen.usage-open > :not(.usage-box)'))
  || (Boolean(document.querySelector('.usage-open')) && node !== document.activeElement && Boolean(node.matches?.(TYPED)))
  || (onTouch() && node !== touched && Boolean(node.matches?.(TYPED)));
const nativeFocus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function focus(options) {
  if (!refused(this)) nativeFocus.call(this, options);
};
document.addEventListener('focusin', event => { if (refused(event.target)) event.target.blur(); }, true);

function lineHeight(node) {
  const style = getComputedStyle(node);
  const value = Number.parseFloat(style.lineHeight);
  return Number.isFinite(value) ? value : (Number.parseFloat(style.fontSize) || 16) * 1.2;
}

function growComposer() {
  input.style.height = 'auto';
  const line = lineHeight(input);
  const style = getComputedStyle(input);
  const pad = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  // Whole lines only, so a long message never shows half a line at its foot;
  // past a third of the room it scrolls. The room is the canvas, not the
  // window: on a phone the keys take their height out of it (--safe-bottom),
  // and a cap measured against the whole screen let the field outgrow what
  // was left above them.
  const room = canvas.clientHeight || innerHeight;
  const most = Math.max(1, Math.floor((room * 0.3) / line)) * line + pad;
  input.style.height = `${Math.min(Math.max(input.scrollHeight, line + pad), most)}px`;
}

resizeGrid();

const SURFACE_REVISION_KEY = 'imperfect.surface-code-revision';
const SURFACE_VIEW_KEY = 'imperfect.surface-canvas-view';
let loadedSurfaceRevision = '';
let restoredSurfaceView = null;
try {
  loadedSurfaceRevision = sessionStorage.getItem(SURFACE_REVISION_KEY) || '';
  restoredSurfaceView = JSON.parse(sessionStorage.getItem(SURFACE_VIEW_KEY) || 'null');
  sessionStorage.removeItem(SURFACE_VIEW_KEY);
} catch { restoredSurfaceView = null; }

const harness = mountGueyPi({
  hooks: {
    onDraftChange: growComposer,
    canFocus: handsOnKeys,
    onSheet: open => underSheet(open),
    openThemes: () => { void openThemes(); },
    openKeys: () => openKeys(),
  },
});

// imperfect OS's lock: only the sky while it holds, the rest in over it as the sky goes.
mountArrival();
mountLaunchDrag();
void notifyDemoReady(harness.ready);

// The rail is always there; this key hands the keyboard to it and back.
function toggleTabs() {
  if (harness.tabsOpen()) harness.closeTabs();
  else harness.openTabs();
}

bindHarnessKeys({ onTabs: toggleTabs });
// Session navigation is registered once by harness.js (MOD+Up/Down).
// MOD+Enter belongs to the composer, like Enter.
registerKeyBinding({
  label: `${MOD}+T`, description: 'collapse or expand the agents rail', code: 'KeyT', mod: true,
  handler: () => { harness.toggleRail(); },
});
registerKeyBinding({
  label: `${MOD}+Esc`, description: 'close focused tab, interrupting it if needed', code: 'Escape', mod: true,
  handler: () => {
    const tabs = harness.guiSnapshot().tabs ?? [];
    if (!tabs.length) return;
    // This is an explicit force-close gesture. A stale runtime can report busy
    // forever, so do not make that same unreliable flag prevent its removal.
    // The host aborts this turn before retiring its runtime. closeTab captures
    // this tab's owner and identity now, not after a later selection change.
    const focused = tabs.find(tab => tab.focused);
    if (focused) harness.closeTab(focused.id, { closeConfirmed: true, gesture: 'key' }).catch(() => {});
  },
});

// The keys, on a page of their own.
//
// The registry already knows every binding and whether it currently applies —
// it has to, to answer the key at all. So this is not a written list that drifts
// from the bindings; it is the bindings, asked what they are. A key that stops
// existing stops being taught.
const keysFace = document.createElement('section');
keysFace.id = 'keys-face';
keysFace.className = 'keys-face';
keysFace.hidden = true;
keysFace.setAttribute('aria-label', 'keybindings');
document.body.append(keysFace);

function keyRow(label, description) {
  const row = document.createElement('li');
  row.className = 'keys-row';
  const key = document.createElement('span');
  key.className = 'keys-key';
  key.textContent = label ?? '';
  const act = document.createElement('span');
  act.className = 'keys-act';
  act.textContent = description ?? '';
  row.append(key, act);
  return row;
}

function paintKeys() {
  const box = document.createElement('div');
  box.className = 'keys-box';
  const title = document.createElement('p');
  title.className = 'keys-title';
  title.textContent = 'keybindings';
  const list = document.createElement('ul');
  list.className = 'keys-list';
  const seen = new Set();
  for (const { label, description } of activeKeyBindings()) {
    if (!label || !description) continue;
    const key = `${label}\u0000${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.append(keyRow(label, description));
  }
  const hint = document.createElement('p');
  hint.className = 'keys-hint';
  hint.textContent = 'esc closes';
  box.append(title, list, hint);
  keysFace.replaceChildren(box);
}

function keysOpen() { return !keysFace.hidden; }
function openKeys() {
  paintKeys();
  if (keysFace.hidden) underSheet(true);
  keysFace.hidden = false;
  document.body.classList.add('keys-open');
}
function closeKeys() {
  if (keysFace.hidden) return;
  keysFace.hidden = true;
  document.body.classList.remove('keys-open');
  underSheet(false);
  focusComposer();
}
function toggleKeys() { keysOpen() ? closeKeys() : openKeys(); }
keysFace.addEventListener('pointerdown', event => { if (event.target === keysFace) closeKeys(); });

registerKeyBinding({
  label: `${MOD}+K`, description: 'show the keys', code: 'KeyK', mod: true,
  handler: () => onceCanvas(toggleKeys),
});
registerKeyBinding({
  label: 'Esc', description: 'close the keys', code: 'Escape',
  when: keysOpen, handler: closeKeys,
});

// A sheet over the canvas (the keys, the themes) is counted, so a new build
// never reloads the window out from under one.
let sheets = 0;
function underSheet(open) {
  sheets = Math.max(0, sheets + (open ? 1 : -1));
}

let lastCanvasKey = 0;
function onceCanvas(fn) {
  const now = performance.now();
  if (now - lastCanvasKey < 80) return;
  lastCanvasKey = now;
  fn();
}
let lookRev = '';

function lockCanvasZoom(event) {
  if (event.ctrlKey || event.type.startsWith('gesture')) event.preventDefault();
}
addEventListener('wheel', lockCanvasZoom, { passive: false });
addEventListener('gesturestart', lockCanvasZoom);
addEventListener('gesturechange', lockCanvasZoom);

// The theme picker.
//
// MOD+Shift+T, or three fingers drawn together: the store's
// picker (locker/public/store/desktop.js). The chosen theme large in the
// middle with an accent edge, the rest as narrow slanted slices either side,
// dimmed, wrapping round. ← → / Tab / the wheel / a swipe move, Enter or a
// click on the chosen one takes it, a click on another moves to it, Escape or
// the ground around it leaves. Black, then any the person made in
// ~/.imperfect/themes, each drawn as its own plain colour ground.
const PICK = { wide: 640, tall: 400, slice: 96, sliceTall: 340, overlap: 12, reach: 8 };
const picker = document.createElement('section');
picker.id = 'theme-picker';
picker.className = 'picker';
picker.hidden = true;
picker.tabIndex = -1;
picker.setAttribute('role', 'dialog');
picker.setAttribute('aria-label', 'theme');
picker.innerHTML = '<div class="picker-card"><div class="picker-strip"></div><p class="picker-name"></p></div>';
document.body.append(picker);
const pickStrip = picker.querySelector('.picker-strip');
const pickName = picker.querySelector('.picker-name');
let picking = null; // { items, index }
let pickerShownAt = 0;
// The fingers that drew the pinch lift over the picker that answered it; that
// lift is not a choice of theme.
const JUST_OPENED_MS = 350;

function pickerOpen() { return Boolean(picking); }

// A theme's face is its ground alone, with no logo overlay.
function themeFace(theme) {
  const face = document.createElement('span');
  face.className = 'pick-face';
  face.style.setProperty('--face-bg', theme.background.startsWith('linear-gradient') ? 'transparent' : theme.background);
  face.style.backgroundImage = theme.background.startsWith('linear-gradient') ? theme.background : 'none';
  if (theme.background.startsWith('linear-gradient')) face.style.backgroundSize = '100% 100%';
  return face;
}

function paintThemes(themes) {
  const items = themes.map(theme => ({ id: theme.id, name: theme.name, faces: [themeFace(theme)], current: theme.current }));
  picking = { items, index: Math.max(0, items.findIndex(item => item.current)) };
  pickStrip.replaceChildren(...items.map((item, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pick';
    button.dataset.theme = item.id;
    button.setAttribute('aria-label', item.name);
    const image = document.createElement('span');
    image.className = 'pick-image';
    image.append(...item.faces);
    button.append(image);
    button.addEventListener('click', event => { event.stopPropagation(); i === picking?.index ? takePick() : movePick(i - picking.index); });
    return button;
  }));
  paintPicker();
}

function paintPicker() {
  if (!picking) return;
  const { items, index } = picking;
  const step = PICK.slice + PICK.overlap;
  const width = PICK.wide + 2 * PICK.reach * step;
  const left = (width - PICK.wide) / 2;
  pickStrip.style.width = `${width}px`;
  pickStrip.style.height = `${PICK.tall}px`;
  picker.style.setProperty('--pick-scale', String(Math.min(1, (innerWidth - 24) / (PICK.wide + 2 * step), (innerHeight - 160) / PICK.tall)));
  const count = items.length;
  pickName.textContent = items[index]?.name ?? '';
  [...pickStrip.children].forEach((button, i) => {
    // Round the ring: slices on both sides.
    let rel = i - index;
    if (count > 2 && rel > count / 2) rel -= count;
    if (count > 2 && rel < -count / 2) rel += count;
    const chosen = rel === 0;
    button.hidden = Math.abs(rel) > PICK.reach;
    button.classList.toggle('chosen', chosen);
    Object.assign(button.style, {
      left: `${chosen ? left : rel < 0 ? left + rel * step : left + PICK.wide + PICK.overlap + (rel - 1) * step}px`,
      top: `${chosen ? 0 : (PICK.tall - PICK.sliceTall) / 2}px`,
      width: `${chosen ? PICK.wide : PICK.slice}px`,
      height: `${chosen ? PICK.tall : PICK.sliceTall}px`,
      zIndex: String(chosen ? 100 : 50 - Math.abs(rel)),
    });
  });
}

function movePick(step) {
  if (!picking || !picking.items.length) return;
  picking.index = (picking.index + step + picking.items.length) % picking.items.length;
  paintPicker();
}

function takePick() {
  const item = picking?.items[picking.index];
  closePicker();
  if (item) void hangTheme(item.id);
}

async function openThemes() {
  if (pickerOpen()) return;
  let answer = {};
  try { answer = await (await fetch('/themes.json', { cache: 'no-store' })).json(); }
  catch { answer = {}; }
  if (pickerOpen()) return;
  // Automatic first: the system's own light or dark, Mac · Light or Mac · Dark.
  const themes = answer.themes ?? [];
  const light = themes.find(theme => theme.id === 'mac-light')?.background ?? '#ffffff';
  const dark = themes.find(theme => theme.id === 'mac-dark')?.background ?? '#121214';
  paintThemes([{ id: 'auto', name: 'Automatic', background: `linear-gradient(135deg, ${light} 50%, ${dark} 50%)`, current: Boolean(answer.auto) },
    ...themes.map(theme => ({ ...theme, current: theme.current && !answer.auto }))]);
  pickerShownAt = performance.now();
  underSheet(true);
  picker.hidden = false;
  document.body.classList.add('picker-open');
  picker.focus();
}

function closePicker() {
  if (!pickerOpen()) return;
  picking = null;
  underSheet(false);
  picker.hidden = true;
  document.body.classList.remove('picker-open');
  focusComposer();
}

async function hangTheme(id) {
  try {
    await fetch('/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } catch { /* the theme stays as it was, which is visible without a message */ }
}

for (const type of ['pointerdown', 'click']) {
  picker.addEventListener(type, event => {
    if (performance.now() - pickerShownAt < JUST_OPENED_MS) {
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    if (type === 'click' && event.target === picker) closePicker();
  }, true);
}
picker.addEventListener('wheel', event => { event.preventDefault(); movePick(Math.sign(event.deltaY || event.deltaX)); }, { passive: false });
picker.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key] ?? (event.key === 'Tab' ? (event.shiftKey ? -1 : 1) : 0);
  if (step) movePick(step);
  else if (event.key === 'Enter') takePick();
  else if (event.key === 'Escape') closePicker();
  else return;
  event.preventDefault();
  event.stopPropagation();
});
// A finger drawn sideways turns the ring.
let swipe = null;
picker.addEventListener('pointerdown', event => { swipe = event.pointerType === 'touch' ? { x: event.clientX, y: event.clientY } : null; });
picker.addEventListener('pointerup', event => {
  if (!swipe) return;
  const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) movePick(dx < 0 ? 1 : -1);
});
addEventListener('resize', paintPicker);

// A new theme turns in (turn.js) once the stylesheet that brings it has loaded.
let themeSwap = Promise.resolve();
function turnTheme(href, animate) {
  // Reserve stylesheet swaps in request order, including the first (unanimated)
  // look. Its load handler must not remove a newer, still-loading stylesheet.
  const before = themeSwap;
  let settled;
  themeSwap = new Promise(done => { settled = done; });
  const swap = async () => {
    await before;
    try {
      await new Promise(done => {
        const sheets = document.querySelectorAll('link#theme-css');
        const last = sheets[sheets.length - 1];
        if (!last) { done(); return; }
        const next = last.cloneNode();
        next.href = href;
        const settle = () => {
          for (const sheet of document.querySelectorAll('link#theme-css')) if (sheet !== next) sheet.remove();
          done();
        };
        next.addEventListener('load', settle, { once: true });
        next.addEventListener('error', settle, { once: true });
        last.after(next);
      });
    } finally { settled(); }
  };
  if (animate) turn('turn', swap); else void swap();
}


// MOD+Shift+T, or three fingers drawn together, is the list of themes.
registerKeyBinding({
  label: `${MOD}+Shift+T`, description: 'themes', code: 'KeyT', mod: true, shift: true,
  handler: () => { if (pickerOpen()) closePicker(); else void openThemes(); },
});
const fingers = event => [...event.touches].map(touch => ({ x: touch.clientX, y: touch.clientY }));
let pinch = null;
// Three fingers that close in together, not a pan: each finger ends nearer the
// others than it started.
const spread = points => { const cx = points.reduce((t, p) => t + p.x, 0) / points.length, cy = points.reduce((t, p) => t + p.y, 0) / points.length; return points.reduce((t, p) => t + Math.hypot(p.x - cx, p.y - cy), 0) / points.length; };

function onPhoneTouchStart(event) {
  pinch = event.touches.length === 3 && !pickerOpen() ? { points: fingers(event) } : null;
}

function onPhoneTouchMove(event) {
  if (!pinch || event.touches.length !== 3) return;
  if (spread(fingers(event)) > spread(pinch.points) * 0.6) return;
  pinch = null;
  void openThemes();
}

addEventListener('imperfect-themes', () => { void openThemes(); });
addEventListener('imperfect-pinch', event => {
  if (Number(event.detail?.fingers) === 3) void openThemes();
});
// In the Android app the keys' room is the app's to give (--safe-bottom); the
// page does not shrink for them as well, which lifted it over empty space.
if (window.imperfectNative) {
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) viewport.content = viewport.content.replace('interactive-widget=resizes-content', 'interactive-widget=overlays-content');
}

// A control pressed with a finger answers with a click of the phone's
// vibration motor: through the Android app's bridge, or the web's own
// vibration where a browser has one.
addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch' || !event.target.closest?.('button, [role="button"], a[href], label, summary, select')) return;
  try { if (window.imperfectNative?.tick) window.imperfectNative.tick(); else navigator.vibrate?.(8); } catch { /* no motor */ }
}, { passive: true, capture: true });
addEventListener('touchstart', onPhoneTouchStart, { passive: true });
addEventListener('touchmove', onPhoneTouchMove, { passive: true });
addEventListener('touchend', () => { pinch = null; }, { passive: true });

input.addEventListener('input', growComposer);
addEventListener('resize', resizeGrid);
growComposer();
// Workbench, in imperfect's window, at the folder asked for if any (a
// folder opened from elsewhere, or imperfect-open files).
const opened = new URLSearchParams(location.search);
if (opened.get('face') === 'files') harness.openFiles(opened.get('path') || '');
// A notification tapped with imperfect closed opens it at its session.
if (opened.get('session')) {
  void harness.showSession(opened.get('session'));
  opened.delete('session');
  history.replaceState(history.state, '', `${location.pathname}${opened.size ? `?${opened}` : ''}${location.hash}`);
}
focusComposer();
if (restoredSurfaceView) requestAnimationFrame(() => {
  scrollTo(Number(restoredSurfaceView.windowX) || 0, Number(restoredSurfaceView.windowY) || 0);
  restoredSurfaceView = null;
});
// The keys rising on a phone move the canvas's foot, not the window's.
new ResizeObserver(growComposer).observe(canvas);
// Inline status changes the field's width without resizing the canvas. Refit
// wrapped drafts too, but ignore our own height changes.
let composerWidth = input.clientWidth;
new ResizeObserver(() => {
  if (input.clientWidth === composerWidth) return;
  composerWidth = input.clientWidth;
  growComposer();
}).observe(input);
// The machine says what it looks like -- theme and build -- over the
// socket, once on connect and again whenever it changes. Nothing is polled.
addEventListener('imperfect-look', event => {
  const next = event.detail;
  followSurfaceRelease(String(next?.build || ''));
  if (!next?.rev || next.rev === lookRev) return;
  const changed = Boolean(lookRev);
  lookRev = next.rev;
  turnTheme(`/theme.css?r=${encodeURIComponent(next.rev)}`, changed);
});

// A restart that brings a different build reloads the window at the first
// non-destructive point: no draft, attachment, picker, or sheet. Runtime work
// stays on the server and the selected tab/scroll/faces are restored from
// session storage.
let releaseRetry = 0;
function followSurfaceRelease(next) {
  if (!next) return;
  try {
    if (!loadedSurfaceRevision) {
      loadedSurfaceRevision = next;
      sessionStorage.setItem(SURFACE_REVISION_KEY, next);
      return;
    }
    if (next === loadedSurfaceRevision) return;
    // Not now (a draft, an open panel): try again until it is safe.
    if (!harness.surfaceReloadSafe() || sheets > 0) { clearTimeout(releaseRetry); releaseRetry = setTimeout(() => followSurfaceRelease(next), 2000); return; }
    harness.prepareSurfaceReload();
    sessionStorage.setItem(SURFACE_VIEW_KEY, JSON.stringify({
      windowX: scrollX, windowY: scrollY,
    }));
    sessionStorage.setItem(SURFACE_REVISION_KEY, next);
    loadedSurfaceRevision = next;
    location.reload();
  } catch { /* storage refused; the next build message tries again */ }
}
