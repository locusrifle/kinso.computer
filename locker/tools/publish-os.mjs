#!/usr/bin/env node
// One PC release: build the committed public distro, pin its ISO, then publish
// a new public commit and the download manifest. Never mirror private history.
// Run this long command in a systemd-run --user --collect unit (see --help).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SECRETS } from '../hooks/pre-receive.mjs';
import { validOSRelease } from '../os-product.mjs';

const VERSION = /^\d+(?:\.\d+){0,2}$/;
const MARKER = 'Imperfect-OS-Publication: 1';
const AUTHOR = { GIT_AUTHOR_NAME: 'Noah', GIT_AUTHOR_EMAIL: 'noah@imperfect.computer', GIT_COMMITTER_NAME: 'Noah', GIT_COMMITTER_EMAIL: 'noah@imperfect.computer' };
const mapped = new Map([['distribution/flake.nix', 'flake.nix'], ['flake.lock', 'flake.lock']]);
const safeTests = new Set(['tests/installer.nix', 'tests/installer-hardware.nix', 'tests/os-update.nix', 'tests/fake-store.py']);
const publicPath = path => mapped.get(path) ?? (/^(?:modules|lib|installer)\//.test(path) || safeTests.has(path) ? path : null);
const publishedPath = path => ['flake.nix', 'flake.lock'].includes(path) || /^(?:modules|lib|installer)\//.test(path) || safeTests.has(path);

function run(command, args, { input, env, inherit = false, liveErrors = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'] });
    const out = [], errors = [];
    if (!inherit) {
      child.stdout.on('data', b => out.push(b));
      child.stderr.on('data', b => { if (liveErrors) process.stderr.write(b); errors.push(b); if (errors.length > 32) errors.shift(); });
    }
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', code => code === 0 ? resolvePromise(Buffer.concat(out)) : reject(new Error(`${basename(command)} failed (${code}): ${Buffer.concat(errors).toString().slice(-2000)}`)));
  });
}
const git = (directory, args, options) => run('git', ['-C', directory, ...args], options);
const bareGit = (repo, args, options) => run('git', ['--git-dir', repo, ...args], options);
async function exists(path) { try { await access(path); return true; } catch { return false; } }
function noSecrets(body, path) {
  for (const [pattern, what] of SECRETS) if (pattern.test(body.toString('utf8'))) throw new Error(`refusing to publish ${path}: looks like ${what}`);
}

export async function exportPublicDistro({ source, destination }) {
  if ((await git(source, ['status', '--porcelain', '--untracked-files=normal'])).length) throw new Error('commit or remove local OS changes before publishing');
  const commit = (await git(source, ['rev-parse', 'HEAD'])).toString().trim();
  const records = (await git(source, ['ls-tree', '-rz', '--full-tree', commit])).toString().split('\0').filter(Boolean);
  const copied = new Set();
  await mkdir(destination, { recursive: true });
  for (const record of records) {
    const [metadata, path] = record.split('\t');
    const target = publicPath(path);
    if (!target) continue;
    const [mode, type, object] = metadata.split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || !/^[A-Za-z0-9_./-]+$/.test(path) || record.split('\t').length !== 2 || path.split('/').some(p => p === '..' || p.startsWith('.'))) throw new Error(`unsafe public source entry: ${path}`);
    const bytes = await git(source, ['cat-file', 'blob', object]);
    noSecrets(bytes, target);
    const file = join(destination, target);
    await mkdir(resolve(file, '..'), { recursive: true });
    await writeFile(file, bytes, { mode: mode === '100755' ? 0o755 : 0o644 });
    copied.add(target);
  }
  for (const path of ['flake.nix', 'flake.lock', 'installer/iso.nix', 'modules/default.nix']) if (!copied.has(path)) throw new Error(`public distro is missing ${path}`);
  return { commit, files: [...copied].sort() };
}

async function buildInstaller({ source, publicTree }) {
  // The existing launcher uses the isolated rootless store. The exported tree
  // lives below productDir (normally in HOME), not the launcher's private /tmp.
  const output = await run(join(source, 'tools', 'nix'), ['build', '--no-update-lock-file', '--no-link', '--print-out-paths', `path:${publicTree}#installer`], { liveErrors: true });
  const outputs = output.toString().trim().split('\n');
  if (outputs.length !== 1 || !outputs[0].startsWith('/nix/store/')) throw new Error('installer build returned an unexpected output');
  const cache = process.env.IMPERFECT_OS_CACHE || join(homedir(), '.cache', 'imperfect-os');
  const physical = join(cache, 'nix', 'store', basename(outputs[0]));
  const root = await exists(physical) ? physical : outputs[0];
  const files = (await readdir(join(root, 'iso'))).filter(f => f.endsWith('.iso'));
  if (files.length !== 1) throw new Error('installer output must contain exactly one ISO');
  return join(root, 'iso', files[0]);
}

async function checksum(file) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}
async function pinInstaller(file, downloads, staging) {
  if (!(await lstat(file)).isFile()) throw new Error('installer must be a regular file, not a symlink');
  const temporary = join(staging, 'installer.iso');
  const hash = createHash('sha256'); let bytes = 0;
  const meter = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); bytes += chunk.length; done(null, chunk); } });
  await pipeline(createReadStream(file), meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
  if (!bytes || !Number.isSafeInteger(bytes)) throw new Error('installer is empty or too large');
  const sha256 = hash.digest('hex');
  const name = `imperfect-os-${sha256}.iso`;
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  const target = join(downloads, name);
  if (await exists(target)) {
    if (!(await lstat(target)).isFile()) throw new Error('existing ISO is not a regular file');
    const prior = await checksum(target);
    if (prior.sha256 !== sha256 || prior.bytes !== bytes) throw new Error('existing pinned ISO is corrupt; repair it before publishing');
  } else await rename(temporary, target);
  return { file: name, sha256, bytes };
}

async function checkPublicHistory(repo) {
  const commits = (await bareGit(repo, ['rev-list', '--all'])).toString().trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    const message = await bareGit(repo, ['show', '-s', '--format=%B', commit]);
    if (!message.toString().split('\n').includes(MARKER)) throw new Error('existing OS repository was not made by this publisher; never reuse a private clone');
    noSecrets(message, 'previous release message');
    const records = (await bareGit(repo, ['ls-tree', '-rz', commit])).toString().split('\0').filter(Boolean);
    for (const record of records) {
      const [metadata, path] = record.split('\t');
      const [mode, type, object] = metadata.split(' ');
      if (!publishedPath(path) || type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('existing OS repository contains unpublished/private paths');
      noSecrets(await bareGit(repo, ['cat-file', 'blob', object]), path);
    }
  }
}

export async function publishOS({ version, source, product, notes, builder = buildInstaller, log = console }) {
  if (!VERSION.test(String(version ?? ''))) throw new Error('version must be digits, e.g. 1.0');
  if (typeof notes !== 'string' || !notes.trim() || Buffer.byteLength(notes) > 1024 * 1024) throw new Error('write short public release notes first');
  noSecrets(Buffer.from(notes), 'release notes');
  source = resolve(source); product = resolve(product);
  await mkdir(product, { recursive: true, mode: 0o700 });
  const lockPath = join(product, '.os-publication.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('another OS publication is running (or interrupted; inspect .os-publication.lock before removing it)'); throw error; }
  let staging;
  try {
    await lock.writeFile(`${process.pid}\n`);
    const repo = join(product, 'imperfect-os.git');
    let previous = '';
    if (await exists(repo)) {
      await checkPublicHistory(repo);
      if ((await bareGit(repo, ['tag', '--list', `v${version}`])).length) {
        // Recover a crash after the source ref promotion but before the manifest
        // rename. Never move the ISO pointer back past a newer main commit.
        const pendingPath = join(product, '.os-release.pending.json');
        if (await exists(pendingPath)) {
          const pending = JSON.parse(await readFile(pendingPath, 'utf8'));
          const current = (await bareGit(repo, ['rev-parse', 'refs/heads/main'])).toString().trim();
          const tag = (await bareGit(repo, ['rev-parse', `refs/tags/v${version}`])).toString().trim();
          if (validOSRelease(pending) && pending.version === version && pending.repoCommit === tag && tag === current) {
            const iso = join(product, 'os-downloads', pending.installer.file);
            if (!(await lstat(iso)).isFile()) throw new Error('interrupted publication ISO is not a regular file');
            const actual = await checksum(iso);
            if (actual.sha256 !== pending.installer.sha256 || actual.bytes !== pending.installer.bytes) throw new Error('interrupted publication ISO is corrupt');
            await rename(pendingPath, join(product, 'os-release.json'));
            log.info?.(`finished interrupted imperfect OS ${version} publication`);
            return pending;
          }
        }
        throw new Error(`${version} has already been published`);
      }
      try { previous = (await bareGit(repo, ['rev-parse', '--verify', 'refs/heads/main'])).toString().trim(); } catch { /* first publication was interrupted */ }
    }
    staging = await mkdtemp(join(product, '.os-publish-'));
    const publicTree = join(staging, 'public');
    await exportPublicDistro({ source, destination: publicTree });
    log.info?.(`building public imperfect OS ${version} (no personal hosts or history)`);
    const iso = await builder({ source, publicTree, staging });
    const installer = await pinInstaller(iso, join(product, 'os-downloads'), staging);
    if (!await exists(repo)) {
      await run('git', ['init', '--bare', '--object-format=sha1', '--initial-branch=main', repo]);
      await chmod(repo, 0o700);
    }
    // No push, mirror, fetch or private ancestry. A fresh index writes exactly
    // the clean exported tree into the public bare repo.
    const env = { ...AUTHOR, GIT_INDEX_FILE: join(staging, 'index') };
    await bareGit(repo, ['read-tree', '--empty'], { env });
    await bareGit(repo, [`--work-tree=${publicTree}`, 'add', '--all'], { env });
    const tree = (await bareGit(repo, ['write-tree'], { env })).toString().trim();
    const message = `imperfect OS ${version}\n\n${notes.trim()}\n\n${MARKER}\nCo-Authored-By: GPT-6.1 Sol <noreply@openai.com>\n`;
    const commit = (await bareGit(repo, ['commit-tree', tree, ...(previous ? ['-p', previous] : [])], { input: message, env })).toString().trim();
    const manifest = { schema: 1, version, repoCommit: commit, installer };
    const manifestTemp = join(staging, 'os-release.json');
    const pendingPath = join(product, '.os-release.pending.json');
    await writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(manifestTemp, pendingPath);
    // Promote source and version together; never overwrite another operator's
    // update. The ISO exists first. The filesystem manifest is promoted last.
    await bareGit(repo, ['update-ref', '--stdin'], { input: `start\nupdate refs/heads/main ${commit} ${previous || '0'.repeat(40)}\ncreate refs/tags/v${version} ${commit}\nprepare\ncommit\n` });
    await bareGit(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await rename(pendingPath, join(product, 'os-release.json'));
    log.info?.(`published imperfect OS ${version}: ${commit}, SHA-256 ${installer.sha256}`);
    return manifest;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2);
  const usage = 'publish-os.mjs <version> --source <private-os-checkout> --notes-file <public-notes> [--product <store-product-dir>]\nBuilds the ISO from committed public source. Run in systemd-run --user --collect with a persistent log.';
  if (args.includes('--help')) console.log(usage);
  else {
    try {
      const version = args.shift(); const flags = {};
      while (args.length) { const name = args.shift(); if (!['--source', '--notes-file', '--product'].includes(name) || !args.length || flags[name]) throw new Error(usage); flags[name] = args.shift(); }
      if (!flags['--source'] || !flags['--notes-file']) throw new Error(usage);
      await publishOS({ version, source: flags['--source'], product: flags['--product'] || join(homedir(), '.imperfect', 'product'), notes: await readFile(flags['--notes-file'], 'utf8') });
    } catch (error) { console.error(`publish OS: ${error.message}`); process.exitCode = 1; }
  }
}
