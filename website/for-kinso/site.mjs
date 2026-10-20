// kinso.computer: the launch page made for Kinso (variant.mjs). launch.mjs loads this only there. It dresses the page in
// Kinso's names and brings what differs from imperfect.computer: the sharks on the lock, the film window, and the build
// told to Noah's words. Visitors only ever see kinso.computer: nothing here names the computer's own address.
import { variant } from '../variant.mjs?v=kinso-install-1';
import { kinsoIcons } from './brand.mjs?v=kinso-1';
export { createKinsoFilm } from './film.mjs?v=kinso-1';
export { createKinsoBuild } from './build.mjs?v=kinso-install-1';
export { mountSharks } from './lock-sharks.mjs?v=kinso-pale-grid-1';

function favicon(doc, href) {
  for (const link of doc.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')) link.remove();
  const link = doc.createElement('link'); link.rel = 'icon'; link.type = 'image/png'; link.href = href;
  doc.head.append(link);
}

// The page's names, its stylesheet and Kinso's icons (the word at once, the logo's once it loads: brand.mjs).
export function dressPage(doc = document) {
  doc.body.dataset.company = 'kinso';
  const style = doc.createElement('link'); style.rel = 'stylesheet'; style.href = new URL('./kinso.css?v=kinso-pale-grid-1', import.meta.url).href;
  doc.head.append(style);
  doc.title = variant.title;
  const name = variant.name, set = (selector, attribute, text) => doc.querySelector(selector)?.setAttribute(attribute, text);
  const heading = doc.getElementById('launchHeading'); if (heading) heading.textContent = `${variant.title}: a film and a live computer`;
  set('#macScreen', 'aria-label', `A Mac, with ${name} being built on it`);
  set('#demoScreen', 'aria-label', `The real ${name} computer`);
  set('#computer', 'title', `${name} · live computer`);
  set('meta[name="description"]', 'content', 'Kinso, as a computer: a concept by Noah Fleming.');
  // The prompt's spare link would open the computer in a tab of its own; here the visitor stays on kinso.computer.
  doc.getElementById('fallback')?.removeAttribute('href');
  const icons = kinsoIcons();
  favicon(doc, icons.now.favicon);
  icons.ready.then(drawn => { if (drawn) favicon(doc, drawn.favicon); });
  return icons;
}
