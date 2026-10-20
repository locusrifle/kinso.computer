// Paint one ttfx frame onto a 2d canvas, and decide what colour it is.
//
// The art is made of block characters, and a font would leave hairline seams
// between neighbouring blocks at fractional cell sizes. So the blocks are
// drawn as rectangles and only the characters the effects throw in along the
// way go through the text rasteriser.
//
// A `tint` replaces whatever colour an effect chose, because the wasm build
// takes an effect's name and nothing else.

const FLAG_BOLD = 1;
const FLAG_ITALIC = 2;
const FLAG_UNDERLINE = 4;
const FLAG_BLINK = 16;
const FLAG_HIDDEN = 32;
const FLAG_STRIKE = 64;

// Whatever an effect throws in is set in the same face as the letters.
const MONO_FAMILY = '"Omarchy Font", monospace';

// Fractions of a cell: [x, y, width, height]
const SOLIDS = new Map([
  [0x2588, [0, 0, 1, 1]],       // full
  [0x2580, [0, 0, 1, 0.5]],     // upper half
  [0x2584, [0, 0.5, 1, 0.5]],   // lower half
  [0x258c, [0, 0, 0.5, 1]],     // left half
  [0x2590, [0.5, 0, 0.5, 1]],   // right half
  [0x2596, [0, 0.5, 0.5, 0.5]],
  [0x2597, [0.5, 0.5, 0.5, 0.5]],
  [0x2598, [0, 0, 0.5, 0.5]],
  [0x259d, [0.5, 0, 0.5, 0.5]],
]);

function css(packed) {
  return `#${(packed & 0xffffff).toString(16).padStart(6, '0')}`;
}

// The frame is centred on the canvas, whether it is smaller than the canvas or
// larger, and these are the rows and columns of it that land inside.
function visibleBounds(metrics, frame) {
  const { cellWidth, cellHeight, cssWidth, cssHeight } = metrics;
  const { width, height } = frame;
  const offsetX = Math.floor((cssWidth - width * cellWidth) / 2);
  const offsetY = Math.floor((cssHeight - height * cellHeight) / 2);
  return {
    offsetX,
    offsetY,
    col0: Math.max(0, Math.floor(-offsetX / cellWidth)),
    col1: Math.min(width - 1, Math.ceil((cssWidth - offsetX) / cellWidth) - 1),
    row0: Math.max(0, Math.floor(-offsetY / cellHeight)),
    row1: Math.min(height - 1, Math.ceil((cssHeight - offsetY) / cellHeight) - 1),
  };
}

export function paintFrame(ctx, metrics, frame, { blinkOn = true, tint = null } = {}) {
  const { cellWidth, cellHeight, fontSize, cssWidth, cssHeight } = metrics;
  const { symbols, fg, bg, flags, width, height } = frame;

  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const { offsetX, offsetY, col0, col1, row0, row1 } = visibleBounds(metrics, frame);

  let fill = '';
  const setFill = (color) => {
    if (fill !== color) {
      ctx.fillStyle = color;
      fill = color;
    }
  };

  let textFont = '';
  const setFont = (spec) => {
    if (textFont !== spec) {
      ctx.font = spec;
      textFont = spec;
    }
  };
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  for (let row = row0; row <= row1; row++) {
    const y = offsetY + row * cellHeight;
    for (let col = col0; col <= col1; col++) {
      const index = row * width + col;
      const cellFlags = flags[index] ?? 0;
      const x = offsetX + col * cellWidth;

      const background = bg[index] ?? 0;
      if ((background & 0xffffff) !== 0) {
        setFill(css(background));
        ctx.fillRect(x, y, cellWidth + 1, cellHeight + 1);
      }

      const cp = symbols[index] ?? 32;
      if (cp === 32 || cp === 0) continue;
      if ((cellFlags & FLAG_HIDDEN) !== 0) continue;
      if ((cellFlags & FLAG_BLINK) !== 0 && !blinkOn) continue;

      const chosen = fg[index] ?? 0xffffff;
      setFill(css(tint === null ? chosen : tint(chosen, col, row, width)));

      const solid = SOLIDS.get(cp);
      if (solid !== undefined) {
        // Overdraw by a pixel so neighbouring blocks cannot show a seam.
        const w = solid[2] === 1 ? cellWidth + 1 : cellWidth * solid[2];
        const h = solid[3] === 1 ? cellHeight + 1 : cellHeight * solid[3];
        ctx.fillRect(x + cellWidth * solid[0], y + cellHeight * solid[1], w, h);
        continue;
      }

      const bold = (cellFlags & FLAG_BOLD) !== 0;
      const italic = (cellFlags & FLAG_ITALIC) !== 0;
      setFont(`${italic ? 'italic ' : ''}${bold ? '700' : '400'} ${fontSize}px ${MONO_FAMILY}`);
      ctx.fillText(String.fromCodePoint(cp), x + cellWidth / 2, y + cellHeight / 2);

      if ((cellFlags & FLAG_UNDERLINE) !== 0) {
        ctx.fillRect(x, y + cellHeight - Math.max(1, cellHeight * 0.08), cellWidth, Math.max(1, cellHeight * 0.06));
      }
      if ((cellFlags & FLAG_STRIKE) !== 0) {
        ctx.fillRect(x, y + cellHeight / 2, cellWidth, Math.max(1, cellHeight * 0.06));
      }
    }
  }
}
