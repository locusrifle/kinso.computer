import { createWriteStream, constants } from 'node:fs';
import { mkdir, unlink, link, open, lstat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { pictureSize } from './images.mjs';
import { getSessionToken } from '../../../system/session-token.mjs';

// Originals stay in the captured session's uploads folder. Commands carry only
// scoped references; image bytes are prepared at the harness boundary.
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
// 1 GiB on a slow phone can outlast Node's 300s requestTimeout. Upload time is
// owned here; other routes keep a 300s body deadline of their own.
export const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
export const OTHER_POST_TIMEOUT_MS = 300_000;

export function sanitizeUploadName(name) {
  const base = String(name ?? '').replace(/^.*[/\\]/, '').replace(/[^\w.+-]+/g, '_') || 'file';
  return base.slice(0, 180) || 'file';
}

export function filenameFromHeader(raw) {
  if (raw == null || raw === '') return 'file';
  const text = String(Array.isArray(raw) ? raw[0] : raw).replace(/[\r\n]/g, '');
  try { return decodeURIComponent(text); }
  catch { return text; }
}

export function uniqueUploadName(originalName, id = randomUUID()) {
  const safe = sanitizeUploadName(originalName);
  const ext = extname(safe);
  const stem = basename(safe, ext) || 'file';
  return `${stem}-${id}${ext}`;
}

function statusError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createPartStream(path) {
  const stream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  let failed = null;
  let rejectFailure = () => {};
  const failure = new Promise((_, reject) => {
    rejectFailure = (error) => {
      if (failed) return;
      failed = error;
      reject(error);
    };
  });
  failure.catch(() => {});
  stream.on('error', rejectFailure);
  return {
    stream,
    failure,
    error: () => failed,
    async waitOpen() {
      await Promise.race([once(stream, 'open'), failure]);
      if (failed) throw failed;
    },
    async write(chunk) {
      if (failed) throw failed;
      if (!stream.write(chunk)) await Promise.race([once(stream, 'drain'), failure]);
      if (failed) throw failed;
    },
    async end() {
      if (failed) throw failed;
      stream.end();
      await Promise.race([finished(stream), failure]);
      if (failed) throw failed;
    },
    destroy() {
      stream.destroy();
    },
  };
}

export async function receiveHttpUpload(req, options = {}) {
  const cwd = options.cwd;
  const filename = options.filename ?? filenameFromHeader(req.headers?.['x-filename']);
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw statusError(413, 'file too large');

  const dir = join(cwd, 'uploads');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw statusError(400, 'uploads must be a directory, not a symlink');
  const part = join(dir, `.upload-${randomUUID()}.part`);

  const res = options.res;
  let timedOut = false;
  let clientGone = false;
  const ac = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
    if (res && !res.headersSent) res.writeHead(408).end('timeout');
    req.destroy?.();
  }, timeoutMs);
  const onAbort = () => { clientGone = true; ac.abort(); };
  req.once?.('aborted', onAbort);

  const out = createPartStream(part);
  try {
    await out.waitOpen();
    let written = 0;
    for await (const chunk of req) {
      if (ac.signal.aborted) break;
      if (out.error()) throw out.error();
      written += chunk.length;
      if (written > maxBytes) throw statusError(413, 'file too large');
      await out.write(chunk);
    }
    if (ac.signal.aborted) {
      throw timedOut ? statusError(408, 'timeout') : statusError(499, 'aborted');
    }
    if (out.error()) throw out.error();
    if (Number.isFinite(declared) && written !== declared) throw statusError(400, 'incomplete upload');
    await out.end();

    let lastExist = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const name = (attempt === 0 && options.uniqueName) ? options.uniqueName : uniqueUploadName(filename);
      const dest = join(dir, name);
      try {
        await link(part, dest);
        await unlink(part).catch(() => {});
        return { path: dest, name, originalName: sanitizeUploadName(filename), size: written };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        lastExist = error;
      }
    }
    throw lastExist ?? statusError(500, 'upload name collision');
  } catch (error) {
    out.destroy();
    await unlink(part).catch(() => {});
    if (error.status) throw error;
    if (timedOut) throw statusError(408, 'timeout');
    if (clientGone || req.aborted || error.name === 'AbortError') throw statusError(499, 'aborted');
    throw error;
  } finally {
    clearTimeout(timer);
    req.off?.('aborted', onAbort);
  }
}

// Captured identities are a routing guard, not a separate filesystem ACL: the
// person and their agents already own this cwd. Never accept an arbitrary path.
// Keep the seal across ordinary restarts with the existing private session
// token, not another key file or attachment registry. SID references are durable;
// null-SID references still require the original host lifetime and tab below.
const seal = async (reference, { cwd, referenceKey }) => createHmac('sha256', await getSessionToken(referenceKey))
  .update('imperfect/upload-reference/v1\0')
  .update(JSON.stringify([cwd, reference.name, reference.tabId, reference.sessionId ?? null, reference.instanceId])).digest();
export async function uploadReference(saved, target) {
  const reference = { name: saved.name, tabId: target.tabId, sessionId: target.sessionId ?? null, instanceId: target.instanceId };
  return { ...reference, seal: (await seal(reference, target)).toString('hex') };
}

export async function openUpload(reference, target, maxBytes = MAX_UPLOAD_BYTES) {
  const { cwd, tabId, sessionId, instanceId } = target;
  if (!reference || typeof reference.name !== 'string' || !/^[\w.+-]+-[0-9a-f-]{36}(?:\.[\w.+-]+)?$/.test(reference.name)
    || reference.name.length > 220) throw statusError(400, 'invalid attachment reference');
  const supplied = Buffer.from(typeof reference.seal === 'string' && /^[0-9a-f]{64}$/.test(reference.seal) ? reference.seal : '', 'hex');
  const expected = await seal(reference, target);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw statusError(409, 'attachment seal does not match this computer or folder; attach it again');
  if (reference.sessionId != null ? reference.sessionId !== sessionId
    : !reference.instanceId || reference.instanceId !== instanceId || reference.tabId !== tabId) throw statusError(409, 'attachment belongs to another session');
  const dir = join(cwd, 'uploads');
  if (!(await lstat(dir)).isDirectory()) throw statusError(400, 'invalid uploads directory');
  const path = join(dir, reference.name);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw statusError(400, 'attachment is not a regular file');
    if (stat.size > maxBytes) throw statusError(413, 'attachment too large for this operation');
    return { file, path };
  } catch (error) { await file.close(); throw error; }
}

export async function resolvePromptUploads(command, target, { resize } = {}) {
  const refs = command.attachments ?? [];
  if (!Array.isArray(refs) || refs.length > 8) throw statusError(400, 'attach at most 8 files');
  let text = typeof command.text === 'string' ? command.text : '';
  const images = Array.isArray(command.images) ? command.images.filter(img => img?.type === 'image' && typeof img.data === 'string' && typeof img.mimeType === 'string').slice(0, 8) : [];
  if (images.length + refs.filter(ref => ref?.kind === 'image').length > 8) throw statusError(400, 'attach at most 8 images');
  for (const ref of refs) {
    if (!['image', 'file'].includes(ref?.kind)) throw statusError(400, 'invalid attachment kind');
    const { file, path } = await openUpload(ref.reference, target, ref.kind === 'image' ? 32 * 1024 * 1024 : MAX_UPLOAD_BYTES);
    try {
      if (ref.kind === 'image') {
        let bytes = await file.readFile();
        // MIME comes from bytes, never an extension or a client-supplied type.
        let mimeType = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg'
          : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
          : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString()) ? 'image/gif'
          : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
          : bytes.toString('ascii', 0, 2) === 'BM' ? 'image/bmp' : null;
        const bitmapSize = mimeType === 'image/bmp' && bytes.length >= 26
          ? bytes.readUInt32LE(14) === 12 ? [bytes.readUInt16LE(18), bytes.readUInt16LE(20)]
            : bytes.length >= 54 && bytes.readUInt32LE(14) >= 40 ? [bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22))] : null
          : null;
        const size = bitmapSize ?? (mimeType === 'image/gif' && bytes.length >= 10 ? [bytes.readUInt16LE(6), bytes.readUInt16LE(8)] : pictureSize(bytes));
        if (size && (size[0] <= 0 || size[1] <= 0 || size[0] * size[1] > 64 * 1024 * 1024)) throw statusError(413, 'picture exceeds the 64 megapixel preview limit; original saved in uploads');
        if (mimeType === 'image/bmp') {
          if (!bitmapSize) throw statusError(422, 'unsupported bitmap header; original saved in uploads');
          // The former browser canvas decoded BMP. Use the SDK's existing
          // converter so moving preparation to the owner preserves that vision.
          const converted = await (await import('@earendil-works/pi-coding-agent')).convertToPng(bytes.toString('base64'), mimeType);
          if (!converted) throw statusError(422, 'could not prepare bitmap; original saved in uploads');
          bytes = Buffer.from(converted.data, 'base64'); mimeType = converted.mimeType;
        }
        if (!mimeType) throw statusError(422, 'unsupported picture; original saved in uploads');
        const prepare = resize ?? (await import('@earendil-works/pi-coding-agent')).resizeImage;
        const made = await prepare(bytes, mimeType, { maxWidth: 1600, maxHeight: 1600, maxBytes: 1024 * 1024 });
        if (!made || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(made.mimeType) || made.data.length > 1024 * 1024) throw statusError(422, 'could not prepare picture; original saved in uploads');
        images.push({ type: 'image', data: made.data, mimeType: made.mimeType });
      }
      text = [text.trim(), `[uploaded ${ref.kind === 'image' ? 'image original' : 'file'}: ${path}]`].filter(Boolean).join('\n\n');
    } finally { await file.close(); }
  }
  return { text: text.trim(), images };
}

export async function readAttachmentJson(req) {
  let size = 0;
  const chunks = [];
  const timer = setTimeout(() => req.destroy?.(statusError(408, 'attachment request timed out')), OTHER_POST_TIMEOUT_MS);
  try {
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > 1024 * 1024) throw statusError(413, 'attachment request too large');
      chunks.push(Buffer.from(chunk));
    }
  } finally { clearTimeout(timer); }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw statusError(400, 'attachment request must be JSON'); }
}
