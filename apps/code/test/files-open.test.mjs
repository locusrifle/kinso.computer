// What Workbench reads to open a file (system/files.mjs: /files/peek and
// /files/raw): what each kind is, its bytes sent only as what cannot run on
// imperfect's origin, streamed and in ranges, and never to a page from
// elsewhere, here or through /peer/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFiles } from '../../../system/files.mjs';
import { createGueyServer } from '../../../system/server.mjs';
import { createTabHost } from '../native/tabs.mjs';

async function serve(t, handle = createFiles({ thumbnailDir: join(tmpdir(), 'imperfect-open-test-cache') })) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!await handle(req, res, url.pathname, url.search)) res.writeHead(418).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'files-open-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = {
    'photo.JPG': 'jpeg bytes', 'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    'README.md': '# Hi', 'page.html': '<script>alert(1)</script>', 'app.mjs': 'export {}', 'Makefile': 'all:',
    'notes': 'plain words, no name it is known by', 'clip.mp4': 'not really a film', 'song.flac': 'sound', 'paper.pdf': '%PDF-1.4',
    'blob': Buffer.from([0, 1, 2, 255, 254]), 'latin1': Buffer.from('caf\xe9', 'latin1'), 'empty': '',
  };
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  await mkdir(join(dir, 'sub.md'));
  return dir;
}
const peek = async (base, path, headers) => (await fetch(`${base}/files/peek?path=${encodeURIComponent(path)}`, { headers })).json();

test('each file is known for what it opens as', async t => {
  const dir = await folder(t);
  const base = await serve(t);
  const kinds = {};
  for (const name of ['photo.JPG', 'logo.svg', 'README.md', 'page.html', 'app.mjs', 'Makefile', 'notes', 'clip.mp4', 'song.flac', 'paper.pdf', 'blob', 'latin1', 'empty']) kinds[name] = (await peek(base, join(dir, name))).kind;
  assert.deepEqual(kinds, {
    'photo.JPG': 'image', 'logo.svg': 'image', 'README.md': 'markdown', 'page.html': 'text', 'app.mjs': 'text', Makefile: 'text',
    notes: 'text', 'clip.mp4': 'video', 'song.flac': 'audio', 'paper.pdf': 'pdf', blob: 'none', latin1: 'none', empty: 'text',
  });
  const found = await peek(base, join(dir, 'clip.mp4'));
  assert.deepEqual([found.name, found.size, found.type], ['clip.mp4', 17, 'video/mp4']);
  assert.equal((await fetch(`${base}/files/peek?path=${encodeURIComponent(join(dir, 'sub.md'))}`)).status, 404, 'a folder is not a file');
  assert.equal((await fetch(`${base}/files/peek?path=${encodeURIComponent(join(dir, 'gone'))}`)).status, 404);
});

test('an unknown file over 1 MB is not read to find out what it is', async t => {
  const dir = await folder(t);
  const big = await open(join(dir, 'huge'), 'w');
  await big.truncate((1 << 20) + 1);
  await big.close();
  assert.equal((await peek(await serve(t), join(dir, 'huge'))).kind, 'none');
});

test('a file is sent only as what cannot run here, sandboxed', async t => {
  const dir = await folder(t);
  const base = await serve(t);
  const raw = name => fetch(`${base}/files/raw?path=${encodeURIComponent(join(dir, name))}`);
  const sent = async name => { const res = await raw(name); return [res.headers.get('content-type'), /sandbox/.test(res.headers.get('content-security-policy') ?? ''), await res.text()]; };
  assert.deepEqual(await sent('photo.JPG'), ['image/jpeg', true, 'jpeg bytes']);
  assert.deepEqual((await sent('logo.svg')).slice(0, 2), ['image/svg+xml', true], 'an SVG opened by its address runs nothing');
  assert.deepEqual(await sent('page.html'), ['text/plain; charset=utf-8', true, '<script>alert(1)</script>'], 'a page is its source');
  assert.deepEqual((await sent('README.md')).slice(0, 2), ['text/plain; charset=utf-8', true]);
  assert.deepEqual((await sent('blob')).slice(0, 2), ['application/octet-stream', true]);
  assert.deepEqual((await sent('paper.pdf')).slice(0, 2), ['application/pdf', false], "the browser's PDF viewer cannot show a sandboxed PDF");
  const res = await raw('song.flac');
  assert.equal(res.headers.get('content-type'), 'audio/flac');
  assert.match(res.headers.get('content-disposition'), /^inline; filename\*=UTF-8''song\.flac$/);
  assert.equal((await fetch(`${base}/files/raw?path=${encodeURIComponent(join(dir, 'sub.md'))}`)).status, 404);
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(`${base}/files/raw?path=${encodeURIComponent(join(dir, 'notes'))}`, { method })).status, 404, `${method} changes nothing`);
});

test('a big file streams, in the ranges asked for', async t => {
  const dir = await folder(t);
  // 64 MB, mostly holes: what a film is to the server, without the disk.
  const film = await open(join(dir, 'film.webm'), 'w');
  await film.truncate(64 << 20);
  await film.write(Buffer.from('the middle'), 0, 10, 32 << 20);
  await film.close();
  const base = await serve(t);
  const url = `${base}/files/raw?path=${encodeURIComponent(join(dir, 'film.webm'))}`;
  const part = await fetch(url, { headers: { range: `bytes=${32 << 20}-${(32 << 20) + 9}` } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes ${32 << 20}-${(32 << 20) + 9}/${64 << 20}`);
  assert.equal(await part.text(), 'the middle');
  const whole = await fetch(url);
  assert.equal(whole.headers.get('content-length'), String(64 << 20));
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  // Read a little and let go: the rest is never read into memory.
  const reader = whole.body.getReader();
  assert.ok((await reader.read()).value.length > 0);
  await reader.cancel();
});

test('a page from elsewhere, or beside imperfect, never reads a file', async t => {
  const dir = await folder(t);
  const base = await serve(t);
  for (const path of ['/files/raw', '/files/peek', '/files/thumbnail']) {
    const url = `${base}${path}?path=${encodeURIComponent(join(dir, 'photo.JPG'))}`;
    for (const site of ['cross-site', 'same-site']) assert.equal((await fetch(url, { headers: { 'sec-fetch-site': site } })).status, 403, `${path} from ${site}`);
    for (const site of ['same-origin', 'none']) assert.notEqual((await fetch(url, { headers: { 'sec-fetch-site': site } })).status, 403, `${path} from ${site}`);
  }
});

test('through /peer/, files are refused to a page from elsewhere before the other computer is asked', async t => {
  const root = await mkdtemp(join(tmpdir(), 'files-open-peer-'));
  const asked = [];
  const other = createServer((req, res) => { asked.push(req.url); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('from the desktop'); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => other.close(resolve)));
  const runtime = await createTabHost({
    stateDir: join(root, 'tabs'), listPiSessions: async () => [],
    createRuntime: () => ({ events: new EventEmitter(), snapshot: () => ({ sessionId: 's', cwd: '/', messages: [], busy: false, streaming: false, failed: null }), command: async () => ({ ok: true }), close: async () => {} }),
  });
  const url = `http://127.0.0.1:${other.address().port}`;
  const machines = {
    self: async () => 'laptop', selfId: async () => 'node-laptop', origins: async () => [],
    list: async () => [{ id: 'node-laptop', name: 'laptop', self: true, online: true, reachable: true, protocol: 1, capabilities: ['code', 'files'] }],
    peer: async id => (id === 'desktop' ? { id, name: 'desktop', url, reachable: true } : null),
  };
  const app = await createGueyServer({ host: '127.0.0.1', port: 0, stateDir: join(root, 'server'), runtime, machines });
  try {
    const address = await app.listen();
    const base = `http://127.0.0.1:${address.port}/peer/desktop`;
    const refused = await fetch(`${base}/files/raw?path=/etc/hostname`, { headers: { 'sec-fetch-site': 'same-site' } });
    assert.equal(refused.status, 403);
    assert.deepEqual(asked, [], 'the desktop was never asked');
    const read = await fetch(`${base}/files/raw?path=/etc/hostname`, { headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(await read.text(), 'from the desktop');
    assert.deepEqual(asked, ['/files/raw?path=/etc/hostname']);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
