import { crc32, deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

// Real RGB PNGs with valid CRCs; camera-sized noise does not compress away.
export function noisePNG(width = 1, height = 1) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0); out.write(type, 4); data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, data.length + 8)), data.length + 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), randomBytes(width * 3)])));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// Standard 24-bit Windows BMP, also accepted by the former browser decoder.
export function tinyBMP() {
  const bytes = Buffer.alloc(58);
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(1, 18); bytes.writeInt32LE(1, 22);
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes[56] = 255;
  return bytes;
}
