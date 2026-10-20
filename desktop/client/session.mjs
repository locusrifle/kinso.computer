import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

// No plaintext fallback: Electron's Linux basic_text backend is NOT encryption.
export function canRemember(safeStorage) {
  return safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}
export async function saveGrant(path, grant, safeStorage) {
  if (!canRemember(safeStorage)) {
    await forgetGrant(path); // A session-only new account must not restore an older saved account later.
    return false;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, safeStorage.encryptString(JSON.stringify(grant)), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
  return true;
}
export async function loadGrant(path, safeStorage) {
  if (!canRemember(safeStorage)) return null;
  try { return JSON.parse(safeStorage.decryptString(await readFile(path))); } catch { return null; }
}
export async function forgetGrant(path) { await rm(path, { force: true }); await rm(`${path}.tmp`, { force: true }); }
