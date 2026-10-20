// A file sent to be saved (system/files.mjs: /files/raw?download=1): as an
// attachment under its own name, however strange, quoted so no header can be
// broken; in ranges, so a download that broke off resumes, and whole when the
// file changed meanwhile; never a folder; and never to a page from
// elsewhere, here or through /peer/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, mkdir, open, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { createFiles, disposition, sendRange } from '../../../system/files.mjs';
import { createGueyServer } from '../../../system/server.mjs';
import { createTabHost } from '../native/tabs.mjs';

async function serve(t, handle = createFiles({ thumbnailDir: join(tmpdir(), 'imperfect-download-test-cache') })) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!await handle(req, res, url.pathname, url.search)) res.writeHead(418).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function folder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'files-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const download = (base, path, headers) => fetch(`${base}/files/raw?path=${encodeURIComponent(path)}&download=1`, { headers });
// filename*, as a browser reads it back.
const named = header => decodeURIComponent(/filename\*=UTF-8''([^;\s]+)$/.exec(header)[1]);

test('a file to be saved is an attachment under its own name, in filename* and in plain ASCII', async t => {
  const dir = await folder(t);
  const base = await serve(t);
  const names = ['song.flac', 'Ünïcode café.pdf', "it's (a) *star*.txt", 'q"b\\s%;.bin', 'line\nbreak.txt', 'tab\there\r.md', '📷 holiday.jpg', 'Makefile', 'page.html',
    "notes; filename*=UTF-8''setup.apk; x.txt"];
  for (const name of names) {
    await writeFile(join(dir, name), `bytes of ${name}`);
    const res = await download(base, join(dir, name));
    assert.equal(res.status, 200, name);
    const header = res.headers.get('content-disposition');
    assert.match(header, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''[A-Za-z0-9!#$&+\-.^_`|~%]+$/, `${JSON.stringify(name)}: ${header}`);
    assert.equal(named(header), name, 'filename* is the name exactly');
    const plain = /filename="([^"]*)"/.exec(header)[1];
    assert.doesNotMatch(plain, /["\\%;=*\r\n]/, 'the plain name has nothing to unquote or decode, and no parameter in it');
    // A reader that ignores quotes finds one filename* only, the real one.
    assert.equal(header.match(/filename\*=/g).length, 1, name);
    assert.equal(await res.text(), `bytes of ${name}`);
  }
  assert.equal(disposition('attachment', 'Ünïcode café.pdf'), "attachment; filename=\"Unicode cafe.pdf\"; filename*=UTF-8''%C3%9Cn%C3%AFcode%20caf%C3%A9.pdf");
  assert.equal(disposition('attachment', '📷.jpg'), "attachment; filename=\"_.jpg\"; filename*=UTF-8''%F0%9F%93%B7.jpg", 'one stand-in for one character');
  assert.equal(disposition('inline', "a (b)'s.mp4"), "inline; filename*=UTF-8''a%20%28b%29%27s.mp4");
  assert.equal(disposition('attachment', "notes; filename*=UTF-8''setup.apk; x.txt"),
    "attachment; filename=\"notes_ filename__UTF-8''setup.apk_ x.txt\"; filename*=UTF-8''notes%3B%20filename%2A%3DUTF-8%27%27setup.apk%3B%20x.txt");
});

test('saved, a picture, film, sound or PDF is what it is, and anything else bytes, never run', async t => {
  const dir = await folder(t);
  const base = await serve(t);
  const types = { 'photo.JPG': 'image/jpeg', 'clip.mp4': 'video/mp4', 'song.flac': 'audio/flac', 'paper.pdf': 'application/pdf',
    'page.html': 'application/octet-stream', 'README.md': 'application/octet-stream', NOTES: 'application/octet-stream', 'logo.svg': 'image/svg+xml' };
  for (const [name, type] of Object.entries(types)) {
    await writeFile(join(dir, name), '<script>alert(1)</script>');
    const res = await download(base, join(dir, name));
    assert.equal(res.headers.get('content-type'), type, name);
    assert.match(res.headers.get('content-security-policy'), /sandbox/, `${name} is sandboxed if it is ever shown`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  // Shown rather than saved, nothing changed: inline, and a page its source.
  const shown = await fetch(`${base}/files/raw?path=${encodeURIComponent(join(dir, 'page.html'))}`);
  assert.equal(shown.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(shown.headers.get('content-disposition'), "inline; filename*=UTF-8''page.html");
  for (const value of ['0', 'yes', '']) {
    const other = await fetch(`${base}/files/raw?path=${encodeURIComponent(join(dir, 'page.html'))}&download=${value}`);
    assert.match(other.headers.get('content-disposition'), /^inline;/, `download=${value} is not a download`);
  }
});

test('a big download resumes where it broke off, and starts again if the file changed', async t => {
  const dir = await folder(t);
  const path = join(dir, 'film.mp4');
  // 64 MB, mostly holes: a film to the server, without the disk.
  const film = await open(path, 'w');
  await film.truncate(64 << 20);
  await film.write(Buffer.from('the middle'), 0, 10, 32 << 20);
  await film.close();
  await utimes(path, 1700000000, 1700000000);
  const base = await serve(t);

  const whole = await download(base, path);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-length'), String(64 << 20));
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  const etag = whole.headers.get('etag'), modified = whole.headers.get('last-modified');
  assert.match(etag, /^"[^"]+"$/, 'a strong ETag');
  assert.equal(modified, new Date(1700000000 * 1000).toUTCString());
  // Read a little and let go: the rest is never read into memory.
  const reader = whole.body.getReader();
  assert.ok((await reader.read()).value.length > 0);
  await reader.cancel();

  const from = `bytes=${32 << 20}-`;
  for (const ifRange of [etag, modified]) {
    const rest = await download(base, path, { range: from, 'if-range': ifRange });
    assert.equal(rest.status, 206, `resumed against ${ifRange}`);
    assert.equal(rest.headers.get('content-range'), `bytes ${32 << 20}-${(64 << 20) - 1}/${64 << 20}`);
    assert.equal(rest.headers.get('content-length'), String(32 << 20));
    assert.match(rest.headers.get('content-disposition'), /^attachment;/);
    const part = rest.body.getReader();
    assert.equal(Buffer.from((await part.read()).value).subarray(0, 10).toString(), 'the middle');
    await part.cancel();
  }
  // Changed since: the whole of it, from the start.
  await utimes(path, 1700000100, 1700000100);
  for (const stale of [etag, modified, 'W/"weak"', 'Mon, 01 Jan 2001 00:00:00 GMT']) {
    const again = await download(base, path, { range: from, 'if-range': stale });
    assert.equal(again.status, 200, `${stale} is not the file now`);
    assert.equal(again.headers.get('content-length'), String(64 << 20));
    assert.notEqual(again.headers.get('etag'), etag);
    await again.body.cancel();
  }
  // Changed within the last second: its date could stay the same through
  // another change, so only the ETag resumes it.
  const fresh = join(dir, 'fresh.mp4');
  await writeFile(fresh, '0123456789');
  const now = await download(base, fresh);
  await now.arrayBuffer();
  const byDate = await download(base, fresh, { range: 'bytes=4-', 'if-range': now.headers.get('last-modified') });
  assert.equal(byDate.status, 200, 'a date a second old or less is not enough');
  assert.equal(await byDate.text(), '0123456789');
  const byTag = await download(base, fresh, { range: 'bytes=4-', 'if-range': now.headers.get('etag') });
  assert.equal(byTag.status, 206);
  assert.equal(await byTag.text(), '456789');

  // A range asked plainly is still a range.
  const plain = await download(base, path, { range: 'bytes=0-9' });
  assert.equal(plain.status, 206);
  assert.equal((await plain.arrayBuffer()).byteLength, 10);
});

test('a file is never sent past the size it was said to be, though it grows meanwhile', async t => {
  const dir = await folder(t);
  await writeFile(join(dir, 'growing.log'), '0123456789');
  await writeFile(join(dir, 'empty'), '');
  // As though it had been 4 bytes when it was looked at, and 0.
  const server = createServer((req, res) => sendRange(req, res, join(dir, req.url === '/empty' ? 'empty' : 'growing.log'), req.url === '/empty' ? 0 : 4, { 'content-type': 'text/plain' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const grown = await fetch(`${base}/growing`);
  assert.equal(grown.headers.get('content-length'), '4');
  assert.equal(await grown.text(), '0123');
  const empty = await fetch(`${base}/empty`);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal(await empty.text(), '');
});

test('a folder is not downloaded, nor anything that is not a file, and one that cannot be read says so first', async t => {
  const dir = await folder(t);
  const base = await serve(t);
  await mkdir(join(dir, 'photos'));
  const refused = await download(base, join(dir, 'photos'));
  assert.equal(refused.status, 404);
  assert.deepEqual(await refused.json(), { error: "Can't download a folder, only a file" });
  assert.equal((await download(base, join(dir, 'gone.txt'))).status, 404);
  assert.equal((await download(base, '/dev/null')).status, 404, 'a device is not a file');
  if (userInfo().uid !== 0) {
    await writeFile(join(dir, 'secret.txt'), 'kept');
    await chmod(join(dir, 'secret.txt'), 0o000);
    const shut = await download(base, join(dir, 'secret.txt'));
    assert.equal(shut.status, 403, 'refused whole, never broken off');
    assert.match(shut.headers.get('content-type'), /json/);
    assert.deepEqual(await shut.json(), { error: "Can't open this file: you don't have permission" });
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    assert.equal((await fetch(`${base}/files/raw?path=${encodeURIComponent(join(dir, 'photos'))}&download=1`, { method })).status, 404, method);
  }
});

test('a page from elsewhere, or beside imperfect, never downloads a file', async t => {
  const dir = await folder(t);
  await writeFile(join(dir, 'notes.txt'), 'mine');
  const base = await serve(t);
  for (const site of ['cross-site', 'same-site']) assert.equal((await download(base, join(dir, 'notes.txt'), { 'sec-fetch-site': site })).status, 403, site);
  // Workbench itself, a link opened by the person, and the phone app's own
  // request (no Sec-Fetch-Site at all, as a browser never sends).
  for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}]) {
    const res = await download(base, join(dir, 'notes.txt'), headers);
    assert.equal(res.status, 200, JSON.stringify(headers));
    assert.equal(await res.text(), 'mine');
  }
});

test('through /peer/, a download is refused to a page from elsewhere, and otherwise comes with its name, ranges and validators', async t => {
  const root = await mkdtemp(join(tmpdir(), 'files-download-peer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'Ünïcode café.txt'), '0123456789');
  const asked = [];
  const desktopFiles = createFiles({ thumbnailDir: join(root, '.cache') });
  const other = createServer(async (req, res) => {
    asked.push(req.url);
    const url = new URL(req.url, 'http://x');
    if (!await desktopFiles(req, res, url.pathname, url.search)) res.writeHead(404).end();
  });
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
    const file = encodeURIComponent(join(root, 'Ünïcode café.txt'));
    const at = `http://127.0.0.1:${address.port}/peer/desktop/files/raw?path=${file}&download=1`;
    const refused = await fetch(at, { headers: { 'sec-fetch-site': 'same-site' } });
    assert.equal(refused.status, 403);
    // A refusal says it is text: never taken for a file to save.
    assert.equal(refused.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(refused.headers.get('content-disposition'), null);
    assert.deepEqual(asked, [], 'the desktop was never asked');
    const whole = await fetch(at);
    assert.equal(whole.status, 200);
    assert.equal(named(whole.headers.get('content-disposition')), 'Ünïcode café.txt');
    assert.match(whole.headers.get('content-disposition'), /^attachment;/);
    assert.equal(await whole.text(), '0123456789');
    const etag = whole.headers.get('etag');
    assert.ok(etag && whole.headers.get('last-modified'), 'the validators come through');
    const rest = await fetch(at, { headers: { range: 'bytes=4-', 'if-range': etag } });
    assert.equal(rest.status, 206);
    assert.equal(rest.headers.get('content-range'), 'bytes 4-9/10');
    assert.equal(await rest.text(), '456789');
    // The laptop's own window check still holds: a page claiming another origin is refused.
    const foreign = await fetch(at, { headers: { origin: 'https://example.com' } });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(foreign.headers.get('content-disposition'), null);
  } finally {
    await app.close();
  }
});
