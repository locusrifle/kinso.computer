// A project's page with no dev script of its own (system/projects.mjs): its
// folder, served as it is on loopback, a folder's index.html at its address.
//
//   node system/project-page.mjs <folder> <port>

import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { MIME, sendRange } from './files.mjs';

const [root, port] = process.argv.slice(2);
createServer(async (req, res) => {
  let path;
  try { path = normalize(decodeURIComponent(new URL(req.url, 'http://page').pathname)); } catch { res.writeHead(400).end(); return; }
  // normalize takes every ../ to the top, which is the folder's own.
  let full = join(root, path);
  let info = await stat(full).catch(() => null);
  if (info?.isDirectory()) {
    if (!path.endsWith('/')) { res.writeHead(301, { location: `${path}/` }).end(); return; }
    full = join(full, 'index.html');
    info = await stat(full).catch(() => null);
  }
  if (!info?.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found\n'); return; }
  sendRange(req, res, full, info.size, { 'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
}).listen(Number(port), '127.0.0.1');
