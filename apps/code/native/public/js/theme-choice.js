// Both pickers use the same choices. Kinso never reads or writes the Mac
// theme; its local appearance cannot colour an imperfect window beside it.
import { brand } from './brand.js';
import { kinsoThemeOptions, setKinsoTheme } from './kinso-theme.js';

export async function themeOptions() {
  if (brand.id === 'kinso') return kinsoThemeOptions();
  try { return await (await fetch('/themes.json', { cache: 'no-store' })).json(); }
  catch { return {}; }
}

export async function chooseTheme(id) {
  if (brand.id === 'kinso') { setKinsoTheme(id); return; }
  await fetch('/theme', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
}
