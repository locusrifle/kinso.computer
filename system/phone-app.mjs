// The phone app, from the computer it talks to. The phone asks what the
// current APK is (the one main pins in binaries.json) and, when it is not the
// one installed, fetches it here and offers to install it: an update reaches a
// phone anywhere on the tailnet, no cable and no store key needed.
//
//   GET /phone              -> what the QR from `./install.sh phone` opens on
//                              the phone: a button that opens the app on this
//                              computer (imperfect://<host>), or, with no app
//                              yet, downloads it
//   GET /phone/android.json -> { sha256, size }
//   GET /phone/android.apk  -> the APK, from the downloads on this computer
//                              (the store's, or install.sh's), or the PC's
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.apk$/;

// `authority()` answers the PC's URL when this computer is not it, else null.
export function createPhoneApp({
  root = new URL('..', import.meta.url).pathname,
  downloads = [
    join(process.env.IMPERFECT_PREFIX || join(homedir(), '.imperfect'), 'product', 'downloads'),
    join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'imperfect-code', 'downloads'),
  ],
  authority = async () => null,
} = {}) {
  async function pinned() {
    const android = JSON.parse(await readFile(join(root, 'binaries.json'), 'utf8')).android;
    return android && FILE.test(android.file ?? '') && /^[0-9a-f]{64}$/.test(android.sha256 ?? '') ? android : null;
  }

  return async function handle(req, res, path) {
    if (req.method === 'GET' && path === '/phone') return pairing(req, res);
    if (req.method !== 'GET' || !['/phone/android.json', '/phone/android.apk'].includes(path)) return false;
    const android = await pinned().catch(() => null);
    if (!android) { res.writeHead(404).end('no android app is pinned'); return true; }
    if (path === '/phone/android.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ sha256: android.sha256, size: android.size }));
      return true;
    }
    let full = null, here = null;
    for (const dir of [downloads].flat()) {
      here = await stat(join(dir, android.file)).catch(() => null);
      if (here?.isFile()) { full = join(dir, android.file); break; }
    }
    const headers = { 'content-type': 'application/vnd.android.package-archive', 'cache-control': 'no-store' };
    if (here?.isFile()) {
      res.writeHead(200, { ...headers, 'content-length': String(here.size) });
      createReadStream(full).on('error', () => res.destroy()).pipe(res);
      return true;
    }
    const url = await authority().catch(() => null);
    const upstream = url ? await fetch(`${url}/phone/android.apk`, { signal: AbortSignal.timeout(120_000) }).catch(() => null) : null;
    if (!upstream?.ok || !upstream.body) { res.writeHead(404).end('the android app is not on this computer'); return true; }
    const length = upstream.headers.get('content-length');
    res.writeHead(200, { ...headers, ...(length ? { 'content-length': length } : {}) });
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
    return true;
  };
}

// The camera opens this page in the phone's browser (the phone is on the
// tailnet, so it reaches this computer by the same name the app will use).
// Android only opens an app from a page by a tap, so it is one button: the
// app takes imperfect://<host> as this computer's address; without the app the
// browser follows the fallback and downloads it.
const HOST = /^[a-z0-9][a-z0-9.-]{0,252}(:\d{1,5})?$/i;

function pairing(req, res) {
  const host = String(req.headers.host ?? '');
  if (!HOST.test(host)) { res.writeHead(400).end('no address to pair with'); return true; }
  const apk = `https://${host}/phone/android.apk`;
  const open = `intent://${host}#Intent;scheme=imperfect;package=computer.imperfect.code;S.browser_fallback_url=${encodeURIComponent(apk)};end`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>imperfect</title>
<style>:root{--ground:#2c2525;--ink:#e6d9db;--bright:#f5ecee;--accent:#ff77c8;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--ground:#f2edf2;--ink:#1a1b26;--bright:#1a1b26;--accent:#c2187f;color-scheme:light}}
body{margin:0;min-height:100vh;display:grid;place-content:center;gap:20px;padding:28px;background:var(--ground);color:var(--ink);font:17px/1.45 system-ui,sans-serif}b{color:var(--bright)}a{color:var(--accent)}.open{display:block;padding:16px 28px;background:var(--accent);color:var(--ground);font-weight:600;text-align:center;text-decoration:none;border-radius:10px}</style>
<p>Open imperfect on this phone, connected to <b>${host.split(':')[0].split('.')[0]}</b>.</p>
<a class="open" href="${open}">Open imperfect</a>
<p>No app yet? <a href="${apk}">Get it</a>, install it, then come back here.</p>
`);
  return true;
}
