import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, statfs, symlink, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFiles } from '../../../system/files.mjs';
import { createFileActions, trashRefusal } from '../../../system/file-actions.mjs';
import { realDisk } from '../native/test/fixtures/real-disk.mjs';

const exec = promisify(execFile);
const hasGio = await exec('gio', ['help']).then(() => true, () => false);
// A tmpfs to try trashing on: the temporary folder where it is one, else /dev/shm.
const TMPFS = 0x01021994;
const isTmpfs = path => statfs(path).then(fs => fs.type === TMPFS, () => false);
const tmpfs = (await isTmpfs(tmpdir())) ? tmpdir() : (await isTmpfs('/dev/shm')) ? '/dev/shm' : null;

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
const place = async (t, prefix) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('a picture is made small once, kept on disk, and made again when it changes', async t => {
  const root = await place(t, 'files-thumbs-');
  const cache = join(root, 'cache');
  const made = [];
  const maker = (from, to) => { made.push(from); return [process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "small-webp")', to]]; };
  const base = await serve(t, { thumbnailDir: cache, pictureMakers: [maker] });
  const photo = join(root, 'photo.JPG');
  await writeFile(photo, 'a big picture');
  const small = path => fetch(`${base}/files/thumbnail?path=${encodeURIComponent(path)}`);

  const first = await small(photo);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/webp');
  assert.match(first.headers.get('content-security-policy'), /sandbox/);
  assert.match(first.headers.get('cache-control'), /max-age/);
  assert.equal(await first.text(), 'small-webp');
  assert.equal((await readdir(cache)).length, 1, 'kept on disk');
  assert.equal(await (await small(photo)).text(), 'small-webp');
  assert.equal(made.length, 1, 'asked twice, made once');
  const both = await Promise.all([1, 2, 3].map(() => small(join(root, 'photo.JPG'))));
  assert.ok(both.every(r => r.ok) && made.length === 1);

  await writeFile(photo, 'a different big picture');
  await utimes(photo, 1, 1);
  await small(photo).then(r => r.text());
  assert.equal(made.length, 2, 'a changed picture is made again');
});

test('with no maker, or for an SVG, the picture itself is sent; anything else is not a picture', async t => {
  const root = await place(t, 'files-thumbs-none-');
  const base = await serve(t, { thumbnailDir: join(root, 'cache'), pictureMakers: [(from, to) => ['imperfect-no-such-maker', [from, to]]] });
  await writeFile(join(root, 'a.png'), 'png bytes');
  await writeFile(join(root, 'b.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(root, 'c.txt'), 'text');
  await mkdir(join(root, 'folder.png'));
  const small = path => fetch(`${base}/files/thumbnail?path=${encodeURIComponent(join(root, path))}`);
  const png = await small('a.png');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(await png.text(), 'png bytes');
  const svg = await small('b.svg');
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.match(svg.headers.get('content-security-policy'), /sandbox/, 'opened by its address, an SVG runs nothing');
  assert.equal((await small('c.txt')).status, 404);
  assert.equal((await small('folder.png')).status, 404);
  assert.equal((await small('gone.png')).status, 404);
});

test('Delete moves things to the desktop trash, and an item that cannot go is said and left', { skip: !hasGio && 'gio is not installed' }, async t => {
  // On a real disk: gio has no trash for tmpfs, which the temporary folder may be.
  const disk = await realDisk('trash-');
  const root = disk.files;
  const base = await serve(t, { actions: createFileActions({ run: disk.run }) });
  // After the server's own hook, so it closes even if this one were to fail.
  t.after(disk.remove);
  await mkdir(join(root, 'folder', 'inside'), { recursive: true });
  await writeFile(join(root, 'a.txt'), 'a');
  await writeFile(join(root, 'target.txt'), 'kept');
  await symlink(join(root, 'target.txt'), join(root, 'link'));
  const trash = async paths => (await fetch(`${base}/files/trash`, { method: 'POST', body: JSON.stringify({ paths }) })).json();

  const went = await trash([join(root, 'a.txt'), join(root, 'folder'), join(root, 'link'), join(root, 'gone.txt'), '/']);
  assert.deepEqual(went.trashed, [join(root, 'a.txt'), join(root, 'folder'), join(root, 'link')]);
  assert.deepEqual(went.refused, [
    { path: join(root, 'gone.txt'), name: 'gone.txt', reason: "it isn't there any more" },
    { path: '/', name: '/', reason: 'the top of the computer cannot be moved' },
  ]);
  assert.deepEqual(await readdir(root), ['target.txt'], 'a link goes, never what it points at');
  assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), 'kept');
  assert.deepEqual((await readdir(disk.trash)).sort(), ['a.txt', 'folder', 'link']);
  const info = await readFile(join(disk.trash, '..', 'info', 'a.txt.trashinfo'), 'utf8');
  assert.match(info, /^\[Trash Info\]\nPath=.*a\.txt\nDeletionDate=/, 'restorable, the freedesktop way');

  if (process.getuid?.() === 0) return t.diagnostic('running as root, which may move anything');
  await mkdir(join(root, 'locked'));
  await writeFile(join(root, 'locked', 'b.txt'), 'b');
  await chmod(join(root, 'locked'), 0o555);
  try {
    const refused = await trash([join(root, 'locked', 'b.txt')]);
    assert.deepEqual(refused.refused.map(r => r.reason), ["you don't have permission"]);
    assert.equal(await readFile(join(root, 'locked', 'b.txt'), 'utf8'), 'b');
  } finally {
    await chmod(join(root, 'locked'), 0o755);
  }
});

test('a file on tmpfs, which has no Trash, is refused and left where it is', { skip: (!hasGio && 'gio is not installed') || (!tmpfs && 'no tmpfs here') }, async t => {
  const disk = await realDisk('trash-tmpfs-');
  t.after(disk.remove);
  const dir = await mkdtemp(join(tmpfs, 'imperfect-trash-tmpfs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 't-trash'), 'stays');
  await writeFile(join(disk.files, 'goes.txt'), 'goes');
  const result = await createFileActions({ run: disk.run }).trash([join(dir, 't-trash'), join(disk.files, 'goes.txt')]);
  assert.deepEqual(result, {
    trashed: [join(disk.files, 'goes.txt')],
    refused: [{ path: join(dir, 't-trash'), name: 't-trash', reason: 'this drive has no Trash' }],
  });
  assert.equal(await readFile(join(dir, 't-trash'), 'utf8'), 'stays');
  assert.deepEqual(await readdir(disk.trash), ['goes.txt']);
});

test('a refusal from gio is said plainly, and the rest still go', async t => {
  const root = await place(t, 'files-trash-refused-');
  await writeFile(join(root, 'keep.txt'), 'k');
  await writeFile(join(root, 'usb.txt'), 'u');
  const asked = [];
  const run = async (bin, args) => {
    asked.push([bin, ...args]);
    if (args.at(-1).endsWith('usb.txt')) throw Object.assign(new Error('Command failed'), { stderr: `gio: file://${args.at(-1)}: Unable to find or create trash directory for ${args.at(-1)}\n` });
  };
  const result = await createFileActions({ run }).trash([join(root, 'usb.txt'), join(root, 'keep.txt')]);
  assert.deepEqual(result, { trashed: [join(root, 'keep.txt')], refused: [{ path: join(root, 'usb.txt'), name: 'usb.txt', reason: 'this drive has no Trash' }] });
  assert.ok(asked.every(([bin, sub, dashes]) => bin === 'gio' && sub === 'trash' && dashes === '--'), 'only ever gio trash, never a delete');
  assert.equal(trashRefusal({ stderr: 'gio: file:///mnt/usb/x: Unable to find or create trash directory for /mnt/usb/x' }), 'this drive has no Trash');
  assert.equal(trashRefusal({ stderr: 'gio: file:///x: Trashing on system internal mounts is not supported' }), 'this drive has no Trash');
  assert.equal(trashRefusal({ stderr: 'gio: file:///x: Error trashing file /x: Permission denied' }), "you don't have permission");
  assert.equal(trashRefusal({ code: 'ENOENT', syscall: 'spawn gio' }), 'this computer has no gio to move things to the Trash');
  assert.equal(trashRefusal({ stderr: 'gio: file:///x: Something odd' }), 'Something odd');
});

