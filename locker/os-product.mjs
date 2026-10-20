// OS releases are promoted by replacing one manifest after the immutable ISO
// and public git commit exist. Never serve arbitrary files in this directory.
import { constants } from 'node:fs';
import { open, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { KEY_PATTERN, OS_PRODUCT } from './store.mjs';
import { keyFromAuthorization, OS_REPO_NAME } from './git.mjs';

const run = promisify(execFile);
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.sort().join(',');

export function validOSRelease(value) {
  const iso = value?.installer;
  return exact(value, ['schema', 'version', 'repoCommit', 'installer']) && value.schema === 1
    && typeof value.version === 'string' && value.version.length > 0 && value.version.length <= 100
    && !/[\u0000-\u001f\u007f]/.test(value.version) && COMMIT.test(value.repoCommit)
    && exact(iso, ['file', 'sha256', 'bytes']) && HASH.test(iso.sha256)
    && iso.file === `imperfect-os-${iso.sha256}.iso` && Number.isSafeInteger(iso.bytes) && iso.bytes > 0;
}

export function isOSDownloadPath(path) {
  return path === '/os-release.json' || path === '/os/installer' || path.startsWith('/os/download/');
}

export function createOSProduct({ productDir, store, limiter, clientKey }) {
  // A digest cache only for unchanged open-file identities, never auth/results.
  const verified = new Set();
  return async function serveOS(req, res, path, search) {
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('vary', 'Authorization');
    res.setHeader('referrer-policy', 'no-referrer');
    const answer = (status, message, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
      res.end(`${message}\n`);
    };
    const queryKey = new URLSearchParams(search).get('key') ?? '';
    const key = KEY_PATTERN.test(queryKey) ? queryKey : keyFromAuthorization(req.headers.authorization, KEY_PATTERN);
    const license = store.activeLicense(key, OS_PRODUCT);
    if (!license) {
      if (!limiter.allow(`os-miss:${clientKey(req)}`)) return answer(429, 'slow down');
      return answer(403, 'this key does not open imperfect OS');
    }
    if (req.method !== 'GET') return answer(405, 'use GET or HEAD', { allow: 'GET, HEAD' });
    let release;
    try {
      if (!productDir) throw new Error('no product');
      const raw = await readFile(join(productDir, 'os-release.json'), 'utf8');
      if (raw.length > 4096) throw new Error('manifest too large');
      release = JSON.parse(raw);
      if (!validOSRelease(release)) throw new Error('bad manifest');
      const { stdout } = await run('git', ['--git-dir', join(productDir, OS_REPO_NAME), 'cat-file', '-t', release.repoCommit]);
      if (stdout.trim() !== 'commit') throw new Error('missing commit');
    } catch { return answer(503, 'the imperfect OS installer has not been published yet'); }
    const iso = release.installer;
    if (path.startsWith('/os/download/') && path.slice('/os/download/'.length) !== iso.file) return answer(404, 'no such OS installer');

    let file;
    try {
      const dir = join(productDir, 'os-downloads');
      const directory = await lstat(dir);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('invalid directory');
      file = await open(join(dir, iso.file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat({ bigint: true });
      if (!info.isFile() || info.size !== BigInt(iso.bytes)) throw new Error('invalid ISO');
      const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${iso.sha256}`;
      if (!verified.has(identity)) {
        const hash = createHash('sha256');
        for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
        if (hash.digest('hex') !== iso.sha256) throw new Error('checksum mismatch');
        const after = await file.stat({ bigint: true });
        if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) throw new Error('ISO changed');
        if (verified.size >= 4) verified.clear();
        verified.add(identity);
      }
    } catch {
      await file?.close().catch(() => {});
      return answer(503, 'the imperfect OS installer is unavailable; publication needs checking');
    }
    // Even metadata only advertises a file whose size and checksum were checked.
    if (path === '/os-release.json') {
      await file.close();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(release));
    }
    let start = 0;
    let end = iso.bytes - 1;
    const range = req.headers.range;
    if (range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, iso.bytes - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      }
      if (!match || !(match[1] || match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0) {
        await file.close();
        return answer(416, 'invalid range', { 'content-range': `bytes */${iso.bytes}` });
      }
    }
    store.countDownload(license.key);
    res.writeHead(range === undefined ? 200 : 206, {
      'content-type': 'application/octet-stream', 'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      'content-disposition': `attachment; filename="${iso.file}"`,
      ...(range === undefined ? {} : { 'content-range': `bytes ${start}-${end}/${iso.bytes}` }),
    });
    if (req.isHead) { await file.close(); return res.end(); }
    const stream = file.createReadStream({ start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };
}
