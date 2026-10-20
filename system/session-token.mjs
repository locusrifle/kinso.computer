import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The existing private authority for local session callers. Attachment seals
// use a separate HMAC domain, never exposing the token to a window or a peer.
export async function getSessionToken(token, home = homedir()) {
  if (token !== undefined) return Buffer.from(token);
  const dir = join(home, '.imperfect'), path = join(dir, 'session-token');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, randomBytes(24).toString('hex'), { mode: 0o600, flag: 'wx' }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  const kept = Buffer.from((await readFile(path, 'utf8')).trim());
  if (!kept.length) throw new Error('private session token is empty');
  return kept;
}
