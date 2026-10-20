// J06 · grey · wide · 5 rings, selected by Noah. These masters preserve
// the exact transparent mark; no tracing, flipping or geometry changes.
// node tools/icons.mjs (ImageMagick required)
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const master = join(root, 'tools/assets/goat-head/goat-head.png');
const svg = join(root, 'tools/assets/goat-head/favicon.svg');
// Installed PNG home-screen icons cannot universally follow live system theme
// changes. Use a high-contrast neutral backing; Android 13+ launchers may instead
// colour the monochrome alpha mask when themed icons are enabled.
const destinations = ['locker/public/store', 'website'];
const magick = (...args) => execFileSync('magick', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const out = path => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); return file; };
const PNG = ['-strip', '-define', 'png:color-type=6', '-depth', '8'];
const work = mkdtempSync(join(tmpdir(), 'imperfect-icons-'));
try {
  const square = join(work, 'square.png');
  const bounds = magick(master, '-trim', '-format', '%w %h', 'info:').split(' ').map(Number);
  const side = Math.max(...bounds);
  magick(master, '-trim', '+repage', '-background', 'none', '-gravity', 'center', '-extent', `${side}x${side}`, ...PNG, square);
  const backed = (size, markSize, file) => magick(square, '-filter', 'Lanczos', '-resize', `${markSize}x${markSize}`, '-background', 'black', '-gravity', 'center', '-extent', `${size}x${size}`, '-alpha', 'remove', '-alpha', 'off', ...PNG, file);
  const ico = [16, 32, 48].map(size => { const file = join(work, `${size}.png`); backed(size, size - 2, file); return file; });
  magick(...ico, join(work, 'favicon.ico'));
  backed(180, 144, join(work, 'apple-touch-icon.png'));
  for (const size of [192, 512]) {
    backed(size, Math.floor(size * .84), join(work, `icon-${size}.png`));
    // A square of .54*size fits wholly inside the maskable .4*size circle.
    backed(size, Math.floor(size * .54), join(work, `icon-maskable-${size}.png`));
  }
  for (const destination of destinations) {
    copyFileSync(svg, out(`${destination}/favicon.svg`));
    for (const name of ['favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png']) copyFileSync(join(work, name), out(`${destination}/${name}`));
    writeFileSync(out(`${destination}/manifest.webmanifest`), JSON.stringify({
      id: '/', name: 'imperfect', short_name: 'imperfect', start_url: '/', scope: '/',
      display: 'standalone', background_color: '#000000', theme_color: '#000000',
      icons: [192, 512].flatMap(size => [
        { src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' },
        { src: `/icon-maskable-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'maskable' },
      ]),
    }, null, 2) + '\n');
  }
  // The native page is part of this same checkout: serve the website's icons, not copies.
  for (const name of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png', 'manifest.webmanifest']) {
    const link = out(`apps/code/native/public/${name}`);
    rmSync(link, { force: true });
    symlinkSync(relative(dirname(link), join(root, 'website', name)), link);
  }
  magick(square, '-resize', '160x160', ...PNG, out('locker/public/store/goat.png'));

  const res = 'phone/app/src/main/res';
  for (const [density, scale] of [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]) {
    // 108dp canvas, all nontransparent pixels within its central 66dp
    // safe circle, including interpolation fringes (one dp inset).
    const fit = 64 * scale / Math.hypot(...bounds);
    const [w, h] = bounds.map(n => Math.floor(n * fit));
    const foreground = out(`${res}/mipmap-${density}/ic_launcher_foreground.png`);
    magick(master, '-trim', '+repage', '-filter', 'Lanczos', '-resize', `${w}x${h}!`, '-background', 'none', '-gravity', 'center', '-extent', `${108 * scale}x${108 * scale}`, ...PNG, foreground);
    // The themed launcher paints this alpha mask with its own system colours.
    magick(foreground, '-channel', 'RGB', '-evaluate', 'set', '100%', '+channel', ...PNG, out(`${res}/mipmap-${density}/ic_launcher_monochrome.png`));
    backed(48 * scale, Math.floor(38 * scale), out(`${res}/mipmap-${density}/ic_launcher.png`));
    copyFileSync(out(`${res}/mipmap-${density}/ic_launcher.png`), out(`${res}/mipmap-${density}/ic_launcher_round.png`));
  }
} finally { rmSync(work, { recursive: true, force: true }); }
console.log('J06 favicon, PWA, store and Android icons generated.');
