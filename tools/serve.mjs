// A static file server for the website, with no dependencies.
// Module imports and the wasm need a real origin, so file:// will not do.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}));

export function serveDirectory(root, { port = 0, host = '127.0.0.1' } = {}) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    // normalize collapses any ../ before it can escape the root.
    let pathname = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (pathname.endsWith('/')) pathname += 'index.html';

    const file = join(root, pathname);
    try {
      const info = await stat(file);
      if (info.isDirectory()) {
        response.writeHead(301, { location: `${pathname}/` });
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': TYPES.get(extname(file)) ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found\n');
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : port;
      resolve({ server, port: bound, origin: `http://${host}:${bound}` });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('../website/', import.meta.url).pathname;
  const port = Number(process.env.PORT ?? 4321);
  const { origin } = await serveDirectory(root, { port });
  process.stdout.write(`${origin}\n`);
}
