// Whose window this is. imperfect is its own, and its agent is Locus. A
// company's version of it, opened by the launch site with ?for=kinso, wears
// that company's name and mark instead, and Kinso is its agent's name too.
// The address is read once and the answer kept for the tab, so a reload, or
// an address without it, is still the same window. Only a name and a mark
// change; what runs is imperfect either way. Where nothing names a brand,
// the copy's own default does (brand-default.js: Kinso's repository says kinso).
import fallback from './brand-default.js';
const BRANDS = Object.freeze({
  imperfect: Object.freeze({ id: 'imperfect', name: 'imperfect', agent: 'Locus' }),
  // Kinso's own logo and type are theirs, never in this source: a computer
  // that has them keeps them in public/kinso/ (git-ignored; kinso.css names
  // the fonts). Without the logo, the word.
  kinso: Object.freeze({ id: 'kinso', name: 'Kinso', agent: 'Kinso', logo: new URL('../kinso/mark.png', import.meta.url).pathname }),
});
const KEPT = 'imperfect.for';

export function readBrand(win = globalThis.window, byDefault = fallback) {
  let asked = null;
  try { asked = new URLSearchParams(win?.location?.search ?? '').get('for'); } catch { asked = null; }
  const known = id => typeof id === 'string' && Object.hasOwn(BRANDS, id);
  // The ticket door deliberately discards its query when it sets the session
  // cookie. Kinso has its own computer, so its exact HTTPS origin also names
  // the brand on the very first visit, before tab storage exists.
  if (!known(asked) && win?.location?.origin === 'https://computer.kinso.computer') asked = 'kinso';
  try {
    if (known(asked)) win.sessionStorage.setItem(KEPT, asked);
    else asked = win?.sessionStorage?.getItem(KEPT) ?? null;
  } catch { /* storage refused: the address alone says */ }
  if (known(asked)) return BRANDS[asked];
  return known(byDefault) ? BRANDS[byDefault] : BRANDS.imperfect;
}

export const brand = readBrand();

// The page says whose it is: a class for the look, and the title.
export function applyBrand(doc = globalThis.document, which = brand) {
  if (!doc) return;
  doc.documentElement.dataset.brand = which.id;
  if (which.id !== 'imperfect') doc.title = which.name;
}

// The brand's mark beside the model's name, where the harness's was: the
// imperfect goat, drawn in the theme's ink (imperfect.css), or Kinso's logo,
// or failing that Kinso's name. It moves while the agent works.
export function brandMark({ working = false } = {}, which = brand) {
  const mark = document.createElement('span');
  mark.className = 'brand-mark';
  mark.dataset.brand = which.id;
  mark.setAttribute('aria-hidden', 'true');
  if (which.logo) {
    const word = () => { mark.replaceChildren(which.name); mark.classList.add('brand-word'); };
    const logo = new Image();
    logo.alt = '';
    logo.decoding = 'async';
    logo.draggable = false;
    logo.onerror = word;
    logo.src = which.logo;
    mark.append(logo);
  }
  mark.classList.toggle('mark-working', working);
  return mark;
}
