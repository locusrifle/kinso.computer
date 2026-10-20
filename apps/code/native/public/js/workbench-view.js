// Workbench: one bar, and a folder below it.
//
// The single bar holds the space map, breadcrumbs/address and view count.
// Computers is a synthetic location above each computer's filesystem;
// it never sends a file request. Folders are always lists. Pictures show
// small, the icon until the picture comes. Click, Shift+click, Ctrl+click and
// the arrows select (workbench-selection.js); Delete moves what is selected to the Trash.
// A file opens in place of the folder (workbench-open.js) on a double-click,
// Enter or a tap; Escape, Backspace or the back gesture go back to the folder,
// and Backspace in a folder goes to the one above. A Markdown or .txt file
// of the person's own has Edit in the bar: edited in place, saved as it goes
// and with Mod+S, and Done (Escape, back) shows it as a page again. Nothing
// takes its place while some of it is not saved. Files has no downloads and
// shows one view: imperfect is being stripped back to what matters.
//
// Views (workbench-tabs.js) each keep their own folder/file and owner; the
// one in front is the only one offered (its + is hidden). The view is kept
// on the device. An HTML page plays in its Files tab on every screen.
// A computer opens at its home; / is the first part of the path. Names that
// start with a dot are not listed, but a typed path opens one.
// Another computer's folders are the same requests through /peer/<id>/
// (system/files.mjs).
//
// In a computer's ~/projects each project wears a preview of its page,
// which clicked starts it in an isolated Files view (projects.js). Project
// views are kept by name and computer; dev views by registered cwd/name, so
// their current server address is resolved afresh after a reload.
//
//   const workbench = mountWorkbench({ host, onProject, onFull });
// onFull(), if given, has Workbench fill the screen, for a page playing in it.
//   workbench.open(path?, { base?, quiet? })   workbench.back()
//   workbench.where()   { path, base, file }: the tab in front's folder, its computer, the file open in it
//   workbench.unsaved()   whether a file being edited, in any tab, has changes not yet on disk

import { mountSpace } from './files-space.js';
import { watchFolder } from './files-live.js';
import { all, none, pick, step } from './workbench-selection.js';
import { copyPaths, holdToCopy } from './workbench-copy.js';
import { mountViewer } from './workbench-open.js';
import { macFiles } from './workbench-mac.js';
import { COMPUTER_ROOT, fileComputers, viewCount, loadTabs, saveTabs, tabName, withTab, withoutTab } from './workbench-tabs.js';
import { phone } from './windows.js';
import { MOD, registerKeyBinding } from './pi-card.js';
import { launchMarker, projectPreview, projectsAt, startProject, holdProjects } from './projects.js';

const svg = {
  folder: '<svg viewBox="0 0 64 64" aria-hidden="true"><path class="fold-back" d="M6 10h18l6 6h28v8H6z"/><path class="fold-front" d="M6 22h52v32H6z"/></svg>',
  file: '<svg viewBox="0 0 64 64" aria-hidden="true"><path class="page" d="M12 6h28l12 12v40H12z"/><path class="corner" d="M40 6v12h12z"/></svg>',
};
const PICTURE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
// Match the file viewer's supported media; these are views, not apps.
const media = [
  ['image', PICTURE, 'M8 12h48v40H8z M12 46l14-18 10 12 8-10 8 16z M44 20h4v4h-4z'],
  ['video', /\.(mp4|m4v|webm|mov|ogv)$/i, 'M6 16h36v32H6z M44 26l14-10v32L44 38z'],
  ['audio', /\.(mp3|m4a|ogg|opus|wav|flac|aac)$/i, 'M26 10h28v8H34v30a10 10 0 1 1-8-10z'],
  ['pdf', /\.pdf$/i, 'M12 6h28l12 12v40H12z M22 28h20 M22 36h20 M22 44h14'],
];
// Pictures asked for at once, so a folder of thousands leaves room for the
// next folder.
const PICTURES_AT_ONCE = 4;
const glyph = name => `<span class="workbench-glyph workbench-glyph-${name}" aria-hidden="true"></span>`;

function size(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
  return i === 0 ? `${n} bytes` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
function when(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
// A typed path, against the folder it was typed in.
function resolvePath(typed, from) {
  const parts = typed.startsWith('/') ? [] : from.split('/').filter(Boolean);
  for (const part of typed.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}
const parentOf = path => path.replace(/\/[^/]+\/?$/, '') || '/';
const nameOf = path => path.split('/').filter(Boolean).at(-1) ?? path;
const baseOf = owner => (owner ? `/peer/${encodeURIComponent(owner)}` : '');
const TABS = 'imperfect.workbench.tabs';

export function defaultFilesBase(machines) {
  if (!machines) throw new Error('Files computer unavailable');
  const home = machines.find(machine => machine.home);
  if (!home || home.self) return '';
  if (!home.id || !home.reachable) throw new Error(`${home.name || home.id || 'Home computer'} unavailable`);
  return baseOf(home.id);
}

export function mountWorkbench({ host, onProject = null, onFull = null, defaultBase = defaultFilesBase, onViews = () => {} }) {
  const doc = host.ownerDocument;
  if (!doc.querySelector('link[data-workbench-style]')) {
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../css/workbench.css', import.meta.url).href;
    link.dataset.workbenchStyle = '';
    doc.head.append(link);
  }
  let storage;
  try { storage = doc.defaultView?.localStorage; } catch { /* storage denied */ }

  const root = doc.createElement('section');
  root.className = 'workbench';
  root.hidden = true;
  root.tabIndex = -1;
  root.setAttribute('aria-label', 'Workbench');
  root.innerHTML = `
    <header class="workbench-bar">
      <button type="button" data-space aria-label="Disk usage" aria-pressed="false" title="Where the space went">${glyph('space')}</button>
      <div class="workbench-address" title="Go to a folder (Ctrl+L)">
        <nav class="workbench-path" aria-label="Location"></nav>
        <input class="workbench-type" type="text" spellcheck="false" autocomplete="off" aria-label="Go to folder" hidden>
      </div>
      <p class="workbench-status" role="status" hidden></p>
      <button type="button" data-edit hidden>Edit</button>
      <button type="button" class="workbench-view-count" aria-label="New view" title="New view" hidden>+</button>
      <button type="button" data-full aria-label="Full screen" title="Full screen" hidden>${glyph('full')}</button>
    </header>
    <main class="workbench-main"><div class="workbench-items" role="listbox" aria-multiselectable="true" aria-label="Folder"></div><p class="workbench-note" hidden></p></main>`;
  host.append(root);
  const $ = selector => root.querySelector(selector);
  const address = $('.workbench-address'), pathBar = $('.workbench-path'), typed = $('.workbench-type');
  const items = $('.workbench-items'), note = $('.workbench-note'), status = $('.workbench-status');
  const main = $('.workbench-main'), count = $('.workbench-view-count');

  // What every tab shares: the computers, a move to the Trash
  // under way, and the latest open() asked for.
  const shared = {
    homes: new Map(),
    machines: [], opening: 0, busy: false,
    inventoryKnown: false,
  };
  // Each tab's own: its computer, its folder ('' its home, until it is known)
  // and what is in it, what is selected there, and its own viewer with the
  // file open in it. A tab kept from before is loaded when it first comes to
  // the front, its file (file) opened again. state is the tab in front.
  let tabs = [], state, unowned;
  const held = holdProjects();
  function makeTab({ owner = '', path = '', file = null, app = null } = {}) {
    const tab = { owner, path, file, app, loaded: false, loading: false, listing: null, etag: null, projects: null, selection: none(), generation: 0, scroll: 0, note: '' };
    tab.viewer = mountViewer({ doc, host: main, base: () => baseOf(tab.owner), mac: macFiles(doc.defaultView, () => hereOf(tab.owner)),
      onOpen: path => { if (tab === state) void openFile({ path, name: nameOf(path) }); },
      onChange: () => { if (tab === state) paintPath(); paintTabs(); keep(); },
      onEdit: () => {
        if (tab !== state) return;
        paintPath();
        // Done: the keys come back to Workbench, from the text area that went.
        if (!tab.viewer.editing() && (!doc.activeElement || doc.activeElement === doc.body)) root.focus({ preventScroll: true });
      } });
    tab.viewer.conceal(true);
    return tab;
  }
  // The file open in a tab: its viewer's, or for a tab not yet loaded, the one kept.
  const fileOf = tab => (tab.loaded ? (tab.viewer.isOpen() ? tab.viewer.file()?.path ?? null : null) : tab.file);
  function keep() {
    held.paint(tabs.filter(tab => tab.app?.project).map(tab => ({ base: baseOf(tab.owner), project: { name: tab.app.project } })));
    onViews();
    try { storage?.setItem(TABS, saveTabs(tabs.map(tab => ({ owner: tab.owner, path: tab.path, file: fileOf(tab), app: tab.app })), tabs.indexOf(state))); } catch { /* fine */ }
  }
  {
    let kept;
    try { kept = loadTabs(storage?.getItem(TABS) ?? ''); } catch { kept = { tabs: [], active: 0 }; }
    tabs = kept.tabs.map(makeTab);
    unowned = !tabs.length;
    if (unowned) tabs = [makeTab()];
    state = tabs[kept.active] ?? tabs[0];
    state.viewer.conceal(false);
  }

  const base = () => baseOf(state.owner);
  // A computer's home, asked once, so a view kept at it is called Home.
  const homeAsked = new Set();
  function learnHome(owner) {
    if (shared.homes.has(owner) || homeAsked.has(owner)) return;
    homeAsked.add(owner);
    listAt(baseOf(owner), '').then(({ listing }) => { if (listing?.path) { shared.homes.set(owner, listing.path); onViews(); } }, () => { setTimeout(() => homeAsked.delete(owner), 10000); });
  }
  // Whether a tab's folder is this computer's (a Mac's window opens its
  // files in their apps and shows them in Finder: workbench-mac.js).
  const hereOf = owner => !owner || Boolean(shared.machines.find(machine => machine.id === owner)?.self);
  const mac = macFiles(doc.defaultView, () => hereOf(state.owner));
  async function askAt(from, path) {
    const res = await fetch(`${from}${path}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Can't open this folder: the computer said ${res.status}`);
    return body;
  }
  const ask = path => askAt(base(), path);
  async function listAt(from, path, { etag, signal } = {}) {
    const res = await fetch(`${from}/files/list?path=${encodeURIComponent(path)}`, {
      cache: 'no-store', headers: etag ? { 'If-None-Match': etag } : {},
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
    });
    if (res.status === 304) return { listing: null, etag };
    const listing = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(listing.error || `Can't open this folder: the computer said ${res.status}`), { status: res.status });
    listing.entries = listing.entries.filter(entry => !entry.name.startsWith('.'));
    return { listing, etag: res.headers.get('etag') };
  }

  // Automatic updates never call go(): no navigation, viewer reset, focus,
  // address repaint, menu closing or hold cancellation.
  let live = null, liveTab = null, liveKey = '', onScreen = true;
  function stopLive() {
    live?.stop(); live = null; liveTab = null; liveKey = '';
  }
  function syncLive() {
    const tab = state;
    const visible = onScreen && !doc.hidden && !root.hidden && root.isConnected && root.getClientRects().length && doc.defaultView.getComputedStyle(root).visibility !== 'hidden';
    const eligible = visible && !tab.loading && tab.listing && !tab.viewer.isOpen() && !space.isOpen() && tab.path !== COMPUTER_ROOT;
    const key = `${baseOf(tab.owner)}\n${tab.path}\n${tab.generation}`;
    if (!eligible) { stopLive(); return; }
    if (liveTab === tab && liveKey === key) return;
    stopLive(); liveTab = tab; liveKey = key;
    const generation = tab.generation, owner = tab.owner, path = tab.path;
    const current = () => liveTab === tab && tab === state && tabs.includes(tab) && tab.generation === generation && tab.owner === owner && tab.path === path;
    live = watchFolder({ base: baseOf(owner), path,
      async refresh({ force, signal }) {
        const [result, projects] = await Promise.all([
          listAt(baseOf(owner), path, { etag: force ? null : tab.etag, signal }), projectsAt(baseOf(owner), path, { signal }),
        ]);
        if (signal.aborted || !current()) return;
        const listing = result.listing || tab.listing;
        const previous = tab.listing.entries, selection = tab.selection;
        const indices = new Map(listing.entries.map((entry, n) => [entry.path, n]));
        const index = n => indices.get(previous[n]?.path) ?? -1;
        tab.selection = { picked: new Set([...selection.picked].map(index).filter(n => n >= 0)), anchor: index(selection.anchor), cursor: index(selection.cursor) };
        tab.listing = listing; tab.etag = result.etag; tab.projects = projects; tab.note = '';
        patchItems();
        say(listing.entries.length ? '' : 'Folder is empty');
      },
    });
  }
  const visibility = new IntersectionObserver(found => {
    onScreen = found.some(entry => entry.isIntersecting);
    syncLive();
  });
  visibility.observe(root);
  // The window manager reparents this section and hides its containing pane.
  const visibilityChanges = new MutationObserver(changes => {
    if (changes.some(change => change.target === root || change.target.contains?.(root)
      || [...change.removedNodes, ...change.addedNodes].some(node => node === root || node.contains?.(root)))) syncLive();
  });
  visibilityChanges.observe(doc.documentElement, { attributes: true, attributeFilter: ['hidden', 'class', 'style'], childList: true, subtree: true });
  doc.addEventListener('visibilitychange', () => { syncLive(); if (!doc.hidden) live?.revalidate(); });
  doc.defaultView.addEventListener('focus', () => { syncLive(); live?.revalidate(); });
  doc.defaultView.addEventListener('online', () => { syncLive(); live?.revalidate(); });
  doc.defaultView.addEventListener('pagehide', stopLive);
  doc.defaultView.addEventListener('pageshow', syncLive);
  const say = text => { note.textContent = text; note.hidden = !text; };
  function unavailable(text, retryOpen) {
    say(`${text}. Retry to open Files.`);
    const retry = doc.createElement('button');
    retry.type = 'button'; retry.textContent = 'Retry';
    retry.style.pointerEvents = 'auto';
    retry.onclick = retryOpen;
    note.append(' ', retry);
  }
  // A short note in the bar, for what a change did.
  let quiet;
  function tell(text) {
    clearTimeout(quiet);
    status.textContent = text; status.title = text; status.hidden = !text;
    if (text) quiet = setTimeout(() => tell(''), 8000);
  }

  const space = mountSpace({ doc, host: main, ask, onOpen: path => { void go(path); } });
  function showSpace(on) {
    cancelHold();
    if (on && state.path === COMPUTER_ROOT) return;
    $('[data-space]').setAttribute('aria-pressed', String(on));
    // The map opens under the folder's list (Noah's Mac design), which stays.
    if (on) space.show(state.path);
    else space.hide();
    syncLive();
  }

  // --- the computer -------------------------------------------------------------
  async function loadMachines() {
    let known = true;
    try {
      const res = await fetch('/machines.json', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('Inventory unavailable');
      const { machines } = await res.json();
      if (!Array.isArray(machines)) throw new Error('Inventory unavailable');
      shared.machines = machines;
    } catch { shared.machines = []; known = false; }
    shared.inventoryKnown = known;
    return known;
  }
  function holdDefault() {
    for (const selector of ['.workbench-view-count', '[data-space]', '[data-full]']) $(selector).inert = unowned;
  }
  async function chooseComputer(machine) {
    const tab = state;
    const turn = ++tab.generation;
    // Refresh reachability on every attempt, including an offline row.
    await loadMachines();
    if (tab !== state || turn !== tab.generation || tab.path !== COMPUTER_ROOT) return;
    const current = fileComputers(shared.machines).find(one => machine.self ? one.self : one.id === machine.id);
    if (!current || (!current.self && !current.reachable)) {
      paintItems();
      unavailable(`${machine.name || machine.id || 'Computer'} unavailable`, () => { void chooseComputer(machine); });
      return;
    }
    shared.opening++;
    tab.owner = current.self ? '' : current.id;
    await go('', { tab });
  }

  // --- the tabs -------------------------------------------------------------------
  function paintTabs() {
    count.textContent = viewCount(tabs, tabs.indexOf(state));
    count.setAttribute('aria-label', tabs.length === 1 ? 'New view' : `Views, ${tabs.indexOf(state) + 1} of ${tabs.length}`);
    count.title = tabs.length === 1 ? 'New view at this folder' : 'Select, close or add a view';
    count.setAttribute('aria-expanded', String(Boolean(menu?.classList.contains('workbench-view-picker'))));
    onViews();
  }
  function viewPicker() {
    closeMenu();
    menu = doc.createElement('div');
    menu.className = 'workbench-menu workbench-view-picker';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Files views');
    menu.append(...tabs.map(tab => {
      const one = doc.createElement('div');
      one.className = 'workbench-tab';
      const select = doc.createElement('button');
      select.type = 'button';
      if (tab === state) select.setAttribute('aria-current', 'true');
      const file = fileOf(tab);
      const owner = shared.machines.find(machine => machine.id === tab.owner)?.name || tab.owner;
      one.title = `${file || tab.path || 'Home'}${owner ? ` · ${owner}` : ''}`;
      const name = doc.createElement('span');
      name.className = 'workbench-tab-name';
      name.textContent = tab.app?.project || tab.app?.service?.name || tabName({ path: tab.path, file });
      select.append(name);
      const provenance = doc.createElement('small');
      provenance.className = 'workbench-tab-owner';
      provenance.textContent = tab.path === COMPUTER_ROOT ? '' : shared.machines.find(machine => tab.owner ? machine.id === tab.owner : machine.self)?.name || tab.owner || 'This computer';
      select.append(provenance);
      select.title = one.title;
      select.onclick = () => { closeMenu(); toFront(tab); };
      one.append(select);
      {
        const close = doc.createElement('button');
        close.type = 'button';
        close.className = 'workbench-tab-close';
        close.setAttribute('aria-label', `Close view ${tabs.indexOf(tab) + 1}`);
        close.title = 'Close view';
        close.textContent = '×';
        close.onclick = event => {
          event.stopPropagation(); const last = tabs.length === 1;
          closeMenu(); closeTab(tab);
          if (!last) viewPicker();
        };
        one.append(close);
      }
      return one;
    }));
    const add = doc.createElement('button');
    add.type = 'button'; add.textContent = 'New view';
    add.onclick = () => { closeMenu(); addTab(); };
    menu.append(add);
    main.append(menu);
    paintTabs();
    menu.querySelector('button')?.focus();
  }
  // A tab to the front: the folder and the file it shows, as it left them.
  function toFront(tab) {
    if (tab === state || !tabs.includes(tab)) return;
    stopLive();
    cancelHold();
    closeMenu();
    stopEditing();
    if (space.isOpen()) showSpace(false);
    state.scroll = items.scrollTop;
    state.viewer.conceal(true);
    state = tab;
    tab.viewer.conceal(false);
    paintTabs();
    keep();
    if (!tab.loaded) { void load(tab); return; }
    paintPath();
    paintItems();
    items.hidden = tab.viewer.isOpen();
    say(tab.viewer.isOpen() ? '' : tab.note || (tab.listing && !tab.listing.entries.length ? 'Folder is empty' : ''));
    items.scrollTop = tab.scroll;
    // What is in the folder now, the file open staying.
    syncLive();
  }
  // A new tab, just after the one in front, and in front itself; at a
  // folder, or a file in its folder. At the folder in front, it shows at once.
  function addTab({ owner = state.owner, path = state.path, file = null } = {}) {
    if (file) path = parentOf(file);
    const tab = makeTab({ owner, path, file });
    const listed = owner === state.owner && path === state.path && state.listing;
    if (listed) Object.assign(tab, { loaded: true, file: null, listing: state.listing, etag: state.etag, projects: state.projects });
    const next = withTab(tabs, tabs.indexOf(state), tab);
    tabs = next.tabs;
    for (const gone of next.dropped) { gone.viewer.remove(); gone.generation += 1; }
    toFront(tab);
    if (listed && file) void openFile({ path: file, name: nameOf(file) });
    return tab;
  }
  function closeTab(tab) {
    if (tab.viewer.unsaved()) { void savedFirst(tab).then(ok => { if (ok && tabs.includes(tab)) closeTab(tab); }); return; }
    if (tabs.length === 1 && tabs[0] === tab) {
      cancelHold();
      closeMenu();
      stopEditing();
      if (space.isOpen()) showSpace(false);
      stopLive();
      tab.generation++;
      tab.viewer.remove();
      state = makeTab();
      tabs = [state];
      state.viewer.conceal(false);
      unowned = true;
      shared.opening++;
      paintTabs();
      keep();
      void open('', { quiet: true });
      return;
    }
    const next = withoutTab(tabs, tabs.indexOf(state), tabs.indexOf(tab));
    if (!next.closed) return;
    if (tab === liveTab) stopLive();
    if (tab === state) toFront(next.tabs[next.active]);
    tabs = next.tabs;
    tab.viewer.remove();
    tab.generation += 1;
    paintTabs();
    keep();
    syncLive();
  }
  // A tab kept from before, loaded: its folder, then its file.
  async function load(tab) {
    if (tab.app) { tab.loaded = true; await playApp(tab); return; }
    const file = tab.loaded ? null : tab.file;
    tab.loaded = true;
    tab.file = null;
    await go(tab.path, { tab });
    if (file && tab === state && tab.path === parentOf(file) && !tab.viewer.isOpen()) await openFile({ path: file, name: nameOf(file) });
  }
  count.onclick = () => tabs.length === 1 ? addTab() : viewPicker();
  count.oncontextmenu = event => { event.preventDefault(); viewPicker(); };
  count.onkeydown = event => { if (event.key === 'ArrowDown') { event.preventDefault(); viewPicker(); } };
  // An item in a tab of its own: a folder at itself, a file in its folder.


  // --- held: copied, and offered in a new tab -----------------------------------
  let menu = null;
  function closeMenu() {
    const was = menu; menu?.remove(); menu = null; count.setAttribute('aria-expanded', 'false');
    if (was && !protectedRows() && !items.hidden) patchItems();
  }
  // Held (or, on a Mac, clicked with the right button: at the pointer, with
  // what Finder's menu has too).
  function offer(entry, row, { at: point = null } = {}) {
    closeMenu();
    menu = doc.createElement('div');
    menu.className = 'workbench-menu';
    menu.setAttribute('role', 'menu');
    const item = (label, run) => {
      const one = doc.createElement('button');
      one.type = 'button';
      one.setAttribute('role', 'menuitem');
      one.textContent = label;
      one.onclick = run;
      menu.append(one);
      return one;
    };
    if (mac) menu.append(...mac.buttons(doc, entry.path, { role: 'menuitem', done: closeMenu, tell }));
    if (point) {
      const many = picked().length > 1;
      item(many ? 'Copy Paths' : 'Copy Path', () => { closeMenu(); void copyPicked(); });
      item('Move to Trash', () => { closeMenu(); void trashPicked(); }).className = 'workbench-menu-danger';
    }
    main.append(menu);
    // Below the item (above it near the foot), never under the finger; or
    // where the pointer was.
    const at = row.getBoundingClientRect(), box = main.getBoundingClientRect();
    const high = menu.offsetHeight, wide = menu.offsetWidth;
    const below = point ? point.y - box.top : at.bottom - box.top + 2;
    menu.style.top = `${below + high > main.clientHeight ? Math.max(0, (point ? point.y : at.top) - box.top - high - 2) : below}px`;
    menu.style.left = `${Math.max(0, Math.min(main.clientWidth - wide, (point ? point.x : at.left) - box.left))}px`;
  }
  doc.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) closeMenu(); }, true);
  let restoredScroll = null;
  items.addEventListener('scroll', () => {
    // Anchor restoration is asynchronous: its scroll event can arrive after
    // the person has opened a menu. Only their own scrolling closes it.
    const restored = restoredScroll === items.scrollTop;
    restoredScroll = null;
    if (!restored) closeMenu();
  }, { passive: true });

  // --- the address ----------------------------------------------------------------
  function paintPath() {
    const crumb = (label, path) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'workbench-crumb';
      button.textContent = label;
      const here = viewing()?.path ?? state.path;
      if (path === here) button.setAttribute('aria-current', 'page');
      // While a file is open, its own folder is the way back to it as it was.
      button.onclick = event => { event.stopPropagation(); if (viewing() && path === state.path) closeFile(); else if (path !== here) void go(path); };
      return button;
    };
    const owner = shared.machines.find(machine => state.owner ? machine.id === state.owner : machine.self);
    const choose = !viewing() && (!state.path || state.path === '/');
    const deviceRoot = crumb(owner?.name || state.owner || 'This computer', choose ? COMPUTER_ROOT : '/');
    deviceRoot.setAttribute('aria-label', choose ? 'Choose a computer' : `${owner?.name || state.owner || 'This computer'} filesystem root`);
    deviceRoot.title = deviceRoot.getAttribute('aria-label');
    if (choose) deviceRoot.setAttribute('aria-current', 'page');
    address.title = `${owner?.name || state.owner || 'This computer'} · Go to a folder (Ctrl+L)`;
    // Edit or Done first: it takes room from the address, which then shows its end.
    const editing = state.viewer.editing(), editButton = $('[data-edit]');
    editButton.hidden = !viewing() || !state.viewer.editable();
    editButton.textContent = editing ? 'Done' : 'Edit';
    editButton.setAttribute('aria-pressed', String(editing));
    editButton.title = editing ? 'Save, and show it as a page again (Esc)' : `Edit this file here (${MOD}+S saves)`;
    const crumbs = state.path === COMPUTER_ROOT ? [] : [deviceRoot];
    let path = '';
    for (const name of (state.path === COMPUTER_ROOT ? '' : viewing()?.path ?? state.path).split('/').filter(Boolean)) { path += `/${name}`; crumbs.push(crumb(name, path)); }
    pathBar.replaceChildren(...crumbs);
    pathBar.scrollLeft = pathBar.scrollWidth;
    // A file open: the room is its path's, the list and the map are the
    // folder's; a page playing: full screen, to play it.
    $('[data-space]').hidden = Boolean(viewing());
    $('[data-space]').disabled = state.path === COMPUTER_ROOT;
    $('[data-full]').hidden = !onFull || state.viewer.kind() !== 'page';
  }
  function edit() {
    if (unowned || state.path === COMPUTER_ROOT) return;
    typed.value = viewing()?.path ?? state.path;
    typed.hidden = false;
    pathBar.hidden = true;
    typed.focus();
    typed.select();
  }
  function stopEditing() {
    if (typed.hidden) return;
    typed.hidden = true;
    pathBar.hidden = false;
  }
  address.addEventListener('click', () => { if (typed.hidden) edit(); });
  typed.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const to = resolvePath(typed.value.trim() || '/', state.path);
      stopEditing(); root.focus({ preventScroll: true });
      void go(to);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      stopEditing(); root.focus({ preventScroll: true });
    }
  });
  typed.addEventListener('blur', stopEditing);

  // --- the folder -----------------------------------------------------------------
  function icon(entry) {
    const box = doc.createElement('span');
    box.className = `workbench-icon workbench-icon-${entry.dir ? 'folder' : 'file'}`;
    const kind = !entry.dir && media.find(([, pattern]) => pattern.test(entry.name));
    if (kind) {
      box.classList.add(`workbench-icon-${kind[0]}`);
      box.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true"><path class="media-symbol" d="${kind[2]}"/></svg>`;
      box.title = kind[0] === 'pdf' ? 'PDF' : kind[0];
    } else box.innerHTML = entry.dir ? svg.folder : svg.file;
    if (!entry.dir && /\.html?$/i.test(entry.path)) box.append(launchMarker(doc));
    const ext = !entry.dir && /\.([a-z0-9]{1,5})$/i.exec(entry.name)?.[1];
    if (ext) box.insertAdjacentHTML('beforeend', `<span class="workbench-ext">${ext.toLowerCase()}</span>`);
    if (!entry.dir && PICTURE.test(entry.name)) { pictureFor.set(box, { entry, from: base() }); seen.observe(box); }
    return box;
  }

  // --- pictures: the icon first, the picture once it has come -------------------
  // Only what is on screen is asked for, a few at a time; a new folder drops
  // whatever the last one was still waiting on.
  const pictureFor = new WeakMap();
  const pictures = { waiting: [], loading: new Set() };
  const seen = new IntersectionObserver(found => {
    for (const { target, isIntersecting } of found) {
      if (!isIntersecting) continue;
      seen.unobserve(target);
      pictures.waiting.push(target);
    }
    nextPicture();
  }, { root: items, rootMargin: '200px' });
  function nextPicture() {
    while (pictures.loading.size < PICTURES_AT_ONCE && pictures.waiting.length) {
      const box = pictures.waiting.shift(), { entry, from } = pictureFor.get(box) ?? {};
      if (!entry || !box.isConnected) continue;
      const img = doc.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      const settle = () => { pictures.loading.delete(img); nextPicture(); };
      img.onload = () => { if (box.isConnected && pictureFor.get(box)?.entry === entry) { box.replaceChildren(img); box.classList.add('workbench-picture'); } settle(); };
      img.onerror = settle;
      pictures.loading.add(img);
      // The picture's time and size in its address: a changed one is asked again.
      img.src = `${from}/files/thumbnail?path=${encodeURIComponent(entry.path)}&v=${entry.mtime}-${entry.size}`;
    }
  }
  function dropPictures() {
    for (const img of pictures.loading) { img.onload = img.onerror = null; img.removeAttribute('src'); }
    pictures.loading.clear();
    pictures.waiting.length = 0;
    seen.disconnect();
  }
  function paintItems() {
    cancelHold();
    const entries = state.listing?.entries ?? [];
    dropPictures();
    items.className = 'workbench-items workbench-list';
    items.setAttribute('role', state.path === COMPUTER_ROOT ? 'group' : 'listbox');
    items.setAttribute('aria-label', state.path === COMPUTER_ROOT ? 'Computers' : 'Folder');
    if (state.path === COMPUTER_ROOT) items.removeAttribute('aria-multiselectable');
    else items.setAttribute('aria-multiselectable', 'true');
    if (state.path === COMPUTER_ROOT) {
      const machines = fileComputers(shared.machines);
      items.replaceChildren(...machines.map(machine => {
        const row = doc.createElement('button');
        row.type = 'button'; row.className = 'workbench-item workbench-device';
        const name = doc.createElement('span'); name.className = 'workbench-name'; name.textContent = machine.name || machine.id || 'This computer';
        const reach = doc.createElement('span'); reach.className = 'workbench-size'; reach.textContent = machine.self || machine.reachable ? 'Reachable' : 'Offline · retry';
        row.append(icon({ dir: true, name: '', path: '' }), name, reach);
        row.onclick = () => { void chooseComputer(machine); };
        return row;
      }));
      return;
    }
    items.replaceChildren(...entries.map(makeRow));
    select(state.selection, false);
  }
  const entryIndex = row => state.listing?.entries.findIndex(entry => entry.path === row.dataset.path) ?? -1;
  function makeRow(entry) {
    const row = doc.createElement('div');
    row.className = 'workbench-item'; row.setAttribute('role', 'option'); row.dataset.path = entry.path;
    for (const name of ['name', 'size', 'date']) {
      const span = doc.createElement('span'); span.className = `workbench-${name}`; row.append(span);
    }
    updateRow(row, entry);
    row.onclick = event => {
      const i = entryIndex(row);
      if (i < 0) return;
      select(pick(state.selection, i, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }));
      if (phone() && !event.ctrlKey && !event.metaKey && !event.shiftKey) activate(row.entry);
    };
    row.ondblclick = () => { if (entryIndex(row) >= 0) activate(row.entry); };
    row.onmousedown = event => { if (event.button === 1) event.preventDefault(); };
    return row;
  }
  function updateRow(row, entry) {
    const project = entry.dir && state.projects?.get(entry.name);
    const art = project ? `project:${entry.name}` : `${entry.dir}:${entry.name}`;
    const version = project ? String(project.picture || 0) : `${entry.mtime}-${entry.size}`;
    row.title = entry.path; row.entry = entry;
    row.classList.toggle('workbench-launchable', Boolean(project || (!entry.dir && /\.html?$/i.test(entry.path))));
    const text = (selector, value) => { const node = row.querySelector(selector); if (node.textContent !== value) node.textContent = value; };
    text('.workbench-name', entry.name); text('.workbench-size', entry.dir ? '' : size(entry.size)); text('.workbench-date', when(entry.mtime));
    if (row.art !== art) {
      if (row.art !== undefined) { seen.unobserve(row.firstElementChild); row.firstElementChild.remove(); }
      row.prepend(project ? projectPreview(project, base(), onProject || ((name, from) => { void openProject(name, { base: from }); })) : icon(entry));
    } else if (row.version !== version) {
      const box = row.firstElementChild;
      if (project) {
        const fresh = projectPreview(project, base(), () => {});
        box.firstElementChild.replaceWith(fresh.firstElementChild);
      } else if (!entry.dir && PICTURE.test(entry.name)) {
        pictureFor.set(box, { entry, from: base() }); seen.observe(box);
      }
    }
    row.art = art; row.version = version;
  }
  // Keep row identity, and keep its position while a pointer or menu uses it.
  // Deleted rows leave a temporary empty slot; additions append until idle.
  let overItems = false, pressing = false;
  const protectedRows = () => overItems || pressing || Boolean(menu);
  function patchItems() {
    if (state.path === COMPUTER_ROOT || !state.listing) return;
    const entries = state.listing.entries, paths = new Set(entries.map(entry => entry.path));
    const rows = new Map([...items.querySelectorAll(':scope > .workbench-item')].map(row => [row.dataset.path, row]));
    const protect = protectedRows(), scroll = items.scrollTop;
    const anchor = [...rows.values()].find(row => row.offsetTop + row.offsetHeight > scroll);
    const offset = anchor ? anchor.offsetTop - scroll : 0;
    const motion = !doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Read departure geometry before inserting any slots/removing any rows.
    // Otherwise a protected row's own slot shifts its fade down by one row;
    // batching these reads also avoids a layout flush per bulk deletion.
    const departures = [...rows].filter(([path]) => !paths.has(path)).map(([path, row]) => ({
      path, row, height: row.getBoundingClientRect().height,
      top: row.offsetTop, left: row.offsetLeft, width: row.offsetWidth,
      columns: motion ? doc.defaultView.getComputedStyle(row).gridTemplateColumns : '',
    }));
    for (const { path, row, height, top, left, width, columns } of departures) {
      seen.unobserve(row.firstElementChild);
      if (protect) {
        const gap = doc.createElement('div'); gap.className = 'workbench-gap'; gap.style.height = `${height}px`; gap.setAttribute('aria-hidden', 'true'); row.before(gap);
      }
      if (motion) {
        const ghost = row.cloneNode(true); ghost.inert = true;
        ghost.className = 'workbench-row-leaving'; ghost.removeAttribute('data-path'); ghost.removeAttribute('role'); ghost.setAttribute('aria-hidden', 'true');
        ghost.style.cssText = `top:${top}px;left:${left}px;width:${width}px;height:${height}px;grid-template-columns:${columns}`;
        items.append(ghost); setTimeout(() => ghost.remove(), 160);
      }
      row.remove(); rows.delete(path);
    }
    for (const entry of entries) {
      let row = rows.get(entry.path);
      if (row) updateRow(row, entry);
      else { row = makeRow(entry); row.classList.add('workbench-row-added'); items.append(row); rows.set(entry.path, row); setTimeout(() => row.classList.remove('workbench-row-added'), 160); }
    }
    if (!protect) {
      for (const gap of items.querySelectorAll('.workbench-gap')) gap.remove();
      let before = items.firstElementChild;
      for (const entry of entries) {
        const row = rows.get(entry.path);
        if (row !== before) items.insertBefore(row, before);
        before = row.nextElementSibling;
      }
      const target = scroll === 0 ? 0 : anchor?.isConnected ? anchor.offsetTop - offset : scroll;
      if (items.scrollTop !== target) {
        items.scrollTop = target;
        restoredScroll = items.scrollTop;
      }
    }
    select(state.selection, false);
  }
  items.addEventListener('pointerenter', () => { overItems = true; });
  items.addEventListener('pointerleave', () => { overItems = false; if (!protectedRows()) patchItems(); });
  items.addEventListener('pointerdown', () => { pressing = true; }, true);
  const released = () => { pressing = false; if (!protectedRows() && !items.hidden) patchItems(); };
  doc.addEventListener('pointerup', released); doc.addEventListener('pointercancel', released);
  function select(selection, reveal = true) {
    state.selection = selection;
    let cursor;
    const indices = new Map((state.listing?.entries ?? []).map((entry, n) => [entry.path, n]));
    for (const row of items.querySelectorAll(':scope > .workbench-item')) {
      const n = indices.get(row.dataset.path) ?? -1;
      row.setAttribute('aria-selected', String(selection.picked.has(n)));
      row.classList.toggle('workbench-cursor', n >= 0 && n === selection.cursor);
      if (n >= 0 && n === selection.cursor) cursor = row;
    }
    if (reveal) cursor?.scrollIntoView({ block: 'nearest' });
  }
  const picked = () => (state.listing?.entries ?? []).filter((_, n) => state.selection.picked.has(n));
  let copying = 0;
  async function copyPicked() {
    const paths = picked().map(entry => entry.path);
    const tab = state, turn = ++copying, generation = tab.generation;
    const owner = shared.machines.find(machine => machine.id === tab.owner)?.name || tab.owner;
    const same = () => turn === copying && tab === state && generation === tab.generation;
    try {
      await copyPaths(paths, doc);
      if (same()) tell(`Copied ${paths.length} paths${owner ? ` · ${owner}` : ''}`);
    } catch (error) {
      if (same()) tell(`Couldn't copy paths: ${error.message}`);
    }
  }
  const cancelHold = holdToCopy(items, position => {
    const row = items.children[position], i = entryIndex(row);
    if (i < 0) return;
    select(pick(state.selection, i, { toggle: true }), false);
    void copyPicked();
    const entry = state.listing?.entries[i];
    if (entry && state.selection.picked.has(i)) offer(entry, row);
    else closeMenu();
  });
  function activate(entry) { if (entry.dir) void go(entry.path); else void openFile(entry); }
  // A Mac's right-click: the item (with the others picked, if it is one of
  // them) and its menu where the pointer is.
  if (mac) items.addEventListener('contextmenu', event => {
    const row = event.target.closest?.('.workbench-item');
    const i = row ? entryIndex(row) : -1;
    if (i < 0 || event.defaultPrevented) return;
    event.preventDefault();
    if (!state.selection.picked.has(i)) select(pick(state.selection, i), false);
    offer(state.listing.entries[i], row, { at: { x: event.clientX, y: event.clientY } });
  });

  // --- a file, open in place of the folder --------------------------------------
  const viewing = () => (state.viewer.isOpen() ? state.viewer.file() : null);
  const folderPictures = () => (state.listing?.entries ?? []).filter(entry => !entry.dir && PICTURE.test(entry.name));
  async function openFile(file) {
    if (state.viewer.unsaved() && !await savedFirst()) return;
    cancelHold();
    closeMenu();
    stopEditing();
    if (space.isOpen()) showSpace(false);
    const tab = state;
    tab.app = null;
    items.hidden = true; say('');
    stopLive();
    const inFolder = (tab.listing?.entries ?? []).some(entry => entry.path === file.path);
    const shown = tab.viewer.show(file, { pictures: inFolder && PICTURE.test(file.name) ? folderPictures() : [] });
    paintPath();
    paintTabs();
    const found = await shown;
    if (tab !== state) { paintTabs(); keep(); return; }
    // A Markdown link, or a typed path, to a folder: the folder.
    if (!found) { await go(file.path.replace(/(.)\/$/, '$1')); return; }
    paintPath();
    paintTabs();
    keep();
    syncLive();
  }
  function closeFile() {
    if (!state.viewer.isOpen()) return;
    if (state.viewer.unsaved()) { const tab = state; void savedFirst(tab).then(ok => { if (ok && tab === state) closeFile(); }); return; }
    const wasApp = Boolean(state.app);
    state.app = null;
    state.viewer.hide();
    if (wasApp) void go(state.path);
    items.hidden = false;
    say(state.note || (state.listing && !state.listing.entries.length ? 'Folder is empty' : ''));
    paintPath();
    paintTabs();
    keep();
    select(state.selection);
    root.focus({ preventScroll: true });
    syncLive();
  }

  // A file being edited is saved before anything takes its place. What
  // could not be saved keeps it there, and the bar and its line say why.
  async function savedFirst(tab = state) {
    if (!tab.viewer.unsaved() || await tab.viewer.save()) return true;
    if (tab === state) tell(`Not saved yet: ${tab.viewer.trouble() || 'try again'}`);
    return false;
  }

  // path: a folder, or '' for the computer's home.
  // keep: paths to keep selected, when the same folder is shown again.
  // stay: keep the file that is open (the folder refreshed under it).
  // tab: the tab it is for, the one in front unless said; one sent behind
  // meanwhile still gets its folder, shown when it comes to the front.
  async function go(path, { keep: keeping = [], stay = false, tab = state } = {}) {
    if (!stay && tab.viewer.unsaved() && !await savedFirst(tab)) return;
    const front = () => tab === state;
    if (front()) { cancelHold(); closeMenu(); stopEditing(); if (space.isOpen()) showSpace(false); }
    const turn = ++tab.generation;
    if (tab === liveTab) stopLive();
    tab.loaded = true; tab.loading = true;
    if (!stay) { tab.app = null; tab.viewer.hide(); if (front()) items.hidden = false; }
    if (path === COMPUTER_ROOT) {
      unowned = false; shared.opening++; holdDefault();
      tab.loading = false;
      tab.path = COMPUTER_ROOT; tab.file = null; tab.listing = null; tab.projects = null; tab.selection = none(); tab.note = '';
      keep(); paintTabs();
      if (front()) { paintPath(); paintItems(); say(''); }
      await loadMachines();
      if (turn !== tab.generation || !front()) return;
      paintItems(); paintPath();
      if (!shared.inventoryKnown) unavailable('Computer inventory unavailable', () => { void go(COMPUTER_ROOT); });
      return;
    }
    const from = baseOf(tab.owner);
    let result, listing, projects;
    try { [result, projects] = await Promise.all([listAt(from, path), projectsAt(from, path)]); listing = result.listing; }
    catch (error) {
      if (turn !== tab.generation) return;
      tab.loading = false;
      // A typed path to a file: the file, in its folder.
      if (/isn't a folder/.test(error.message) && !stay) {
        await go(parentOf(path), { tab });
        if (turn + 1 === tab.generation && front()) await openFile({ path, name: path.split('/').at(-1) });
        return;
      }
      tab.path = path; tab.listing = null; tab.selection = none(); tab.note = error.message;
      keep();
      paintTabs();
      if (front()) {
        paintPath(); paintItems();
        const computer = shared.machines.find(machine => machine.id === tab.owner)?.name || tab.owner || 'This computer';
        // The computer answered (a folder that isn't there, or isn't yours to
        // open): say what it said, not that the computer is unavailable.
        unavailable(error.status === 403 || error.status === 404 ? error.message : `${computer} unavailable: ${error.message}`, () => { void go(path, { tab }); });
      }
      return;
    }
    if (turn !== tab.generation) return;
    tab.loading = false;
    listing.entries = listing.entries.filter(entry => !entry.name.startsWith('.'));
    const again = listing.path === tab.path;
    if (!again && front()) tell('');
    // Each computer's home, as its own answer to '' names it.
    if (path === '') shared.homes.set(tab.owner, listing.path);
    tab.path = listing.path;
    tab.listing = listing;
    tab.etag = result.etag;
    tab.projects = projects;
    tab.note = '';
    const kept = new Set(keeping);
    tab.selection = kept.size
      ? { picked: new Set(listing.entries.flatMap((entry, n) => (kept.has(entry.path) ? [n] : []))), anchor: -1, cursor: -1 }
      : none();
    if (!again) tab.scroll = 0;
    keep();
    paintTabs();
    if (!front()) return;
    paintPath();
    paintItems();
    if (tab.viewer.isOpen()) return;
    say(listing.entries.length ? '' : 'Folder is empty');
    if (!again) items.scrollTop = 0;
    syncLive();
  }

  // --- the Trash --------------------------------------------------------------------
  // Delete moves what is selected to the Trash of the computer the folder is
  // on, with no question: it can be restored from there. What could not go
  // stays, selected, and the bar says why.
  async function moveToTrash(paths) {
    const res = await fetch(`${base()}/files/trash`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths }) });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || `the computer said ${res.status}`);
    return { refused: result.refused ?? [], trashed: result.trashed ?? [] };
  }
  function sayTrashed({ trashed, refused }, going) {
    const name = path => going.find(entry => entry.path === path)?.name ?? path;
    const said = [];
    if (trashed.length) said.push(trashed.length === 1 ? `Moved ${name(trashed[0])} to Trash` : `Moved ${trashed.length} items to Trash`);
    if (refused.length === 1) said.push(`Couldn't move ${refused[0].name}: ${refused[0].reason}`);
    else if (refused.length) said.push(`Couldn't move ${refused.length} items: ${[...new Set(refused.map(item => item.reason))].join('; ')}`);
    tell(said.join('. '));
  }
  async function trashPicked() {
    const going = picked();
    if (!going.length || shared.busy) return;
    shared.busy = true;
    const tab = state, owner = tab.owner, path = tab.path;
    let result;
    try { result = await moveToTrash(going.map(entry => entry.path)); }
    catch (error) { tell(`Couldn't move to Trash: ${error.message}`); return; }
    finally { shared.busy = false; }
    if (owner === tab.owner && path === tab.path) await go(path, { keep: result.refused.map(item => item.path), tab });
    sayTrashed(result, going);
  }
  // Delete on a picture that is open: that picture goes, and the next comes.
  async function trashViewed() {
    const file = viewing();
    const tab = state, viewer = tab.viewer;
    if (!file || viewer.kind() !== 'image' || shared.busy) return;
    shared.busy = true;
    const owner = tab.owner, path = tab.path;
    const others = viewer.pictures();
    const at = others.findIndex(picture => picture.path === file.path);
    let result;
    try { result = await moveToTrash([file.path]); }
    catch (error) { tell(`Couldn't move to Trash: ${error.message}`); return; }
    finally { shared.busy = false; }
    sayTrashed(result, [file]);
    if (!result.trashed.length || tab !== state || owner !== tab.owner || viewing()?.path !== file.path) return;
    const left = others.filter(picture => picture.path !== file.path);
    const kept = picked().filter(entry => entry.path !== file.path).map(entry => entry.path);
    if (path === tab.path) await go(path, { keep: kept, stay: Boolean(left.length) });
    if (tab !== state) return;
    if (left.length && viewing()?.path === file.path) { await viewer.show(left[Math.min(at, left.length - 1)], { pictures: folderPictures() }); paintPath(); paintTabs(); keep(); }
    else if (!left.length) closeFile();
  }

  // --- keys -----------------------------------------------------------------------
  root.addEventListener('keydown', event => {
    if (root.hidden || unowned || event.defaultPrevented || event.target === typed) return;
    if (event.key === 'Escape' && menu) { closeMenu(); count.focus(); event.preventDefault(); return; }
    if (menu?.classList.contains('workbench-view-picker') || event.target.closest?.('button')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'l') { edit(); event.preventDefault(); return; }
    const viewer = state.viewer;
    // Editing: Escape is Done; every other key is the text's.
    if (viewer.editing()) {
      if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey) { void viewer.done(); event.preventDefault(); }
      return;
    }
    if (viewer.isOpen()) {
      // Keys meant for what plays, or for the page's own text, stay there.
      if (event.target.closest?.('video, audio, iframe, input, textarea, [contenteditable="true"]')) { if (event.key === 'Escape') { closeFile(); event.preventDefault(); } return; }
      if ((event.key === 'Escape' || event.key === 'Backspace') && !event.altKey && !event.ctrlKey && !event.metaKey) { closeFile(); event.preventDefault(); return; }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && viewer.step(event.key === 'ArrowRight' ? 1 : -1)) { event.preventDefault(); return; }
      if (event.key === 'Delete') { void trashViewed(); event.preventDefault(); }
      return;
    }
    if (state.path === COMPUTER_ROOT) return;
    if (space.isOpen()) {
      if (event.key === 'Escape') { showSpace(false); event.preventDefault(); }
      else if (event.key === 'Backspace') { space.out(); event.preventDefault(); }
      return;
    }
    // Backspace, as in a file manager: the folder above; text being typed
    // keeps its own.
    if (event.key === 'Backspace' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.target.closest?.('input, textarea, select, [contenteditable="true"]')) {
      void go(state.path === '/' ? COMPUTER_ROOT : parentOf(state.path)); event.preventDefault(); return;
    }
    const entries = state.listing?.entries ?? [];
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'c' && picked().length) { void copyPicked(); event.preventDefault(); return; }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && key === 'a') { select(all(state.selection, entries.length)); event.preventDefault(); return; }
    if (event.key === 'Delete' && !event.altKey && !event.ctrlKey && !event.metaKey) { void trashPicked(); event.preventDefault(); return; }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const by = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (by && entries.length) { select(step(state.selection, by, entries.length, { range: event.shiftKey })); event.preventDefault(); return; }
    if (event.key === 'Enter') { const entry = entries[state.selection.cursor]; if (entry) activate(entry); event.preventDefault(); }
  });
  $('[data-space]').onclick = () => showSpace(!space.isOpen());
  $('[data-edit]').onclick = () => { if (state.viewer.editing()) void state.viewer.done(); else void state.viewer.edit(); };
  registerKeyBinding({ label: `${MOD}+S`, description: 'save the file being edited in Files', code: 'KeyS', mod: true,
    when: () => !root.hidden && state.viewer.editing(), handler: () => { void state.viewer.save(); } });
  $('[data-full]').onclick = () => onFull?.();
  items.addEventListener('click', event => { if (event.target === items) select(none()); });

  // --- open -----------------------------------------------------------------------
  // path: a folder, in the tab in front; base: the computer it is on (''
  // this one, /peer/<id> another). With no path, where the tab was on that
  // computer, or its home the first time and when the computer changes. A
  // tab kept from before opens as it was left, its file too; a file open in
  // the tab in front stays, and another folder or computer asked for has a
  // tab of its own.
  async function open(path = '', { base: from, quiet = false, refresh = quiet } = {}) {
    cancelHold();
    root.hidden = false;
    if (!quiet) root.focus({ preventScroll: true });
    const tab = state;
    // The latest asked wins, whichever list of computers comes first.
    const turn = ++shared.opening;
    if (from !== undefined) unowned = false;
    holdDefault();
    const needsDefault = unowned;
    if (needsDefault) { paintPath(); say('Finding Files computer…'); }
    const known = await loadMachines();
    try {
      if (needsDefault) from = await defaultBase(known ? shared.machines : null);
    } catch (error) {
      if (turn !== shared.opening || tab !== state) return;
      unavailable(error.message, () => { void open(path, { quiet }); });
      return;
    }
    paintTabs();
    if (turn !== shared.opening || tab !== state) return;
    unowned = false;
    holdDefault();
    const owner = from === undefined ? tab.owner : from.startsWith('/peer/') ? decodeURIComponent(from.slice(6)) : '';
    const moved = owner !== tab.owner;
    const to = path || (moved || (from !== undefined && tab.path === COMPUTER_ROOT) ? '' : tab.path);
    // Re-show a kept file even when the selected view is currently a folder.
    // A quiet update refreshes its stream without selecting that Files tab.
    const shown = path && tabs.find(one => one.owner === owner && !one.app && fileOf(one) === to && (one.viewer.isStream() || (tab.loaded && fileOf(tab))));
    if (shown) {
      if (!quiet || !shown.viewer.isStream()) toFront(shown);
      if (refresh) shown.viewer.refreshHosted();
      return;
    }
    if (tab.loaded && fileOf(tab)) {
      const there = tabs.find(one => one.owner === owner && (fileOf(one) === to || (one.path === to && !fileOf(one))));
      if (path || moved) {
        if (there) { toFront(there); if (refresh) there.viewer.refreshHosted(); }
        else addTab({ owner, path: to });
      }
      return;
    }
    tab.owner = owner;
    if (!tab.loaded && !moved && to === tab.path) await load(tab);
    else { tab.loaded = true; tab.file = null; await go(to, { tab }); }
  }
  async function previewRequest(from, body) {
    const res = await fetch(`${from}/shown/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const answer = await res.json();
    if (!res.ok) throw Object.assign(new Error(answer.error || 'App unavailable'), { local: answer.local });
    return answer;
  }
  async function playApp(tab, { reload = false } = {}) {
    const app = tab.app;
    if (!app) return;
    if (tab === state) { items.hidden = true; say(''); stopLive(); }
    const identity = { path: tab.path, name: app.project || app.service.name };
    await tab.viewer.app(identity, async () => {
      const from = baseOf(tab.owner);
      if (app.project) {
        const started = await startProject(app.project, from);
        if (started.path) tab.path = identity.path = started.path;
        return started.url;
      }
      return (await previewRequest(from, { service: app.service })).url;
    }, { reload });
    if (tab === state) paintPath();
    paintTabs(); keep();
  }
  async function openApp(app, { base: from = base(), quiet = false, refresh = false } = {}) {
    root.hidden = false;
    unowned = false; holdDefault();
    const owner = from.startsWith('/peer/') ? decodeURIComponent(from.slice(6)) : '';
    const known = tabs.find(tab => tab.owner === owner && JSON.stringify(tab.app) === JSON.stringify(app));
    if (known) {
      if (!quiet) toFront(known);
      // Showing an updated creation reloads its existing frame. Ordinary
      // project navigation keeps the running app and its state intact.
      if (refresh) await playApp(known, { reload: true });
      return true;
    }
    // Keep every ongoing file/app intact. The ordinary folder remains a view.
    const tab = makeTab({ owner, path: app.service?.cwd || (state.path === COMPUTER_ROOT ? '' : state.path), app });
    const next = withTab(tabs, tabs.indexOf(state), tab);
    tabs = next.tabs;
    for (const gone of next.dropped) gone.viewer.remove();
    tab.loaded = true;
    if (!quiet) toFront(tab);
    await playApp(tab);
    return true;
  }
  const openProject = (name, options) => openApp({ project: name }, options);
  async function preview(target, options = {}) {
    const from = options.base ?? base();
    let answer;
    try { answer = await previewRequest(from, { target }); }
    catch (error) {
      if (!error.local && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/i.test(target)) return false;
      tell(error.message); return true;
    }
    if (!answer.local) return false;
    return openApp(answer.project ? { project: answer.project } : { service: answer.service }, { ...options, refresh: true });
  }
  paintTabs();
  holdDefault();
  return {
    open, project: openProject, preview,

    focus() {
      if (root.contains(doc.activeElement)) return;
      if (state.viewer.editing() && !phone()) state.viewer.focusEditor();
      else root.focus({ preventScroll: true });
    },
    // What the back gesture closes first: the menu, the typed address, then
    // a file that is open, then the map.
    back() {
      if (menu) { closeMenu(); return true; }
      if (!typed.hidden) { stopEditing(); return true; }
      if (state.viewer.editing()) { void state.viewer.done(); return true; }
      if (state.viewer.isOpen()) { closeFile(); return true; }
      if (space.isOpen()) { showSpace(false); return true; }
      if (state.path !== COMPUTER_ROOT) { void go(state.path === '/' ? COMPUTER_ROOT : parentOf(state.path)); return true; }
      return false;
    },
    where: () => ({ path: state.path, base: base(), file: viewing()?.path ?? null }),
    // The views, as the sidebar lists them (harness.js): like a browser's
    // tabs, each a folder (or a file in it) on one computer, one in front.
    // Sidebar painting must not read the provisional local computer while
    // the Files owner is unresolved, nor race the restored folder's first read.
    views: () => tabs.map(tab => (!unowned && tab.listing && !tab.loading && learnHome(tab.owner), tab)).map((tab, key) => ({ key, owner: tab.owner, path: fileOf(tab) || tab.path, file: Boolean(fileOf(tab)), home: !fileOf(tab) && (!tab.path || shared.homes.get(tab.owner) === tab.path),
      name: tab.app?.project || tab.app?.service?.name || (!fileOf(tab) && shared.homes.get(tab.owner) === tab.path ? 'Home' : tabName({ path: tab.path, file: fileOf(tab) })), front: tab === state })),
    selectView: key => { if (tabs[key] && tabs[key] !== state) toFront(tabs[key]); },
    newView: () => addTab({ owner: state.owner, path: '' }),
    closeView: key => { if (tabs[key]) closeTab(tabs[key]); },
    unsaved: () => tabs.some(tab => tab.viewer.unsaved()),
  };
}
