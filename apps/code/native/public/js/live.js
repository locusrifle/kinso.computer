// The agents' browser, on a phone or a hosted computer's page (pages.js):
// what an agent browses in is imperfect's window on a computer, and this is
// that browser, live, in a panel of its own beside the page's own windows.
// The tab in front comes as pictures (desktop/electron/live.mjs), only while
// the panel is in sight; the tabs are a list along the bar, a tap bringing one to the front.
// A tap on the picture is a click at the same place on the page, a finger
// drawn up or down scrolls it, a hidden native keyboard bridge types directly
// at the website's caret, and the bar
// goes back, forward and reloads. With a mouse, a click is a tap and the
// wheel scrolls. What is typed here goes only to the page:
// never to the conversation, its input or anything kept.
//
// It watches through the computer it is on: /browser/live there, through
// /peer/<computer>/ when that is not the one serving the phone
// (apps/code/native/browser.mjs, relayLive), on its own authenticated
// connection, on the tailnet.

import { mountTabStrip } from './browser-tab-strip.js';
import { mountStartPage } from './browser-start.js';
import { addressOf } from './pages.js';

// Where on the page a finger fell. The picture fills its box as far as it
// can uncut, centred (object-fit: contain). box: the box on screen, { left,
// top, width, height }; page: the page's size as the pictures give it. null
// for a finger beside the picture.
export function pagePoint({ x, y }, box, page) {
  if (!page?.width || !page?.height || !box?.width || !box?.height) return null;
  const scale = Math.min(box.width / page.width, box.height / page.height);
  const left = box.left + (box.width - page.width * scale) / 2;
  const top = box.top + (box.height - page.height * scale) / 2;
  const px = (x - left) / scale, py = (y - top) / scale;
  if (px < 0 || py < 0 || px > page.width || py > page.height) return null;
  return { x: Math.round(px), y: Math.round(py) };
}
// How far a finger drawn dy pixels on screen moves the page, in its pixels:
// drawn up, the page goes down.
export const pageScroll = (dy, box, page) => (page?.width && page?.height && box?.width && box?.height ? Math.round(-dy / Math.min(box.width / page.width, box.height / page.height)) : 0);

// The connection: open while the view is in sight (show(true)), closed when
// it is not, so pictures come only while someone looks. connect(base): a
// WebSocket onto /browser/live of the computer base reaches ('' this one).
// size(): frame bounds in device pixels, plus the panel's CSS size/scale
// for the actual remote tab's viewport, headed or screenless.
// onFrame(said, drawn): a picture, and drawn() once it is on screen, which
// asks for the next. A window that cannot be reached is tried again, less
// often each time, while the view is in sight.
// scheme: this page's light or dark appearance (a prefers-color-scheme: dark
// query). It goes with the watch, and again whenever it turns, so a browser
// with no screen of its own (desktop/electron/browser.mjs) draws its pages
// as this page is drawn. It rides on a size line, which a browser from
// before it takes as an unchanged size.
const DARK = globalThis.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
export function createLive({ connect, tab = null, browser = false, resume = false, size = () => ({}), onFrame = () => {}, onTabs = () => {}, onNote = () => {}, onField = () => {}, onExpired = () => {}, retry = 2000, scheme = DARK }) {
  let ws = null, base = '', visible = false, again = 0, fails = 0, launching = false, pendingNew = 0, ready = false, expired = false, watching = tab, resumable = resume;
  const appearance = () => (scheme ? { appearance: scheme.matches ? 'dark' : 'light' } : {});
  const turned = () => { if (ws?.readyState === 1) ws.send(JSON.stringify({ size: size().size, ...appearance() })); };
  function expire(note) {
    expired = true;
    pendingNew = 0;
    visible = false;
    close();
    onTabs([]);
    onNote(note);
    onExpired();
  }
  function open() {
    clearTimeout(again);
    ready = false;
    scheme?.addEventListener?.('change', turned);
    const socket = ws = connect(base);
    socket.onopen = () => {
      socket.send(JSON.stringify({ do: 'watch', ...size(), ...appearance(), ...(browser ? { tab: watching, scope: 'browser', ...(resumable ? { resume: true } : {}) } : tab != null ? { tab } : {}) }));
    };
    socket.onmessage = event => {
      if (ws !== socket) return;
      let said;
      try { said = JSON.parse(event.data); } catch { return; }
      if ((said.expired || said.closed) && (tab != null || browser)) {
        expire(said.error || 'This preview expired. Retry to open it again.');
        return;
      }
      // An old independently running browser ignores watch.tab, even when
      // the requested tab happens to be in front. Require fixed-watch proof.
      if (browser && (said.scope !== 'browser' ||
          !(said.watching === null || (Number.isSafeInteger(said.watching) && said.watching > 0)) ||
          (said.frame && (said.watching === null || said.tab !== said.watching)) ||
          (said.tabs && said.watching !== null && !said.tabs.some(one => one.tab === said.watching)))) {
        expire('The open browser predates browser-scoped previews. Stop watching for five idle minutes, then Retry.');
        return;
      }
      if (!browser && tab != null && (said.tabs || said.frame) &&
          (said.watching !== tab || (said.frame && Number(said.tab) !== Number(tab)))) {
        expire('The open browser predates hosted previews. Stop watching for five idle minutes, then Retry.');
        return;
      }
      if (browser) { watching = said.watching; resumable = true; }
      if (said.frame || said.tabs) fails = 0;
      if (said.tabs) ready = true;
      if (said.tabs && launching) { launching = false; socket.send('{"do":"launch"}'); }
      if (said.tabs) onTabs(browser ? said.tabs.map(one => ({ ...one, front: one.tab === watching })) : tab == null ? said.tabs : said.tabs.filter(one => Number(one.tab) === Number(tab)));
      if (said.frame) onFrame(said, () => { if (ws === socket && socket.readyState === 1) socket.send('{"ack":true}'); });
      if (said.field) onField(said.field, said.gesture);
      if (said.error) onNote(said.error);
      if (said.tabs && ready && ws === socket && socket.readyState === 1 && pendingNew) {
        const count = pendingNew; pendingNew = 0;
        for (let n = 0; n < count; n++) socket.send('{"do":"new"}');
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      ready = false;
      onTabs([]);
      onNote('Browser computer unavailable. Retrying…');
      if (visible) again = setTimeout(open, retry * Math.min(5, ++fails));
    };
  }
  function close() {
    clearTimeout(again);
    scheme?.removeEventListener?.('change', turned);
    const socket = ws;
    ws = null;
    socket?.close();
  }
  return {
    show(on) {
      if (expired || on === visible) return;
      visible = on;
      if (on) open(); else close();
    },
    // The computer whose browser it shows.
    watch(from = '') {
      if (from === base) return;
      base = from;
      pendingNew = 0;
      if (visible) { close(); open(); }
    },
    // What the person does; nothing waits for a connection to come back.
    send(said) {
      if ((browser && said.do === 'launch') || (!browser && tab != null && ['front', 'launch', 'new', 'close'].includes(said.do))) return;
      // Scoped input retains the picture's id: never rewrite stale input to
      // the newly selected pin. The owner rejects it instead.
      if (ws?.readyState === 1) ws.send(JSON.stringify(browser || tab == null ? said : { ...said, tab }));
    },
    resize() {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ size: size().size }));
    },
    launch() {
      if (tab != null || browser) return;
      if (ready && ws?.readyState === 1) ws.send('{"do":"launch"}');
      else launching = true;
    },
    // Only explicit creation may wait for a connection/proof. Page input,
    // close and selection keep their picture ids and are never replayed.
    newTab() {
      if (expired || (!browser && tab != null)) return;
      if (ready && ws?.readyState === 1) ws.send('{"do":"new"}');
      else pendingNew++;
    },
    stop() { visible = false; pendingNew = 0; close(); },
    get base() { return base; },
    get connected() { return Boolean(ws); },
    get pendingNew() { return pendingNew > 0; },
    get tab() { return watching; },
    get expired() { return expired; },
  };
}

const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const ICON = path => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="miter"/></svg>`;
const SOCKET = base => new WebSocket(new URL(`${base}/browser/live`, location.href).href.replace(/^http/, 'ws'));
const MOVED = 10; // px a finger moves before it is a scroll, not a tap

// The view: { bar, body } for a window (windows.js), and what pages.js does
// with it. full(): fill the screen.
export function mountLive({ full = () => {}, connect = SOCKET, tab = null, browser = false, resume = false, onExpired = () => {}, onTabs = () => {}, onLocation = () => {} } = {}) {
  const bar = make('div', 'gui-window-bar');
  const body = make('div', 'gui-window-body browser-live');
  const navigable = tab == null || browser;
  const strip = navigable ? mountTabStrip({
    select: id => live.send({ do: 'front', tab: id }),
    close: id => live.send({ do: 'close', tab: id }),
    create: () => newTab(),
    visit: url => visit(url),
  }) : null;
  const controls = make('div', 'browser-controls');
  const go = (label, path, run) => {
    const button = make('button', 'gui-window-go');
    button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
    button.innerHTML = ICON(path);
    button.onclick = run;
    return button;
  };
  if (strip) bar.append(strip.el);
  bar.append(controls);
  bar.addEventListener('keydown', event => { if (strip && !strip.el.contains(event.target)) strip.keys(event); });
  body.addEventListener('keydown', event => strip?.keys(event));
  controls.append(
    go('Back', 'M15 5l-7 7 7 7', () => act({ do: 'back' })),
    go('Forward', 'M9 5l7 7-7 7', () => act({ do: 'forward' })),
    go('Reload', 'M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4', () => act({ do: 'reload' })),
    go('Full screen', 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5', () => full()));
  const address = make('input', 'gui-window-address');
  address.type = 'text'; address.spellcheck = false;
  address.placeholder = 'Search or type an address'; address.setAttribute('aria-label', 'Address');
  address.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const url = addressOf(address.value);
    if (url) visit(url);
  });
  controls.insertBefore(address, controls.lastElementChild);
  // An embedded preview owns one tab, not the person's browser navigation.
  if (!navigable) address.hidden = true;
  const view = make('div', 'browser-live-view');
  const picture = make('img', 'browser-live-frame');
  picture.alt = '';
  picture.draggable = false;
  const note = make('p', 'browser-live-note', 'Connecting to the browser…');
  const start = navigable ? mountStartPage(url => visit(url)) : null;
  if (start) start.hidden = true;
  view.append(picture, note);
  if (start) view.append(start);
  // A native editable, not a second visible form. It holds ordinary field
  // context for IME/autocorrect; passwords/contenteditable use only a sentinel
  // and incremental native edits, never a copy of the website's private value.
  const keyboard = password => {
    const node = make(password ? 'input' : 'textarea', 'browser-live-keyboard');
    if (password) node.type = 'password';
    node.autocapitalize = 'off'; node.spellcheck = false; node.tabIndex = -1;
    node.autocomplete = 'off'; node.setAttribute('autocorrect', 'off');
    node.setAttribute('aria-label', 'Website keyboard');
    return node;
  };
  let text = keyboard(false);
  view.append(text);
  body.append(view);
  let field = null, gesture = 0, pendingGesture = null, composing = false, before = '', anchor = null;
  const sentinel = '\u200b';
  const releaseKeys = () => { field = null; pendingGesture = null; composing = false; anchor = null; before = ''; text.value = ''; text.blur(); };
  const resetBuffer = () => { text.value = sentinel; text.setSelectionRange(1, 1); before = sentinel; };
  // Everything the person does goes to the tab of the latest picture only.
  let frontTab = null, lastFront = null, blank = false, openingTab = false;
  let previousTabs = new Map();
  const visit = url => { if (navigable && frontTab != null) live.send({ do: 'navigate', url, tab: frontTab }); };
  const newTab = () => {
    if (!navigable || live.expired) return;
    openingTab = true;
    address.value = ''; address.focus({ preventScroll: true });
    live.newTab();
  };
  const closeFront = () => { if (navigable && frontTab != null) live.send({ do: 'close', tab: frontTab }); };
  const showStart = on => {
    blank = Boolean(start && on);
    if (start) start.hidden = !blank;
    if (blank) { finger = null; releaseKeys(); }
  };
  let page = null; // the page's size and tab, as the latest picture gives them
  const act = said => {
    if (blank && ['tap', 'scroll', 'type', 'edit'].includes(said.do)) return;
    if (page) live.send({ ...said, tab: page.tab, ...(page.size && ['tap', 'scroll'].includes(said.do) ? { page: { width: page.width, height: page.height } } : {}) });
  };
  const edit = said => { if (field && document.activeElement === text) act({ do: 'edit', field: field.token, ...said }); };
  const changedText = () => {
    if (!field) return;
    const after = text.value;
    let start = 0, end = before.length, tail = after.length;
    while (start < end && start < tail && before[start] === after[start]) start++;
    while (end > start && tail > start && before[end - 1] === after[tail - 1]) { end--; tail--; }
    // Repeated characters are ambiguous to a whole-value diff; prefer the
    // native replacement range when its unchanged prefix/suffix still match.
    if (field.mirror && anchor) {
      const a = anchor.start, b = anchor.end, t = after.length - (before.length - b);
      if (t >= a && before.slice(0, a) === after.slice(0, a) && before.slice(b) === after.slice(t)) { start = a; end = b; tail = t; }
    }
    anchor = null;
    if (before !== after) edit(field.mirror ? { start, end, text: after.slice(start, tail) } : { text: after.replace(sentinel, '') });
    before = after;
    if (!field.mirror) resetBuffer();
  };
  const bindKeyboard = () => {
    // Ordinary fields mirror real text: native copy/cut and paste work there.
    // A private/rich field holds only a sentinel, not a remote selection.
    // Never put that implementation marker on the person's clipboard.
    for (const type of ['copy', 'cut']) text.addEventListener(type, event => {
      if (field?.mirror) return;
      event.preventDefault();
      say('Copy and cut are available only in plain-text fields in this stream.');
    });
    text.addEventListener('compositionstart', () => { composing = true; anchor = { start: text.selectionStart, end: text.selectionEnd }; });
    text.addEventListener('compositionend', () => { composing = false; changedText(); });
    text.addEventListener('input', () => { if (!composing) changedText(); });
    text.addEventListener('beforeinput', event => {
      if (!field || composing || event.isComposing) return;
      anchor = { start: text.selectionStart, end: text.selectionEnd };
      if (anchor.start === anchor.end && event.inputType === 'deleteContentBackward') anchor.start = Math.max(0, anchor.start - 1);
      if (anchor.start === anchor.end && event.inputType === 'deleteContentForward') anchor.end = Math.min(before.length, anchor.end + 1);
      if ((!field.mirror && event.inputType.startsWith('delete')) ||
          ((!field.mirror || !field.multiline) && ['insertParagraph', 'insertLineBreak'].includes(event.inputType))) {
        event.preventDefault();
        edit({ key: event.inputType.startsWith('delete') ? (/Forward/.test(event.inputType) ? 'Delete' : 'Backspace') : 'Enter',
          ...(field.mirror ? { start: text.selectionStart, end: text.selectionEnd } : {}) });
      }
    });
    text.addEventListener('keydown', event => {
      if (!field || event.isComposing || composing) return;
      // A mirrored textarea keeps its own newline/caret in step with the page.
      if (event.key === 'Enter' && field.mirror && field.multiline) return;
      if (['Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        const move = /^(Arrow|Home|End)/.test(event.key);
        edit({ key: `${event.shiftKey ? 'Shift+' : ''}${event.key}`, ...(field.mirror ? { start: text.selectionStart, end: text.selectionEnd } : {}) });
        if (!move || !field.mirror) event.preventDefault();
        if (event.key === 'Escape' || event.key === 'Tab') releaseKeys();
      }
    });
  };
  bindKeyboard();

  const say = words => { note.textContent = words; note.hidden = !words; };
  const live = createLive({
    connect, tab, browser, resume, onExpired,
    size: () => ({
      width: Math.round(view.clientWidth * (devicePixelRatio || 1)), height: Math.round(view.clientHeight * (devicePixelRatio || 1)),
      size: { width: view.clientWidth, height: view.clientHeight, scale: devicePixelRatio || 1 },
    }),
    onFrame: (said, drawn) => {
      page = { width: said.width, height: said.height, tab: said.tab, size: said.size };
      picture.src = `data:image/jpeg;base64,${said.frame}`;
      say('');
      picture.decode().then(drawn, drawn);
    },
    onTabs: tabs => {
      const front = navigable ? tabs.find(tab => tab.front) : tabs.find(one => Number(one.tab) === Number(tab));
      const current = front?.tab ?? null;
      const available = Boolean(front || live.connected);
      const changed = available && lastFront !== current;
      if (changed || (browser && frontTab !== current)) { releaseKeys(); page = null; finger = null; picture.removeAttribute('src'); }
      frontTab = current;
      onTabs(tabs);
      if (available) { lastFront = current; onLocation(front ?? null); }
      showStart(front?.url === 'about:blank');
      if (changed && openingTab && !live.pendingNew) { openingTab = false; address.focus({ preventScroll: true }); }
      // Front changes (selection/close/new) follow even a focused field;
      // metadata paints and transport loss must not destroy human typing.
      if (available && !openingTab && (changed || document.activeElement !== address)) address.value = front?.url === 'about:blank' ? '' : front?.url ?? '';
      const descriptors = tabs.map(one => {
        const previous = previousTabs.get(one.tab);
        const updated = !previous || (previous.loading && !one.loading) || previous.title !== one.title || previous.url !== one.url;
        // Loading and favicon are backend metadata. Unread is local to this
        // viewer: quiet background arrivals/updates persist until selected.
        const unread = !one.front && Boolean(one.unread ?? (previous?.unread || updated));
        return { ...one, id: one.tab, unread };
      });
      previousTabs = new Map(descriptors.map(one => [one.tab, one]));
      strip?.paint(descriptors);
      if (!tabs.length) { picture.removeAttribute('src'); page = null; say('No tab is open in the browser there.'); }
    },
    onNote: words => { releaseKeys(); openingTab = false; page = null; showStart(false); picture.removeAttribute('src'); say(words); },
    onField: (remote, reply) => {
      const pending = pendingGesture;
      if (!pending || reply !== pending.id || pending.tab !== page?.tab) return;
      pendingGesture = null;
      if (!remote.editable || !remote.token) { releaseKeys(); return; }
      field = remote;
      if ((text.tagName === 'INPUT') !== (remote.kind === 'password')) {
        const old = text; text = keyboard(remote.kind === 'password'); old.replaceWith(text); bindKeyboard();
      }
      // Authorize the actual native editable only after this trusted page tap
      // receives a truthful field reply, never on a background snapshot.
      document.dispatchEvent(new CustomEvent('browser-field-gesture', { detail: { field: text, gesture: pending.event } }));
      text.inputMode = ['email', 'tel', 'url', 'number'].includes(remote.kind) ? (remote.kind === 'number' ? 'decimal' : remote.kind) : 'text';
      text.enterKeyHint = remote.multiline ? 'enter' : 'go';
      if (remote.mirror) { text.value = before = remote.value; text.setSelectionRange(remote.start, remote.end); }
      else resetBuffer();
      text.focus({ preventScroll: true });
    },
  });

  // Rotation, panel resizing and the keyboard change the available page.
  let resizing;
  const resized = new ResizeObserver(() => {
    clearTimeout(resizing);
    resizing = setTimeout(() => live.resize(), 120);
  });
  resized.observe(view);

  // A finger: a tap is a click where it fell; drawn up or down, a scroll.
  // Drawn sideways it is the strip's (touch-action), which moves the panels.
  let finger = null;
  const box = () => picture.getBoundingClientRect();
  view.addEventListener('pointerdown', event => {
    if (!blank && event.isPrimary && event.target !== text) {
      pendingGesture = null;
      finger = { x: event.clientX, y: event.clientY, last: event.clientY, scrolling: false };
    }
  });
  view.addEventListener('pointermove', event => {
    if (blank || !finger || !event.isPrimary) return;
    if (!finger.scrolling && Math.abs(event.clientY - finger.y) < MOVED) return;
    finger.scrolling = true;
    const dy = pageScroll(event.clientY - finger.last, box(), page);
    finger.last = event.clientY;
    if (dy) { const at = pagePoint(finger, box(), page) ?? { x: 0, y: 0 }; act({ do: 'scroll', ...at, dy }); }
  });
  view.addEventListener('pointerup', event => {
    const was = finger;
    finger = null;
    if (blank || !was || was.scrolling || Math.hypot(event.clientX - was.x, event.clientY - was.y) >= MOVED) return;
    const at = pagePoint({ x: event.clientX, y: event.clientY }, box(), page);
    if (at) {
      releaseKeys();
      pendingGesture = { id: ++gesture, tab: page.tab, event };
      act({ do: 'tap', ...at, gesture });
    }
  });
  view.addEventListener('pointercancel', () => { finger = null; });
  // The wheel, gathered into one scroll a frame.
  let wheel = null;
  view.addEventListener('wheel', event => {
    // Horizontal intent belongs to the surrounding column strip, not the
    // remote page. In particular do not turn Shift+wheel into page scrolling.
    if (blank || event.defaultPrevented || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    if (!wheel) {
      wheel = { x: event.clientX, y: event.clientY, dy: 0 };
      requestAnimationFrame(() => {
        const dy = pageScroll(-wheel.dy, box(), page), at = pagePoint(wheel, box(), page) ?? { x: 0, y: 0 };
        wheel = null;
        if (dy) act({ do: 'scroll', ...at, dy });
      });
    }
    wheel.dy += event.deltaY * (event.deltaMode ? 40 : 1);
  }, { passive: false });

  // In sight: in the strip's view, and the screen on.
  let inStrip = false, concealed = false, stopped = false;
  const look = () => {
    const visible = !stopped && !concealed && inStrip && document.visibilityState === 'visible';
    if (!visible) releaseKeys();
    live.show(visible);
  };
  // Half of it in view, or half the view when the pane is wider than the
  // screen (a 640px column on a 320px one). A hairline left after a swipe
  // is out of sight, and its stream closes.
  const seen = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const seenWidth = entry.intersectionRect.width, view = entry.rootBounds?.width ?? innerWidth;
      inStrip = entry.isIntersecting && seenWidth >= Math.min(entry.boundingClientRect.width, view) / 2;
    }
    look();
  }, { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] });
  seen.observe(body);
  document.addEventListener('visibilitychange', look);

  return {
    bar, body,
    conceal(on) { concealed = Boolean(on); look(); },
    launch: () => live.launch(),
    newTab, closeFront, visit,
    flick(step) {
      const tabs = [...previousTabs.values()], at = tabs.findIndex(one => one.front);
      if (!strip || tabs.length < 2) return false;
      live.send({ do: 'front', tab: tabs[(at + step + tabs.length) % tabs.length].tab });
      return true;
    },
    keys: () => { if (blank) address.focus({ preventScroll: true }); else if (field) text.focus({ preventScroll: true }); },
    // Another computer's browser: nothing of the last one's is shown or acted on.
    watch(from = '') {
      if (from !== live.base) { releaseKeys(); strip?.paint([]); previousTabs.clear(); showStart(false); frontTab = lastFront = null; openingTab = false; page = null; picture.removeAttribute('src'); say('Connecting to the browser…'); }
      live.watch(from);
    },
    get base() { return live.base; },
    get tab() { return live.tab; },
    get expired() { return live.expired; },
    stop() { releaseKeys(); stopped = true; clearTimeout(resizing); resized.disconnect(); seen.disconnect(); document.removeEventListener('visibilitychange', look); live.stop(); },
  };
}
