import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

// A tiny decoder for the deterministic 8-bit RGBA assets the generator emits.
export function rgbaOf(png) {
  assert.equal(png.toString('latin1', 1, 4), 'PNG');
  let at = 8, width = 0, height = 0;
  const data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at), type = png.toString('latin1', at + 4, at + 8), body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      [width, height] = [body.readUInt32BE(0), body.readUInt32BE(4)];
      assert.deepEqual([body[8], body[9], body[12]], [8, 6, 0], '8-bit RGBA, not interlaced');
    }
    if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data)), stride = width * 4, rows = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? line[x - 4] : 0, b = previous[x], c = x >= 4 ? previous[x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[x] = (line[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter]) & 255;
    }
    rows.push(line);
    previous = line;
  }
  return { width, height, pixel: (x, y) => [...rows[y].subarray(x * 4, x * 4 + 4)], alpha: (x, y) => rows[y][x * 4 + 3] };
}
