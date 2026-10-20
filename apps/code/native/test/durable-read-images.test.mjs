import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initSync, PhotonImage } from '@silvia-odwyer/photon/photon_rs.js';
import { fixture, answer } from './durable-fixture.mjs';
import { SettingsManager } from '@earendil-works/pi-coding-agent';

function jpeg(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(x < width / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], (y * width + x) * 4);
  const image = new PhotonImage(pixels, width, height);
  try { return image.get_bytes_jpeg(95); } finally { image.free(); }
}
function rotated(bytes) {
  // APP1 Exif, little-endian TIFF: one SHORT orientation tag, value 6 (90° clockwise).
  const exif = Buffer.alloc(32);
  exif.write('Exif\0\0'); exif.write('II', 6); exif.writeUInt16LE(42, 8); exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(1, 14); exif.writeUInt16LE(0x112, 16); exif.writeUInt16LE(3, 18);
  exif.writeUInt32LE(1, 20); exif.writeUInt16LE(6, 24);
  return Buffer.concat([bytes.subarray(0, 2), Buffer.from([0xff, 0xe1, 0, 34]), exif, bytes.subarray(2)]);
}
function bmp() {
  const bytes = Buffer.alloc(54 + 4 * 4 * 3);
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10); bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(4, 18); bytes.writeInt32LE(4, 22); bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(48, 34);
  for (let i = 54; i < bytes.length; i += 3) bytes[i + 2] = 255;
  return bytes;
}
function decode(block) {
  const image = PhotonImage.new_from_byteslice(Buffer.from(block.data, 'base64'));
  try { return { width: image.get_width(), height: image.get_height(), pixels: image.get_raw_pixels() }; }
  finally { image.free(); }
}

test('interactive and worker reads resize JPEG, convert BMP and orient EXIF without altering files', { timeout: 60_000 }, async t => {
  initSync({ module: await readFile(createRequire(import.meta.url).resolve('@silvia-odwyer/photon/photon_rs_bg.wasm')) });
  const dir = await mkdtemp(join(tmpdir(), 'durable-read-images-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = { 'large.jpg': jpeg(4000, 3000), 'small.bmp': bmp(), 'rotated.jpg': rotated(jpeg(48, 32)) };
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
  const cases = [...Object.keys(files).map(name => [name, true]), ['large.jpg', false]];
  for (const worker of [false, true]) for (const [name, autoResize] of cases) {
    await t.test(`${worker ? 'worker' : 'interactive'}: ${name}${autoResize ? '' : ' (resize disabled)'}`, async t => {
      const { runtime: r, idle, seen } = await fixture(t, {
        serviceOptions: { worker, settingsManager: SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol', retry: { enabled: false }, compaction: { enabled: false }, images: { autoResize } }) },
        respond: (model, _messages, count) => count === 1
          ? answer(model, [{ type: 'toolCall', id: 'picture', name: 'read', arguments: { path: join(dir, name) } }], 'toolUse')
          : answer(model),
      });
      await r.command({ type: 'prompt', text: `inspect ${name}` });
      await idle();
      const result = r.snapshot().messages.find(message => message.role === 'toolResult');
      assert.ok(result);
      assert.equal(result.isError, false, JSON.stringify(result.content));
      assert.equal(seen.length, 2);
      const image = seen[1].messages.find(message => message.role === 'toolResult').content.find(block => block.type === 'image');
      assert.ok(image, 'the next model request must contain the read image');
      assert.ok(image.data.length <= 4.5 * 1024 * 1024);
      const decoded = decode(image);
      if (name === 'large.jpg') {
        assert.equal(decoded.width, autoResize ? 2000 : 4000); assert.equal(decoded.height, autoResize ? 1500 : 3000);
      } else if (name === 'small.bmp') {
        assert.equal(image.mimeType, 'image/png');
        assert.equal(decoded.width, 4); assert.equal(decoded.height, 4);
      } else {
        assert.equal(decoded.width, 32); assert.equal(decoded.height, 48);
        const pixel = y => [...decoded.pixels.subarray((y * decoded.width + 16) * 4, (y * decoded.width + 16) * 4 + 3)].map(value => value > 127 ? 255 : 0);
        assert.deepEqual(pixel(8), [255, 0, 0]);
        assert.deepEqual(pixel(40), [0, 0, 255]);
      }
      assert.deepEqual(await readFile(join(dir, name)), Buffer.from(files[name]));
    });
  }
});
