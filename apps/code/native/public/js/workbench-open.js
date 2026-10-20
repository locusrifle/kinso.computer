// A file, open in Workbench, in place of the folder (workbench-view.js):
// pictures whole and fitted, with the folder's others before and after;
// Markdown as a page (markdown.js); text and code as text; video, sound and
// PDFs in the browser's own player and viewer; an HTML page or app playing,
// from where the computer it is on serves it (pages.js addressFor); anything
// else, what it is. Everything is read through the computer it is on
// (system/files.mjs: /files/peek, /files/raw). A Markdown or .txt file of
// the person's own can be edited in place (workbench-edit.js), and is shown
// as a page again, as saved, when that is done. Any file open can be
// downloaded as it is on its computer (/files/raw?download=1); on a Mac,
// one with no preview here opens in its app there (workbench-mac.js).
//
// Each of Workbench's tabs has its own: concealed, a tab behind keeps what
// it shows as it is (a page goes on playing; what plays out loud pauses).
//
//   const viewer = mountViewer({ doc, host, base, mac, onOpen, onChange });
//   await viewer.show(file, { pictures })   file: { path, name }; pictures: the folder's, in order
//   viewer.step(±1)   viewer.hide()   viewer.conceal(on)   viewer.remove()   viewer.isOpen()   viewer.file()   viewer.kind()
//   viewer.editable()   viewer.editing()   viewer.edit()   viewer.done()
//   viewer.unsaved()   viewer.save() -> whether nothing is left unsaved   viewer.trouble()
//   viewer.download()   the file open, { path, name } to download, or null (an app, a folder, an error)
//
// onOpen(path) is a Markdown link to another file or folder; show() is false
// when the path is not a file, for the caller to open it as a folder.
// onChange() is another file shown, by the viewer itself (the next picture).
// onEdit() is editing begun or done.

import { renderMarkdown } from './markdown.js';
import { viewFor } from './pages.js';
import { mountLive } from './live.js';
import { openEditor } from './workbench-edit.js';
import { phone } from './windows.js';

const TEXT_LIMIT = 1 << 20;
const PICTURE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;
const PAGE = /\.html?$/i;

function size(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i += 1; }
  return i === 0 ? `${n} bytes` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
const folderOf = path => path.replace(/\/[^/]*$/, '') || '/';
// A link's address, against the folder of the page it is in.
function beside(href, page) {
  const clean = href.split(/[?#]/)[0];
  if (!clean) return null;
  let decoded;
  try { decoded = decodeURIComponent(clean); } catch { return null; }
  const parts = decoded.startsWith('/') ? [] : folderOf(page).split('/').filter(Boolean);
  for (const part of decoded.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}${clean.endsWith('/') && parts.length ? '/' : ''}`;
}

export function mountViewer({ doc, host, base, mac = null, onOpen = () => {}, onChange = () => {}, onEdit = () => {} }) {
  const view = doc.createElement('section');
  view.className = 'workbench-view';
  view.hidden = true;
  view.innerHTML = '<div class="workbench-view-body"></div><p class="workbench-view-line"></p>';
  host.append(view);
  const body = view.querySelector('.workbench-view-body'), line = view.querySelector('.workbench-view-line');
  const state = { file: null, kind: null, pictures: [], turn: 0, concealed: false, live: null, refresh: null, refreshPending: false,
    editable: false, editor: null, opening: false, facts: '', found: null };
  const dispose = () => {
    state.live?.stop(); state.live = null; state.refresh = null; state.refreshPending = false;
    const editing = Boolean(state.editor || state.opening);
    state.editor?.close(); state.editor = null; state.opening = false; state.editable = false;
    if (editing) onEdit();
  };
  const raw = path => `${base()}/files/raw?path=${encodeURIComponent(path)}`;
  const tell = text => { line.textContent = text; line.hidden = !text; };

  async function peek(path) {
    const res = await fetch(`${base()}/files/peek?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(answer.error || `the computer said ${res.status}`), { status: res.status });
    return answer;
  }
  // The start of a text file, at most TEXT_LIMIT of it.
  async function text(path) {
    const res = await fetch(raw(path), { cache: 'no-store', headers: { range: `bytes=0-${TEXT_LIMIT - 1}` } });
    if (!res.ok && res.status !== 416) throw new Error(`the computer said ${res.status}`);
    return res.status === 416 ? '' : res.text();
  }
  const element = (tag, props = {}) => Object.assign(doc.createElement(tag), props);
  // Text as itself, Markdown as a page.
  function paintText(kind, content, path) {
    body.className = `workbench-view-body workbench-view-${kind}`;
    if (kind === 'text') { body.replaceChildren(element('pre', { textContent: content })); return; }
    const page = element('article', { className: 'workbench-page' });
    page.innerHTML = renderMarkdown(content, { file: href => beside(href, path), raw });
    body.replaceChildren(page);
  }

  async function show(file, { pictures = [], reload = false } = {}) {
    const turn = ++state.turn;
    dispose();
    view.hidden = state.concealed;
    state.file = file; state.found = null;
    state.pictures = pictures.length ? pictures : PICTURE.test(file.path) ? [file] : [];
    body.replaceChildren();
    body.className = 'workbench-view-body';
    tell(file.name);
    let found;
    try { found = await peek(file.path); }
    catch (error) {
      if (turn !== state.turn) return true;
      if (error.status === 404 && /isn't a file/.test(error.message)) return false;
      state.kind = 'error';
      body.append(element('p', { className: 'workbench-view-message', textContent: error.message }));
      return true;
    }
    if (turn !== state.turn) return true;
    const kind = PAGE.test(found.name) ? 'page' : found.kind;
    state.kind = kind;
    state.found = { path: found.path, name: found.name };
    state.file = { ...file, size: found.size, mtime: found.mtime };
    body.classList.add(`workbench-view-${kind}`);
    const facts = [found.name, size(found.size)];
    if (kind === 'page' || kind === 'pdf') {
      const refresh = () => { void show(file, { pictures, reload: true }); };
      try {
        let answer = await viewFor(found.path, base(), { reload });
        if (turn !== state.turn) return true;
        if (answer.stream && state.refreshPending && !reload) answer = await viewFor(found.path, base(), { reload: true });
        if (turn !== state.turn) return true;
        // The non-hosted PDF viewer keeps its existing Files raw route.
        play(!answer.stream && kind === 'pdf' ? { ...answer, url: raw(found.path) } : answer, found.name, turn, refresh);
      } catch (error) {
        if (turn !== state.turn) return true;
        body.replaceChildren(element('p', { className: 'workbench-view-message', textContent: `Can't open this preview: ${error.message}` }));
      }
      if (turn === state.turn) { tell(facts.filter(Boolean).join(' · ')); retry(refresh); }
      return true;
    } else if (found.kind === 'image') {
      const at = state.pictures.findIndex(picture => picture.path === file.path);
      if (state.pictures.length > 1 && at >= 0) facts.push(`${at + 1} of ${state.pictures.length}`);
      body.append(element('img', { src: raw(found.path), alt: found.name, decoding: 'async' }));
    } else if (found.kind === 'video') {
      body.append(element('video', { src: raw(found.path), controls: true, preload: 'metadata' }));
    } else if (found.kind === 'audio') {
      body.append(element('audio', { src: raw(found.path), controls: true, preload: 'metadata' }));
    } else if (found.kind === 'markdown' || found.kind === 'text') {
      let content;
      try { content = await text(found.path); }
      catch (error) { if (turn === state.turn) body.append(element('p', { className: 'workbench-view-message', textContent: `Can't read this file: ${error.message}` })); return true; }
      if (turn !== state.turn) return true;
      if (found.size > TEXT_LIMIT) facts.push(`showing the first ${size(TEXT_LIMIT)}`);
      paintText(found.kind, content, found.path);
      state.editable = Boolean(found.editable) && found.size <= TEXT_LIMIT;
    } else {
      const ext = /\.([^./]{1,8})$/.exec(found.name)?.[1];
      const what = found.type ?? (ext ? `${ext.toUpperCase()} file` : 'Unknown type');
      body.append(element('div', { className: 'workbench-view-message' }));
      body.lastChild.append(element('p', { textContent: 'No preview for this file' }), element('p', { className: 'workbench-view-facts', textContent: `${size(found.size)} · ${what}` }));
      // On a Mac, in the app it opens in there, or in Finder.
      const buttons = mac?.buttons(doc, found.path, { tell }) ?? [];
      if (buttons.length) { const actions = element('p', { className: 'workbench-view-actions' }); actions.append(...buttons); body.lastChild.append(actions); }
    }
    state.facts = facts.filter(Boolean).join(' · ');
    tell(state.facts);
    body.scrollTop = 0;
    return true;
  }

  // --- editing a text file in place (workbench-edit.js) ---------------------
  // Begun where the page was scrolled to; on a phone the keyboard waits for
  // a tap where the words are to go.
  async function edit() {
    if (!state.editable || state.editor || state.opening) return;
    const turn = state.turn, file = state.file;
    const room = body.scrollHeight - body.clientHeight;
    const at = room > 0 ? body.scrollTop / room : 0;
    state.opening = true;
    onEdit();
    let editor;
    try {
      editor = await openEditor({ doc, base: base(), file, line,
        onDone: ({ discard }) => { if (state.editor === editor) void done({ discard }); } });
    } catch (error) {
      if (turn !== state.turn) return;
      state.opening = false;
      tell(`${state.facts} · Can't edit this: ${error.message}`);
      onEdit();
      return;
    }
    if (turn !== state.turn || !state.opening) { editor.close(); return; }
    state.opening = false;
    state.editor = editor;
    body.className = 'workbench-view-body workbench-view-edit';
    body.replaceChildren(editor.area);
    editor.paint();
    editor.place(at);
    if (!phone() && !state.concealed) editor.focus();
    onEdit();
  }
  // Editing done: saved, then the page again, as saved. What could not be
  // saved keeps the editor, the line saying why, unless it is let go of.
  async function done({ discard = false } = {}) {
    const editor = state.editor;
    // Done before the text came: never begun.
    if (!editor) { if (state.opening) { state.opening = false; tell(state.facts); onEdit(); } return true; }
    if (!discard && !await editor.save()) { if (state.editor === editor) editor.focus(); return false; }
    if (state.editor !== editor) return true;
    const file = state.file, room = body.scrollHeight - body.clientHeight;
    const at = room > 0 ? editor.area.scrollTop / room : 0;
    state.editor = null;
    editor.close({ discard });
    // Let go of, or changed on disk: the file as it is there now.
    if (discard || editor.stale()) { await show(file); onEdit(); return true; }
    paintText(state.kind, editor.text(), file.path);
    state.file = { ...file, size: editor.size() };
    state.facts = [file.name, size(editor.size())].join(' · ');
    tell(state.facts);
    body.scrollTop = at * Math.max(0, body.scrollHeight - body.clientHeight);
    onEdit();
    return true;
  }

  function retry(run) {
    const button = element('button', { type: 'button', textContent: 'Retry / reload' });
    button.onclick = run;
    line.append(' ', button);
  }
  function play(answer, name, turn, refresh, app = false) {
    if (answer.stream) {
      const live = state.live = mountLive({ tab: answer.tab, onExpired: () => {
        if (turn !== state.turn) return;
        tell(`${name} · Preview expired. Retry to open it again.`);
        retry(refresh);
      } });
      state.refresh = refresh;
      live.watch(base());
      live.conceal(state.concealed);
      // The fixed stream has no browser tab strip or address bar of its own.
      live.body.style.height = '100%';
      body.replaceChildren(live.body);
    } else {
      const url = new URL(answer.url, doc.location.href);
      if (!/^https?:$/.test(url.protocol) || (app && url.origin === doc.location.origin)) throw new Error('App must have its own page origin');
      const frame = element('iframe', { title: name, src: answer.url });
      if (app) frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock');
      frame.setAttribute('allow', 'autoplay; fullscreen; microphone; camera; gamepad');
      body.replaceChildren(frame);
    }
  }

  // A server-backed app uses the same isolated Files viewer. Resolve again on
  // retry: a project's port can change while its identity stays the same.
  async function app(identity, resolve, { reload = false } = {}) {
    const turn = ++state.turn;
    dispose();
    state.file = identity; state.found = null;
    state.kind = 'page'; state.pictures = [];
    view.hidden = state.concealed;
    body.className = 'workbench-view-body workbench-view-page';
    body.replaceChildren();
    tell('Starting…');
    try {
      const src = await resolve();
      if (turn !== state.turn) return;
      const answer = await viewFor(src, base(), { reload });
      if (turn !== state.turn) return;
      play(answer, identity.name, turn, () => { void app(identity, resolve, { reload: true }); }, true);
      tell(identity.name);
    } catch (error) {
      if (turn !== state.turn) return;
      body.replaceChildren(element('p', { className: 'workbench-view-message', textContent: `Can't open ${identity.name}: ${error.message}` }));
      tell(identity.name);
    }
    if (turn !== state.turn) return;
    retry(() => { void app(identity, resolve, { reload: true }); });
  }

  // Links in a page: another file opens here, a place in the page is scrolled to.
  body.addEventListener('click', event => {
    const link = event.target.closest?.('a');
    if (!link || !body.contains(link)) return;
    if (link.dataset.anchor !== undefined) {
      event.preventDefault();
      body.querySelector(`[id="${CSS.escape(link.dataset.anchor)}"]`)?.scrollIntoView({ block: 'start' });
    } else if (link.dataset.path) {
      event.preventDefault();
      onOpen(link.dataset.path);
    }
  });

  function step(by) {
    if (state.kind !== 'image' || state.pictures.length < 2) return false;
    const at = state.pictures.findIndex(picture => picture.path === state.file.path);
    const next = state.pictures[(at + by + state.pictures.length) % state.pictures.length];
    const shown = show(next, { pictures: state.pictures });
    // Its path at once; what it offers (Download) once it is known.
    onChange();
    void shown.then(() => onChange());
    return true;
  }
  // A swipe across a picture, on a phone, is the next or the one before.
  let swipe = null;
  body.addEventListener('pointerdown', event => { if (event.pointerType !== 'mouse') swipe = { x: event.clientX, y: event.clientY }; });
  body.addEventListener('pointerup', event => {
    if (!swipe) return;
    const dx = event.clientX - swipe.x, dy = event.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  });
  body.addEventListener('pointercancel', () => { swipe = null; });

  function hide() {
    state.turn += 1;
    dispose();
    state.file = null; state.kind = null; state.found = null;
    // Stop whatever plays, and let go of what was being fetched.
    for (const media of body.querySelectorAll('video, audio')) { media.pause(); media.removeAttribute('src'); media.load(); }
    body.replaceChildren();
    view.hidden = true;
  }
  // Out of sight with its tab, what it shows kept; sound and video pause.
  function conceal(on) {
    state.concealed = Boolean(on);
    state.live?.conceal(on);
    if (on) for (const media of body.querySelectorAll('video, audio')) media.pause();
    view.hidden = state.concealed || !state.file;
  }
  return {
    show, app, step, hide, conceal, edit, done,
    editable: () => state.editable,
    download: () => state.found,
    editing: () => Boolean(state.editor || state.opening),
    unsaved: () => Boolean(state.editor?.unsaved()),
    save: async () => (state.editor ? state.editor.save() : true),
    trouble: () => state.editor?.trouble() ?? '',
    focusEditor: () => state.editor?.focus(),
    refreshHosted() { if (state.refresh) state.refresh(); else state.refreshPending = true; },
    // Gone with its tab.
    remove() { hide(); view.remove(); },
    isOpen: () => Boolean(state.file),
    isStream: () => Boolean(state.live),
    file: () => state.file,
    kind: () => state.kind,
    pictures: () => state.pictures,
  };
}
