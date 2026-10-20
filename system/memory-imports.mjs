// Private, per-native-path provenance. Install the manifest BEFORE the log.
// A broken manifest blocks only its import; missing means an ordinary log.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const absolute = path => typeof path === 'string' && isAbsolute(path) && normalize(path) === path && !/[\x00-\x1f\x7f]/.test(path);
const native = path => absolute(path) && /\/(?:\.imperfect\/data\/state\/sessions|\.pi\/agent\/sessions|\.claude\/projects)\/.+\.jsonl$/.test(path)
  && !path.includes('/subagents/');
const fields = ['version', 'path', 'machine', 'originalPath', 'recordCount', 'byteCutoff', 'originalHash', 'importedHash', 'importedAt'];
const problem = message => new Error(`memory import: ${message}`);

export const importManifestPath = (dir, path) => join(dir, 'imports', `${sha(path)}.json`);

export async function readMemoryImport(dir, path) {
  const file = importManifestPath(dir, path);
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw problem('manifest unreadable'); }
  if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw problem('manifest must be an owned private regular file');
  let entry;
  try { entry = JSON.parse(await readFile(file, 'utf8')); } catch { throw problem('malformed manifest'); }
  return validateEntry(entry, path);
}

// Archived Durable snapshots carry this same manifest in memory's private
// collection index. Validate its structure again, even without a native file.
function validateEntry(entry, path = entry?.path) {
  if (!object(entry) || Object.keys(entry).length !== fields.length || fields.some(key => !Object.hasOwn(entry, key))
    || entry.version !== 1 || entry.path !== path || !native(path) || entry.machine !== 'laptop' || !native(entry.originalPath)
    || !Number.isSafeInteger(entry.recordCount) || entry.recordCount < 1
    || !Number.isSafeInteger(entry.byteCutoff) || entry.byteCutoff < 1
    || !/^[0-9a-f]{64}$/.test(entry.originalHash) || !/^[0-9a-f]{64}$/.test(entry.importedHash)
    || typeof entry.importedAt !== 'string' || !Number.isFinite(Date.parse(entry.importedAt))) throw problem('invalid manifest fields');
  return entry;
}

// Validate the derivative prefix, never the original. Pass the whole stream
// through so readers retain headers, parents, compactions and tool context.
// No parsed session is returned if this generator fails, hence no old calls.
export async function* importedBytes(bytes, entry) {
  validateEntry(entry);
  const digest = createHash('sha256');
  let remaining = entry.byteCutoff, records = 0, parts = [], size = 0, last = -1;
  const record = () => {
    const text = Buffer.concat(parts, size).toString('utf8').trim();
    parts = []; size = 0;
    if (!text) return;
    try { if (!object(JSON.parse(text))) throw new Error(); } catch { throw problem('invalid historical JSON record'); }
    records++;
  };
  for await (const chunk of bytes) {
    if (remaining) {
      const prefix = chunk.subarray(0, Math.min(remaining, chunk.length));
      digest.update(prefix);
      remaining -= prefix.length;
      if (prefix.length) last = prefix.at(-1);
      let start = 0, end;
      while ((end = prefix.indexOf(10, start)) !== -1) {
        parts.push(prefix.subarray(start, end)); size += end - start; record(); start = end + 1;
      }
      if (start < prefix.length) { parts.push(prefix.subarray(start)); size += prefix.length - start; }
      if (!remaining) {
        if (last !== 10 || size) throw problem('historical prefix must end with LF');
        if (records !== entry.recordCount) throw problem('historical record count mismatch');
        if (digest.digest('hex') !== entry.importedHash) throw problem('historical prefix hash mismatch');
      }
    }
    yield chunk;
  }
  if (remaining) throw problem('truncated historical prefix');
}

export async function validateMemoryImport(path, entry) {
  for await (const _ of importedBytes(createReadStream(path, { end: entry.byteCutoff - 1 }), entry)) { /* prefix validation only */ }
}
