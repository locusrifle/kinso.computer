// The leaping goat artwork: Noah's white goat, cut out of his galaxy art,
// turned to face right, trimmed tight and made square. Keep its existing
// tab/theme artwork and marketing link preview, not the app's logo.
// App/store icons are J06 now: node tools/icons.mjs owns those outputs.
//
//   node tools/goat.mjs ~/workbench/kinso/art/cutouts/scene/animal-4-white-goat.png
//
// It needs ImageMagick. The small ones are lifted (their mid-tones made
// lighter), so the stipple reads as a white goat rather than grey mush.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error('usage: node tools/goat.mjs <the white goat cut-out, a PNG>');
const root = resolve(import.meta.dirname, '..');
const magick = (...args) => execFileSync('magick', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const out = path => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); return file; };
const LIFT = ['-channel', 'RGB', '-level', '0%,70%,1.5', '+channel'];
const PNG = ['-strip', '-define', 'png:color-type=6', '-depth', '8'];

const work = mkdtempSync(join(tmpdir(), 'goat-'));
try {
  const side = Math.max(...magick(source, '-trim', '-format', '%w %h', 'info:').split(' ').map(Number));
  const square = join(work, 'square.png');
  magick(source, '-flop', '-trim', '+repage', '-background', 'none', '-gravity', 'center', '-extent', `${side}x${side}`, square);
  const lifted = join(work, 'lifted.png');
  magick(square, ...LIFT, lifted);
  const sized = (from, size, ...rest) => [from, '-filter', 'Lanczos', '-resize', `${size}x${size}`, ...rest];

  // imperfect: the tabs, the agents' list and the status line (22px at 1x,
  // 2x and 3x), and the theme picker's faces, large.
  for (const size of [22, 44, 66]) magick(...sized(lifted, size), '-strip', '-define', 'webp:lossless=true', out(`apps/code/native/public/goat/goat-${size}.webp`));
  magick(square, '-strip', '-quality', '90', out('apps/code/native/public/goat/goat.webp'));

  // Preserve the existing marketing artwork, not the app's selected mark.
  magick(square, '-background', 'black', '-gravity', 'center', '-extent', '1200x630', '-alpha', 'remove', '-alpha', 'off', ...PNG, out('locker/public/store/og.png'));
} finally {
  rmSync(work, { recursive: true, force: true });
}
