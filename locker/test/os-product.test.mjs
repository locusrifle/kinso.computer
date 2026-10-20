import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openStore } from '../store.mjs';
import { createLockerServer } from '../server.mjs';
import { validOSRelease } from '../os-product.mjs';
import { run as licenseCommand } from '../tools/license.mjs';

const exec = promisify(execFile);
const git = args => exec('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'false' } });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const basic = key => ({ authorization: `Basic ${Buffer.from(`buyer:${key}`).toString('base64')}` });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'locker-os-test-'));
  const work = join(root, 'source');
  const product = join(root, 'product');
  await mkdir(join(product, 'os-downloads'), { recursive: true });
  await git(['init', '--quiet', '--initial-branch=main', work]);
  await writeFile(join(work, 'AGENTS.md'), 'public OS instructions\n');
  await git(['-C', work, 'add', '-A']);
  await git(['-C', work, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'First public OS']);
  for (const repo of ['imperfect-os.git', 'imperfect.git']) await git(['clone', '--quiet', '--bare', work, join(product, repo)]);
  const commit = (await git(['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
  const bytes = Buffer.from('fake ISO bytes for local tests only\n');
  const sha256 = digest(bytes);
  const manifest = { schema: 1, version: '26.05-test', repoCommit: commit, installer: { file: `imperfect-os-${sha256}.iso`, sha256, bytes: bytes.length } };
  const isoPath = join(product, 'os-downloads', manifest.installer.file);
  const manifestPath = join(product, 'os-release.json');
  await writeFile(isoPath, bytes);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const store = openStore(join(root, 'fresh.db'));
  const os = store.issueLicense({ email: 'os@example.com', product: 'os' });
  const code = store.issueLicense({ email: 'code@example.com' });
  const app = await createLockerServer({ store, mail: { configured: false }, config: { hosts: '127.0.0.1', secure: false }, productDir: product, port: 0, log: { error() {}, warn() {} } });
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const get = (path, key = os.key, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...(key ? basic(key) : {}), ...init.headers } });
  t.after(async () => { await app.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, work, product, store, os, code, base, get, bytes, manifest, manifestPath, isoPath };
}

test('OS licence includes app, default code never includes OS, and session product is immutable', () => {
  const store = openStore();
  try {
    const os = store.issueLicense({ email: 'a@example.com', product: 'os', stripeSession: 'cs_os' });
    assert.equal(store.issueLicense({ email: 'a@example.com', product: 'os', stripeSession: 'cs_os' }).key, os.key);
    assert.throws(() => store.issueLicense({ email: 'a@example.com', stripeSession: 'cs_os' }), /different product/);
    const code = store.issueLicense({ email: 'a@example.com' });
    assert.equal(code.product, 'code');
    assert.equal(store.activeLicense(code.key, 'os'), null);
    assert.equal(store.activeLicense(os.key).key, os.key);
    assert.equal(store.activeLicense(os.key, 'os').key, os.key);
    assert.equal(store.activeLicense(os.key, 'unknown'), null);
    assert.throws(() => store.issueLicense({ email: 'a@example.com', product: 'unknown' }), /unknown/);
    let output = '';
    licenseCommand(store, ['issue', 'operator@example.com', '--product', 'os'], { write: text => { output += text; } });
    assert.equal(store.license(output.trim()).product, 'os');
    store.revokeLicense(os.key);
    assert.equal(store.activeLicense(os.key), null);
    assert.equal(store.activeLicense(os.key, 'os'), null);
  } finally { store.close(); }
});

test('actual smart-HTTP OS clone and new-commit fetch require OS; even maintainer cannot push', async t => {
  const f = await fixture(t);
  const mine = join(f.root, 'clone');
  const url = key => f.base.replace('http://', `http://buyer:${key}@`) + '/imperfect-os.git';
  await git(['clone', '--quiet', url(f.os.key), mine]);
  const refs = await f.get('/imperfect-os.git/info/refs?service=git-upload-pack');
  assert.equal(refs.status, 200);
  assert.equal(refs.headers.get('cache-control'), 'no-store');
  assert.equal(refs.headers.get('vary'), 'Authorization');
  const anonymous = await f.get('/imperfect-os.git/info/refs?service=git-upload-pack', '');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  assert.equal(await readFile(join(mine, 'AGENTS.md'), 'utf8'), 'public OS instructions\n');
  await writeFile(join(f.work, 'new.txt'), 'new version');
  await git(['-C', f.work, 'add', '-A']);
  await git(['-C', f.work, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'New OS update']);
  await git(['-C', f.work, 'push', '--quiet', join(f.product, 'imperfect-os.git'), 'main']);
  await git(['-C', mine, 'fetch', '--quiet', 'origin']);
  assert.equal((await git(['-C', mine, 'show', 'origin/main:new.txt'])).stdout, 'new version');
  for (const key of [f.code.key, `ic_${'f'.repeat(40)}`]) {
    await assert.rejects(git(['clone', '--quiet', url(key), join(f.root, key)]), /401|Authentication failed|could not read/);
  }
  await git(['clone', '--quiet', f.base.replace('http://', `http://${f.os.key}@`) + '/imperfect-os.git', join(f.root, 'username-key')]);
  await git(['clone', '--quiet', f.base.replace('http://', `http://buyer:${f.os.key}@`) + '/imperfect.git', join(f.root, 'app-clone')]);
  f.store.claimHandle(f.os.buyer_id, 'locus', { operator: true });
  await assert.rejects(git(['-C', mine, 'push', 'origin', 'HEAD:main']), /read-only|403/);
  for (const path of ['/imperfect-os.git/config', '/imperfect-os.git/HEAD', '/imperfect-os.git/objects/abc']) assert.equal((await f.get(path)).status, 403);
  f.store.revokeLicense(f.os.key);
  await assert.rejects(git(['-C', mine, 'fetch', '--quiet', 'origin']), /401|Authentication failed|could not read/);
});

test('manifest and checksum-pinned ISO are OS-gated; ranges, HEAD and validators never bypass auth', async t => {
  const f = await fixture(t);
  for (const path of ['/os-release.json', '/os/installer', `/os/download/${f.manifest.installer.file}`]) {
    for (const key of ['', f.code.key, `ic_${'e'.repeat(40)}`]) {
      const denied = await f.get(path, key);
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get('cache-control'), 'private, no-store');
    }
  }
  const metadata = await f.get('/os-release.json');
  assert.deepEqual(await metadata.json(), f.manifest);
  const download = await f.get(`/os/download/${f.manifest.installer.file}`);
  assert.equal(download.status, 200);
  const actual = Buffer.from(await download.arrayBuffer());
  assert.equal(digest(actual), f.manifest.installer.sha256);
  assert.deepEqual(actual, f.bytes);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  assert.equal(download.headers.get('vary'), 'Authorization');
  assert.equal(download.headers.get('etag'), null);
  const range = await f.get('/os/installer', f.os.key, { headers: { range: 'bytes=2-8' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 2-8/${f.bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), f.bytes.subarray(2, 9));
  const suffix = await f.get('/os/installer', f.os.key, { headers: { range: 'bytes=-3' } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), f.bytes.subarray(-3));
  for (const range of ['bytes=999-', 'bytes=5-1', 'bytes=-0', 'bytes=0-1,4-6', 'garbage']) assert.equal((await f.get('/os/installer', f.os.key, { headers: { range } })).status, 416);
  const head = await f.get('/os/installer', f.os.key, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(f.bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await f.get(`/os/installer?key=${f.os.key}`, '')).status, 200);
  assert.equal((await f.get('/os/installer', f.os.key, { method: 'POST' })).status, 405);
  f.store.revokeLicense(f.os.key);
  for (const method of ['GET', 'HEAD']) assert.equal((await f.get('/os/installer', f.os.key, { method, headers: { range: 'bytes=0-1', 'if-none-match': '*', 'if-modified-since': new Date().toUTCString() } })).status, 403);
});

test('only current manifest file is served, never staged/stale files or traversal paths', async t => {
  const f = await fixture(t);
  const stale = `imperfect-os-${'b'.repeat(64)}.iso`;
  await writeFile(join(f.product, 'os-downloads', stale), 'stale private bytes');
  for (const name of [stale, '%2e%2e%2fos-release.json', '%2Fetc%2Fpasswd', '%5c..%5csecret', `${f.manifest.installer.file}/more`]) assert.equal((await f.get(`/os/download/${name}`)).status, 404);
  const nextBytes = Buffer.from('a different immutable release');
  const sha256 = digest(nextBytes);
  const next = { ...f.manifest, version: 'next', installer: { file: `imperfect-os-${sha256}.iso`, sha256, bytes: nextBytes.length } };
  await writeFile(join(f.product, 'os-downloads', next.installer.file), nextBytes);
  assert.equal((await f.get(`/os/download/${next.installer.file}`)).status, 404);
  await writeFile(f.manifestPath + '.tmp', JSON.stringify(next));
  await rename(f.manifestPath + '.tmp', f.manifestPath);
  assert.equal((await f.get(`/os/download/${f.manifest.installer.file}`)).status, 404);
  assert.deepEqual(await (await f.get('/os-release.json')).json(), next);
  assert.deepEqual(Buffer.from(await (await f.get('/os/installer')).arrayBuffer()), nextBytes);
});

test('incomplete/malformed publication, wrong checksum and symlinks never serve bytes', async t => {
  const f = await fixture(t);
  for (const value of [null, {}, { ...f.manifest, schema: 2 }, { ...f.manifest, extra: 1 }, { ...f.manifest, installer: { ...f.manifest.installer, file: '../secret.iso' } }, { ...f.manifest, repoCommit: '0'.repeat(40) }]) {
    await writeFile(f.manifestPath, JSON.stringify(value));
    assert.equal((await f.get('/os/installer')).status, 503);
  }
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  assert.equal((await f.get('/os/installer')).status, 200, 'warms checksum cache');
  await writeFile(f.isoPath, Buffer.alloc(f.bytes.length, 1));
  assert.equal((await f.get('/os/installer')).status, 503, 'same-size change invalidates digest cache');
  assert.equal((await f.get('/os-release.json')).status, 503);
  await writeFile(f.isoPath, 'short');
  assert.equal((await f.get('/os/installer')).status, 503);
  await rm(f.isoPath);
  assert.equal((await f.get('/os/installer')).status, 503);
  assert.equal((await f.get('/os/installer', f.os.key, { method: 'HEAD', headers: { range: 'bytes=0-1' } })).status, 503);
  const external = join(f.root, 'private.iso');
  await writeFile(external, f.bytes);
  await symlink(external, f.isoPath);
  assert.equal((await f.get('/os/installer')).status, 503);
  await rm(f.isoPath);
  await writeFile(f.isoPath, f.bytes);
  await rename(join(f.product, 'os-downloads'), join(f.product, 'moved'));
  await symlink(join(f.product, 'moved'), join(f.product, 'os-downloads'));
  assert.equal((await f.get('/os/installer')).status, 503);
  await rm(f.manifestPath);
  const unpublished = await f.get('/os/installer');
  assert.equal(unpublished.status, 503);
  assert.match(await unpublished.text(), /not been published yet/);
  assert.equal((await f.get('/os/installer', f.code.key)).status, 403, 'publication state is not an auth shortcut');
});

test('manifest schema rejects unsafe or mismatched names and lengths', () => {
  const good = { schema: 1, version: 'test', repoCommit: 'a'.repeat(40), installer: { file: `imperfect-os-${'b'.repeat(64)}.iso`, sha256: 'b'.repeat(64), bytes: 12 } };
  assert.ok(validOSRelease(good));
  for (const bytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12']) assert.ok(!validOSRelease({ ...good, installer: { ...good.installer, bytes } }));
  for (const version of ['', 'bad\n', 'x'.repeat(101)]) assert.ok(!validOSRelease({ ...good, version }));
});
