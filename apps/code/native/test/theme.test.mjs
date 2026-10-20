import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contrast, currentLook, listThemes, readTheme, secondaryText, setTheme, themeChoice, themeCss, watchThemes } from '../../../../system/theme.mjs';

const home = async () => mkdtemp(join(tmpdir(), 'theme-'));
const value = (css, name) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))?.[1];

test('Mac · Dark and Mac · Light ship to a fresh home, plain, and nothing else; auto follows the system', async () => {
  const dir = await home();
  try {
    const themes = await listThemes(dir);
    assert.deepEqual(themes.map(theme => theme.id), ['mac-dark', 'mac-light']);
    assert.equal(themes.find(theme => theme.current).id, 'mac-dark');
    // no picture under the window and no sky: the black and the white alone
    for (const id of ['mac-dark', 'mac-light']) assert.doesNotMatch(themeCss(await readTheme(id, dir)), /--theme-(underlay|wallpaper|sky)|url\(/);
    for (const id of ['kinso-light', 'kinso-dark']) {
      assert.equal(await readTheme(id, dir), null);
      await assert.rejects(setTheme(id, dir), /No such theme/);
    }
    await setTheme('auto', dir);
    assert.equal((await readTheme('mac-light', dir)).mode, 'light');
    // Auto: Mac · Dark, and Mac · Light when the system asks for light.
    const auto = (await currentLook(dir)).css;
    assert.match(auto, /^:root \{\n  --theme-bg: #121214;/);
    assert.match(auto, /@media \(prefers-color-scheme: light\) \{\n:root \{\n  --theme-bg: #ffffff;/);
    for (const id of ['mac-dark', 'mac-light']) {
      const css = themeCss(await readTheme(id, dir));
      for (const ink of ['theme-ink', 'theme-secondary']) assert.ok(contrast(value(css, ink), value(css, 'theme-raised')) >= 4.5, `${id} ${ink}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a theme of three colours is a whole theme, and the person can choose it', async () => {
  const dir = await home();
  try {
    await mkdir(join(dir, '.imperfect/themes'), { recursive: true });
    await writeFile(join(dir, '.imperfect/themes/midnight.json'), JSON.stringify({ background: '#101018', foreground: '#e8e4f0', accent: '#ff77c8', evil: 'red;}' }));
    await writeFile(join(dir, '.imperfect/themes/broken.json'), '{ not json');
    const theme = await readTheme('midnight', dir);
    assert.equal(theme.name, 'Midnight');
    assert.equal(theme.evil, undefined, 'only colours reach the css');
    assert.equal((await listThemes(dir)).length, 3, 'a broken file is skipped');
    await setTheme('midnight', dir);
    assert.equal((await readFile(join(dir, '.imperfect/theme'), 'utf8')).trim(), 'midnight');
    const css = (await currentLook(dir)).css;
    for (const name of ['theme-band', 'theme-muted', 'theme-rule', 'theme-red', 'theme-secondary']) assert.ok(value(css, name), name);
    await assert.rejects(setTheme('nope', dir), /No such theme/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a personal copy overrides a shipped theme without changing the saved choice', async () => {
  const dir = await home();
  try {
    await setTheme('mac-dark', dir);
    await mkdir(join(dir, '.imperfect/themes'), { recursive: true });
    await writeFile(join(dir, '.imperfect/themes/mac-dark.json'), JSON.stringify({name:'My Dark', background:'#121212', foreground:'#ffffff', accent:'#dddddd'}));
    assert.equal((await listThemes(dir)).length, 2);
    assert.equal((await readTheme('mac-dark', dir)).name, 'My Dark');
    assert.equal((await currentLook(dir)).theme, 'mac-dark');
    assert.match((await currentLook(dir)).css, /--theme-bg: #121212;/);
    await rm(join(dir, '.imperfect/themes/mac-dark.json'));
    assert.equal((await readTheme('mac-dark', dir)).name, 'Mac · Dark');
    assert.equal((await currentLook(dir)).theme, 'mac-dark');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('without a choice, or with one that is gone, it follows the system', async () => {
  const dir = await home();
  try {
    await mkdir(join(dir, '.imperfect/themes'), { recursive: true });
    await writeFile(join(dir, '.imperfect/themes/paper.json'), JSON.stringify({ mode: 'light', background: '#f4f1ea', foreground: '#1a1a1a', accent: '#a0522d' }));
    assert.equal((await currentLook(dir)).theme, 'auto');
    await setTheme('paper', dir);
    assert.equal((await currentLook(dir)).theme, 'paper', 'a theme picked by hand stays');
    await writeFile(join(dir, '.imperfect/theme'), 'bloom-dark\n');
    assert.equal((await currentLook(dir)).theme, 'auto', 'a theme that no longer exists falls back');
    await setTheme('auto', dir);
    assert.equal((await currentLook(dir)).theme, 'auto');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('retired galaxy files are never offered, selected or applied; other choices stay untouched', async () => {
  const dir = await home();
  try {
    await mkdir(join(dir, '.imperfect/themes'), { recursive: true });
    const personal = {
      'galaxy-aurora': JSON.stringify({ background: '#061613', foreground: '#ffffff', accent: '#71dfc1' }),
      'galaxy-future': JSON.stringify({ background: '#123456' }),
      midnight: JSON.stringify({ background: '#101018', foreground: '#e8e4f0', accent: '#ff77c8' }),
    };
    for (const [id, json] of Object.entries(personal)) await writeFile(join(dir, `.imperfect/themes/${id}.json`), json);
    for (const chosen of ['galaxy-aurora', 'mac-dark', 'mac-light', 'auto', 'midnight']) {
      const saved = `${chosen}\n`;
      await writeFile(join(dir, '.imperfect/theme'), saved);
      const expected = chosen.startsWith('galaxy-') ? 'auto' : chosen;
      const themes = await listThemes(dir);
      assert.deepEqual(themes.map(t => t.id), ['mac-dark', 'mac-light', 'midnight']);
      assert.equal(await themeChoice(dir), expected);
      assert.equal(themes.find(t => t.current).id, expected === 'auto' ? 'mac-dark' : expected);
      assert.equal((await readTheme(null, dir)).id, expected === 'auto' ? 'mac-dark' : expected);
      const look = await currentLook(dir);
      assert.equal(look.theme, expected);
      if (expected === 'auto') {
        assert.match(look.css, /--theme-bg: #121214;/);
        assert.match(look.css, /prefers-color-scheme: light/);
        assert.match(look.css, /--theme-bg: #ffffff;/);
      } else assert.equal(look.css, themeCss(await readTheme(expected, dir)));
      for (const id of ['galaxy-aurora', 'galaxy-future']) {
        assert.equal(await readTheme(id, dir), null);
        await assert.rejects(setTheme(id, dir), /No such theme/);
      }
      assert.equal(await readFile(join(dir, '.imperfect/theme'), 'utf8'), saved, 'display and rejected choices never rewrite the choice');
      if (expected !== 'auto' || chosen === 'auto') {
        await setTheme(chosen, dir);
        assert.equal(await readFile(join(dir, '.imperfect/theme'), 'utf8'), saved);
      }
    }
    for (const [id, json] of Object.entries(personal)) assert.equal(await readFile(join(dir, `.imperfect/themes/${id}.json`), 'utf8'), json);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the painted goat turns to dark ink on light themes', () => {
  assert.match(themeCss({ mode: 'light' }), /--theme-goat-filter: invert\(1\);/);
  assert.doesNotMatch(themeCss({ mode: 'light' }), /--theme-stardust-glow/);
  assert.match(themeCss({ mode: 'dark' }), /--theme-goat-filter: brightness\(1\);/);
  assert.doesNotMatch(themeCss({ mode: 'dark' }), /--theme-stardust-glow/);
});

test('secondary text stays readable on the panel it is drawn on', () => {
  for (const [ink, panel] of [['#e6d9db', '#2c2525'], ['#1a1b26', '#f2edf2'], ['#cacccc', '#101315']]) {
    assert.ok(contrast(secondaryText(ink, panel), panel) >= 4.5, `${ink} on ${panel}`);
  }
  const css = themeCss({ background: '#101315', foreground: '#cacccc', accent: '#798186' });
  assert.ok(contrast(value(css, 'theme-secondary'), '#101315') >= 4.5);
});

test('a new theme file restyles the windows without a restart', async () => {
  const dir = await home();
  try {
    await mkdir(join(dir, '.imperfect/themes'), { recursive: true });
    let fired = 0;
    const stop = watchThemes(() => { fired++; }, dir);
    await writeFile(join(dir, '.imperfect/themes/dusk.json'), JSON.stringify({ background: '#201020', foreground: '#ffeeff', accent: '#e040fb' }));
    await new Promise(resolve => setTimeout(resolve, 300));
    stop();
    assert.ok(fired > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
