import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exportPublicDistro, publishOS } from '../tools/publish-os.mjs';

const run = promisify(execFile);
const git = async (dir, ...args) => (await run('git', ['-C', dir, ...args])).stdout.trim();
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'os-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'private'); const product = join(root, 'product');
  await mkdir(source);
  await git(source, 'init', '-q', '-b', 'main');
  const files = {
    'flake.nix': '# PERSONAL private root flake',
    'distribution/flake.nix': '# generic public flake',
    'flake.lock': '{"nodes":{}}',
    'modules/default.nix': '# generic module',
    'modules/session/run.sh': '#!/bin/sh\necho generic',
    'installer/iso.nix': '# generic installer',
    'lib/source.nix': '# generic lib',
    'tests/installer.nix': '# safe installer test',
    'tests/installer-hardware.nix': '# safe test hardware',
    'tests/os-update.nix': '# safe fake store test',
    'tests/fake-store.py': '# generic test HTTP git backend',
    'tests/boot-pc.nix': '# PERSONAL PC UUID fixture',
    'hosts/desktop/default.nix': '# PERSONAL user keys paths',
    'hosts/laptop/default.nix': '# PERSONAL tailnet names',
    'hosts/noah/default.nix': '# PERSONAL cloud hostname',
    'REPORT.md': '# PERSONAL private operations',
    'tools/nix': '# private rootless build launcher',
  };
  for (const [path, body] of Object.entries(files)) { await mkdir(join(source, path, '..'), { recursive: true }); await writeFile(join(source, path), body, { mode: path.endsWith('.sh') ? 0o755 : 0o644 }); }
  await git(source, 'add', '-A');
  await git(source, '-c', 'user.name=Private Person', '-c', 'user.email=private@example.test', 'commit', '-qm', 'PERSONAL private history, host addresses and names');
  const iso = join(root, 'built.iso'); await writeFile(iso, 'ISO bytes built from public tree');
  let builds = 0;
  const builder = async ({ publicTree }) => {
    builds++;
    assert.equal(await readFile(join(publicTree, 'flake.nix'), 'utf8'), files['distribution/flake.nix']);
    assert.equal(await readFile(join(publicTree, 'modules/default.nix'), 'utf8'), files['modules/default.nix']);
    for (const path of ['hosts', '.git', 'tools', 'REPORT.md', 'tests/boot-pc.nix', 'distribution']) await assert.rejects(readFile(join(publicTree, path)), { code: 'ENOENT' });
    return iso;
  };
  const publish = (version = '1.0', options = {}) => publishOS({ source, product, version, notes: 'Your computer can now update when you ask.\n\nEvery change is yours to approve.', builder, log: {}, ...options });
  return { root, source, product, iso, builder, publish, builds: () => builds };
}

test('one release builds only clean public source, creates fresh history and pins immutable ISO bytes', async t => {
  const f = await fixture(t); const result = await f.publish();
  const repo = join(f.product, 'imperfect-os.git');
  const privateCommit = await git(f.source, 'rev-parse', 'HEAD');
  await assert.rejects(git(repo, 'cat-file', '-e', privateCommit));
  const manifest = JSON.parse(await readFile(join(f.product, 'os-release.json')));
  assert.deepEqual(result, manifest);
  assert.equal(result.schema, 1);
  assert.equal(result.installer.sha256, createHash('sha256').update(await readFile(f.iso)).digest('hex'));
  assert.equal(result.installer.bytes, (await readFile(f.iso)).length);
  assert.deepEqual(await readFile(join(f.product, 'os-downloads', result.installer.file)), await readFile(f.iso));
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), result.repoCommit);
  assert.equal(await git(repo, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(await git(repo, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(await git(repo, 'rev-parse', 'v1.0'), result.repoCommit);
  const names = await git(repo, 'ls-tree', '-r', '--name-only', 'HEAD');
  assert.match(names, /installer\/iso.nix/);
  assert.match(names, /tests\/os-update.nix/);
  assert.match(names, /tests\/fake-store.py/);
  assert.doesNotMatch(names, /hosts|REPORT|tools|distribution|boot-pc/);
  const history = await git(repo, 'log', '--format=%B');
  assert.match(history, /Every change is yours to approve/);
  assert.doesNotMatch(history, /PERSONAL|private@example/);
  assert.match(history, /Co-Authored-By: GPT-6.1 Sol/);
  await assert.rejects(f.publish(), /already been published/);
  assert.equal(f.builds(), 1);
  const next = await f.publish('1.1', { notes: 'A second version with the full change description.' });
  assert.notEqual(next.repoCommit, result.repoCommit);
  assert.equal(await git(repo, 'rev-list', '--count', 'HEAD'), '2');
  assert.equal(await git(repo, 'rev-parse', 'HEAD^'), result.repoCommit);
});

test('public commit ids keep the store schema even when the operator defaults to SHA256 Git', async t => {
  const previous = process.env.GIT_DEFAULT_HASH;
  process.env.GIT_DEFAULT_HASH = 'sha256';
  try {
    const f = await fixture(t); const manifest = await f.publish();
    assert.match(manifest.repoCommit, /^[a-f0-9]{40}$/);
    assert.equal(await git(join(f.product, 'imperfect-os.git'), 'rev-parse', '--show-object-format'), 'sha1');
  } finally {
    if (previous === undefined) delete process.env.GIT_DEFAULT_HASH;
    else process.env.GIT_DEFAULT_HASH = previous;
  }
});

test('rerunning the same version completes an interrupted source/manifest promotion without rebuilding', async t => {
  const f = await fixture(t); const manifest = await f.publish();
  await rename(join(f.product, 'os-release.json'), join(f.product, '.os-release.pending.json'));
  assert.deepEqual(await f.publish(), manifest);
  assert.equal(f.builds(), 1);
  assert.deepEqual(JSON.parse(await readFile(join(f.product, 'os-release.json'))), manifest);
});

test('interrupted metadata must satisfy the exact store schema before recovery', async t => {
  const f = await fixture(t); const manifest = await f.publish();
  await writeFile(join(f.product, '.os-release.pending.json'), JSON.stringify({ ...manifest, extra: 'not supported' }));
  await assert.rejects(f.publish(), /already been published/);
  assert.deepEqual(JSON.parse(await readFile(join(f.product, 'os-release.json'))), manifest);
});

test('a failed build leaves the published repository and manifest unchanged', async t => {
  const f = await fixture(t); const before = await f.publish();
  await assert.rejects(f.publish('1.1', { builder: async () => { throw new Error('test build failure'); } }), /test build failure/);
  assert.deepEqual(JSON.parse(await readFile(join(f.product, 'os-release.json'))), before);
  assert.equal(await git(join(f.product, 'imperfect-os.git'), 'rev-parse', 'HEAD'), before.repoCommit);
  await f.publish('1.1'); // The publication lock was released after failure.
});

test('a dirty private checkout cannot be accidentally released', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'modules/default.nix'), '# unreviewed');
  await assert.rejects(f.publish(), /commit or remove local OS changes/);
  assert.equal(f.builds(), 0);
});

test('allowlisted symlinks are refused; they cannot smuggle personal files into the public export', async t => {
  const f = await fixture(t);
  await symlink('../hosts/desktop/default.nix', join(f.source, 'modules/secret.nix'));
  await git(f.source, 'add', '-A');
  await git(f.source, '-c', 'user.name=Noah', '-c', 'user.email=noah@imperfect.computer', 'commit', '-qm', 'A symlink');
  await assert.rejects(exportPublicDistro({ source: f.source, destination: join(f.root, 'export') }), /unsafe public source entry/);
});

test('public files and release notes must not contain licence secrets', async t => {
  const f = await fixture(t); const key = `ic_${'1'.repeat(40)}`; // This test owns this fake key.
  await assert.rejects(f.publish('1.0', { notes: `Use ${key}` }), /membership key/);
  await writeFile(join(f.source, 'modules/bad.nix'), key);
  await git(f.source, 'add', '-A');
  await git(f.source, '-c', 'user.name=Noah', '-c', 'user.email=noah@imperfect.computer', 'commit', '-qm', 'A secret');
  await assert.rejects(f.publish(), /membership key/);
  assert.equal(f.builds(), 0);
});

test('an existing private clone is never reused as a public repository', async t => {
  const f = await fixture(t);
  await mkdir(f.product);
  await run('git', ['clone', '--bare', f.source, join(f.product, 'imperfect-os.git')]);
  await assert.rejects(f.publish(), /never reuse a private clone/);
  assert.equal(f.builds(), 0);
});

test('concurrent publications refuse rather than racing main or the manifest', async t => {
  const f = await fixture(t);
  await mkdir(f.product);
  await writeFile(join(f.product, '.os-publication.lock'), 'test operator\n');
  await assert.rejects(f.publish(), /another OS publication/);
  assert.equal(await readFile(join(f.product, '.os-publication.lock'), 'utf8'), 'test operator\n');
});

test('corrupt immutable ISO paths are not overwritten or promoted', async t => {
  const f = await fixture(t); const manifest = await f.publish();
  await writeFile(join(f.product, 'os-downloads', manifest.installer.file), 'corrupt');
  await assert.rejects(f.publish('1.1'), /existing pinned ISO is corrupt/);
  assert.deepEqual(JSON.parse(await readFile(join(f.product, 'os-release.json'))), manifest);
});
