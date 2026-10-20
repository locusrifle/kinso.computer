// A word as ▀▄█ block art out of the Omarchy Font, on a canvas, at rest.
// The art itself comes from the website's own modules; this only fits it to
// a box and paints it still, so it needs no WebAssembly and works on every
// name the locker answers for.

import { loadFont, stackWordmarks, wordmarkArt } from '/assets/js/wordmark.js';
import { paintFrame } from '/assets/js/paint.js';
import { measureArt, sizeCanvas } from '/assets/js/sequence.js';

// The font has to be the Omarchy Font or the art is of some other face.
// check() is true only when every face of that name has loaded, and
// locker.css declares one that loads only when text uses it, so it is asked
// for here too: with no heading set in it, the art was never drawn.
export async function fontReady() {
  try { await loadFont(); await document.fonts?.load?.('400 20px "Omarchy Font"'); } catch { return false; }
  return document.fonts?.check?.('400 20px "Omarchy Font"') ?? false;
}

// Every way the words can be set -- on one line, or one word to a line -- and
// the one that draws biggest in the box wins.
export function bestArt(words, width, height, { maxCell = 14, share = [0.9, 0.8] } = {}) {
  const options = [{ art: wordmarkArt(words.join(' ')), lines: [words.join(' ')] }];
  if (words.length > 1) options.push({ art: stackWordmarks(words, { gap: 4 }), lines: words });
  let best = null;
  for (const option of options) {
    const metrics = fit(option.art, width, height, { maxCell, share });
    if (best === null || metrics.cellWidth > best.metrics.cellWidth) best = { ...option, metrics };
  }
  return best;
}

// A grid of cells as big as the art allows, and a grid over the whole box so
// an effect has black to scatter into.
export function fit(art, cssWidth, cssHeight, { maxCell = 14, share = [0.9, 0.8] } = {}) {
  const { columns, rows } = measureArt(art);
  const cellWidth = Math.max(1, Math.min(maxCell, (cssWidth * share[0]) / columns, (cssHeight * share[1]) / (rows * 2)));
  const cellHeight = cellWidth * 2;
  return {
    cellWidth,
    cellHeight,
    fontSize: Math.max(1, Math.round(cellHeight / 1.2)),
    columns: Math.max(columns, Math.floor(cssWidth / cellWidth)),
    rows: Math.max(rows, Math.floor(cssHeight / cellHeight)),
    cssWidth,
    cssHeight,
  };
}

// The art centred on the grid in one colour, as a ttfx frame would carry it.
export function staticFrame(metrics, art, colour) {
  const { columns, rows } = metrics;
  const size = measureArt(art);
  const lines = art.split('\n');
  const count = columns * rows;
  const frame = { symbols: new Uint32Array(count).fill(32), fg: new Uint32Array(count), bg: new Uint32Array(count), flags: new Uint8Array(count), width: columns, height: rows };
  const originCol = Math.floor((columns - size.columns) / 2);
  const originRow = Math.floor((rows - size.rows) / 2);
  lines.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      const cp = ch.codePointAt(0);
      if (cp === 32) return;
      const at = (originRow + row) * columns + originCol + col;
      frame.symbols[at] = cp;
      frame.fg[at] = typeof colour === 'function' ? colour(col, row, size) : colour;
    });
  });
  return frame;
}

// Paint `words` into `canvas` and keep them fitted to it. Returns false when
// the font could not be had, and the page keeps its plain text title.
// `align: 'start'` sets it flush left instead of centred.
export async function drawStill(canvas, words, { colour = 0xffffff, maxCell = 14, share, align = 'center' } = {}) {
  if (!(await fontReady())) return false;
  const paint = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const { art, metrics } = bestArt(words, width, height, { maxCell, share });
    const ctx = sizeCanvas(canvas, width, height);
    if (align === 'start') {
      // A frame exactly the art's width, in a box exactly the frame's width,
      // lands at the left edge.
      metrics.columns = measureArt(art).columns;
      metrics.cssWidth = metrics.columns * metrics.cellWidth;
      ctx.clearRect(0, 0, width, height);
    }
    paintFrame(ctx, metrics, staticFrame(metrics, art, colour));
  };
  paint();
  new ResizeObserver(paint).observe(canvas);
  return true;
}
