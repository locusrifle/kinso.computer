#!/usr/bin/env node
// Pins the Android app for members. It is built on the PC, not in git: this copies one to the store's downloads/
// under a name derived from its checksum, and records name, SHA-256 and size
// in binaries.json at the root of this checkout. Commit that with the change
// that needed it and push; install.sh fetches and checks exactly that file.
//
//   node locker/tools/pin.mjs --apk phone/app/build/outputs/apk/release/app-release.apk

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const ENTRIES = { '--apk': 'android' };

export async function pin({ entry, file, root = ROOT, product = join(homedir(), '.imperfect', 'product') }) {
  const body = await readFile(file);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const name = `imperfect-${entry}-${sha256.slice(0, 12)}${file.endsWith('.apk') ? '.apk' : ''}`;
  const downloads = join(product, 'downloads');
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  if (!existsSync(join(downloads, name))) await copyFile(file, join(downloads, name));
  const pinsPath = join(root, 'binaries.json');
  const pins = existsSync(pinsPath) ? JSON.parse(await readFile(pinsPath, 'utf8')) : {};
  pins[entry] = { file: name, sha256, size: body.length };
  await writeFile(pinsPath, `${JSON.stringify(pins, null, 2)}\n`);
  return pins[entry];
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [flag, file] = process.argv.slice(2);
  if (!ENTRIES[flag] || !file) {
    console.error('usage: pin.mjs --apk <file>');
    process.exit(1);
  }
  const pinned = await pin({ entry: ENTRIES[flag], file: resolve(file) });
  console.log(`pinned ${pinned.file}; commit binaries.json with the change and push`);
}
