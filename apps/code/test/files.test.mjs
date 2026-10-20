import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, lutimes, mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createFiles, inside, kindOfFolder, otherDisks, spaceTree } from '../../../system/files.mjs';

async function serve(t, options) {
  const handle = createFiles(options);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!await handle(req, res, url.pathname, url.search)) res.writeHead(418).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('inside holds for the root itself and below it, including /', () => {
  assert.equal(inside('/a/b', '/a'), true);
  assert.equal(inside('/a', '/a'), true);
  assert.equal(inside('/ab', '/a'), false);
  assert.equal(inside('/etc', '/'), true);
  assert.equal(inside('/', '/'), true);
});

test('a folder anywhere is listed, newest first, dot names too (the page hides them); no path is home; / is the top', async t => {
  const root = await mkdtemp(join(tmpdir(), 'files-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'b-folder'));
  await mkdir(join(root, 'Documents'));
  await writeFile(join(root, 'a.txt'), 'hello files');
  await writeFile(join(root, '.hidden'), 'x');
  await symlink(join(root, 'Documents'), join(root, 'docs'));
  await symlink(join(root, 'gone'), join(root, 'dangling'));
  for (const name of ['b-folder', 'Documents', 'a.txt', '.hidden']) await utimes(join(root, name), 100, 100);
  await lutimes(join(root, 'docs'), 900, 900); // Listing uses the target date, not the link date.
  await lutimes(join(root, 'dangling'), 0, 0);
  const base = await serve(t);

  const list = await (await fetch(`${base}/files/list?path=${encodeURIComponent(root)}`)).json();
  assert.equal(list.path, root);
  assert.deepEqual(list.entries.map(e => [e.name, e.dir]), [
    ['b-folder', true], ['docs', true], ['Documents', true], ['.hidden', false], ['a.txt', false], ['dangling', false],
  ], 'a link to a folder is a folder; a dangling one is still listed');
  assert.equal(list.entries.find(e => e.name === 'a.txt').size, 11);
  assert.equal(list.up, tmpdir());

  assert.equal((await (await fetch(`${base}/files/list`)).json()).path, homedir(), 'no path is the home folder');
  assert.equal((await (await fetch(`${base}/files/list?path=`)).json()).path, homedir());
  const top = await (await fetch(`${base}/files/list?path=/`)).json();
  assert.equal(top.path, '/');
  assert.equal(top.up, null);
  assert.ok(top.entries.some(e => e.name === 'etc' && e.dir));
  assert.equal((await fetch(`${base}/files/list?path=/etc`)).status, 200, 'outside home is fine');
  assert.equal((await (await fetch(`${base}/files/list?path=${encodeURIComponent(`${root}/b-folder/..`)}`)).json()).path, root);
});

test('modified dates outrank type and name, with deterministic equal and zero-date ties', async t => {
  const root = await mkdtemp(join(tmpdir(), 'files-newest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtures = [
    ['old-folder', true, 100], ['edited.txt', false, 400],
    ['new-folder', true, 300], ['old.txt', false, 200],
    ['folder10', true, 50], ['Folder2', true, 50],
    ['file10', false, 50], ['File2', false, 50], ['file2', false, 50],
    ['zero-folder', true, 0], ['zero10', false, 0], ['Zero2', false, 0],
  ];
  for (const [name, dir, seconds] of fixtures) {
    if (dir) await mkdir(join(root, name));
    else await writeFile(join(root, name), name);
    await utimes(join(root, name), seconds, seconds);
  }
  await symlink(join(root, 'missing'), join(root, 'zero3'));
  await lutimes(join(root, 'zero3'), 0, 0);
  const base = await serve(t);
  const listing = async () => (await (await fetch(`${base}/files/list?path=${encodeURIComponent(root)}`)).json()).entries;
  const entries = await listing();
  const expected = ['edited.txt', 'new-folder', 'old.txt', 'old-folder', 'Folder2', 'folder10',
    'File2', 'file2', 'file10', 'zero-folder', 'Zero2', 'zero3', 'zero10'];
  assert.deepEqual(entries.map(e => e.name), expected, 'edited files beat older folders; newer folders beat older files; ties use type then natural case-insensitive names');
  assert.deepEqual((await listing()).map(e => e.name), expected, 'case-equivalent names have a stable final tie-break');
  assert.deepEqual(entries.map(e => e.mtime), [400000, 300000, 200000, 100000, ...Array(5).fill(50000), ...Array(4).fill(0)]);
  assert.equal(entries.find(e => e.name === 'zero3').dir, false, 'a dangling link retains its own metadata');
});

test('entries whose metadata cannot be read keep unknown dates at zero and natural name ties', async t => {
  if (process.getuid?.() === 0) return t.skip('root can read every entry metadata');
  const root = await mkdtemp(join(tmpdir(), 'files-unknown-'));
  t.after(async () => { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'Folder10'));
  await writeFile(join(root, 'file2'), 'x');
  await writeFile(join(root, 'File1'), 'x');
  for (const name of ['Folder10', 'file2', 'File1']) await utimes(join(root, name), 500, 500);
  // Read permission allows readdir; no search permission makes stat/lstat fail.
  await chmod(root, 0o400);
  const base = await serve(t);
  const list = await (await fetch(`${base}/files/list?path=${encodeURIComponent(root)}`)).json();
  assert.deepEqual(list.entries.map(e => [e.name, e.mtime, e.dir, e.size]), [
    ['File1', 0, false, 0], ['file2', 0, false, 0], ['Folder10', 0, false, 0],
  ], 'unreadable metadata stays listed without inventing dates or folder types');
});

test('a folder that cannot be opened says so, and nothing else breaks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'files-denied-'));
  t.after(async () => { await chmod(join(root, 'locked'), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'locked'));
  await writeFile(join(root, 'a.txt'), 'x');
  const base = await serve(t);
  const missing = await fetch(`${base}/files/list?path=${encodeURIComponent(join(root, 'missing'))}`);
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /^Can't open/);
  assert.equal((await fetch(`${base}/files/list?path=${encodeURIComponent(join(root, 'a.txt'))}`)).status, 404, 'a file is not a folder');
  assert.equal(await (await fetch(`${base}/files/raw?path=${encodeURIComponent(join(root, 'a.txt'))}`)).text(), 'x', 'a file is read to open it (files-open.test.mjs)');
  assert.equal((await fetch(`${base}/elsewhere`)).status, 418, 'other paths are not answered');
  if (process.getuid?.() === 0) return t.diagnostic('running as root, which opens every folder');
  await chmod(join(root, 'locked'), 0);
  const locked = await fetch(`${base}/files/list?path=${encodeURIComponent(join(root, 'locked'))}`);
  assert.equal(locked.status, 403);
  assert.match((await locked.json()).error, /^Can't open this folder/);
});

test('the space map measures any folder, / included', async t => {
  // With no mounts to go by, du stays on the folder's own filesystem.
  const base = await serve(t, { mounts: async () => '', launcher: (bin, args) => {
    assert.deepEqual([bin, ...args.slice(0, -1)], ['du', '-x', '-B1', '-d', '4']);
    const path = args.at(-1);
    const stdout = { setEncoding() {}, on(event, fn) { if (event === 'data') setImmediate(() => fn(path === '/' ? '40\t/etc\n100\t/\n' : '')); } };
    return { stdout, on(event, fn) { if (event === 'close') setTimeout(fn, 5); } };
  } });
  const scan = await (await fetch(`${base}/files/space?path=/`)).json();
  assert.equal(scan.path, '/');
  assert.deepEqual(scan.tree.children.map(c => [c.name, c.size]), [['etc', 40], ['files', 60]]);
  assert.equal((await fetch(`${base}/files/space?path=/no-such-folder-here`)).status, 404);
});

test('du becomes the map: loose files and small folders are blocks of their own, caches are worth a look', () => {
  const du = [
    ['6000', '/h/src/app/node_modules'], ['500', '/h/src/app/.git'], ['7000', '/h/src/app'],
    ['9', '/h/src/tiny'], ['8000', '/h/src'],
    ['1500', '/h/.cache'], ['10000', '/h'],
  ].map(([n, p]) => `${n}\t${p}`).join('\n');
  const { tree, worth } = spaceTree(du, '/h');
  assert.equal(tree.size, 10000);
  assert.deepEqual(tree.children.map(c => [c.name, c.size, c.kind]), [['src', 8000, 'other'], ['.cache', 1500, 'regenerable'], ['files', 500, 'files']]);
  const src = tree.children[0];
  assert.deepEqual(src.children.map(c => c.name), ['app', 'files'], 'under a thousandth of the whole is not drawn on its own');
  assert.equal(src.children[1].size, 991, 'its loose files; tiny, under a thousandth, is too small to draw');
  assert.deepEqual(src.children[0].children.map(c => [c.name, c.kind]), [['node_modules', 'regenerable'], ['.git', 'git'], ['files', 'files']]);
  assert.deepEqual(worth.map(w => w.path), ['/h/src/app/node_modules', '/h/.cache']);
  assert.equal(kindOfFolder('Videos'), 'media');
  assert.equal(spaceTree('', '/h'), null);
  assert.deepEqual(spaceTree('5\t/usr\n9\t/\n', '/').tree.children.map(c => c.path), ['/usr', '/'], 'the root holds everything');
});

// Omarchy's disk: / and /home are subvolumes of one btrfs, each with its own
// st_dev, so a one-filesystem du at / stopped at /home and / came out smaller.
const OMARCHY = [
  '23 1 0:22 / /proc rw - proc proc rw',
  '24 1 0:6 / /dev rw - devtmpfs devtmpfs rw',
  '28 1 0:31 /@ / rw,relatime - btrfs /dev/mapper/root rw,subvol=/@',
  '29 28 0:33 /@home /home rw,relatime - btrfs /dev/mapper/root rw,subvol=/@home',
  '30 28 0:34 /@log /var/log rw,relatime - btrfs /dev/dm-0 rw,subvol=/@log',
  '31 28 0:35 /@.snapshots /.snapshots rw,relatime - btrfs /dev/mapper/root rw,subvol=/@.snapshots',
  '32 28 259:1 / /boot rw - vfat /dev/nvme0n1p1 rw',
  '33 28 0:40 / /tmp rw - tmpfs tmpfs rw',
  '34 33 0:41 / /tmp/other rw - tmpfs tmpfs rw',
  '35 28 8:17 / /mnt/usb\\040stick rw - ext4 /dev/sdb1 rw',
  '36 29 0:42 / /home/me/.cache/[x]* rw - tmpfs tmpfs rw',
].join('\n');
const real = async path => (path === '/dev/mapper/root' ? '/dev/dm-0' : path);

test('on btrfs the map measures across subvolumes of the same disk, never into another disk or a virtual one', async t => {
  assert.deepEqual(await otherDisks(OMARCHY, '/', { real }), ['/proc', '/dev', '/.snapshots', '/boot', '/tmp', '/mnt/usb stick', '/home/me/.cache/[x]*'],
    '/home and /var/log are the same disk, met through another name for it; snapshots, other disks and virtual mounts are not');
  assert.deepEqual(await otherDisks(OMARCHY, '/home', { real }), ['/home/me/.cache/[x]*']);
  assert.deepEqual(await otherDisks(OMARCHY, '/tmp', { real }), ['/tmp/other'], 'one tmpfs is not another');
  assert.equal(await otherDisks('', '/'), null);

  // What du is told decides what it finds: here, a disk with 49 GB used,
  // 44 of them in /home.
  const asked = [];
  const base = await serve(t, { mounts: async () => OMARCHY, launcher: (bin, args) => {
    asked.push(args);
    const crossed = !args.includes('-x') && !args.some(arg => arg === '--exclude=/home');
    const text = args.at(-1) === '/'
      ? (crossed ? '44000000000\t/home\n5000000000\t/usr\n49000000000\t/\n' : '5000000000\t/usr\n11000000000\t/\n')
      : '44000000000\t/home\n';
    const stdout = { setEncoding() {}, on(event, fn) { if (event === 'data') setImmediate(() => fn(text)); } };
    return { stdout, on(event, fn) { if (event === 'close') setTimeout(fn, 5); } };
  } });
  const top = await (await fetch(`${base}/files/space?path=/`)).json();
  const home = await (await fetch(`${base}/files/space?path=/home`)).json();
  assert.ok(!asked[0].includes('-x'));
  assert.ok(asked[0].includes('--exclude=/boot') && asked[0].includes('--exclude=/.snapshots') && asked[0].includes('--exclude=/proc'));
  assert.ok(asked[0].includes('--exclude=/mnt/usb stick'));
  assert.ok(asked[0].includes('--exclude=/home/me/.cache/\\[x\\]\\*'), 'a mount point is excluded as itself, not as a pattern');
  assert.equal(top.tree.size, 49000000000);
  assert.ok(top.tree.size >= home.tree.size, 'a folder is never smaller than one inside it');
  assert.equal(top.tree.children.find(child => child.path === '/home').size, home.tree.size);
});
