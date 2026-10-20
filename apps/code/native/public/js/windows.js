// The windows: three panels on one canvas, shared by every session.
//
// The transcript is the home middle window in a shared session frame;
// the agents' strip follows its header and the composer spans every window.
// Switching sessions changes only the conversation and its draft. Workbench and the browser (pages.js, which holds every page,
// website and thing shown as a tab) are one each, beside it, whichever
// session opened them or showed something in them, and stay where they are
// when another session comes into view. open() spawns one; quiet, it opens
// where it goes without being shown (a tab or a folder an agent opened).
// One that stays (Workbench) is never closed: it can only be full and back.
//
// On a desk the windows tile one of two ways, MOD+L between them (Super in
// the desktop window, Alt in a browser: pi-card.js). Scrolling: readable,
// full-height columns in a horizontal strip. One fills the viewport; two
// share it when each has at least 640px. Further windows extend the strip,
// never subdividing another window. Dwindle: every window in the viewport,
// each new one halving the last one's space along its longer side. They meet
// at one hairline, without gutters. A new window always opens in the next
// place along, on the right; saved orders return as they were. MOD+Left and
// MOD+Right move by what is in view, not window by window: the next window
// out of sight on that side comes whole into view at once and takes the keys
// (with nothing out of sight, or in dwindle, the one beside takes them).
// Nothing slides. Quiet agent openings leave the view and the keyboard
// alone. Focus follows the pointer at once. Held in the desktop window, MOD
// picks a window up wherever the pointer is: dropped on another's place it
// takes it; Escape puts it back. MOD+F fills the middle; MOD+Shift+F covers
// the composer too. MOD+Shift+arrows rotate windows; over() reveals the
// agents' strip above a full window and takes the keys.
//
// There is a third way, focus, which every desktop window starts in (native
// or a browser page, so there is one interface to keep): the
// conversation in the middle, its composer floating over its foot, and Files
// or the browser in a floating panel on the right, the size of a phone, the
// sidebar's Files and Sites choosing which. MOD+F there fills the whole
// window with whichever of the two has the keys: the conversation, its
// composer staying as it is, or the panel's window, edge to edge, its
// composer then hidden under the window's foot until the pointer reaches
// for it, as a Mac's Dock is; again (or Escape), and the layout is back.
// MOD+Shift+F and MOD+Shift+Enter are the other layouts' and do nothing in it.
// The windows are not moved in the page for any of it (a website would load
// again), only placed; the ones the panel is not showing wait under it.
// MOD+L goes focus, scrolling, dwindle, and round again.
//
// On a phone the input bar stays where it is, and the windows are the panel
// above it: the conversation's own panel first, then the rest of the canvas,
// side by side in a strip the finger swipes along. The agents' strip is the
// conversation's: it leaves upwards as a finger brings another window into
// view, that window's own bar in its place, and comes back with it
// (--wm-away on the conversation, 0 to 1, imperfect.css). A new one opens to the right of the one in view, never
// between the conversation and a window that stays, and the phone's back
// gesture closes the one in view; a window that holds several things, or
// stays (closeOne), does its own thing that way instead. A window's bar (the
// browser's) is imperfect's whatever the page under it does with a finger:
// a swipe that starts on it moves the strip like any other, and a tap on it
// is the conversation. A window swiped out of view lets go of the keys. Full
// (full(win)), a window covers both bars too; a tab hanging from the top
// edge, or back, brings them back.
//
//   const wm = mountWindows({ conversation, panel, keys, held });
//   const win = wm.open({ kind, body, bar, onClose, closeOne, keys, quiet, stays });   wm.close(win)
//   wm.show(win)   wm.home()   wm.showing(win)   wm.focused()   wm.full(win)   wm.over()   wm.overlaid()
//   wm.navigate(step)   wm.bring(win)   wm.rotate(step)   wm.closeAt(node)   wm.closeHovered()   wm.owns(node)   wm.list()
//   wm.layout()   wm.tiling()   wm.grab(held)   wm.order()
//
// panel: the conversation's middle, placed inside the shared frame. keys(): a window
// taking the keyboard (the input bar, the page in front, the list of files).
// held(): whether something open is using the keyboard (a dialog, a menu),
// so focus stays where it is.

// Each window wears a hairline rule all round, and two side by side share
// theirs: they overlap by it, so where they meet there is one rule, and the
// rules round the outside lie just past the canvas's edge, out of sight.
import { MOD, heldMod } from './pi-card.js';
import { windowClose } from './window-close.js';
import { initialLayout, LAYOUT_CHOICE, LAYOUTS } from './layout-choice.js';
import { framedByLaunch, phoneByLaunch } from './arrival.js';

const RULE = 1;
// The one test of a phone, for the whole page: a finger is the pointer.
const PHONE = '(pointer: coarse)';
export const phone = () => phoneByLaunch() || (!framedByLaunch() && matchMedia(PHONE).matches);
// Dwindle cuts a space the other way rather than leave a window narrower or
// shorter than this, when the other way can.
const MIN_WIDTH = 480, MIN_HEIGHT = 240;

export function mountWindows({ conversation, panel = conversation, keys, held = () => false, restoredOrder = [], restoredLayout = null, onPanel = () => {} }) {
  const doc = conversation.ownerDocument;
  const strip = conversation.parentElement;
  strip.classList.add('wm');
  // Only the middle tiles or swipes. The session owns one outer frame and
  // one composer, independent of the number of windows beside its transcript.
  const shared = panel !== conversation;
  if (shared) {
    strip.replaceWith(conversation);
    panel.replaceWith(strip);
    strip.prepend(panel);
    conversation.classList.add('wm-frame');
  }
  const home = shared ? panel : conversation;
  home.classList.add('wm-window');
  // The windows in column order, on both desk and phone. No split tree. An
  // element, once in the canvas, is never moved in it: Electron loads a
  // <webview> again when it is (and a page in a frame reloads), so the
  // order is this list, placed on a desk and, on a phone, CSS's order.
  const first = { kind: 'conversation', keys, get el() { return home; } };
  const windows = [first];
  const restoring = new Set(restoredOrder);
  let focused = first, full = null, over = false;
  // Windows still closing on a desk (close()), each ended by calling it.
  const closing = new Set();
  let whole = false, savedViewport = 0, savedFocus = null, savedFull = null, savedOver = false;
  // The same desktop layout in a shell, browser or iframe. Phone placement
  // remains governed by phone(), not by whether a native bridge exists.
  let choice;
  try { choice = localStorage.getItem(LAYOUT_CHOICE); } catch { /* storage denied */ }
  let tiling = initialLayout(choice, restoredLayout, Boolean(globalThis.imperfectDesk));
  // Focus: which of the other windows the panel shows, and which of the two
  // fills the whole window, if either ('middle' or 'panel', MOD+F).
  let panelFront = null, zoom = null;
  // The composer's height the conversation was last placed above, and the
  // frame that looks again.
  let placedDock = -1, docking = 0;
  // The view moves at once, never animated: where it is is where it goes.
  let viewportLeft = 0;
  function setViewport(left) {
    viewportLeft = tiling !== 'scrolling' ? 0 : Math.max(0, Math.min(left, strip.scrollWidth - strip.clientWidth));
    strip.scrollLeft = viewportLeft;
    heading();
    invalidatePointer();
  }
  let hovered = null;
  const windowOf = node => (node ? windows.find(win => win.el.contains(node)) : undefined);

  // The window focused, the one with the keys.
  function focus(win) {
    if (!win || win === focused) return;
    focused.el.classList.remove('wm-focused');
    win.el.classList.add('wm-focused');
    focused = win;
  }
  home.classList.add('wm-focused');
  // A window that takes the keyboard is the focused one.
  const frameEvents = shared ? conversation : strip;
  // The pointer then takes the keys again from wherever it next moves.
  frameEvents.addEventListener('focusin', event => { had = event.target; focus(windowOf(event.target) ?? first); aimed = null; });
  // A website (a <webview>) has the keys a moment after it is given them:
  // the desktop window then moves the canvas's focus into it, which the
  // canvas hears only as its own blur. If the keys went to another window in
  // that moment (the pointer moved into it), the website's arrival is stale,
  // and they go straight back where they went. A website the pointer is in
  // took them itself, by a click: its window is the focused one.
  doc.defaultView.addEventListener('blur', () => {
    const page = doc.activeElement, win = windowOf(page);
    if (page?.localName !== 'webview' || !win || win === focused || held()) return;
    if (windowOf(under) === win) focus(win);
    else if (had?.isConnected && windowOf(had) === focused) had.focus({ preventScroll: true });
    else focused.keys?.();
  });
  // And on a desk focus follows the pointer, keyboard and all: the window the
  // pointer moves into is focused and takes the keys, at once. Only the
  // pointer itself crossing counts: windows tiling afresh under a still
  // pointer, and events a script makes up, move nothing; nor does a pointer
  // with a button down (selecting, or carrying a window).
  let point = '', retiled = false, aimed = null;
  // Where the pointer last was in the canvas: in a website, its <webview>
  // (the canvas sees nothing more until the pointer comes out).
  let under = null;
  // The element last holding the keys in the canvas.
  let had = null;
  // MOD held, and a window being carried (grab, below).
  let wanted = false, grabbing = false, drag = null;
  function pointer(event, crossing) {
    if (!event.isTrusted) return;
    under = event.target;
    if (event.pointerType === 'touch' || phone()) return;
    const at = `${event.clientX},${event.clientY}`;
    // Really moving without MOD, the pointer lets the cover go, should MOD's
    // release not have been heard.
    if (!crossing && at !== point && grabbing && !drag && !heldMod(event)) grab(false);
    // A control chooses its own focus when activated.
    if (drag || event.buttons || held() || event.target.closest('button, label, input, textarea, select, a')) return;
    // A move is the pointer moving; crossing into something where it already
    // was is a window having come to it. So is crossing just after the
    // windows tiled afresh, until the pointer moves in the canvas again (it
    // may have moved inside a page, where the canvas cannot see it).
    if (!crossing) {
      if (at === point) return;
      point = at;
      retiled = false;
    } else if (at === point || retiled) return;
    const win = windowOf(event.target) ?? (shared ? first : null);
    if (!win || win === aimed || !windows.includes(win)) return;
    aimed = win;
    // A window already holding the keys keeps them where they are in it.
    const has = holder() === win && doc.activeElement !== doc.body;
    focus(win);
    if (!has) win.keys?.();
  }
  // Which window is under the pointer, for MOD+W, the moment it is.
  frameEvents.addEventListener('pointerover', event => { hovered = windowOf(event.target); pointer(event, true); });
  frameEvents.addEventListener('pointermove', event => pointer(event, false));

  const ordered = () => windows.slice();
  const columnWidth = () => windows.length === 1 ? strip.clientWidth : Math.max(640, Math.ceil(strip.clientWidth / 2));
  // Preserve scroll extent when the last column is temporarily full.
  const extent = doc.createElement('div');
  extent.className = 'wm-extent';
  extent.setAttribute('aria-hidden', 'true');
  strip.append(extent);
  // Each window's place in the strip (tile), and its box: grown by the rule
  // up and left, and past the canvas's own edges, so neighbours share one.
  function put(win, tile) {
    const { x, y, w, h } = win.tile = tile;
    // Focus draws no rules between windows: each is exactly its place, so a
    // window in the panel has the card's own edges and corners.
    if (tiling === 'focus') { Object.assign(win.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` }); return; }
    const outer = (end, size) => (end >= size ? RULE : 0);
    Object.assign(win.el.style, {
      left: `${x - RULE}px`, top: `${y - RULE}px`,
      width: `${w + RULE + (tiling === 'dwindle' ? outer(x + w, strip.clientWidth) : 0)}px`,
      height: `${h + RULE + outer(y + h, strip.clientHeight)}px`,
    });
  }
  // Focus (a Mac's): the conversation's place and the panel's. The composer
  // is the frame's, over the strip (imperfect.css, focus.css): the
  // conversation runs on under it.
  const frameRoot = strip.parentElement;
  const card = doc.createElement('div');
  card.className = 'wm-panel-card';
  card.setAttribute('aria-hidden', 'true');
  // gap: the panel's margin from the window's top, side and bottom, the same
  // as the field's from the bottom (focus.css), so the two end level; top:
  // the band the Mac's three buttons (and the sidebar's) sit in; bar: the
  // panel's one row, its address or the folder's path.
  const FOCUS = { gap: 16, top: 38, bar: 44, least: 340, most: 430 };
  // The panel's left edge, drawn wider by a drag (Noah): from a phone's width
  // up to the most that still leaves the conversation room to read, kept on
  // the device. A double-click puts it back.
  const PANEL_WIDTH = 'imperfect.panel-width';
  const MIDDLE_LEAST = 420;
  let panelDrawn = Number(localStorage.getItem(PANEL_WIDTH)) || 0;
  const edge = doc.createElement('div');
  edge.className = 'wm-panel-edge';
  edge.setAttribute('role', 'separator');
  edge.setAttribute('aria-orientation', 'vertical');
  edge.setAttribute('aria-label', 'Resize the panel');
  edge.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    try { edge.setPointerCapture(event.pointerId); } catch { /* not a live pointer */ }
    const right = strip.getBoundingClientRect().right - FOCUS.gap;
    edge.classList.add('dragging'); frameRoot.classList.add('wm-resizing');
    const move = e => { panelDrawn = Math.round(right - e.clientX); layout(); };
    const done = () => {
      edge.classList.remove('dragging'); frameRoot.classList.remove('wm-resizing');
      edge.removeEventListener('pointermove', move);
      try { localStorage.setItem(PANEL_WIDTH, String(panelDrawn)); } catch { /* storage denied */ }
    };
    edge.addEventListener('pointermove', move);
    edge.addEventListener('pointerup', done, { once: true });
    edge.addEventListener('pointercancel', done, { once: true });
  });
  edge.addEventListener('dblclick', () => { panelDrawn = 0; try { localStorage.removeItem(PANEL_WIDTH); } catch {} layout(); });
  const sides = () => windows.filter(win => win !== first);
  const panelWindow = () => (here(panelFront) && panelFront !== first ? panelFront : sides()[0] ?? null);
  // How tall the composer is, the bars under the conversation, as laid out
  // (offsets, not the screen: the window's opening zoom scales the screen's).
  function dockHeight() {
    const bottom = strip.offsetTop + strip.offsetHeight;
    let top = bottom;
    for (const el of frameRoot.querySelectorAll(':scope > :is(#entry-pending, #entry-work, #entry-input-zone, .entry-status)')) {
      if (!el.offsetHeight || el.offsetParent !== strip.offsetParent) continue;
      top = Math.min(top, el.offsetTop);
    }
    return Math.max(0, bottom - top);
  }
  function placeFocus() {
    const front = panelWindow();
    // Full with nothing left in the panel is the layout as it was.
    if (zoom === 'panel' && !front) zoom = null;
    // Full, the sidebar steps out of the way (focus.css), so the strip is
    // measured without it.
    frameRoot.classList.toggle('focus-full-middle', zoom === 'middle');
    frameRoot.classList.toggle('focus-full-panel', zoom === 'panel');
    const width = strip.clientWidth, height = strip.clientHeight;
    // The panel floating beside the conversation, unless one of them is full.
    const beside = zoom ? null : front;
    const { gap } = FOCUS;
    // A phone's width, never more than a little under half a narrow window.
    const usual = Math.round(Math.min(width * 0.45, Math.max(FOCUS.least, Math.min(FOCUS.most, width * 0.34))));
    const widest = Math.max(usual, width - MIDDLE_LEAST - 2 * FOCUS.gap);
    const panelWidth = beside ? (panelDrawn ? Math.round(Math.max(FOCUS.least, Math.min(widest, panelDrawn))) : usual) : 0;
    const middleWidth = beside ? width - panelWidth - 2 * gap : width;
    // The panel floats the whole height, top to bottom (Noah). The middle
    // is the whole height too, up to the panel's edge, so the conversation
    // is centred between the sidebar and the panel: it runs up under the
    // band and down under the field, which floats over it (focus.css).
    const panel = { x: middleWidth + gap, y: gap, w: panelWidth, h: height - 2 * gap };
    const middle = { x: 0, y: 0, w: beside ? panel.x : width, h: height };
    // Full, the panel's window is the whole window, edge to edge, off the card.
    const inPanel = zoom === 'panel' ? { x: 0, y: 0, w: width, h: height } : panel;
    const dock = placedDock = dockHeight();
    extent.style.width = `${width}px`;
    frameRoot.style.setProperty('--focus-panel-x', `${panel.x}px`);
    frameRoot.style.setProperty('--focus-panel-w', `${panel.w}px`);
    frameRoot.style.setProperty('--focus-panel-column', `${beside ? panelWidth + gap : 0}px`);
    frameRoot.style.setProperty('--focus-foot', `${gap}px`);
    // How much of the middle's foot the field covers: the conversation's
    // last words are kept above it.
    frameRoot.style.setProperty('--focus-dock', `${dock}px`);
    // Where a sheet over the conversation centres (the sign-in sheet, guey.css).
    document.documentElement.style.setProperty('--sheet-left', `${Math.round(strip.getBoundingClientRect().left + middle.w / 2)}px`);
    frameRoot.style.setProperty('--focus-top', `${FOCUS.top}px`);
    frameRoot.style.setProperty('--focus-bar', `${FOCUS.bar}px`);
    frameRoot.classList.toggle('focus-panel', Boolean(front));
    put(first, middle);
    first.el.classList.toggle('wm-tucked', zoom === 'panel');
    for (const win of sides()) {
      const shown = win === front && zoom !== 'middle';
      win.el.classList.toggle('wm-tucked', !shown);
      win.el.inert = !shown;
      win.el.classList.toggle('wm-in-panel', true);
      put(win, inPanel);
    }
    if (beside) {
      Object.assign(card.style, { left: `${panel.x}px`, top: `${panel.y}px`, width: `${panel.w}px`, height: `${panel.h}px` });
      if (!card.isConnected) strip.prepend(card);
      Object.assign(edge.style, { left: `${panel.x - 5}px`, top: `${panel.y}px`, height: `${panel.h}px` });
      if (!edge.isConnected) strip.append(edge);
    } else { card.remove(); edge.remove(); }
    paintDock();
    onPanel(zoom === 'middle' ? null : front?.kind ?? null);
  }
  function unplaceFocus() {
    document.documentElement.style.removeProperty('--sheet-left');
    card.remove(); edge.remove();
    frameRoot.classList.remove('focus-panel', 'focus-full-middle', 'focus-full-panel', 'dock-hidden', 'dock-shown');
    first.el.classList.remove('wm-tucked');
    for (const win of windows) { win.el.classList.remove('wm-tucked', 'wm-in-panel'); win.el.inert = false; }
  }
  // The panel full, its composer is a Mac's Dock (focus.css): down out of
  // sight until the pointer reaches the window's foot or the input takes the
  // keys (a key that gives them to it), and down again once the pointer has
  // left it, unless the input has the keys or text is chosen in it. The
  // reach is the strip along the foot that brings it up, over whatever is
  // there: a website under the pointer would keep the pointer to itself.
  // While the composer is up the reach lies under and round it, so the
  // pointer on its way to it, or beside it, keeps it up.
  const reach = doc.createElement('div');
  reach.className = 'focus-dock-reach';
  reach.setAttribute('aria-hidden', 'true');
  const DOCK = '#entry-pending, .entry-connection, #entry-input-zone, .entry-status, #entry-dialog, .focus-dock-reach';
  const inDock = node => (node?.nodeType === 1 ? node : node?.parentElement)?.closest(DOCK)?.parentElement === frameRoot;
  let onDock = false;
  function dockKept() {
    if (onDock || inDock(doc.activeElement)) return true;
    const chosen = doc.getSelection();
    return Boolean(chosen && !chosen.isCollapsed && inDock(chosen.anchorNode));
  }
  function paintDock() {
    const hides = tiling === 'focus' && zoom === 'panel' && !phone(), up = hides && dockKept();
    frameRoot.classList.toggle('dock-hidden', hides && !up);
    frameRoot.classList.toggle('dock-shown', up);
  }
  {
    frameRoot.append(reach);
    frameEvents.addEventListener('pointerover', event => { onDock = inDock(event.target); if (zoom) paintDock(); });
    frameEvents.addEventListener('focusin', () => { if (zoom) paintDock(); });
    // Looked at once the keys have arrived, so moving them within it leaves it up.
    frameEvents.addEventListener('focusout', () => { if (zoom) setTimeout(paintDock); });
    doc.addEventListener('selectionchange', () => { if (zoom) paintDock(); });
  }
  // The composer growing (a long prompt, a queue), or settling into its
  // place a frame after focus begins, moves where the conversation's place
  // stops.
  const redock = () => { if (tiling === 'focus' && !phone() && dockHeight() !== placedDock) placeFocus(); };
  {
    const watch = new ResizeObserver(redock);
    for (const el of frameRoot.querySelectorAll(':scope > :is(#entry-pending, #entry-work, #entry-input-zone, .entry-status)')) watch.observe(el);
  }
  function place() {
    const order = ordered(), height = strip.clientHeight;
    frameRoot.classList.toggle('focus-layout', tiling === 'focus');
    if (tiling === 'focus') {
      placeFocus();
      cancelAnimationFrame(docking);
      docking = requestAnimationFrame(redock);
      return;
    }
    unplaceFocus();
    if (tiling === 'scrolling') {
      const width = columnWidth();
      extent.style.width = `${order.length * width}px`;
      order.forEach((win, i) => put(win, { x: i * width, y: 0, w: width, h: height }));
      return;
    }
    // Dwindle: the first window takes half the space, along its longer side
    // (unless that cuts it too thin and the other way does not), and the
    // rest share the other half the same way.
    extent.style.width = `${strip.clientWidth}px`;
    let rest = { x: 0, y: 0, w: strip.clientWidth, h: height };
    order.forEach((win, i) => {
      if (i === order.length - 1) { put(win, rest); return; }
      const thin = { side: rest.w / 2 < MIN_WIDTH, stacked: rest.h / 2 < MIN_HEIGHT };
      const side = rest.w >= rest.h ? !thin.side || thin.stacked : thin.stacked && !thin.side;
      if (side) {
        const w = Math.floor(rest.w / 2);
        put(win, { ...rest, w });
        rest = { ...rest, x: rest.x + w, w: rest.w - w };
      } else {
        const h = Math.floor(rest.h / 2);
        put(win, { ...rest, h });
        rest = { ...rest, y: rest.y + h, h: rest.h - h };
      }
    });
  }
  // The session heading lives outside the scroller, directly over its column.
  function heading() {
    if (!shared || phone() || tiling === 'focus') return;
    const edge = windows.length > 1 && full !== first && !over ? RULE : 0;
    const left = parseFloat(home.style.left) + edge - strip.scrollLeft;
    conversation.style.setProperty('--wm-home-left', `${left}px`);
    conversation.style.setProperty('--wm-home-top', `${parseFloat(home.style.top) + edge}px`);
    conversation.style.setProperty('--wm-home-width', `${parseFloat(home.style.width) - 2 * edge}px`);
  }
  function invalidatePointer() {
    retiled = true;
    aimed = hovered = null;
  }
  // Full, one window covers the middle; the shared composer stays outside it.
  // On a phone full screen also hides the frame, until the handle brings it back.
  const fill = el => Object.assign(el.style, { left: `${strip.scrollLeft}px`, top: '0px', width: `${strip.clientWidth}px`, height: `${strip.clientHeight}px` });
  const endClosing = () => { for (const end of [...closing]) end(); };
  function layout() {
    endClosing();
    const narrow = phone();
    if (narrow) extent.remove(); else strip.append(extent);
    strip.classList.toggle('wm-phone', narrow);
    frameRoot.classList.toggle('phone-layout', narrow);
    strip.classList.toggle('wm-tiled', !narrow && windows.length > 1);
    strip.classList.toggle('wm-scroll', !narrow);
    strip.classList.toggle('wm-dwindle', !narrow && tiling === 'dwindle');
    strip.classList.toggle('wm-has-full', !narrow && Boolean(full));
    windows.forEach((win, i) => {
      win.el.classList.toggle('wm-full', win === full);
      win.el.style.order = String(i);
    });
    conversation.classList.toggle('wm-fullscreen', narrow && Boolean(full));
    conversation.classList.toggle('wm-full-window', whole);
    globalThis.imperfectDesk?.fullWindow?.(whole);
    conversation.classList.toggle('wm-over', over);
    if (narrow && full) full.el.append(handle);
    else handle.remove();
    follow();
    regrab();
    if (narrow) {
      frameRoot.classList.remove('focus-layout');
      unplaceFocus();
      for (const el of [conversation, ...windows.map(win => win.el)]) Object.assign(el.style, { left: '', top: '', width: '', height: '' });
      return;
    }
    place();
    setViewport(viewportLeft);
    if (windows.length === 1) fill(home);
    if (full) fill(full.el);
    if (over) fill(home);
    heading();
    invalidatePointer();
  }
  // Full on a phone, a tab hanging from the top edge brings the bars back:
  // it is imperfect's, whatever the page under it does with a finger.
  const handle = doc.createElement('button');
  handle.type = 'button';
  handle.className = 'wm-unfull';
  handle.title = 'Leave full screen';
  handle.setAttribute('aria-label', 'Leave full screen');
  handle.addEventListener('click', () => unfull());
  new ResizeObserver(() => {
    layout();
  }).observe(strip);
  matchMedia(PHONE).addEventListener('change', layout);
  // A window opening or closing (or carried) re-tiles the rest; wm-moving
  // marks the moment for anything waiting on settled places.
  let moving = 0;
  function move() {
    strip.classList.add('wm-moving');
    clearTimeout(moving);
    moving = setTimeout(() => strip.classList.remove('wm-moving'), 420);
  }

  // On a phone, the snapped panel; on a desk, the first visible column.
  const inView = () => phone()
    ? ordered()[Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth))] ?? first
    : ordered().find(win => win.el.offsetLeft + win.el.offsetWidth > strip.scrollLeft + RULE) ?? first;
  const here = win => windows.includes(win);
  // How far from the conversation the strip is, for the agents' strip to
  // leave with it: 0 with the conversation in view, 1 with any other.
  let away = -1;
  function follow() {
    const now = phone() ? Math.min(1, Math.max(0, Math.round((strip.scrollLeft / Math.max(1, strip.clientWidth)) * 1000) / 1000)) : 0;
    if (now === away) return;
    away = now;
    conversation.style.setProperty('--wm-away', String(now));
    conversation.classList.toggle('wm-elsewhere', now >= 0.99);
  }
  function show(win) {
    if (!here(win)) return;
    // Focus: another window shown is what the panel shows, full if the panel
    // is; shown while the conversation is full, the panel is back beside it.
    if (tiling === 'focus' && !phone() && win !== first && (win !== panelWindow() || zoom === 'middle')) {
      panelFront = win;
      if (zoom === 'middle') zoom = null;
      layout();
    }
    // Another window shown leaves full screen.
    if (full && full !== win) unfull();
    const holder = windowOf(doc.activeElement);
    if (holder && holder !== win) doc.activeElement.blur();
    focus(win);
    if (phone()) reveal(win);
  }
  function reveal(win, nearest = false) {
    if (full) return;
    if (phone()) strip.scrollTo({ left: win.el.offsetLeft, behavior: 'smooth' });
    // Only explicit human reveal moves the desktop viewport; focus never does.
    else if (!nearest) setViewport(win.el.offsetLeft);
    else {
      const left = Math.max(0, win.el.offsetLeft + RULE), right = left + columnWidth();
      if (left < viewportLeft || right - left >= strip.clientWidth) setViewport(left);
      else if (right > viewportLeft + strip.clientWidth) setViewport(right - strip.clientWidth);
    }
  }
  const showing = win => here(win) && !win.el.classList.contains('wm-tucked') && (full ? full === win : phone() ? inView() === win
    : win.el.offsetLeft + win.el.offsetWidth > strip.scrollLeft && win.el.offsetLeft < strip.scrollLeft + strip.clientWidth);
  // Where the keyboard really is: the window holding it, the conversation
  // for the shared input bar's text, else the one last focused (a button
  // pressed in the input bar, say the browser's, leaves it there).
  function holder() {
    const active = doc.activeElement;
    const typing = active?.matches?.('textarea, input, [contenteditable="true"]') && frameEvents.contains(active);
    return windowOf(active) ?? (typing ? first : focused);
  }
  // MOD+Left and MOD+Right, by what is in view rather than window by window.
  // Scrolling: the nearest window on that side not wholly in view comes
  // wholly into view (bring) and takes the keys, past any between that are
  // in view already; with all of them in view, the one beside takes them.
  // Dwindle: the window beside, on that side, else the next in order. Full,
  // or on a phone: the next in order. Never wrapping.
  function navigate(step) {
    if (held() || ![-1, 1].includes(step)) return false;
    // A window still closing is gone for this: the view is reckoned without it.
    endClosing();
    const next = phone() || full ? beside(step) : tiling === 'dwindle' ? across(step) : page(step);
    if (!next) return false;
    bring(next);
    return true;
  }
  function beside(step, from = full ?? holder()) {
    const order = ordered();
    const next = order[order.indexOf(from) + step];
    return next !== from ? next : undefined;
  }
  function page(step) {
    const order = ordered(), from = order.indexOf(holder()), width = columnWidth();
    const whole = i => i * width >= viewportLeft - RULE && (i + 1) * width <= viewportLeft + strip.clientWidth + RULE;
    // The windows on that side of the one with the keys, nearest first.
    const ahead = order.map((_, i) => i).filter(i => (step > 0 ? i > from : i < from));
    if (step < 0) ahead.reverse();
    return order[ahead.find(i => !whole(i)) ?? ahead[0]];
  }
  function across(step) {
    const from = holder(), here = from.tile;
    if (!here) return beside(step, from);
    const overlap = other => Math.min(here.y + here.h, other.y + other.h) - Math.max(here.y, other.y);
    const gap = other => (step > 0 ? other.x - (here.x + here.w) : here.x - (other.x + other.w));
    const near = ordered().filter(win => win !== from && win.tile && gap(win.tile) >= 0 && overlap(win.tile) > 0)
      .sort((a, b) => gap(a.tile) - gap(b.tile) || overlap(b.tile) - overlap(a.tile))[0];
    return near ?? beside(step, from);
  }
  // A window the person asked for by key: in view (the least movement that
  // shows it whole), focused, and with the keyboard. Another full leaves full.
  function bring(win = first) {
    if (!here(win) || held()) return false;
    endClosing();
    invalidatePointer();
    show(win);
    if (!phone() && !full && tiling === 'scrolling' && windows.length > 1) {
      // A column wider than the window shows from its left edge.
      const left = Math.max(0, win.el.offsetLeft + RULE), right = left + columnWidth();
      if (left < viewportLeft || right - left >= strip.clientWidth) setViewport(left);
      else if (right > viewportLeft + strip.clientWidth) setViewport(right - strip.clientWidth);
    }
    win.keys?.({ byKey: true });
    return true;
  }

  // Quiet: opened where it goes, not shown (focused, or brought into view):
  // what an agent opens, behind the person's back.
  function open({ kind, body, bar, onClose = () => {}, closeOne, keys, quiet = false, stays = false }) {
    const el = doc.createElement('section');
    el.className = `wm-window wm-${kind}`;
    el.append(body);
    if (bar) {
      bar.classList.add('wm-bar');
      bar.addEventListener('click', event => { if (phone() && !event.target.closest('button, input')) show(first); });
    }
    const win = { el, kind, body, onClose, closeOne, keys, stays };
    // Its place is reckoned on the strip as it will be, without any closing.
    endClosing();
    const order = ordered();
    const anchor = order[Math.floor(viewportLeft / columnWidth())] ?? first;
    const offset = viewportLeft - order.indexOf(anchor) * columnWidth();
    let at;
    if (!phone() && restoring.delete(kind)) {
      // Saved columns return to their places.
      const saved = restoredOrder.indexOf(kind);
      at = order.findIndex(other => restoredOrder.indexOf(other.kind) > saved);
      if (at < 0) at = order.length;
    } else {
      // On a desk, the next place along on the right. On a phone, beside the
      // one in view, unless an agent opened it.
      at = !phone() || quiet ? order.length : order.indexOf(inView()) + 1;
      while (order[at]?.stays) at++;
    }
    windows.splice(at, 0, win);
    if (extent.isConnected) extent.before(el); else strip.append(el);
    move();
    if (!phone() && quiet) viewportLeft = ordered().indexOf(anchor) * columnWidth() + offset;
    layout();
    if (!phone()) {
      el.classList.add('wm-arriving');
      el.addEventListener('animationend', () => el.classList.remove('wm-arriving'), { once: true });
    }
    if (!quiet) show(win);
    return win;
  }

  // Closed, a window lets go of everything at once: the keys go to its
  // neighbour, and what it held is stopped (onClose). On a desk it keeps its
  // place while it closes (window-close.js); anything that lays the windows
  // out again first ends that, so the strip never tiles round one closing.
  function close(win) {
    if (!win || win === first || win.stays || !windows.includes(win)) return false;
    // Its page already gone (the browser's last tab) leaves the keys nowhere.
    const hadKeys = win.el.contains(doc.activeElement) || (focused === win && doc.activeElement === doc.body);
    const order = ordered(), index = order.indexOf(win);
    const next = order[index + 1] ?? order[index - 1] ?? first;
    const seen = other => other.el.offsetLeft + other.el.offsetWidth > strip.scrollLeft && other.el.offsetLeft < strip.scrollLeft + strip.clientWidth;
    const anchor = phone() ? inView() : order.find(other => other !== win && seen(other)) ?? next;
    const offset = strip.scrollLeft - anchor.el.offsetLeft;
    // The window filling the whole window gone, the layout is back.
    if (zoom === 'panel' && win === panelWindow()) zoom = null;
    windows.splice(windows.indexOf(win), 1);
    if (aimed === win) aimed = null;
    if (hovered === win) hovered = null;
    if (focused === win) {
      focus(next);
      if (hadKeys && !phone() && !held()) next.keys?.();
    }
    win.onClose();
    let ended = false, end;
    end = windowClose(win.el, () => {
      ended = true;
      closing.delete(end);
      win.el.remove();
      if (full === win) unfull();
      move();
      layout();
      const kept = here(anchor) ? anchor : here(next) ? next : first;
      if (phone()) strip.scrollLeft = Math.max(0, kept.el.offsetLeft + offset);
      else setViewport(kept.el.offsetLeft + offset);
      heading();
    }, { animate: !phone() });
    if (!ended) closing.add(end);
    return true;
  }
  // What MOD+W and the phone's back close: the window, or one thing in it
  // (or, for a window that stays, whatever it says).
  const closeOne = win => (here(win) && win !== first ? (win.closeOne ? win.closeOne() : close(win)) : false);

  // On a phone a window in view other than the conversation is a step in the
  // history, so the back gesture closes it; swiped back to the conversation,
  // the step is taken back, and back leaves the app as it always did. Full
  // is a step of its own, which back takes back, the window staying.
  let stepped = false, fullStep = false, unstepping = false, settling = 0;
  function settle() {
    if (!phone() || unstepping) return;
    const win = inView();
    focus(win);
    onPanel(win === first ? null : win.kind);
    // What is out of view lets go of the keys.
    const holder = windowOf(doc.activeElement);
    if (holder && holder !== win) doc.activeElement.blur();
    if (win !== first && !stepped) { history.pushState({ window: true }, ''); stepped = true; }
    else if (win === first && stepped) { stepped = false; unstepping = true; history.back(); }
  }
  strip.addEventListener('scroll', () => {
    invalidatePointer();
    heading();
    follow();
    // Native focus, wheel and pointer actions cannot move the desktop strip.
    // Keep the original keyboard owner, even when it is now offscreen.
    if (!phone() && Math.abs(strip.scrollLeft - viewportLeft) > 1) {
      strip.scrollLeft = viewportLeft;
      heading();
    }
    clearTimeout(settling); settling = setTimeout(settle, 120);
  }, { passive: true });
  addEventListener('popstate', () => {
    if (unstepping) { unstepping = false; settle(); return; }
    if (fullStep) { fullStep = false; unfull(); return; }
    if (!stepped) return;
    stepped = false;
    closeOne(inView());
    settle();
  });

  // MOD+F (or, on a phone, the browser's button): a window fills the whole
  // canvas, over the others; again, and the layout is back. On a desk,
  // alone, a window fills it already; on a phone the conversation's panel
  // is never full. In focus it is the whole window, and the one with the
  // keys: the panel's window, or else the conversation (the input bar, the
  // sidebar). The keys stay where they are.
  function toggleFull(win) {
    if (tiling === 'focus' && !phone()) {
      const at = win ?? holder();
      if (zoom) zoom = null;
      else if (!here(at)) return false;
      else {
        zoom = at === first ? 'middle' : 'panel';
        if (at !== first) panelFront = at;
        focus(at);
      }
      move();
      layout();
      return true;
    }
    win ??= focused;
    if (full) { unfull(); return true; }
    const narrow = phone();
    if (!here(win) || (narrow ? win === first : windows.length < 2)) return false;
    full = win;
    move();
    layout();
    if (narrow) { history.pushState({ full: true }, ''); fullStep = true; }
    return true;
  }
  function unfull(restorePrevious = false) {
    if (!full) return;
    const restore = whole;
    full = restore && restorePrevious && here(savedFull) ? savedFull : null;
    whole = false;
    over = Boolean(full) && restorePrevious && savedOver;
    move();
    layout();
    if (restore) {
      setViewport(savedViewport);
      if (savedFocus?.isConnected) savedFocus.focus({ preventScroll: true });
      else focused.keys?.();
    }
    if (fullStep) { fullStep = false; unstepping = true; history.back(); }
  }
  // MOD+Shift+Enter: over a window full on a desk, the conversation's bars,
  // which take the keys; again (or Escape), and they go, the keys going back
  // to the window.
  function toggleWhole(win = focused) {
    // Focus has MOD+F alone, for the whole window.
    if (tiling === 'focus' && !phone()) return false;
    if (whole) { unfull(true); return true; }
    if (!here(win) || win === first || held()) return false;
    savedFull = full;
    savedOver = over;
    savedViewport = viewportLeft;
    savedFocus = win.el.contains(doc.activeElement) ? doc.activeElement : null;
    full = win;
    whole = true;
    over = false;
    layout();
    return true;
  }
  function toggleOver() {
    if (phone() || !full || full === first || whole) return false;
    over = !over;
    layout();
    if (held()) return true;
    const to = over ? first : full;
    focus(to);
    to.keys?.();
    return true;
  }

  // MOD+Shift+arrows rotate columns. Focus stays with the slot, so the
  // arriving window takes the keys. Plain MOD+arrows move the keys instead.
  function rotate(step) {
    const was = ordered(), n = was.length;
    if (phone() || n < 2 || held()) return false;
    const now = was.map((_, i) => was[(i - step % n + n) % n]);
    windows.splice(0, n, ...now);
    // The window now where another was.
    const inPlaceOf = win => (win && was.includes(win) ? now[was.indexOf(win)] : win);
    if (full) full = inPlaceOf(full);
    if (full === first) over = false;
    hovered = aimed = inPlaceOf(hovered);
    move();
    layout();
    const arrived = inPlaceOf(focused);
    show(arrived);
    if (!held()) arrived.keys?.();
    return true;
  }

  // MOD+L: focus, scrolling, dwindle, and round. Nothing is lost, focused or moved
  // but the windows' places; back in the strip, the focused one is in view.
  function relayout() {
    if (phone() || held()) return false;
    tiling = LAYOUTS[(LAYOUTS.indexOf(tiling) + 1) % LAYOUTS.length];
    try { localStorage.setItem(LAYOUT_CHOICE, tiling); } catch { /* storage denied */ }
    // Full is each layout's own: focus's stays behind with it, and the
    // others' are not carried into it.
    if (tiling === 'focus') { full = null; whole = false; over = false; } else zoom = null;
    move();
    layout();
    if (tiling === 'scrolling' && !full) reveal(focused, true);
    return true;
  }

  // MOD held (Omarchy's Super+drag), a window can be picked up wherever the
  // pointer is, even over a website, which a cover over each window keeps
  // from seeing it (wm-grab). Dropped on another window's place it takes
  // it, and the keys; Escape, or losing the pointer, puts it back. A finger
  // never carries one, and without MOD nothing changes. Only in the desktop
  // window, where MOD is Super: in a web browser it is Alt (Option on a
  // Mac), which also types.
  function grab(on) {
    wanted = Boolean(on);
    return regrab();
  }
  function regrab() {
    const on = wanted && MOD === 'Super' && !phone() && windows.length > 1 && !full && !held();
    if (!drag && on !== grabbing) {
      grabbing = on;
      strip.classList.toggle('wm-grab', on);
    }
    return grabbing;
  }
  const view = doc.defaultView;
  const windowAt = (x, y) => {
    const bounds = strip.getBoundingClientRect();
    if (x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return undefined;
    return ordered().find(win => {
      const r = win.el.getBoundingClientRect();
      return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    });
  };
  function aim(win) {
    if (!drag || win === drag.over) return;
    drag.over?.el.classList.remove('wm-drop');
    drag.over = win;
    if (win && win !== drag.win) win.el.classList.add('wm-drop');
  }
  function drop(taken) {
    if (!drag) return;
    const { win, over, id, had } = drag;
    aim(null);
    drag = null;
    strip.classList.remove('wm-dragging');
    win.el.classList.remove('wm-dragged');
    if (strip.hasPointerCapture(id)) strip.releasePointerCapture(id);
    if (taken && over && over !== win && here(over) && here(win)) {
      const later = windows.indexOf(win) < windows.indexOf(over);
      windows.splice(windows.indexOf(win), 1);
      windows.splice(windows.indexOf(over) + (later ? 1 : 0), 0, win);
      move();
      layout();
      if (tiling === 'scrolling') reveal(win, true);
      focus(win);
      if (!held()) win.keys?.();
    } else if (had?.isConnected) had.focus({ preventScroll: true });
    invalidatePointer();
    regrab();
  }
  frameEvents.addEventListener('pointerdown', event => {
    if (!event.isTrusted || event.button !== 0 || event.pointerType === 'touch' || drag || !heldMod(event)) return;
    if (!grab(true)) return;
    const win = windowAt(event.clientX, event.clientY);
    if (!win) return;
    event.preventDefault();
    event.stopPropagation();
    // Escape is heard here, not in a page that had the keys.
    const had = doc.activeElement;
    had?.blur?.();
    drag = { win, over: null, id: event.pointerId, had };
    strip.setPointerCapture(event.pointerId);
    strip.classList.add('wm-dragging');
    win.el.classList.add('wm-dragged');
  }, true);
  strip.addEventListener('pointermove', event => {
    if (drag && event.pointerId === drag.id) aim(windowAt(event.clientX, event.clientY) ?? drag.over);
  });
  strip.addEventListener('pointerup', event => { if (drag && event.pointerId === drag.id) drop(true); });
  strip.addEventListener('pointercancel', () => drop(false));
  strip.addEventListener('lostpointercapture', () => drop(false));
  // The modifier's own presses and releases, heard wherever the canvas has
  // the keys; inside websites the desktop window says (grab()).
  for (const type of ['keydown', 'keyup']) view.addEventListener(type, event => {
    if (drag && type === 'keydown' && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      drop(false);
      return;
    }
    grab(heldMod(event));
  }, true);
  view.addEventListener('blur', () => { drop(false); grab(false); });

  layout();
  return {
    open, close, show, reveal, showing, rotate, navigate, bring, grab,
    layout: relayout,
    tiling: () => tiling,
    // Focus: the kind of window the panel shows (the sidebar marks it).
    panel: () => (tiling === 'focus' && !phone() ? panelWindow()?.kind ?? null : null),
    home: () => show(first),
    full: toggleFull,
    // Focus: which of the two fills the whole window, 'middle' or 'panel', if either.
    zoomed: () => (tiling === 'focus' && !phone() ? zoom : null),
    fullWindow: toggleWhole,
    fullWindowed: () => whole,
    restoreFullWindow: () => { if (!whole || held()) return false; unfull(true); return true; },
    over: toggleOver,
    overlaid: () => over,
    focused: () => focused,
    // The window a node is in, closed; never the conversation.
    closeAt: node => closeOne(windowOf(node)),
    closeHovered: () => closeOne(hovered),
    // Whether a node is in a window other than the conversation.
    owns: node => { const win = windowOf(node); return Boolean(win) && win !== first; },
    // The windows but the conversation.
    list: () => windows.filter(win => win !== first),
    order: () => ordered().map(win => win.kind),
  };
}
