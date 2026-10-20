// imperfect's themes: what every window is coloured by.
//
// A theme is one small JSON file of colours. Built-ins come with imperfect
// (apps/code/native/themes); the person's own live in
// ~/.imperfect/themes/<id>.json and win over a built-in of the same id.
// Three colours make a theme; the rest is derived:
//
//   { "name": "Midnight", "mode": "dark",
//     "background": "#101018", "foreground": "#e8e4f0", "accent": "#ff77c8" }
//
// Optional: panel, band, bright, muted, dim, rule, bar, and the terminal
// colours red, yellow, green, orange, blue, cyan, magenta.
// The chosen theme's id is kept in ~/.imperfect/theme. Without one, or with
// "auto", it follows the computer's own light or dark appearance: Mac · Dark
// and Mac · Light, both in one stylesheet, the system choosing between them.

import { readdir, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILT_IN = fileURLToPath(new URL('../apps/code/native/themes/', import.meta.url));
export const DEFAULT_THEME = 'mac-dark';
export const AUTO_THEMES = { dark: 'mac-dark', light: 'mac-light' };
export const AUTO = 'auto';
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const retired = id => id.startsWith('galaxy-');
const COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const KEYS = ['background', 'panel', 'band', 'foreground', 'bright', 'muted', 'dim', 'rule', 'accent', 'bar', 'red', 'yellow', 'green', 'orange', 'blue', 'cyan', 'magenta'];

const userDir = home => join(home, '.imperfect', 'themes');
const choiceFile = home => join(home, '.imperfect', 'theme');
const titled = id => id.split('-').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');

// Only colours reach CSS: anything else in a file is ignored.
function clean(id, raw = {}) {
  const theme = { id, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : titled(id), mode: raw.mode === 'light' ? 'light' : 'dark' };
  for (const key of KEYS) if (COLOUR.test(String(raw[key] ?? ''))) theme[key] = String(raw[key]).toLowerCase();
  return theme;
}

async function readDir(dir) {
  const found = new Map();
  let names = [];
  try { names = await readdir(dir); } catch { return found; }
  for (const name of names.sort()) {
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !THEME_ID.test(id) || retired(id)) continue;
    try { found.set(id, clean(id, JSON.parse(await readFile(join(dir, name), 'utf8')))); }
    catch { /* a half-written or broken file is skipped, not fatal */ }
  }
  return found;
}

export async function listThemes(home = homedir()) {
  const themes = new Map([...await readDir(BUILT_IN), ...await readDir(userDir(home))]);
  const current = await currentThemeId(home, themes);
  return [...themes.values()].map(theme => ({ ...theme, current: theme.id === current }));
}

export async function themeChoice(home = homedir()) {
  const chosen = (await readFile(choiceFile(home), 'utf8').catch(() => '')).trim() || AUTO;
  // Retired personal themes stay on disk, but no longer colour any window.
  return retired(chosen) ? AUTO : chosen;
}

async function currentThemeId(home, themes) {
  const chosen = await themeChoice(home);
  return themes.has(chosen) ? chosen : DEFAULT_THEME;
}

export async function readTheme(id, home = homedir()) {
  const themes = await listThemes(home);
  return themes.find(theme => theme.id === (id || themes.find(t => t.current)?.id)) ?? null;
}

export async function setTheme(id, home = homedir()) {
  if (id !== AUTO && !(await listThemes(home)).some(theme => theme.id === id)) throw new Error('No such theme');
  await mkdir(join(home, '.imperfect'), { recursive: true, mode: 0o700 });
  const tmp = `${choiceFile(home)}.${process.pid}.tmp`;
  await writeFile(tmp, `${id}\n`);
  await rename(tmp, choiceFile(home));
  return id;
}

// The current theme, as the window wants it: its css and a revision that
// changes whenever the css does.
export async function currentLook(home = homedir()) {
  const chosen = await themeChoice(home);
  const themes = await listThemes(home);
  const byId = id => themes.find(theme => theme.id === id);
  let css, id;
  if (chosen === AUTO || !byId(chosen)) {
    // Auto: dark unless the system asks for light, and back the moment it changes.
    const dark = byId(AUTO_THEMES.dark) ?? {}, light = byId(AUTO_THEMES.light) ?? { mode: 'light' };
    css = `${themeCss(dark)}@media (prefers-color-scheme: light) {\n${themeCss(light)}}\n`;
    id = AUTO;
  } else {
    id = chosen;
    css = themeCss(byId(chosen));
  }
  return { theme: id, css, rev: createHash('sha256').update(css).digest('hex').slice(0, 20) };
}

// Watch the choice and the person's themes; a new or edited theme file
// restyles every window at once.
export function watchThemes(onChange, home = homedir()) {
  let timer;
  const fire = () => { clearTimeout(timer); timer = setTimeout(() => { try { onChange(); } catch {} }, 40); };
  const watchers = [];
  for (const [dir, only] of [[join(home, '.imperfect'), 'theme'], [userDir(home), null]]) {
    try {
      const watcher = watch(dir, { persistent: false }, (_, name) => { if (!only || name === only) fire(); });
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch { /* not there yet: a restart picks it up */ }
  }
  return () => { clearTimeout(timer); for (const watcher of watchers) try { watcher.close(); } catch {} };
}

// Enough colour arithmetic to derive what a theme leaves out.
const rgb = hex => {
  const n = String(hex).replace('#', '');
  const wide = n.length === 3 ? n.split('').map(c => c + c).join('') : n;
  return [0, 2, 4].map(i => parseInt(wide.slice(i, i + 2), 16) || 0);
};
const hex = parts => `#${parts.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, weight) => hex(rgb(a).map((v, i) => v * weight + rgb(b)[i] * (1 - weight)));
const luminance = colour => {
  const [r, g, b] = rgb(colour).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Secondary text is the foreground stepped back toward the panel, stopped at
// the first step that still clears 4.5:1; a foreground that cannot is kept.
export function secondaryText(ink, panel) {
  for (const weight of [0.82, 0.88, 0.94]) {
    const candidate = mix(ink, panel, weight);
    if (contrast(candidate, panel) >= 4.5) return candidate;
  }
  return String(ink).toLowerCase();
}

export function themeCss(t = {}) {
  const light = t.mode === 'light';
  const bg = t.background || (light ? '#f2edf2' : '#000000');
  const ink = t.foreground || (light ? '#1a1b26' : '#e6d9db');
  const accent = t.accent || (light ? '#c2187f' : '#ff77c8');
  const raised = t.panel || bg;
  const band = t.band || mix(ink, raised, 0.1);
  const bright = t.bright || ink;
  const muted = t.muted || mix(ink, raised, 0.6);
  const dim = t.dim || muted;
  const rule = t.rule || mix(ink, raised, 0.18);
  const red = t.red || (light ? '#b0456a' : '#f7768e');
  const yellow = t.yellow || (light ? '#9a6b1f' : '#e0af68');
  const green = t.green || (light ? '#4f7a4a' : '#9ece6a');
  const orange = t.orange || yellow;
  const blue = t.blue || (light ? '#7b2ff7' : '#b04dff');
  const cyan = t.cyan || (light ? '#8a2be2' : '#c77dff');
  const magenta = t.magenta || (light ? '#d0399a' : '#ff77c8');
  const secondary = secondaryText(ink, raised);
  return `:root {
  --theme-bg: ${bg};
  --theme-goat-filter: ${light ? 'invert(1)' : 'brightness(1)'};
  --theme-cloud-ink: ${mix(bright, t.bar || bg, light ? 0.14 : 0.35)};
  --theme-bar-bg: ${t.bar || bg};
  --theme-raised: ${raised};
  --theme-band: ${band};
  --theme-ink: ${ink};
  --theme-bright: ${bright};
  --theme-muted: ${muted};
  --theme-accent: ${accent};
  --theme-rule: ${rule};
  --theme-dim: ${dim};
  --theme-red: ${red};
  --theme-yellow: ${yellow};
  --theme-green: ${green};
  --theme-orange: ${orange};
  --theme-blue: ${blue};
  --theme-cyan: ${cyan};
  --theme-magenta: ${magenta};
  --theme-secondary: ${secondary};
  --garden: var(--theme-bg);
  --paper: var(--theme-bg);
  --panel: var(--theme-raised);
  --panel-raised: var(--theme-raised);
  --panel-band: var(--theme-band);
  --panel-text: var(--theme-ink);
  --panel-bright: var(--theme-bright);
  --panel-rule: var(--theme-rule);
  --ink: var(--theme-ink);
  --muted: var(--theme-muted);
  --orange: var(--theme-accent);
  --pi-bg: var(--theme-raised);
  --pi-bg-raised: var(--theme-raised);
  --pi-text: var(--theme-ink);
  --pi-text-bright: var(--theme-bright);
  --pi-muted: var(--theme-muted);
  --pi-dim: var(--theme-dim);
  --pi-accent: var(--theme-accent);
  --pi-cursor: var(--theme-bright);
  --pi-user: var(--theme-band);
  --pi-rule: var(--theme-accent);
  --pi-error: var(--theme-red);
  --pi-tool-error: var(--theme-red);
  --pi-working: var(--theme-accent);
  --tui-pageBg: var(--theme-raised);
  --tui-cardBg: var(--theme-raised);
  --tui-userMessageBg: var(--theme-band);
  --tui-text: var(--theme-ink);
  --tui-userMessageText: var(--theme-bright);
  --tui-muted: var(--theme-muted);
  --tui-dim: var(--theme-dim);
  --tui-accent: var(--theme-accent);
  --tui-selectedBg: var(--theme-band);
  --tui-border: var(--theme-rule);
  --tui-warning: var(--theme-yellow);
  --tui-success: var(--theme-green);
  --tui-permission: var(--theme-red);
  --tui-secondary: var(--theme-secondary);
  /* Two rules, two jobs: a hairline between rows, and the findable line the
     composer sits behind. */
  --tui-rule-strong: var(--theme-muted);
}
html, body { background: var(--theme-bg); color: var(--theme-ink); color-scheme: ${light ? 'light' : 'dark'}; }
`;
}
