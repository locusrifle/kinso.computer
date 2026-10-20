// A text file being edited in Workbench, in place of its page
// (workbench-open.js): the whole file as plain text, soft wrapped, saved to
// the computer it is on (system/file-text.mjs) a moment after the typing
// stops, with Mod+S, and when it is put away. A save names the version the
// text was edited from, so a file changed on disk meanwhile is never saved
// over unasked: the line says so, with Reload (the file as it is on disk
// now, this text let go) and Overwrite (this text over it).
//
//   const editor = await openEditor({ doc, base, file, line, onDone });
//   editor.area        the textarea, for the viewer to place
//   editor.paint()     the line says its state, from now on
//   editor.text()      the text as it is now
//   editor.size()      its size on disk, as last saved
//   editor.unsaved()   whether any of it is not on disk yet (or being sent)
//   editor.trouble()   why the last save failed, or ''
//   editor.save()      -> whether all of it is on disk now
//   editor.place(at)   scrolled to a fraction of the way down, the caret there
//   editor.stale()     whether the file on disk is not the text here (a change
//                      on disk, chosen about or not)
//   editor.focus()     editor.close({ discard })
//
// line is the viewer's line under the file, which it says its state in.
// onDone({ discard }) is Escape, or Discard after a save that failed.
// Closed, what is still unsaved is sent anyway (never over a change on
// disk), unless discarded.

import { heldMod } from './pi-card.js';

const PAUSE_MS = 1000;
const SAVE_TIMEOUT_MS = 20_000;
// What a browser lets a request outlive its page with (64 kB), in characters
// that are at most three bytes each.
const KEEPALIVE_LIMIT = 21_000;

async function answerOf(res) {
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body, error: body.error || `the computer said ${res.status}` };
}

export async function openEditor({ doc, base, file, line, onDone = () => {} }) {
  const url = `${base}/files/text?path=${encodeURIComponent(file.path)}`;
  const opened = await answerOf(await fetch(url, { cache: 'no-store' }));
  if (!opened.ok) throw new Error(opened.error);

  // The text area keeps line ends as \n: a file written with \r\n, or
  // starting with a byte-order mark, is saved as it was written.
  let bom = false, crlf = false;
  const shown = text => {
    bom = text.startsWith('\uFEFF');
    crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text);
    return (bom ? text.slice(1) : text).replace(/\r\n/g, '\n');
  };
  const written = text => `${bom ? '\uFEFF' : ''}${crlf ? text.replace(/\n/g, '\r\n') : text}`;

  const area = doc.createElement('textarea');
  area.className = 'workbench-editor';
  area.setAttribute('aria-label', `Editing ${file.name}`);
  area.autocomplete = 'off';
  area.wrap = 'soft';
  area.value = shown(opened.body.text);
  // What is on disk: its version, and the text it holds, as the area has it.
  let version = opened.body.version, saved = area.value, size = opened.body.size;
  // clean: nothing changed yet; then unsaved, saving, saved, failed, conflict.
  let phase = 'clean', reason = '', current = null, sending = null, timer = 0, closed = false, discarded = false;
  const unsaved = () => !closed && (area.value !== saved || Boolean(sending));

  const button = (label, title, run) => {
    const one = doc.createElement('button');
    one.type = 'button'; one.textContent = label; one.title = title;
    one.onclick = event => { event.stopPropagation(); run(); };
    return one;
  };
  const WORDS = { clean: 'Editing', unsaved: 'Unsaved', saving: 'Saving…', saved: 'Saved' };
  function paint() {
    if (closed) return;
    const state = doc.createElement('span');
    state.className = 'workbench-edit-state';
    state.textContent = phase === 'conflict' ? 'Changed on disk since you opened it' : phase === 'failed' ? `Couldn't save: ${reason}` : WORDS[phase];
    const parts = [`${file.name} · `, state];
    if (phase === 'conflict') parts.push(' ',
      button('Reload', 'Show the file as it is on disk now, letting go of the changes here', () => { void reload(); }),
      button('Overwrite', 'Save the text here over the file on disk', () => { void save({ over: current }); }));
    if (phase === 'failed') parts.push(' ',
      button('Retry', 'Try saving again', () => { void save(); }),
      button('Discard', 'Let go of the changes here, and show the file as it is on disk', () => { onDone({ discard: true }); }));
    line.replaceChildren(...parts);
    line.dataset.edit = phase;
    line.hidden = false;
  }

  // One save at a time; one asked for meanwhile waits for it, then sends
  // whatever the text is by then.
  async function save({ over = null, keepalive = false } = {}) {
    clearTimeout(timer); timer = 0;
    while (sending) await sending;
    if (closed && discarded) return false;
    const text = area.value;
    if (text === saved && over === null) {
      if (phase !== 'clean' && phase !== 'saved') { phase = 'saved'; paint(); }
      return true;
    }
    sending = (async () => {
      phase = 'saving'; paint();
      let answer;
      try {
        const body = written(text);
        answer = await answerOf(await fetch(url, {
          method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
          // Going out of sight (a phone putting the app away): sent even if
          // the page is frozen or let go of meanwhile, where it is small enough.
          keepalive: keepalive && body.length < KEEPALIVE_LIMIT,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'if-match': `"${over ?? version}"` },
          body,
        }));
      } catch (error) {
        answer = { ok: false, status: 0, error: error?.name === 'TimeoutError' ? 'the computer did not answer' : error?.message || 'the computer did not answer' };
      }
      if (answer.ok) {
        version = answer.body.version; saved = text; size = answer.body.size; current = null; reason = '';
        phase = area.value === saved ? 'saved' : 'unsaved';
        if (phase === 'unsaved') later();
      } else if (answer.status === 412) {
        phase = 'conflict'; current = answer.body.version ?? null; reason = 'it changed on disk since you opened it';
      } else {
        phase = 'failed'; reason = answer.error;
      }
      paint();
    })();
    try { await sending; } finally { sending = null; }
    return area.value === saved;
  }
  // A save once the typing pauses; none while a change on disk waits to be
  // chosen about.
  function later() {
    clearTimeout(timer);
    timer = phase === 'conflict' ? 0 : setTimeout(() => { timer = 0; void save(); }, PAUSE_MS);
  }
  async function reload() {
    while (sending) await sending;
    let answer;
    try { answer = await answerOf(await fetch(url, { cache: 'no-store' })); }
    catch (error) { answer = { ok: false, error: error?.message || 'the computer did not answer' }; }
    if (closed) return;
    if (!answer.ok) { phase = 'failed'; reason = answer.error; paint(); return; }
    area.value = shown(answer.body.text);
    version = answer.body.version; saved = area.value; size = answer.body.size; current = null; reason = '';
    phase = 'clean';
    paint();
  }

  area.addEventListener('input', () => {
    const next = area.value !== saved ? 'unsaved' : phase === 'clean' ? 'clean' : 'saved';
    if (phase !== 'conflict' && phase !== next) { phase = next; paint(); }
    later();
  });
  area.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); onDone({ discard: false }); return; }
    // Mod+S is heard by Workbench (workbench-view.js); Ctrl+S here too, which
    // in a browser would otherwise save the page.
    if (event.code === 'KeyS' && !event.shiftKey && (heldMod(event) || ((event.ctrlKey || event.metaKey) && !event.altKey))) { event.preventDefault(); void save(); }
  });

  // Leaving the page: what is unsaved is sent while it still can be, and a
  // browser asks first. imperfect's own window does not (it would only stop
  // the reload), and waits for the save before a new version reloads it.
  const win = doc.defaultView;
  const hidden = () => { if (doc.hidden && unsaved()) void save({ keepalive: true }); };
  const leaving = event => { if (unsaved() && !globalThis.imperfectDesk) { event.preventDefault(); event.returnValue = ''; } };
  const gone = () => {
    if (!unsaved() || area.value === saved || sending) return;
    const body = written(area.value);
    if (body.length < KEEPALIVE_LIMIT) void fetch(url, { method: 'POST', keepalive: true, headers: { 'content-type': 'text/plain; charset=utf-8', 'if-match': `"${version}"` }, body }).catch(() => {});
  };
  doc.addEventListener('visibilitychange', hidden);
  win.addEventListener('beforeunload', leaving);
  win.addEventListener('pagehide', gone);

  return {
    area,
    // What the line says, once the editor is in place.
    paint,
    text: () => area.value,
    size: () => size,
    unsaved,
    trouble: () => reason,
    save,
    place(at) {
      const fraction = Math.max(0, Math.min(1, Number(at) || 0));
      const caret = fraction ? area.value.lastIndexOf('\n', Math.floor(area.value.length * fraction)) + 1 : 0;
      area.setSelectionRange(caret, caret);
      area.scrollTop = fraction * Math.max(0, area.scrollHeight - area.clientHeight);
    },
    stale: () => current !== null,
    focus() { if (!closed) area.focus({ preventScroll: true }); },
    close({ discard = false } = {}) {
      if (closed) return;
      closed = true; discarded = discard;
      clearTimeout(timer); timer = 0;
      doc.removeEventListener('visibilitychange', hidden);
      win.removeEventListener('beforeunload', leaving);
      win.removeEventListener('pagehide', gone);
      delete line.dataset.edit;
      // Put away with changes still unsent (a view closed, a computer gone):
      // they are sent all the same, and a change on disk still wins.
      if (!discard && area.value !== saved) void save();
    },
  };
}
