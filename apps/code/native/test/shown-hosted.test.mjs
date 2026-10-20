import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShown } from '../../../../system/shown.mjs';

const key = Symbol.for('imperfect.shown');
const get = (address, path) => new Promise((resolve, reject) => {
  const url = new URL(address);
  const req = request({ hostname: '127.0.0.1', port: url.port, path: path ?? url.pathname, headers: { host: url.host } }, res => {
    let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
  });
  req.on('error', reject); req.end();
});

test('hosted shown folders have native isolated loopback roots; only media crosses the door', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shown-hosted-')), before = globalThis[key];
  const app = join(root, 'app'), other = join(root, 'other');
  await mkdir(app); await mkdir(other);
  await writeFile(join(app, 'index.html'), '<script src="/app.js"></script><img src="/image.png">');
  await writeFile(join(app, 'app.js'), 'window.ready=true');
  await writeFile(join(app, 'image.png'), 'image');
  await writeFile(join(other, 'secret.html'), 'outside');
  await symlink(join(other, 'secret.html'), join(app, 'escape.html'));
  const views = [];
  const shown = createShown({ stateDir: join(root, 'state'), hosted: true, webOrigin: 'https://ada.imperfect.computer',
    servers: () => ({ list: () => [] }), view: async ask => { views.push(ask); return { tab: 42, url: ask.url }; }, reservedPorts: () => [5067, 5080] });
  await shown.listen();
  const host = createServer(async (req, res) => { if (!await shown.handle(req, res, new URL(req.url, 'http://fixture').pathname)) res.writeHead(404).end(); });
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => host.close(resolve)); await shown.close(); globalThis[key] = before; await rm(root, { recursive: true, force: true }); });
  const view = async (target, reload) => {
    const res = await fetch(`http://127.0.0.1:${host.address().port}/shown/view`, { method: 'POST', body: JSON.stringify({ target, reload }) });
    return { status: res.status, body: await res.json() };
  };
  const one = await globalThis[key](app);
  assert.equal(one.kind, 'page'); assert.equal(one.path, join(app, 'index.html'));
  assert.match(one.url, /^http:\/\/[a-f0-9]{32}\.localhost:\d+\/index.html$/);
  const html = await get(one.url);
  assert.equal(html.status, 200); assert.match(html.body, /src="\/app.js"/);
  assert.equal((await get(one.url, '/app.js')).body, 'window.ready=true');
  assert.equal((await get(one.url, '/')).status, 200);
  assert.equal((await get(one.url, '/escape.html')).status, 404);
  await globalThis[key](join(other, 'secret.html'));
  assert.equal((await get(one.url, '/escape.html')).status, 404, 'even another shown root cannot be reached through a symlink');
  assert.equal((await get(one.url, '/%2e%2e/other/secret.html')).status, 404);
  const opened = await view(one.url, true);
  assert.deepEqual(opened.body, { stream: true, tab: 42, url: one.url });
  assert.deepEqual(views, [{ url: one.url, reload: true }]);
  const image = await globalThis[key](join(app, 'image.png'));
  assert.equal(new URL(image.url).origin, 'https://ada.imperfect.computer');
  assert.equal(new URL(image.url).pathname, '/files/raw');
  assert.equal(shown.here(image.url), `${await shown.origin()}/files/raw?path=${encodeURIComponent(join(app, 'image.png'))}`);
  assert.equal(shown.here(`${await shown.origin()}/port/5173/deep?x=1`), 'http://localhost:5173/deep?x=1');
  assert.deepEqual((await view(join(app, 'image.png'))).body, { stream: false, url: image.url });
  assert.equal(views.length, 1);
  const pdfPath = join(app, 'paper.pdf');
  await writeFile(pdfPath, '%PDF-1.4');
  const pdf = await globalThis[key](pdfPath);
  assert.equal(new URL(pdf.url).origin, new URL(one.url).origin, 'a streamed PDF never needs the door login in its renderer');
  assert.equal((await view(pdfPath)).body.stream, true);
  const dev = await globalThis[key]('http://127.0.0.1:5173/deep/route?x=1#here');
  assert.equal(dev.url, 'http://localhost:5173/deep/route?x=1#here');
  assert.equal((await view(dev.url)).status, 200);
  assert.equal((await view('http://localhost:5174/')).status, 503, 'unopened ports fail closed');
  for (const address of ['http://localhost:5067/', 'http://localhost:5080/', `${await shown.origin()}/`, 'https://example.com/', 'http://user:pass@localhost:5173/']) {
    assert.equal((await view(address)).status, 503, address);
  }
});

test('ordinary shown views keep the existing separate-origin address', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shown-desk-')), before = globalThis[key];
  await writeFile(join(root, 'index.html'), 'desktop');
  const shown = createShown({ stateDir: join(root, 'state'), servers: () => ({ list: () => [] }) });
  await shown.listen();
  const host = createServer((req, res) => shown.handle(req, res, '/shown/view'));
  await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => host.close(resolve)); await shown.close(); globalThis[key] = before; await rm(root, { recursive: true, force: true }); });
  const target = join(root, 'index.html'), original = await globalThis[key](target);
  const res = await fetch(`http://127.0.0.1:${host.address().port}`, { method: 'POST', body: JSON.stringify({ target }) });
  assert.deepEqual(await res.json(), { stream: false, url: original.url });
  assert.match(original.url, /\/shown\/tmp\//);
});
