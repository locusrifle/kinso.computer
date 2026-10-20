// Block art for any word, read straight out of the Omarchy Font itself.
//
// The real screensaver animates a text file of ▀▄█ characters. Rather than
// keeping a hand-drawn copy of that file per word, this measures the font:
// rasterise the word at one square per half block, pair the rows, and the
// letters come back out as art.
//
// The Omarchy Font is grid-built -- unitsPerEm is 1000 and one terminal cell
// is 50x100 font units -- so its em is exactly twenty half blocks and asking
// for that reproduces its own art to the pixel, in every browser.

const SUB_ROWS = 20;                   // half blocks from the top of the band
const PAD_COLS = 2;                    // room for negative left bearings
const INK = 128;                       // half covered is covered

// index = top | bottom << 1
const BLOCKS = [' ', '▀', '▄', '█'];

// The one face everything is set in. Grid-built: unitsPerEm is 1000 and one
// terminal cell is 50x100 font units, so its em is exactly twenty half blocks.
export const FONT = {
  family: 'Omarchy Font',
  url: new URL('../fonts/omarchy-font.ttf', import.meta.url).href,
  weight: 400,
  em: 20,        // the em, in half blocks
  ascent: 18,    // half blocks above the baseline
};

// The band a font is drawn into: how big to set it, and where its baseline
// goes, so that SUB_ROWS half blocks hold it.
function band(font, scale) {
  return { fontSize: scale * font.em, baseline: font.ascent * scale, height: SUB_ROWS * scale };
}

function sampler(word, font, scale) {
  const measure = document.createElement('canvas').getContext('2d');
  if (measure === null) throw new Error('2d canvas is unavailable');

  const { fontSize, baseline, height } = band(font, scale);
  const spec = `${font.weight} ${fontSize}px "${font.family}"`;
  measure.font = spec;

  const advance = measure.measureText(word).width;
  const cols = Math.ceil(advance / scale) + PAD_COLS * 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, cols * scale);
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('2d canvas is unavailable');

  ctx.font = spec;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.fillText(word, PAD_COLS * scale, baseline);

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const stride = canvas.width * 4;
  const area = scale * scale;

  return {
    cols,
    covered(col, subRow) {
      let total = 0;
      for (let y = 0; y < scale; y++) {
        const row = subRow * scale + y;
        if (row >= canvas.height) break;
        let offset = row * stride + col * scale * 4 + 3;
        for (let x = 0; x < scale; x++, offset += 4) total += data[offset];
      }
      return total / area >= INK;
    },
  };
}

// The padding column and the first letter's side bearing are both margin, and
// a margin baked into the art would push the mark off centre on the canvas.
function dedent(lines) {
  let indent = Infinity;
  for (const line of lines) {
    if (line === '') continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(indent) || indent === 0) return lines;
  return lines.map((line) => line.slice(indent));
}

// Sampling at scale 1 would land every edge on a pixel boundary and let
// antialiasing decide; 4px per half block leaves the threshold no room to
// be wrong.
export function wordmarkArt(word, { font = FONT, scale = 4 } = {}) {
  if (word === '') return '';
  const { cols, covered } = sampler(word, font, scale);

  const lines = [];
  for (let row = 0; row * 2 < SUB_ROWS; row++) {
    let line = '';
    for (let col = 0; col < cols; col++) {
      const top = covered(col, row * 2) ? 1 : 0;
      const bottom = covered(col, row * 2 + 1) ? 2 : 0;
      line += BLOCKS[top | bottom];
    }
    lines.push(line.replace(/\s+$/, ''));
  }

  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return dedent(lines).join('\n');
}

export async function loadFont(font = FONT) {
  if (typeof FontFace !== 'function' || document.fonts == null) return false;
  const face = new FontFace(font.family, `url("${font.url}") format("truetype")`, { weight: String(font.weight) });
  await face.load();
  document.fonts.add(face);
  return true;
}

// Where a word's own ink starts and ends, in the full SUB_ROWS band every
// word is sampled into and on the same baseline as every other word in its
// font -- and its horizontal margin, which is not shared, because nothing
// needs it to be.
function inkBounds(cols, covered) {
  let top = -1;
  let bottom = -1;
  let left = cols;
  let right = -1;
  for (let sub = 0; sub < SUB_ROWS; sub++) {
    for (let col = 0; col < cols; col++) {
      if (!covered(col, sub)) continue;
      if (top === -1) top = sub;
      bottom = sub;
      if (col < left) left = col;
      if (col > right) right = col;
    }
  }
  return top === -1 ? null : { top, bottom, left, right };
}

// Stack several words into one block of art, each centred on the widest.
//
// Every word is sampled into the same SUB_ROWS band on the same baseline, so
// stacking that whole band, gap and all, gives every pair of words the same
// distance baseline to baseline -- which is what even line spacing actually
// is. Trimming each word down to its own ink first and spacing the trimmed
// boxes equally does not: two lines a fixed distance apart still read as
// unevenly spaced if one of them is shorter, because "always" reaches
// neither as high nor as low as "one" does and trimming throws that
// difference away instead of leaving it where the eye expects it, in the
// slack around the word rather than the pitch of the lines.
//
// Only the two outer edges of the whole stack -- the top of the first word
// and the bottom of the last -- are trimmed, so the block does not carry a
// full line of empty margin it has no baseline on the other side to answer
// to.
export function stackWordmarks(words, { font = FONT, gap = 4, scale = 4 } = {}) {
  const samples = words
    .map((word) => {
      const { cols, covered } = sampler(word, font, scale);
      const bounds = inkBounds(cols, covered);
      return bounds === null ? null : { covered, bounds };
    })
    .filter((sample) => sample !== null);
  if (samples.length === 0) return '';
  const width = Math.max(...samples.map(({ bounds }) => bounds.right - bounds.left + 1));

  // One entry per half block down the whole stack: a lookup for an inked
  // word row, or null for a row of gap.
  const halfBlocks = [];
  samples.forEach(({ covered, bounds }, index) => {
    if (index > 0) for (let i = 0; i < gap; i++) halfBlocks.push(null);
    const blockWidth = bounds.right - bounds.left + 1;
    const indent = Math.floor((width - blockWidth) / 2);
    const top = index === 0 ? bounds.top : 0;
    const bottom = index === samples.length - 1 ? bounds.bottom : SUB_ROWS - 1;
    for (let sub = top; sub <= bottom; sub++) {
      halfBlocks.push((col) => {
        const local = col - indent;
        return local >= 0 && local < blockWidth && covered(local + bounds.left, sub);
      });
    }
  });

  const lines = [];
  for (let i = 0; i < halfBlocks.length; i += 2) {
    let line = '';
    for (let col = 0; col < width; col++) {
      const top = halfBlocks[i] !== null && halfBlocks[i](col) ? 1 : 0;
      const bottom = i + 1 < halfBlocks.length && halfBlocks[i + 1] !== null && halfBlocks[i + 1](col) ? 2 : 0;
      line += BLOCKS[top | bottom];
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}
