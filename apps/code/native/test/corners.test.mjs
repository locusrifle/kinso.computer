import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Every corner is one of look.css's: a surface rounds by naming a radius
// (--radius-xs … --radius-pill), never a number of its own, so the feel of
// every corner in imperfect is changed in one file. Square (0) and round
// (50%) are not sizes, so they may be written as they are.
test('every corner comes from look.css', async () => {
  const directory = new URL('../public/css/', import.meta.url);
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.css') || file === 'look.css') continue;
    const css = (await readFile(new URL(file, directory), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const match of rule[2].matchAll(/border-(?:radius|(?:top|bottom)-(?:left|right)-radius)\s*:\s*([^;{}]+)/g)) {
        for (const part of match[1].replace(/!important/, '').trim().split(/\s+(?![^(]*\))/)) {
          assert.match(part, /^(?:0(?:px)?|50%|var\(--radius(?:-[a-z]+)?\)|inherit)$/, `${file}: ${match[0]}`);
        }
      }
    }
  }
});

test('look.css names every radius', async () => {
  const look = await readFile(new URL('../public/css/look.css', import.meta.url), 'utf8');
  for (const name of ['--radius-xs', '--radius-s', '--radius', '--radius-l', '--radius-xl', '--radius-pill', '--radius-window']) assert.match(look, new RegExp(`${name}:\\s*\\d`), name);
});
