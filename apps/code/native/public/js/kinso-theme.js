// Kinso keeps its appearance in this browser, separate from the computer's
// imperfect theme. Automatic is the first visit, and follows the system live.
const KEY = 'kinso.appearance';
export const kinsoThemes = [
  { id: 'kinso-light', name: 'Kinso Light', background: '#fcfcfb', foreground: '#000000', accent: '#ff6d33' },
  { id: 'kinso-dark', name: 'Kinso Dark', background: '#0e0e0f', foreground: '#f3f1ed', accent: '#ff9366' },
];
let choice = 'auto';
let root, media;
const valid = id => id === 'auto' || kinsoThemes.some(theme => theme.id === id);

function paint() {
  if (!root || root.dataset.brand !== 'kinso') return;
  const appearance = choice === 'auto' ? (media?.matches ? 'dark' : 'light') : choice.slice(6);
  const changed = root.dataset.kinsoAppearance !== appearance;
  root.dataset.kinsoTheme = choice;
  root.dataset.kinsoAppearance = appearance;
  if (changed) root.dispatchEvent(new Event('kinso-appearance'));
}

export function applyKinsoTheme(doc) {
  if (root === doc.documentElement) { paint(); return; }
  root = doc.documentElement;
  try { const saved = doc.defaultView.localStorage.getItem(KEY); choice = valid(saved) ? saved : 'auto'; } catch { choice = 'auto'; }
  media = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener('change', paint);
  doc.defaultView?.addEventListener('storage', event => {
    if (event.key === KEY || event.key === null) { choice = valid(event.newValue) ? event.newValue : 'auto'; paint(); }
  });
  paint();
}

export function kinsoThemeOptions() {
  return { auto: choice === 'auto', themes: kinsoThemes.map(theme => ({ ...theme, current: theme.id === choice })) };
}

export function setKinsoTheme(id) {
  if (!valid(id)) throw new Error('No such Kinso theme');
  choice = id;
  try { root?.ownerDocument.defaultView.localStorage.setItem(KEY, id); } catch { /* still works for this window */ }
  paint();
}
