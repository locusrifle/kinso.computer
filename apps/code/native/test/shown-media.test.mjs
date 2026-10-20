import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShown } from '../../../../system/shown.mjs';

const KEY = Symbol.for('imperfect.shown');
const raw = (origin, path) => `${origin}/files/raw?path=${encodeURIComponent(path)}`;
const old = (origin, path) => `${origin}/shown${path.split('/').map(encodeURIComponent).join('/')}`;

test('shown media shares raw URLs and ranges, with only registry-authorized media on the isolated origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shown-media-'));
  const before = globalThis[KEY];
  const stateDir = join(dir, 'state');
  let shown = createShown({ stateDir, servers: () => ({ list: () => [] }) });
  let origin = `http://127.0.0.1:${(await shown.listen()).port}`;
  try {
    const piece = join(dir, 'piece'), outside = join(dir, 'piece-other');
    await mkdir(piece); await mkdir(outside);
    const clip = join(piece, 'film #1 & 100%.mp4');
    const secret = join(outside, 'secret.mp4');
    await writeFile(clip, '0123456789');
    await writeFile(secret, 'not authorized');
    await writeFile(join(piece, 'index.html'), '<script src="./app.js"></script>');
    await writeFile(join(piece, 'app.js'), 'window.ok = true;');
    await writeFile(join(piece, 'notes.txt'), 'not media');
    await symlink(secret, join(piece, 'escape.mp4'));
    await symlink(join(piece, 'index.html'), join(piece, 'disguised.mp4'));
    await symlink(outside, join(piece, 'outside'));
    assert.equal((await fetch(raw(origin, clip))).status, 404, 'existing file is not enough');
    const answer = await globalThis[KEY](clip);
    assert.deepEqual(answer, { path: clip, kind: 'video', url: raw(origin, clip) });
    for (const url of [answer.url, old(origin, clip)]) {
      const full = await fetch(url);
      assert.equal(full.status, 200);
      assert.equal(full.headers.get('content-type'), 'video/mp4');
      assert.match(full.headers.get('content-security-policy'), /^sandbox /);
      assert.equal(full.headers.get('accept-ranges'), 'bytes');
      assert.equal(await full.text(), '0123456789');
      for (const [range, bytes, contentRange] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=-3', '789', 'bytes 7-9/10']]) {
        const partial = await fetch(url, { headers: { range } });
        assert.equal(partial.status, 206);
        assert.equal(partial.headers.get('content-range'), contentRange);
        assert.equal(await partial.text(), bytes);
      }
      const head = await fetch(url, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), '10');
      assert.equal(await head.text(), '');
      assert.equal((await fetch(url, { method: 'POST' })).status, 404);
    }
    for (const [name, kind, type] of [['picture.png', 'image', 'image/png'], ['sound.mp3', 'audio', 'audio/mpeg'], ['document.pdf', 'pdf', 'application/pdf']]) {
      const path = join(piece, name);
      await writeFile(path, 'fixture');
      const added = await globalThis[KEY](path);
      assert.equal(added.kind, kind);
      assert.equal(added.url, raw(origin, path));
      assert.equal((await fetch(added.url)).headers.get('content-type'), type);
    }
    assert.equal((await globalThis[KEY](piece)).url, old(origin, join(piece, 'index.html')));
    for (const name of ['index.html', 'app.js']) assert.equal((await fetch(old(origin, join(piece, name)))).status, 200, 'page assets remain readable');
    for (const path of [secret, join(piece, 'notes.txt'), join(piece, 'index.html'), join(piece, 'app.js'), join(piece, 'escape.mp4'), join(piece, 'disguised.mp4'), join(piece, 'outside', 'secret.mp4'), join(piece, '..', 'piece-other', 'secret.mp4')]) {
      assert.equal((await fetch(raw(origin, path))).status, 404, path);
    }
    assert.equal((await fetch(old(origin, join(piece, 'escape.mp4')))).status, 404, 'old route cannot escape through symlinks either');
    for (const path of ['/files/raw', '/files/raw?path=relative.mp4', '/files/raw?path=%00', '/files/list', '/files/space']) assert.equal((await fetch(`${origin}${path}`)).status, 404);
    const rebound = await new Promise((resolve, reject) => get(answer.url, { headers: { host: 'rebound.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    assert.equal(rebound, 403);
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'shown.json'), 'utf8')), [piece]);
    await shown.close();
    shown = createShown({ stateDir, servers: () => ({ list: () => [] }) });
    origin = `http://127.0.0.1:${(await shown.listen()).port}`;
    for (const url of [raw(origin, clip), old(origin, clip)]) assert.equal(await (await fetch(url)).text(), '0123456789', 'registry survives restart');
    const folder = join(dir, 'unshown-folder');
    await mkdir(folder); await writeFile(join(folder, 'hidden.png'), 'hidden');
    assert.deepEqual(await globalThis[KEY](folder), { path: folder, kind: 'folder' });
    assert.equal((await fetch(raw(origin, join(folder, 'hidden.png')))).status, 404, 'opening Workbench does not publish media');
  } finally {
    await shown.close(); globalThis[KEY] = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test('carried media retains Range and media headers without exposing unregistered ports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shown-media-proxy-'));
  const before = globalThis[KEY];
  let request;
  const upstream = createServer((req, res) => {
    request = { range: req.headers.range, cookie: req.headers.cookie };
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 2-5/10', 'content-length': '4', 'set-cookie': 'private=1' });
    res.end('2345');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = upstream.address().port;
  const shown = createShown({ stateDir: dir, servers: () => ({ list: () => [] }) });
  const origin = `http://127.0.0.1:${(await shown.listen()).port}`;
  try {
    const url = `${origin}/port/${port}/movie.mp4`;
    assert.equal((await fetch(url)).status, 404);
    await globalThis[KEY](`http://localhost:${port}/movie.mp4`);
    const result = await fetch(url, { headers: { range: 'bytes=2-5', cookie: 'secret=1' } });
    assert.equal(result.status, 206);
    assert.equal(result.headers.get('content-type'), 'video/mp4');
    assert.equal(result.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(result.headers.get('set-cookie'), null);
    assert.equal(await result.text(), '2345');
    assert.deepEqual(request, { range: 'bytes=2-5', cookie: undefined });
  } finally {
    await shown.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    globalThis[KEY] = before; await rm(dir, { recursive: true, force: true });
  }
});
