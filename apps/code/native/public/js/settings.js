// Settings (the sidebar's foot, harness.js): the shared right panel, System Settings'
// way, in grouped rows. Models: sign in to a provider, choose a model, sign
// out. Appearance: the themes, Automatic first, chosen by a click. Keyboard:
// every key that does something right now, as the binding registry says.
// Usage: the panel. Each row only opens what already does the thing.
//
//   mountSettings({ signIn, signOut, chooseModel, usage })
//     → { open(), close(), toggle(), isOpen }

import { activeKeyBindings } from './pi-card.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

export function mountSettings({ signIn, signOut, chooseModel, usage, present, dismiss, showing, ownsFocus }) {
  const sheet = el('section', 'settings-sheet');
  sheet.setAttribute('aria-labelledby', 'settings-title');
  let opened = false, returnTo = null;

  const close = () => {
    if (!opened) return;
    opened = false;
    dismiss();
    if (returnTo?.isConnected && returnTo.getClientRects().length) returnTo.focus({ preventScroll: true });
  };
  // Start in the click's turn: provider/model actions capture that session,
  // not whichever session a deferred callback would find later.
  const then = action => () => {
    close();
    try { Promise.resolve(action()).catch(() => {}); } catch { /* same boundary as the async actions */ }
  };
  addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !opened || !showing() || !ownsFocus()) return;
    event.preventDefault(); event.stopImmediatePropagation(); close();
  });

  function group(title, ...rows) {
    const section = el('section', 'settings-group');
    section.append(el('h2', 'settings-group-title', title));
    const box = el('div', 'settings-rows');
    box.append(...rows);
    section.append(box);
    return section;
  }
  function row(label, action, note = '') {
    const button = el('button', 'settings-row');
    button.type = 'button';
    button.append(el('span', 'settings-row-label', label));
    if (note) button.append(el('span', 'settings-row-note', note));
    button.append(el('span', 'settings-row-chevron'));
    button.onclick = action;
    return button;
  }

  // The themes: a swatch each, its ground, its text and its accent.
  const themes = el('div', 'settings-themes');
  async function paintThemes() {
    let answer = {};
    try { answer = await (await fetch('/themes.json', { cache: 'no-store' })).json(); } catch { answer = {}; }
    const list = answer.themes ?? [];
    const by = id => list.find(theme => theme.id === id);
    const items = [{ id: 'auto', name: 'Automatic', auto: true, current: Boolean(answer.auto) },
      ...list.map(theme => ({ ...theme, current: theme.current && !answer.auto }))];
    themes.replaceChildren(...items.map(theme => {
      const pick = el('button', 'settings-theme');
      pick.type = 'button';
      pick.setAttribute('aria-pressed', String(theme.current));
      const face = el('span', 'settings-theme-face');
      if (theme.auto) {
        const light = by('mac-light'), dark = by('mac-dark');
        face.style.background = `linear-gradient(135deg, ${light?.background ?? '#ffffff'} 50%, ${dark?.background ?? '#121214'} 50%)`;
      } else {
        face.style.background = theme.background;
        const ink = el('span', 'settings-theme-ink');
        ink.style.background = theme.foreground;
        const dot = el('span', 'settings-theme-dot');
        dot.style.background = theme.accent;
        face.append(ink, dot);
      }
      pick.append(face, el('span', 'settings-theme-name', theme.name));
      pick.onclick = async () => {
        for (const other of themes.children) other.setAttribute('aria-pressed', String(other === pick));
        try { await fetch('/theme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: theme.id }) }); }
        catch { void paintThemes(); }
      };
      return pick;
    }));
  }

  // The keys: what each does, and the keys, as keycaps.
  function keys() {
    const list = el('div', 'settings-keys');
    const seen = new Set();
    for (const { label, description } of activeKeyBindings()) {
      if (!label || !description || seen.has(`${label}\u0000${description}`)) continue;
      seen.add(`${label}\u0000${description}`);
      const line = el('div', 'settings-key');
      const caps = el('span', 'settings-key-caps');
      for (const part of label.split('+')) caps.append(el('kbd', null, part));
      line.append(el('span', 'settings-key-act', description), caps);
      list.append(line);
    }
    if (!list.childElementCount) list.append(el('p', 'settings-empty', 'No keys right now.'));
    return list;
  }

  function paint() {
    const head = el('header', 'settings-head');
    const title = el('h1', 'settings-title', 'Settings');
    title.id = 'settings-title';
    const done = el('button', 'look-button settings-done', 'Back');
    done.setAttribute('aria-label', 'Back to conversation');
    done.type = 'button';
    done.onclick = close;
    head.append(title, done);
    const body = el('div', 'settings-body');
    body.append(
      group('Models',
        row('Sign in to a provider', then(signIn), 'Claude, ChatGPT, API keys'),
        row('Choose a model', then(chooseModel)),
        row('Sign out of a provider', then(signOut))),
      (() => { const section = group('Appearance'); section.querySelector('.settings-rows').replaceWith(themes); return section; })(),
      (() => { const section = group('Keyboard'); section.querySelector('.settings-rows').replaceWith(keys()); return section; })(),
      group('Usage', row('Usage and limits', then(usage))),
    );
    sheet.replaceChildren(head, body);
    void paintThemes();
  }

  function open() {
    returnTo = document.activeElement;
    if (!opened) { paint(); opened = true; }
    present(sheet);
    sheet.querySelector('.settings-done')?.focus({ preventScroll: true });
  }
  return {
    el: sheet, open, close,
    keys: () => sheet.querySelector('.settings-done')?.focus({ preventScroll: true }),
    toggle: () => (opened && showing() ? close() : open()),
    get isOpen() { return opened && showing(); },
  };
}
