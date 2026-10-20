// A QR code for a short text, drawn in the terminal: what `./install.sh phone`
// shows so the phone's own camera can pair with this computer.
//
// Byte mode, error correction L, versions 1 to 5 (up to 106 bytes): enough for
// a machine's Tailscale address, and small enough to need no library.
//
//   qr('https://desk.tail-name.ts.net/phone')  -> rows of booleans (true = dark)
//   node system/qr.mjs <text>                  -> prints it in the terminal

import { fileURLToPath } from 'node:url';

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++, x = (x << 1) ^ (x & 128 ? 0x11d : 0)) { EXP[i] = x; LOG[x] = i; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const times = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function correction(data, n) {
  let poly = [1];
  for (let i = 0; i < n; i++) poly = [...poly, 0].map((c, j) => c ^ (j ? times(poly[j - 1], EXP[i]) : 0));
  const rest = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ rest.shift();
    rest.push(0);
    for (let j = 0; j < n; j++) rest[j] ^= times(poly[j + 1], factor);
  }
  return rest;
}

// [data codewords, correction codewords] at level L; one block each.
const VERSIONS = [null, [19, 7], [34, 10], [55, 15], [80, 20], [108, 26]];

export function qr(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const version = VERSIONS.findIndex(v => v && bytes.length <= v[0] - 2);
  if (version < 1) throw new Error('too long for a small QR code');
  const [dataWords, eccWords] = VERSIONS[version];

  const bits = [];
  const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(4, 4); put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataWords * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; words.length < dataWords; pad ^= 0xec ^ 0x11) words.push(pad);
  const stream = [...words, ...correction(words, eccWords)].flatMap(w => [7, 6, 5, 4, 3, 2, 1, 0].map(i => (w >>> i) & 1));

  const size = 17 + 4 * version;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, on) => { dark[y][x] = on; fixed[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  if (version > 1) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = mask => {
    const data = (1 << 3) | mask; // level L
    let rest = data;
    for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
    const word = ((data << 10) | rest) ^ 0x5412;
    const bit = i => ((word >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0); // reserves the format areas before the data goes in

  let next = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - step : step;
        if (!fixed[y][x]) dark[y][x] = stream[next++] === 1;
      }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const apply = mask => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) dark[y][x] = !dark[y][x];
  };
  let best = 0, lowest = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    apply(mask); format(mask);
    const score = penalty(dark);
    if (score < lowest) { lowest = score; best = mask; }
    apply(mask);
  }
  apply(best); format(best);
  return dark;
}

function penalty(dark) {
  const size = dark.length;
  let score = 0, count = 0;
  const lines = [...dark, ...dark.map((_, x) => dark.map(row => row[x]))];
  const finder = [true, false, true, true, true, false, true];
  for (const line of lines) {
    for (let i = 0, run = 1; i < size; i++, run++) {
      if (i === size - 1 || line[i] !== line[i + 1]) { if (run >= 5) score += run - 2; run = 0; }
    }
    for (let i = 0; i + 7 <= size; i++) {
      if (!finder.every((v, k) => line[i + k] === v)) continue;
      const light = (from, to) => { for (let k = from; k < to; k++) if (k >= 0 && k < size && line[k]) return false; return true; };
      if (light(i - 4, i)) score += 40;
      if (light(i + 7, i + 11)) score += 40;
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (dark[y][x]) count++;
    if (x && y && dark[y][x] === dark[y - 1][x] && dark[y][x] === dark[y][x - 1] && dark[y][x] === dark[y - 1][x - 1]) score += 3;
  }
  const total = size * size;
  return score + 10 * (Math.ceil(Math.abs(count * 20 - total * 10) / total) - 1);
}

// Two rows of modules per line of text, dark on white whatever the terminal's
// own colours, with a four-module margin.
export function terminal(text) {
  const dark = qr(text), size = dark.length, edge = 4;
  const at = (x, y) => x >= 0 && y >= 0 && x < size && y < size && dark[y][x];
  const lines = [];
  for (let y = -edge; y < size + edge; y += 2) {
    let line = '';
    for (let x = -edge; x < size + edge; x++) line += [' ', '▄', '▀', '█'][(at(x, y) ? 2 : 0) + (at(x, y + 1) ? 1 : 0)];
    lines.push(`\x1b[30;107m${line}\x1b[0m`);
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) console.log(terminal(process.argv[2]));
