// Editing a text file in Workbench (system/file-text.mjs, through files.mjs:
// GET and POST /files/text): only this user's own .md and .txt files in the
// home folder, where they really are; never over a version changed on disk;
// written whole or not at all, with the file's mode; no bigger than the
// limit; and only from Workbench, behind the same checks as the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFiles } from '../../../system/files.mjs';
import { createFileText, versionOf } from '../../../system/file-text.mjs';
import { createGueyServer } from '../../../system/server.mjs';
import { createTabHost } from '../native/tabs.mjs';

async function place(t) {
  const top = await realpath(await mkdtemp(join(tmpdir(), 'files-text-')));
  t.after(() => rm(top, { recursive: true, force: true }));
  const home = join(top, 'home'), away = join(top, 'away');
  await mkdir(join(home, 'docs'), { recursive: true });
  await mkdir(away);
  await writeFile(join(home, 'docs', 'script.md'), '# Script\n\nThe first line.\n');
  await writeFile(join(home, 'docs', 'notes.txt'), 'plain notes\n');
  await writeFile(join(away, 'secret.md'), 'not yours to edit\n');
  return { top, home, away };
}
async function serve(t, options) {
  const handle = createFiles({ thumbnailDir: join(tmpdir(), 'files-text-test-cache'), edits: createFileText(options) });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!await handle(req, res, url.pathname, url.search)) res.writeHead(418).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = path => `${base}/files/text?path=${encodeURIComponent(path)}`;
  return {
    base,
    read: async (path, headers) => { const res = await fetch(url(path), { headers }); return { status: res.status, body: await res.json() }; },
    save: async (path, text, version, headers = {}) => {
      const res = await fetch(url(path), { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8', ...(version ? { 'if-match': `"${version}"` } : {}), ...headers }, body: text });
      return { status: res.status, body: await res.json() };
    },
    peek: async path => (await fetch(`${base}/files/peek?path=${encodeURIComponent(path)}`)).json(),
  };
}

test('a Markdown file is read whole with its version, and saved in place with its mode', async t => {
  const { home } = await place(t);
  const api = await serve(t, { roots: [home] });
  const path = join(home, 'docs', 'script.md');
  await chmod(path, 0o640);
  assert.equal((await api.peek(path)).editable, true, 'Workbench is told it can be edited');
  const opened = await api.read(path);
  assert.equal(opened.status, 200);
  assert.deepEqual([opened.body.name, opened.body.text, opened.body.version], ['script.md', '# Script\n\nThe first line.\n', versionOf(Buffer.from('# Script\n\nThe first line.\n'))]);

  const before = await stat(path);
  const saved = await api.save(path, '# Script\n\nThe first line, rewritten. — é\n', opened.body.version);
  assert.equal(saved.status, 200);
  assert.equal(await readFile(path, 'utf8'), '# Script\n\nThe first line, rewritten. — é\n');
  assert.equal(saved.body.version, versionOf(await readFile(path)));
  const after = await stat(path);
  assert.equal(after.mode & 0o7777, 0o640, 'the mode it had');
  assert.notEqual(after.ino, before.ino, 'a new file took its place, whole');
  assert.deepEqual((await readdir(join(home, 'docs'))).sort(), ['notes.txt', 'script.md'], 'nothing left beside it');

  // Saved again from the version that save returned.
  assert.equal((await api.save(path, 'third\n', saved.body.version)).status, 200);
  assert.equal(await readFile(path, 'utf8'), 'third\n');

  const notes = join(home, 'docs', 'notes.txt');
  const read = await api.read(notes);
  assert.equal((await api.save(notes, 'plain notes, more\n', read.body.version)).status, 200, 'a .txt too');
  assert.equal(await readFile(notes, 'utf8'), 'plain notes, more\n');
});

test('a file changed on disk since it was opened is never overwritten unasked', async t => {
  const { home } = await place(t);
  const api = await serve(t, { roots: [home] });
  const path = join(home, 'docs', 'script.md');
  const opened = await api.read(path);
  await writeFile(path, 'changed by another editor\n');
  const refused = await api.save(path, 'mine\n', opened.body.version);
  assert.equal(refused.status, 412);
  assert.match(refused.body.error, /changed on disk/);
  assert.equal(refused.body.version, versionOf(Buffer.from('changed by another editor\n')), 'the version on disk, to choose by');
  assert.equal(await readFile(path, 'utf8'), 'changed by another editor\n');
  // Overwrite: the person saw the version on disk and chose to save over it.
  assert.equal((await api.save(path, 'mine\n', refused.body.version)).status, 200);
  assert.equal(await readFile(path, 'utf8'), 'mine\n');

  // Two saves from one version at once: one is saved, the other refused.
  const now = (await api.read(path)).body.version;
  const both = await Promise.all([api.save(path, 'one\n', now), api.save(path, 'two\n', now)]);
  assert.deepEqual(both.map(answer => answer.status).sort(), [200, 412]);
  assert.equal(await readFile(path, 'utf8'), both.find(answer => answer.status === 200) === both[0] ? 'one\n' : 'two\n');

  assert.equal((await api.save(path, 'no version\n')).status, 428, 'a save names its version');
  assert.equal((await api.save(path, 'bad version\n', 'abc')).status, 428);
  assert.equal(await readFile(path, 'utf8'), both.find(answer => answer.status === 200) === both[0] ? 'one\n' : 'two\n');
});

test('only files in the home folder, where they really are: no climbing out, no links out', async t => {
  const { home, away } = await place(t);
  const api = await serve(t, { roots: [home] });
  const outside = join(away, 'secret.md');
  const version = versionOf(await readFile(outside));
  const tries = {
    'outside': outside,
    'climbing': `${home}/docs/../../away/secret.md`,
    'a link out': join(home, 'docs', 'link.md'),
    'a folder link out': join(home, 'docs', 'elsewhere', 'secret.md'),
  };
  await symlink(outside, tries['a link out']);
  await symlink(away, join(home, 'docs', 'elsewhere'));
  for (const [what, path] of Object.entries(tries)) {
    assert.equal((await api.read(path)).status, 403, `${what}: not read to edit`);
    const answer = await api.save(path, 'overwritten\n', version);
    assert.equal(answer.status, 403, `${what}: not saved`);
    assert.match(answer.body.error, /home folder/);
    assert.equal((await api.peek(path)).editable, false, `${what}: not offered`);
  }
  assert.equal(await readFile(outside, 'utf8'), 'not yours to edit\n');

  // A link inside the home folder is followed: the file it names is saved,
  // and the link stays a link.
  const inner = join(home, 'docs', 'alias.md');
  await symlink(join(home, 'docs', 'script.md'), inner);
  const opened = await api.read(inner);
  assert.equal((await api.save(inner, 'through the link\n', opened.body.version)).status, 200);
  assert.equal(await readFile(join(home, 'docs', 'script.md'), 'utf8'), 'through the link\n');
  assert.equal((await lstat(inner)).isSymbolicLink(), true);

  // A link with an editable name to a file of another kind is refused.
  await writeFile(join(home, '.bashrc'), 'export A=1\n');
  await symlink(join(home, '.bashrc'), join(home, 'docs', 'rc.md'));
  assert.equal((await api.save(join(home, 'docs', 'rc.md'), 'rm -rf ~\n', versionOf(Buffer.from('export A=1\n')))).status, 415);
  assert.equal(await readFile(join(home, '.bashrc'), 'utf8'), 'export A=1\n');

  for (const [path, status] of [['docs/script.md', 400], [`${join(home, 'docs', 'script.md')}\0.md`, 400], [join(home, 'docs', 'gone.md'), 404], [join(home, 'docs'), 415], [join(home, '.bashrc'), 415]]) {
    assert.equal((await api.save(path, 'x\n', version)).status, status, path);
  }
  await mkdir(join(home, 'folder.md'));
  assert.equal((await api.save(join(home, 'folder.md'), 'x\n', version)).status, 404, 'a folder is not a file');
});

test('a file this user cannot change, or one with other links, is left as it is', { skip: process.getuid?.() === 0 && 'root can write anything' }, async t => {
  const { home } = await place(t);
  const api = await serve(t, { roots: [home] });
  const path = join(home, 'docs', 'script.md');
  const { version } = (await api.read(path)).body;
  await chmod(path, 0o444);
  const readOnly = await api.save(path, 'x\n', version);
  assert.equal(readOnly.status, 403);
  assert.match(readOnly.body.error, /permission/);
  assert.equal((await api.peek(path)).editable, false);
  await chmod(path, 0o644);
  await link(path, join(home, 'docs', 'twin.md'));
  assert.equal((await api.save(path, 'x\n', version)).status, 403, 'saving would part it from its twin');
  assert.equal(await readFile(join(home, 'docs', 'twin.md'), 'utf8'), '# Script\n\nThe first line.\n');
  const other = await serve(t, { roots: [home], uid: 4242 });
  assert.equal((await other.save(join(home, 'docs', 'notes.txt'), 'x\n', versionOf(Buffer.from('plain notes\n')))).body.error, 'it belongs to another user');
});

test('the size cap and plain text, both ways', async t => {
  const { home } = await place(t);
  const api = await serve(t, { roots: [home], limit: 1024 });
  const path = join(home, 'docs', 'script.md');
  const { version } = (await api.read(path)).body;
  const tooBig = await api.save(path, 'x'.repeat(1025), version);
  assert.equal(tooBig.status, 413);
  assert.equal((await api.save(path, 'x'.repeat(1024), version)).status, 200, 'up to the limit');
  await writeFile(path, 'y'.repeat(2000));
  assert.equal((await api.read(path)).status, 413, 'too big to edit');
  assert.equal((await api.peek(path)).editable, false);

  await writeFile(path, Buffer.from('caf\xe9\n', 'latin1'));
  assert.equal((await api.read(path)).status, 415, 'not UTF-8: editing would change its bytes');
  await writeFile(path, 'fine\n');
  const now = versionOf(Buffer.from('fine\n'));
  const res = await fetch(`${api.base}/files/text?path=${encodeURIComponent(path)}`, { method: 'POST', headers: { 'if-match': `"${now}"` }, body: Buffer.from([0x66, 0xff, 0x00]) });
  assert.equal(res.status, 415);
  assert.equal(await readFile(path, 'utf8'), 'fine\n');
});

test('whoever reads the file meanwhile sees the old text or the new, never part', async t => {
  const { home } = await place(t);
  const api = await serve(t, { roots: [home] });
  const path = join(home, 'docs', 'script.md');
  const old = 'a'.repeat(900_000), fresh = 'b'.repeat(1_000_000);
  await writeFile(path, old);
  let version = versionOf(Buffer.from(old));
  let reading = true;
  const seen = new Set();
  const reader = (async () => { while (reading) { const text = await readFile(path, 'utf8'); seen.add(text === old ? 'old' : text === fresh ? 'new' : `part ${text.length}`); } })();
  for (let round = 0; round < 6; round++) {
    const text = round % 2 ? old : fresh;
    const answer = await api.save(path, text, version);
    assert.equal(answer.status, 200);
    version = answer.body.version;
  }
  reading = false;
  await reader;
  assert.deepEqual([...seen].filter(what => what.startsWith('part')), [], 'never half written');
  assert.deepEqual((await readdir(join(home, 'docs'))).sort(), ['notes.txt', 'script.md']);
});

test('only from Workbench: never a page from elsewhere, nor another origin, here or through /peer/', async t => {
  const { home } = await place(t);
  const api = await serve(t, { roots: [home] });
  const path = join(home, 'docs', 'script.md');
  const { version } = (await api.read(path)).body;
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await api.read(path, { 'sec-fetch-site': site })).status, 403);
    assert.equal((await api.save(path, 'from elsewhere\n', version, { 'sec-fetch-site': site })).status, 403);
  }
  assert.equal(await readFile(path, 'utf8'), '# Script\n\nThe first line.\n');

  const root = await mkdtemp(join(tmpdir(), 'files-text-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const asked = [];
  const other = createServer((req, res) => { asked.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => other.close(resolve)));
  const runtime = await createTabHost({
    stateDir: join(root, 'tabs'), listPiSessions: async () => [],
    createRuntime: () => ({ events: new EventEmitter(), snapshot: () => ({ sessionId: 's', cwd: '/', messages: [], busy: false, streaming: false, failed: null }), command: async () => ({ ok: true }), close: async () => {} }),
  });
  const machines = {
    self: async () => 'laptop', selfId: async () => 'node-laptop', origins: async () => [],
    list: async () => [{ id: 'node-laptop', name: 'laptop', self: true, online: true, reachable: true, protocol: 1, capabilities: ['code', 'files'] }],
    peer: async id => (id === 'desktop' ? { id, name: 'desktop', url: `http://127.0.0.1:${other.address().port}`, reachable: true } : null),
  };
  const app = await createGueyServer({ host: '127.0.0.1', port: 0, stateDir: join(root, 'server'), runtime, machines, files: { thumbnailDir: join(root, 'pictures'), edits: createFileText({ roots: [home] }) } });
  try {
    const { port } = await app.listen();
    const save = (prefix, headers) => fetch(`http://127.0.0.1:${port}${prefix}/files/text?path=${encodeURIComponent(path)}`, { method: 'POST', headers: { 'if-match': `"${version}"`, ...headers }, body: 'through the server\n' });
    assert.equal((await save('', { origin: 'https://elsewhere.example' })).status, 403, 'another origin is refused before Files is asked');
    assert.equal((await save('/peer/desktop', { 'sec-fetch-site': 'same-site' })).status, 403);
    assert.deepEqual(asked, [], 'the other computer was never asked');
    assert.equal(await readFile(path, 'utf8'), '# Script\n\nThe first line.\n');
    assert.equal((await save('', { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' })).status, 200, "Workbench's own origin");
    assert.equal(await readFile(path, 'utf8'), 'through the server\n');
    assert.equal((await save('/peer/desktop', { 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.deepEqual(asked, [`/files/text?path=${encodeURIComponent(path)}`], 'the save went on to the computer the file is on');
  } finally {
    await app.close();
  }
});
