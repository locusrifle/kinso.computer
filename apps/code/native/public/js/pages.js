// Local addresses and files in the conversation, and the browser they open in.
//
// When an agent has built something it shows it (the `show` tool,
// code-control.mjs): a page, an app, a PDF or a local address opens as a tab
// in the browser beside the conversation (mountPages), and a picture, a video
// or a sound plays in the conversation, in a window the person can take full
// screen (windowNode). What it showed comes with the one address the
// computer it runs on serves it at (system/shown.mjs), which plays just as it
// is on every screen. A local address (http://localhost:5173/) or the path
// of a file it made, named in its words (or shown before there were such
// addresses), is a link that opens it as a tab too, once that computer has
// said where.

import { phone } from './windows.js';
import { brand } from './brand.js';
import { holdProjects, startProject } from './projects.js';
import { mountLive } from './live.js';
import { mountTabStrip } from './browser-tab-strip.js';
import { mountStartPage } from './browser-start.js';
import { launchShopURL, prepareLaunchShop } from './launch-open.js';

const KINSO_CONCEPT = 'https://kinso.computer/kinso/';

const VIEW = { png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image', mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio', opus: 'audio', pdf: 'pdf', html: 'page', htm: 'page' };
export function viewOf(path) {
  let file = String(path);
  try {
    const url = new URL(file, 'http://local');
    if (url.pathname === '/files/raw') file = url.searchParams.get('path') || '';
    else if (/^https?:/.test(file)) file = url.pathname;
  } catch { /* a file path as written */ }
  return VIEW[file.split('.').pop().toLowerCase()] ?? '';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']);
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"`<>)\]]*)?/g;

// A local page address, normalized to localhost; '' for anything else.
export function localPage(href) {
  try {
    const url = new URL(String(href ?? '').trim());
    if (!/^https?:$/.test(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) return '';
    url.hostname = 'localhost';
    return url.href;
  } catch { return ''; }
}

// A file a window can play, named by an absolute or home path (or a
// file:// address), or relative to the folder the session works in (agents
// often name what they made that way); '' for anything else.
const LOCAL_FILE = /(?:file:\/\/)?(?:~\/|\/)?[\w.@+-][^\s`'"<>()[\]]*\.(?:png|jpe?g|gif|webp|svg|avif|mp4|webm|mov|m4v|mp3|wav|ogg|flac|m4a|opus|pdf|html?)\b/gi;
let fileBase = '';
// The folder the conversation's session works in (harness.js sets it).
export function setFileBase(cwd) { fileBase = String(cwd ?? '').replace(/\/+$/, ''); }
function joinPath(base, relative) {
  const parts = [];
  for (const part of `${base}/${relative}`.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}
export function localFile(text) {
  let path = String(text ?? '').trim().replace(/^file:\/\//, '');
  try { path = decodeURI(path); } catch { /* as written */ }
  if (!viewOf(path) || path.includes('\n')) return '';
  if (/^(~\/|\/)/.test(path)) return path;
  return fileBase && /^[\w.@+-][^:]*$/.test(path) ? joinPath(fileBase, path) : '';
}

// Text cut into plain runs, local addresses and files. A sentence's closing
// punctuation is not part of the address it ends on.
export function splitLocal(text) {
  text = String(text ?? '');
  const found = [];
  for (const match of text.matchAll(LOCAL_URL)) {
    let one = match[0];
    while (/[.,;:!?]$/.test(one)) one = one.slice(0, -1);
    const url = shownAt(one) ? one : localPage(one);
    if (url) found.push({ index: match.index, text: one, url });
  }
  for (const match of text.matchAll(LOCAL_FILE)) {
    // The path part of an address is not a file.
    if (found.some(one => match.index >= one.index && match.index < one.index + one.text.length)) continue;
    if (match.index > 0 && /[\w.:/-]/.test(text[match.index - 1])) continue;
    const file = localFile(match[0]);
    if (file && !found.some(one => one.index === match.index)) found.push({ index: match.index, text: match[0], file });
  }
  const out = [];
  let end = 0;
  for (const one of found.sort((a, b) => a.index - b.index)) {
    if (one.index < end) continue;
    if (one.index > end) out.push({ text: text.slice(end, one.index) });
    const { index, ...part } = one;
    out.push(part);
    end = index + one.text.length;
  }
  if (end < text.length) out.push({ text: text.slice(end) });
  return out;
}

export function pageLink(url, label = url) {
  const a = document.createElement('a');
  a.href = url;
  a.dataset.page = url;
  a.className = 'gui-page-link';
  a.title = 'open it in the browser';
  if (typeof label === 'string') a.textContent = label;
  else a.append(label);
  return a;
}
export function fileLink(path, label = path) {
  const a = pageLink('#', label);
  delete a.dataset.page;
  a.removeAttribute('href');
  a.dataset.file = path;
  if (viewOf(path) === 'page') a.title = 'open it in Files';
  a.tabIndex = 0;
  a.setAttribute('role', 'link');
  return a;
}
// The address of a thing an agent showed, read back as the file or local
// address it is: { file } or { port, rest }; null for anything else.
export function shownAt(href) {
  try {
    const url = new URL(String(href ?? '').trim());
    if (!/^https?:$/.test(url.protocol)) return null;
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith('/shown/')) return { file: path.slice('/shown'.length) };
    if (path === '/files/raw' && url.searchParams.get('path')?.startsWith('/')) return { file: url.searchParams.get('path') };
    const port = /^\/port\/(\d+)(\/.*)$/.exec(path);
    return port ? { port: Number(port[1]), rest: `${port[2]}${url.search}` } : null;
  } catch { return null; }
}

// A link for an address or a file named in the conversation, or null.
export function localLink(target, label) {
  if (shownAt(target) || browserLocal(target)) return pageLink(String(target).trim(), label);
  const page = localPage(target);
  if (page) return pageLink(page, label);
  const file = localFile(target);
  return file ? fileLink(file, label) : null;
}

// Plain text, with any local address or file in it made a link.
export function appendWithPages(parent, text) {
  for (const part of splitLocal(text)) parent.append(part.url ? pageLink(part.url, part.text) : part.file ? fileLink(part.file, part.text) : document.createTextNode(part.text));
}

// What is typed in the browser's address field: an address as it is, a
// name that looks like one as https (a local one as http), anything else as
// words to search for. '' for nothing.
const SEARCH = 'https://www.google.com/search?q=';
export function addressOf(typed) {
  const text = String(typed ?? '').trim();
  if (!text) return '';
  if (/^[a-z][\w+.-]*:/i.test(text) && !/\s/.test(text)) {
    try { const url = new URL(text); if (/^https?:$/.test(url.protocol) || url.href === 'about:blank') return url.href; } catch { /* words */ }
  }
  if (!/\s/.test(text) && /^(localhost|127\.0\.0\.1|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(text)) return new URL(`http://${text}`).href;
  if (!/\s/.test(text) && /^([\w-]+\.)+[a-z][\w-]*(:\d+)?([/?#]|$)/i.test(text)) return new URL(`https://${text}`).href;
  return SEARCH + encodeURIComponent(text);
}

export function pageLabel(url) {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.port ? `:${u.port}` : u.host}${path}${u.search}`;
  } catch { return url; }
}

// The lines the `show` tool answers with (code-control.mjs), read back:
// { shape, target, tab } (tab: it opened in the browser), or null.
export const OPENED = 'Opened in the browser beside the conversation, as a tab: ';
export function windowOf(text) {
  text = String(text ?? '');
  const tab = text.match(/^Opened in the browser beside the conversation, as a tab: (\S.*)$/m);
  if (tab) return { shape: 'landscape', target: tab[1].trim(), tab: true };
  const file = text.match(/^Opened in Workbench: (\S.*)$/m);
  if (file && viewOf(file[1].trim()) === 'page') return { shape: 'landscape', target: file[1].trim(), tab: true };
  const shown = text.match(/^Shown in the conversation, in a (landscape|portrait|square) window: (\S.*)$/m);
  return shown ? { shape: shown[1], target: shown[2].trim(), tab: false } : null;
}
// An address, as against a file's path or a local address (a thing shown
// from this computer alone is at one, on loopback).
const address = target => /^https?:\/\//i.test(String(target)) && (!localPage(target) || Boolean(shownAt(target)));
// What plays a thing: a picture, a video, a sound, or (anything else) a page.
const kindOf = target => viewOf(target);
// Hosted file origins exist only inside the owning headless browser.
const browserLocal = target => {
  try { return /^[a-f0-9]{32}\.localhost$/i.test(new URL(target).hostname); } catch { return false; }
};
// Whether a thing shown opens as a tab in the browser (a page, an app, a PDF,
// a local address), rather than playing in the conversation (a picture, a
// video, a sound).
export const inBrowser = target => !['image', 'video', 'audio'].includes(kindOf(target));
// A short name for what a tab or a link holds.
export function shownName(target) {
  const shown = shownAt(target), page = !shown && localPage(target);
  if (page) return pageLabel(page);
  if (shown?.port) return pageLabel(`http://localhost:${shown.port}${shown.rest}`);
  if (address(target) && !shown && !browserLocal(target)) return new URL(target).host;
  const parts = (shown?.file ?? (browserLocal(target) ? new URL(target).pathname : String(target))).split('/').filter(Boolean);
  return /^index\.html?$/i.test(parts.at(-1) ?? '') && parts.length > 1 ? parts.at(-2) : parts.at(-1) ?? String(target);
}

// Where a thing plays from: an address as it is; a file or a local address
// where the computer the conversation runs on says (base: '' for this one,
// else /peer/<computer>), which makes a file playable first.
export async function addressFor(target, base) {
  if (address(target)) return target;
  const res = await fetch(`${base}/shown/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: target }) });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(answer.error || `${res.status}`);
  // A computer whose imperfect is older than these addresses names none,
  // and serves its files itself.
  return answer.url ?? `${base}/shown${String(answer.path ?? target).split('/').map(encodeURIComponent).join('/')}`;
}

// The owning computer decides: a hosted browser stream or an ordinary page.
// Carried addresses stay intact for the server to validate and resolve.
export async function viewFor(target, base = '', { reload = false } = {}) {
  const res = await fetch(`${base}/shown/view`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, reload }) });
  const answer = await res.json().catch(() => ({}));
  // Older non-hosted peers have no view endpoint. New servers report target
  // failures as 503: never downgrade those failures to a client-side frame.
  if (res.status === 404) return { stream: false, url: await addressFor(target, base) };
  if (!res.ok) throw new Error(answer.error || `the computer said ${res.status}`);
  if (typeof answer.stream !== 'boolean' || typeof answer.url !== 'string' || !answer.url || (answer.stream && (!Number.isSafeInteger(answer.tab) || answer.tab <= 0))) throw new Error('Invalid preview response');
  return answer;
}

const make = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
// What plays a thing: a picture, a video, a sound, or a page in a frame.
function player(kind, src, name) {
  let shown;
  if (kind === 'image') { shown = make('img'); shown.alt = name; }
  else if (kind === 'video') { shown = make('video'); shown.controls = true; shown.loop = true; shown.playsInline = true; }
  else if (kind === 'audio') { shown = make('audio'); shown.controls = true; }
  else {
    shown = make('iframe');
    shown.title = name;
    shown.setAttribute('allow', 'autoplay; fullscreen; microphone; camera; gamepad');
  }
  // Chromium can reuse a decoded image within this document even with no-store.
  // Version each new file-image window; retained windows keep their existing src.
  shown.src = kind === 'image' ? `${src}${src.includes('?') ? '&' : '?'}show=${crypto.randomUUID()}` : src;
  return shown;
}

// A picture, a video or a sound an agent showed, playing in the conversation
// in the shape it chose, with a button to take it full screen.
export function windowNode({ shape = 'landscape', target }, { base = '' } = {}) {
  const win = make('div', 'gui-window');
  win.dataset.shape = shape;
  const body = make('div', 'gui-window-body');
  const bar = make('div', 'gui-window-bar');
  const name = shownName(target);
  const full = make('button', 'gui-window-full', '⛶');
  full.type = 'button'; full.title = 'Full screen'; full.setAttribute('aria-label', 'Full screen');
  full.onclick = () => {
    if (document.fullscreenElement === win) { void document.exitFullscreen(); return; }
    if (win.classList.contains('full')) { win.classList.remove('full'); return; }
    Promise.resolve(win.requestFullscreen?.()).then(() => { if (!document.fullscreenElement) win.classList.add('full'); }, () => win.classList.add('full'));
  };
  win.addEventListener('keydown', event => { if (event.key === 'Escape' && win.classList.contains('full')) { event.stopPropagation(); win.classList.remove('full'); } });
  bar.append(make('span', 'gui-window-name', name), full);
  win.append(body, bar);
  addressFor(target, base).then(src => body.replaceChildren(player(kindOf(src), src, name)),
    error => body.replaceChildren(make('p', 'gui-window-error', `${name}: ${error.message}`)));
  return win;
}

// The browser's ordinary tool endpoint returns native tab ids. Assembly
// reuses a Google page, never an unrelated tab or a new tab per visit.
export async function prepareLaunchBrowser(ask) {
  const { tabs } = await ask({ do: 'tabs' });
  if (!Array.isArray(tabs)) throw new Error('The browser did not return its tabs');
  const google = tabs.find(tab => { try { return ['www.google.com', 'google.com'].includes(new URL(tab.url).hostname); } catch { return false; } });
  const target = google ?? await ask({ do: 'open', url: 'https://www.google.com' });
  if (!Number.isSafeInteger(target.tab) || target.tab <= 0) throw new Error('The browser did not return its tab');
  await ask({ do: 'front', tab: target.tab });
}

const ICON = path => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="miter"/></svg>`;
const RELOAD = 'M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4';
const FULL = 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5';
// Chrome identities are local to this document, not secure-context tokens.
let browserKey = 0;

// The browser: a window beside the conversation (windows.js), holding tabs,
// one browser with one set of tabs whichever session is in view. Websites,
// local addresses, and the pages, PDFs and pictures agents make or name all
// open as tabs in it; what an agent shows or opens, from any session, opens
// behind the tab in front, so the person's eyes stay where they are. A
// project's page (projects.js) is a tab too, its server held while one is
// open. In the desktop
// window each tab is a <webview> with the window's cookies; elsewhere a frame,
// and a website opens in the device's own browser. It shows one page at a
// time: every other tab stays full size and drawn behind the one in front, so
// an agent's `browser` tool can use one the person is not looking at
// (desktop/electron/main.mjs). Every form has the same tab strip above its
// address and navigation controls, within the existing bar. MOD+W closes
// the one in front; MOD+arrows move panes, not tabs. On a phone the browser
// is one panel in the pane strip, with a full screen button. On every bar, reload; a
// page an agent shows again (it has changed it) wears a dot on it until it is
// loaded again.
//
// A phone's pages play on the phone, but the browser agents use is a
// computer's: watch(base, { quiet }) opens a panel of its own beside them
// showing it live (live.js), which an agent's browser asks for (harness.js).
// So does a hosted computer's page, on any screen: its window is out of sight.
//
// base(): the computer the conversation in view runs on, as addressFor takes
// it. Answers open(target), shown(target, base) for what an agent just
// showed, project(name, base) for a project's page, browse() for Ctrl+T,
// visit(url) for a website's own tab, flick(step) for tab
// selection, front(), at(win) and reopen(at) across a reload, watch().
export function mountPages({ output, wm, base = () => '', launchBase = null, launchAllowed = () => true, onLaunchError = () => {}, onFolder = () => {}, onApp = null, onProject = null, onTabs = () => {} }) {
  const desk = globalThis.imperfectDesk;
  // The browser is its window's pane, { win, el, bar, stack, tabs, front,
  // ... }; none until its first tab.
  const paneOf = () => wm.list().find(win => win.kind === 'browser')?.pane;

  const idOf = tab => { try { return tab.view.getWebContentsId?.() ?? null; } catch { return null; } };
  const byId = id => paneOf()?.tabs.find(tab => idOf(tab) === id);
  const where = url => (url === 'about:blank' ? '' : url);
  // What plays a tab, which takes the keys.
  const pageOf = tab => tab?.view ?? tab?.el.firstElementChild;
  const hasKeys = pane => Boolean(pane?.el.contains(document.activeElement));
  const sameHost = src => { try { return new URL(src, location.href).hostname === location.hostname; } catch { return false; } };

  // Quiet: opened for a tab behind, so not taking focus.
  function mountPane({ quiet = false } = {}) {
    const el = make('div', 'gui-window browser filling');
    const bar = make('div', 'gui-window-bar');
    bar.tabIndex = -1;
    const stack = make('div', 'gui-window-body browser-stack');
    el.append(bar, stack);
    const pane = { el, bar, stack, tabs: [], front: null };
    const go = (label, path, run) => {
      const button = make('button', 'gui-window-go');
      button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
      button.innerHTML = ICON(path);
      button.onclick = () => { try { if (pane.front) run(pane.front); } catch { /* not ready yet */ } };
      return button;
    };
    pane.strip = mountTabStrip({
      select: id => toFront(pane.tabs.find(tab => tab.key === id)),
      close: id => closeTab(pane.tabs.find(tab => tab.key === id)),
      create: browse,
      visit: url => navigate(pane.front, url),
    });
    const controls = make('div', 'browser-controls');
    bar.append(pane.strip.el, controls);
    pane.chrome = [pane.strip.el, controls];
    // Remote owners have their own strip. A quiet chooser keeps the pane's
    // other local/owner holders reachable without another stream or registry.
    pane.panels = make('button', 'browser-panels', 'Pages');
    pane.panels.type = 'button'; pane.panels.setAttribute('aria-expanded', 'false');
    pane.panels.setAttribute('aria-controls', `browser-pages-${++browserKey}`);
    pane.panelList = make('div', 'browser-panel-list');
    pane.panelList.id = pane.panels.getAttribute('aria-controls');
    pane.panelList.hidden = true;
    pane.panelEntries = new Map();
    const hidePanels = () => { pane.panelList.hidden = true; pane.panels.setAttribute('aria-expanded', 'false'); };
    pane.panels.onclick = () => {
      pane.panelList.hidden = !pane.panelList.hidden;
      pane.panels.setAttribute('aria-expanded', String(!pane.panelList.hidden));
      if (!pane.panelList.hidden) pane.panelList.querySelector('button')?.focus();
    };
    pane.panelList.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hidePanels(); pane.panels.focus(); }
    });
    el.addEventListener('pointerdown', event => { if (!pane.panelList.contains(event.target) && event.target !== pane.panels) hidePanels(); });
    el.addEventListener('focusout', event => { if (!pane.panelList.contains(event.relatedTarget) && event.relatedTarget !== pane.panels) hidePanels(); });
    pane.localNew = make('button', '', 'New local tab'); pane.localNew.type = 'button';
    pane.localNew.onclick = () => { hidePanels(); localTab(); };
    el.addEventListener('keydown', event => { if (!pane.front?.live && !pane.strip.el.contains(event.target)) pane.strip.keys(event); });
    pane.reload = go('Reload', RELOAD, reload);
    {
      if (desk) {
        pane.back = go('Back', 'M15 5l-7 7 7 7', tab => tab.view.goBack());
        pane.forward = go('Forward', 'M9 5l7 7-7 7', tab => tab.view.goForward());
      }
      const address = pane.address = make('input', 'gui-window-address');
      address.type = 'text'; address.spellcheck = false;
      address.placeholder = 'Search or type an address'; address.setAttribute('aria-label', 'Address');
      address.addEventListener('focus', () => address.select());
      address.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !pane.front) return;
        const url = addressOf(address.value);
        if (!url) return;
        event.preventDefault();
        navigate(pane.front, url);
      });
      if (desk) controls.append(pane.back, pane.forward);
      controls.append(pane.reload, address);
      if (phone()) controls.append(go('Full screen', FULL, () => wm.full(pane.win)));
    }
    pane.win = wm.open({
      kind: 'browser', body: el, bar, quiet,
      onClose: () => { for (const tab of pane.tabs) dispose(tab); pane.tabs.length = 0; pane.front = null; held.paint([]); onTabs(); },
      closeOne: () => pane.front?.live ? (pane.front.live.closeFront(), true) : closeTab(pane.front),
      // The pointer come in, the page in front takes the keys, unless
      // something in the browser (its address) has them already. Brought by
      // MOD+arrows in a web browser, a website of another origin would keep
      // them for good (it cannot hand the chord back, as imperfect's own
      // pages do: pane-shortcut.js), so they wait on the bar until a click.
      keys: ({ byKey = false } = {}) => {
        if (hasKeys(pane)) return;
        if (pane.front?.live) { pane.front.live.keys(); return; }
        const page = pageOf(pane.front);
        if (byKey && !desk && page?.localName === 'iframe' && !sameHost(page.src)) bar.focus({ preventScroll: true });
        else page?.focus?.({ preventScroll: true });
      },
    });
    pane.win.pane = pane;
    return pane;
  }

  function paint(pane) {
    // Keep inactive headers detached, not hidden duplicates in the DOM. The
    // outer bar remains the WM's swipe/focus surface throughout the swap.
    const chrome = pane.front?.live?.bar;
    if (chrome ? pane.bar.firstElementChild !== chrome : pane.bar.firstElementChild !== pane.strip.el) {
      pane.bar.replaceChildren(...(chrome ? [chrome] : pane.chrome));
    }
    if (chrome && pane.tabs.length > 1) {
      const controls = chrome.querySelector('.browser-controls');
      if (pane.panels.parentNode !== controls) controls.append(pane.panels);
      if (pane.panelList.parentNode !== pane.bar) pane.bar.append(pane.panelList);
      for (const [tab, entry] of pane.panelEntries) if (!pane.tabs.includes(tab)) { entry.remove(); pane.panelEntries.delete(tab); }
      for (const tab of pane.tabs) {
        let entry = pane.panelEntries.get(tab);
        if (!entry) {
          entry = make('div', 'browser-panel-entry');
          const select = make('button'), close = make('button', '', '×');
          select.type = close.type = 'button';
          select.onclick = () => { pane.panelList.hidden = true; pane.panels.setAttribute('aria-expanded', 'false'); toFront(tab); };
          close.onclick = () => closeTab(tab);
          entry.append(select, close); pane.panelEntries.set(tab, entry);
          pane.panelList.insertBefore(entry, pane.localNew.parentNode ? pane.localNew : null);
        }
        const name = tab.title || tab.label || 'New tab';
        entry.firstElementChild.textContent = name;
        entry.firstElementChild.setAttribute('aria-current', String(tab === pane.front));
        entry.firstElementChild.title = `${name}${tab.base ? ` — ${tab.base}` : ''}`;
        entry.lastElementChild.setAttribute('aria-label', `Close page ${name}`);
      }
      if (!pane.localNew.parentNode) pane.panelList.append(pane.localNew);
    } else {
      pane.panels.remove(); pane.panelList.remove(); pane.panelList.hidden = true; pane.panels.setAttribute('aria-expanded', 'false');
    }
    pane.reload.classList.toggle('stale', Boolean(pane.front?.stale));
    pane.strip.paint(pane.tabs.map(tab => ({ ...tab, id: tab.key, front: tab === pane.front, unread: tab.unread || tab.stale })));
    onTabs();
  }

  // Chrome-only start page: the underlying browser remains truly about:blank.
  function startPage(tab) {
    if (tab.live) return;
    const blank = tab.url === 'about:blank';
    if (blank && !tab.start) { tab.start = mountStartPage(url => navigate(tab, url)); tab.el.append(tab.start); }
    if (tab.start) tab.start.hidden = !blank;
  }
  function navigate(tab, url) {
    if (!tab || tab.live || tab.concept) return;
    tab.url = url; tab.title = ''; tab.favicon = ''; tab.label = url === 'about:blank' ? 'New tab' : shownName(url);
    if (tab.view) tab.view.src = url;
    else { tab.src = url; frame(tab, url); }
    startPage(tab); follow(tab, true); paint(tab.pane);
    if (tab === tab.pane.front) pageOf(tab)?.focus?.();
  }
  function frame(tab, src, kind = kindOf(src)) {
    const shown = player(kind, src, tab.concept ? 'Kinso Computer · concept' : tab.label);
    if (tab.concept) {
      shown.classList.add('kinso-concept');
      shown.removeAttribute('allow');
      shown.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    }
    tab.start = null;
    tab.loading = true;
    shown.addEventListener('load', () => {
      if (!tab.pane.tabs.includes(tab) || !tab.el.contains(shown)) return;
      tab.loading = false;
      if (tab !== tab.pane.front) tab.unread = true;
      try {
        const current = shown.contentWindow?.location.href;
        if (current) { tab.url = tab.src = current; tab.favicon = ''; }
        if (shown.contentDocument?.title) tab.title = tab.label = shown.contentDocument.title;
        const icon = shown.contentDocument?.querySelector('link[rel~="icon"]')?.href;
        if (icon) tab.favicon = icon;
      } catch { /* cross origin: keep the URL label and initial */ }
      startPage(tab); follow(tab); paint(tab.pane);
    });
    tab.el.replaceChildren(shown); startPage(tab);
  }
  function nativeEvents(tab, view) {
    const listen = (name, run, options) => view.addEventListener(name, event => { if (tab.view === view) run(event); }, options);
    listen('dom-ready', () => { if (tab === tab.pane.front) toFront(tab, { human: false }); }, { once: true });
    const moved = event => { tab.url = event.url; tab.favicon = ''; startPage(tab); follow(tab); paint(tab.pane); };
    listen('did-navigate', moved);
    listen('did-navigate-in-page', event => { if (event.isMainFrame) moved(event); });
    listen('page-title-updated', event => { tab.title = event.title; label(tab, event.title); });
    listen('did-start-loading', () => { tab.loading = true; paint(tab.pane); });
    listen('did-stop-loading', () => {
      tab.loading = false;
      if (tab !== tab.pane.front) tab.unread = true;
      startPage(tab); paint(tab.pane);
    });
    listen('page-favicon-updated', event => { tab.favicon = event.favicons?.[0] || ''; paint(tab.pane); });
  }

  // The bar follows the tab in front: its address, and whether it can go back.
  function follow(tab, forceAddress = false) {
    const { pane } = tab;
    if (tab !== pane.front) return;
    if (pane.name) pane.name.textContent = tab.label;
    startPage(tab);
    if (!pane.address) return;
    pane.address.disabled = Boolean(tab.live);
    pane.address.readOnly = Boolean(tab.concept);
    if (forceAddress || document.activeElement !== pane.address) pane.address.value = where(tab.url);
    pane.address.title = tab.title ?? '';
    if (pane.back) try { pane.back.disabled = !tab.view.canGoBack(); pane.forward.disabled = !tab.view.canGoForward(); } catch { pane.back.disabled = pane.forward.disabled = true; }
  }
  function label(tab, text) {
    if (text && text !== tab.label && tab !== tab.pane.front) tab.unread = true;
    tab.label = text || tab.label;
    follow(tab);
    paint(tab.pane);
  }

  // A tab brought to the front; if the browser had the keys, the tab has
  // them now. The desktop window is told which the person has in front.
  function toFront(tab, { human = true } = {}) {
    const pane = tab?.pane;
    if (!pane?.tabs.includes(tab)) return;
    const keys = human && hasKeys(pane);
    if (pane.front !== tab) { pane.front?.el.classList.remove('front'); pane.front?.live?.conceal(true); }
    pane.front = tab;
    tab.el.classList.add('front');
    tab.unread = false;
    tab.live?.conceal(false);
    follow(tab, human);
    paint(pane);
    if (keys && document.activeElement !== pane.address && !pane.strip.el.contains(document.activeElement)) pageOf(tab)?.focus?.();
    const id = idOf(tab);
    if (id != null) desk?.front?.(id);
  }
  // Select the tab before or after the one in front, round and round.
  function flick(step) {
    const pane = paneOf();
    if (pane?.front?.live) return pane.front.live.flick(step);
    const tabs = pane?.tabs ?? [];
    if (tabs.length < 2) return false;
    toFront(tabs[(tabs.indexOf(tabs[0].pane.front) + step + tabs.length) % tabs.length]);
    return true;
  }

  // A tab loaded again, as it is now. A page in a frame is made afresh:
  // sent to its address again, it would be a step back takes.
  function reload(tab) {
    if (tab.preview && (tab.live || (!tab.view && !tab.src))) { void loadPreview(tab, true); return; }
    tab.stale = false;
    paint(tab.pane);
    if (tab.view) tab.view.reload();
    else if (tab.src) frame(tab, tab.src);
  }

  function closeTab(tab, { human = true } = {}) {
    const pane = tab?.pane;
    if (!pane?.tabs.includes(tab)) return false;
    const keys = human && hasKeys(pane);
    dispose(tab);
    pane.tabs.splice(pane.tabs.indexOf(tab), 1);
    held.paint(pane.tabs);
    // The last guest stays drawn, inert inside its closing pane, until the
    // pane's exit finishes. Removing it first would fade an empty window.
    if (!pane.tabs.length) { wm.close(pane.win); return true; }
    tab.el.remove();
    if (pane.front === tab) {
      pane.front = null;
      toFront(pane.tabs.at(-1), { human });
      if (keys) pageOf(pane.front)?.focus?.();
    }
    paint(pane);
    return true;
  }

  // A tab for a thing: an address, a local address or a file. In front
  // unless asked otherwise; the browser opens to hold it if it is not open.
  // As it is: an address the desktop window asked for (a website, or any
  // other), loaded just as it is. project: the project whose page it is.
  function open(target, { behind = false, asItIs = false, base: from = base(), project, remoteTab, remoteURL } = {}) {
    const site = asItIs || target === 'about:blank' || address(target) ? target : '';
    const pane = paneOf() ?? mountPane({ quiet: behind });
    const tab = { pane, key: ++browserKey, target, url: remoteURL ?? target, title: '', label: target === 'about:blank' ? 'New tab' : project?.name || shownName(target) || 'New tab', project, unread: behind };
    tab.el = make('div', 'browser-page');
    pane.stack.append(tab.el);
    pane.tabs.push(tab);
    label(tab);
    if (!behind || !pane.front) toFront(tab);
    if (!behind) wm.show(pane.win);
    tab.base = from;
    tab.remoteTab = remoteTab;
    if (project) held.paint(pane.tabs);
    // Kinso's concept is a visitor-side document, even in a desktop shell.
    // Never resolve it through shown/view, a native webview or a live watcher.
    if (brand.id === 'kinso' && target === KINSO_CONCEPT) {
      tab.concept = true; tab.url = KINSO_CONCEPT;
      // Fetch fresh concept response headers without changing its canonical
      // address, Sites target or Shop matching (older HTML cached CSP for a day).
      tab.src = `${KINSO_CONCEPT}?v=kinso-embed-1`;
      frame(tab, tab.src); follow(tab); paint(pane);
      return tab;
    }
    const preview = remoteTab !== undefined || (!asItIs && target !== 'about:blank' && inBrowser(target) && (!address(target) || Boolean(shownAt(target)) || browserLocal(target)));
    if (preview) {
      tab.preview = true;
      void loadPreview(tab);
      return tab;
    }
    const at = site ? Promise.resolve(site) : addressFor(target, from);
    if (desk) {
      const view = tab.view = make('webview');
      nativeEvents(tab, view);
      view.setAttribute('allowpopups', '');
      // A <webview> needs a whole address, the window's own pages too; one
      // known now is its address as it arrives (main.mjs knows it by that).
      if (site) view.src = site;
      tab.el.append(view);
      if (!site) at.then(src => { tab.url = view.src = src; follow(tab); },
        error => tab.el.replaceChildren(make('p', 'gui-window-error', `${tab.label}: ${error.message}`)));
    } else {
      at.then(src => { if (!pane.tabs.includes(tab)) return; tab.url = tab.src = src; frame(tab, src); follow(tab); paint(pane); },
        error => tab.el.replaceChildren(make('p', 'gui-window-error', `${tab.label}: ${error.message}`)));
    }
    return tab;
  }
  function dispose(tab) {
    tab.turn = (tab.turn || 0) + 1;
    clearTimeout(tab.drivingEnds);
    tab.live?.stop(); tab.live = null; tab.view = null; tab.src = null; tab.start = null;
  }
  async function loadPreview(tab, reload = false) {
    dispose(tab);
    paint(tab.pane);
    const turn = tab.turn;
    if (reload) tab.remoteTab = undefined;
    tab.el.replaceChildren(make('p', 'gui-window-error', 'Opening preview…'));
    try {
      // Restoring a known browser identity uses its authenticated watch
      // directly. The original shown app may be closed/deleted; do not
      // recreate it merely to reconnect to another site or an empty browser.
      let answer = tab.remoteTab !== undefined
        ? { stream: true, url: tab.url, tab: tab.remoteTab }
        : await viewFor(tab.target, tab.base, { reload });
      if (turn !== tab.turn || !tab.pane.tabs.includes(tab)) return;
      if (answer.stream && tab.stale && !reload) answer = await viewFor(tab.target, tab.base, { reload: true });
      if (turn !== tab.turn || !tab.pane.tabs.includes(tab)) return;
      if (tab.remoteTab === undefined || !answer.stream) tab.url = answer.url;
      tab.stale = false;
      if (answer.stream) {
        if (tab.remoteTab === undefined) tab.previewTab = answer.tab;
        const view = tab.live = mountLive({ tab: tab.remoteTab !== undefined ? tab.remoteTab : answer.tab, browser: true, resume: tab.remoteTab !== undefined, full: () => wm.full(tab.pane.win),
          onLocation: current => {
            if (turn !== tab.turn || !tab.pane.tabs.includes(tab)) return;
            tab.url = current?.url || 'about:blank';
            tab.title = current?.title || '';
            tab.label = tab.title || (tab.url === 'about:blank' ? 'New tab' : shownName(tab.url));
            follow(tab); paint(tab.pane);
          }, onExpired: () => {
          tab.stale = true; paint(tab.pane);
          const retry = make('button', '', 'Retry preview');
          retry.type = 'button'; retry.onclick = () => { void loadPreview(tab, true); };
          view.body.append(retry);
        } });
        view.bar.classList.add('browser-remote-chrome');
        view.watch(tab.base);
        view.conceal(tab !== tab.pane.front);
        tab.el.replaceChildren(view.body);
      } else if (desk) {
        const view = tab.view = make('webview');
        nativeEvents(tab, view);
        view.setAttribute('allowpopups', '');
        view.src = answer.url;
        tab.el.replaceChildren(view);
      } else {
        tab.src = answer.url;
        frame(tab, answer.url, kindOf(tab.target));
      }
      follow(tab); paint(tab.pane);
    } catch (error) {
      if (turn !== tab.turn || !tab.pane.tabs.includes(tab)) return;
      const retry = make('button', '', 'Retry');
      retry.type = 'button'; retry.onclick = () => { void loadPreview(tab, true); };
      tab.el.replaceChildren(make('p', 'gui-window-error', `Can't open ${tab.label}: ${error.message}`), retry);
    }
  }
  // One already open is brought to the front rather than opened twice.
  const find = (target, from = base()) => paneOf()?.tabs.find(tab => tab.target === target && tab.base === from);
  // Behind: what an agent shows, which takes nobody's eyes or keys.
  function show(target, options = {}) {
    if (brand.id === 'kinso' && target === KINSO_CONCEPT) return revealConcept({ quiet: Boolean(options.behind) });
    if (onApp && !options.checkedApp && /^https?:\/\//i.test(target)) {
      return Promise.resolve(onApp(target, { base: options.base ?? base(), quiet: Boolean(options.behind) }))
        .then(opened => opened ? true : show(target, { ...options, checkedApp: true }));
    }
    if (/^(\/|~\/)/.test(target) && viewOf(target) === 'page') {
      return onFolder(target, { base: options.base ?? base(), quiet: Boolean(options.behind), refresh: Boolean(options.behind) });
    }
    // Local folders and their index pages belong in Workbench.
    if (!options.resolved && /^(\/|~\/)/.test(target) && !viewOf(target)) {
      const from = options.base ?? base();
      return fetch(`${from}/shown/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: target }) })
        .then(async res => { const got = await res.json(); if (!res.ok) throw new Error(got.error || `${res.status}`);
          if (got.kind === 'folder' || got.kind === 'page') return onFolder(got.path, { base: from, quiet: Boolean(options.behind), refresh: Boolean(options.behind) });
          return show(got.url || got.path, { ...options, resolved: true }); });
    }
    const known = find(target, options.base);
    if (!known) return open(target, options);
    if (options.behind) { paint(known.pane); return known; }
    toFront(known);
    wm.show(known.pane.win);
    return known;
  }
  // What an agent has just shown, from whichever session: open behind, or
  // left where it is, marked changed (an agent shows a thing again after
  // changing it), for the person to load again when they choose.
  function shown(target, from) {
    const known = find(target, from);
    if (known) {
      known.stale = true;
      if (known.live?.expired && known.live.tab === known.previewTab) void loadPreview(known, true);
      else if (known.live) {
        const turn = known.turn;
        // Re-show refreshes the original page behind the person's mutable
        // pin. It must not replace their watcher or select that page again.
        void viewFor(known.target, known.base, { reload: true }).then(() => {
          if (!known.pane.tabs.includes(known) || known.turn !== turn) return;
          known.stale = Boolean(known.live?.expired); paint(known.pane);
        }, () => { if (known.pane.tabs.includes(known)) paint(known.pane); });
      }
    }
    return show(target, { base: from, behind: true });
  }

  // A project's page: its server started (or still running), and its page
  // in a tab in front, or the tab already showing it.
  async function project(name, { base: from = base() } = {}) {
    if (onProject) return onProject(name, { base: from });
    const known = paneOf()?.tabs.find(tab => tab.project?.name === name && tab.base === from);
    if (known) { toFront(known); wm.show(known.pane.win); return known; }
    const { url } = await startProject(name, from);
    return open(url, { base: from, project: { name } });
  }
  // The projects this window's tabs show, told to the computers that run
  // them while they do; a project no tab shows stops a while after
  // (system/projects.mjs).
  const held = holdProjects();
  // A website's own tab, in front with the keys: the one already on its
  // site, or a new one.
  const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };
  function visit(url) {
    const host = hostOf(url);
    const on = paneOf()?.tabs.find(tab => hostOf(tab.url) === host || hostOf(tab.url).endsWith(`.${host}`));
    const tab = on ?? open(url, { asItIs: true });
    toFront(tab);
    wm.show(tab.pane.win);
    pageOf(tab)?.focus?.();
    return tab;
  }

  // The person's own link: what it opens in the browser comes into view.
  const followed = target => Promise.resolve(show(target)).then(tab => { if (tab?.pane) wm.reveal(tab.pane.win, true); });
  output.addEventListener('click', event => {
    const link = event.target.closest?.('a[data-page], a[data-file]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    followed(link.dataset.file || link.dataset.page);
  });
  output.addEventListener('keydown', event => {
    const link = event.target.closest?.('a[data-file]');
    if (link && event.key === 'Enter') { event.preventDefault(); followed(link.dataset.file); }
  });

  // The desktop window asks for tabs too (desktop/electron/main.mjs): a
  // website followed from anywhere in it, and what an agent's `browser`
  // opens, behind, and brings to the front or closes; and while an agent
  // is using a tab, the tab says so.
  desk?.onBrowse(({ url, behind }) => open(url, { behind, asItIs: true }));
  desk?.onTab(({ id, do: action }) => {
    const tab = byId(id);
    if (!tab) return;
    // An agent may choose which browser tab is presented, not which pane
    // the person is looking at. Only a human selection reveals the column.
    if (action === 'front') toFront(tab, { human: false });
    else if (action === 'reveal') {
      toFront(tab, { human: false });
      wm.show(tab.pane.win);
      wm.reveal(tab.pane.win);
    } else if (action === 'close') closeTab(tab, { human: false });
    else if (action === 'driving') {
      tab.driving = true;
      clearTimeout(tab.drivingEnds);
      tab.drivingEnds = setTimeout(() => { tab.driving = false; paint(tab.pane); }, 4000);
      paint(tab.pane);
    }
  });

  // On a phone or a hosted computer's page, a computer's browser, live: one
  // panel, following the computer the agent's browser is on; behind unless
  // an agent brings a tab to the front for the person. Back closes it; the
  // browser there stays as it is. The desktop window has a browser of its own.
  let live = null;
  function watch(from = base(), { quiet = true, remote = false } = {}) {
    if (brand.id === 'kinso') return revealConcept({ quiet });
    if (desk && !remote) return;
    // An explicitly opened home browser stays there when another agent emits
    // browser activity. This does not change that agent's browser target.
    if (live?.pinned && quiet && from !== live.view.base) return;
    if (!live) {
      const view = mountLive({ full: () => wm.full(live.win) });
      const el = make('div', 'gui-window browser filling');
      el.append(view.bar, view.body);
      live = { view };
      live.win = wm.open({ kind: 'live', body: el, bar: view.bar, quiet, keys: view.keys, onClose: () => { view.stop(); live = null; } });
    } else if (!quiet) wm.show(live.win);
    live.view.watch(from);
  }

  // Explicit human launch (the browser button, MOD+Shift+B) reuses the
  // current browser, unlike a new-tab command. The desktop window is a
  // computer with a screen and keyboard of its own: its own browser, here,
  // signed in with the window's profile, a blank tab with the address waiting
  // if none is open. A phone or a browser page shows the home computer's
  // browser live (launchBase), for this human command only: what agents open
  // keeps its own computer.
  let launching = null;
  function launch() {
    if (brand.id === 'kinso') return portal();
    if (desk) {
      if (!launchAllowed()) return Promise.resolve();
      const pane = paneOf();
      if (!pane) browse();
      const current = paneOf();
      wm.show(current.win);
      wm.reveal(current.win);
      if (!pane) current.address?.focus();
      return Promise.resolve();
    }
    return portal();
  }

  // The dock's portal always watches the home PC, even in a laptop's
  // desktop window. The browser shortcut above remains local there.
  function portal() {
    if (brand.id === 'kinso') {
      if (launchAllowed()) revealConcept();
      return Promise.resolve();
    }
    if (launching) return launching;
    launching = Promise.resolve().then(() => launchBase ? launchBase() : live?.view.base ?? base()).then(from => {
      if (!launchAllowed()) return;
      watch(from, { quiet: false, remote: true });
      live.pinned = true;
      wm.reveal(live.win);
      live.view.launch();
    }).catch(onLaunchError).finally(() => { launching = null; });
    return launching;
  }

  // The launch sequence watches the real serving computer, not a web iframe
  // of Google. Reuse its Google tab across visits; never navigate a person's
  // unrelated tab or accumulate one per visitor. The ordinary live transport
  // remains responsible for on-demand start, visibility and error states.
  const askLaunchBrowser = async request => {
    const response = await fetch('/browser', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(30000) });
    const answer = await response.json();
    if (!response.ok || answer.error) throw new Error(answer.error || `Browser unavailable (${response.status})`);
    return answer;
  };
  function revealLaunchBrowser() {
    watch('', { quiet: false, remote: true });
    live.pinned = true;
    wm.reveal(live.win);
    return live.view;
  }
  let assemblingBrowser = null, openingShop = null;
  const shop = { tab: null };
  // Reuse the ordinary pane/tab lifecycle, including Sites, reload, close
  // and fullscreen. Reopening the concept does not reload or duplicate it.
  function revealConcept({ quiet = false } = {}) {
    const known = find(KINSO_CONCEPT, '');
    const tab = known ?? open(KINSO_CONCEPT, { base: '', behind: quiet });
    if (!quiet) { toFront(tab); wm.show(tab.pane.win); wm.reveal(tab.pane.win); }
    return tab;
  }
  function assembleBrowser() {
    if (brand.id === 'kinso') { revealConcept(); return Promise.resolve(); }
    if (assemblingBrowser) return assemblingBrowser;
    revealLaunchBrowser();
    assemblingBrowser = prepareLaunchBrowser(askLaunchBrowser);
    return assemblingBrowser;
  }
  function openShop(value) {
    const url = launchShopURL(value);
    if (!url) return Promise.reject(new Error('Only the public Shop can be opened'));
    if (brand.id === 'kinso') {
      if (url !== KINSO_CONCEPT) return Promise.reject(new Error('Only the Kinso concept can be opened'));
      revealConcept(); return Promise.resolve();
    }
    if (openingShop) return openingShop;
    revealLaunchBrowser();
    // This existing live pane follows the serving browser's front, exactly
    // as the Google assembly does. Immutable scoped previews are untouched.
    openingShop = prepareLaunchShop(askLaunchBrowser, url, shop).finally(() => { openingShop = null; });
    return openingShop;
  }

  // Ctrl+T and + always create a tab, even when the current one is blank.
  function browse() {
    if (brand.id === 'kinso') { revealConcept(); return; }
    const pane = paneOf(), remote = pane?.front?.live;
    if (remote) { wm.show(pane.win); wm.reveal(pane.win, true); remote.newTab(); return; }
    localTab();
  }
  function localTab() {
    const tab = open('about:blank');
    toFront(tab);
    wm.show(tab.pane.win);
    wm.reveal(tab.pane.win, true);
    tab.pane.address?.focus({ preventScroll: true });
  }
  return {
    open: show, shown, project, browse, launch, portal, visit, flick, watch, assembleBrowser, openShop,
    newTab: () => wm.focused?.()?.kind === 'live' && live ? live.view.newTab() : browse(),
    closeFront: () => {
      const focused = wm.focused?.();
      if (focused && !['browser', 'live'].includes(focused.kind)) return false;
      if (focused?.kind === 'live' && live) return live.view.closeFront();
      const tab = paneOf()?.front;
      return tab?.live ? tab.live.closeFront() : closeTab(tab);
    },
    front: () => desk?.front?.(idOf(paneOf()?.front)),
    tabs: () => paneOf()?.tabs.slice() ?? [],
    // The sidebar's Sites: every page open, and bringing one to the front.
    sites: () => (paneOf()?.tabs ?? []).map(tab => ({ key: tab.key, name: tab.title || tab.label || 'New tab', url: tab.url || tab.target || '', favicon: tab.favicon || '', front: tab === paneOf().front, unread: Boolean(tab.unread || tab.stale) })),
    closeSite: key => {
      const tab = paneOf()?.tabs.find(item => item.key === key);
      if (tab) closeTab(tab);
    },
    select: key => {
      const tab = paneOf()?.tabs.find(item => item.key === key);
      if (!tab) return;
      toFront(tab);
      wm.show(tab.pane.win);
      wm.reveal(tab.pane.win, true);
    },
    // A project's tab is kept as its project, whose server may have moved on.
    at: win => (win.pane ? win.pane.tabs.map(tab => (tab.project ? { project: tab.project.name, base: tab.base } : tab.live ? { target: tab.url || 'about:blank', base: tab.base, stream: true, preview: tab.target, tab: tab.live.tab } : tab.url || tab.target))
      : win === live?.win ? [{ live: live.view.base }] : []),
    reopen: at => {
      for (const target of [].concat(at)) {
        if (typeof target?.live === 'string') watch(target.live, { remote: true });
        else if (target?.project) project(target.project, { base: target.base }).catch(() => {});
        else if (typeof target?.target === 'string') open(target.preview ?? target.target, { base: target.base, remoteTab: target.tab, remoteURL: target.target });
        else if (target) open(target);
      }
    },
  };
}
