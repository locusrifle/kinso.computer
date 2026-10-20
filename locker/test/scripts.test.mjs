import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pin } from '../tools/pin.mjs';
import { check, MAINTAINER } from '../hooks/pre-receive.mjs';
import { parseEnvFile } from '../start.mjs';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..', '..');

test('the installer is valid bash and lives at the root, beside the AGENTS.md it follows', async () => {
  const script = await readFile(join(root, 'install.sh'), 'utf8');
  assert.match(script, /set -euo pipefail/);
  await run('bash', ['-n', join(root, 'install.sh')]);
  const agents = await readFile(join(root, 'AGENTS.md'), 'utf8');
  for (const part of ['## Install', '## Updates', '## Undo', 'cherry-pick', 'wireless debugging', '## Working on this repository']) assert.ok(agents.includes(part), part);
  const pins = JSON.parse(await readFile(join(root, 'binaries.json'), 'utf8'));
  assert.ok(pins.android?.sha256);
});

test('pinning copies a native app to the store by checksum and records it in binaries.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pin-'));
  try {
    await writeFile(join(dir, 'app.apk'), 'apk bytes');
    const pinned = await pin({ entry: 'android', file: join(dir, 'app.apk'), root: dir, product: join(dir, 'product') });
    assert.match(pinned.file, /^imperfect-android-[0-9a-f]{12}\.apk$/);
    assert.equal(await readFile(join(dir, 'product', 'downloads', pinned.file), 'utf8'), 'apk bytes');
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'binaries.json'), 'utf8')), { android: pinned });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('only Locus pushes, only main, and never with a secret', () => {
  const clean = () => 'a change';
  const line = ref => `${'0'.repeat(40)} ${'a'.repeat(40)} ${ref}`;
  assert.match(check([line('refs/heads/sam/voice')], 'sam', clean)[0], /only Locus pushes/);
  assert.match(check([line('refs/heads/main')], 'sam', clean)[0], /only Locus pushes/);
  assert.match(check([line('refs/heads/locus/x')], MAINTAINER, clean)[0], /only main/);
  assert.deepEqual(check([line('refs/heads/main')], MAINTAINER, clean), []);
  assert.match(check([`${'a'.repeat(40)} ${'0'.repeat(40)} refs/heads/main`], MAINTAINER, clean)[0], /cannot be deleted/);
  assert.match(check([line('refs/heads/main')], MAINTAINER, () => `sk_live_${'a'.repeat(24)}`)[0], /Stripe secret key/);
});

test('the env file reader takes KEY=VALUE, quotes and comments', () => {
  assert.deepEqual(parseEnvFile('# note\nA=1\nB="two words"\nC=\'x=y\'\n\nbad line\n'), { A: '1', B: 'two words', C: 'x=y' });
});

test("install.sh gives the service the node binary itself, not mise's shim", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'node-binary-'));
  try {
    // A mise shim is a link to mise; mise knows which node it stands for.
    await mkdir(join(dir, 'shims'), { recursive: true });
    await mkdir(join(dir, 'bin'), { recursive: true });
    await mkdir(join(dir, 'node22/bin'), { recursive: true });
    await writeFile(join(dir, 'node22/bin/node'), '#!/usr/bin/env sh\necho v22.0.0\n', { mode: 0o755 });
    await writeFile(join(dir, 'bin/mise'), `#!/usr/bin/env sh\n[ "$1 $2" = "which node" ] && echo ${join(dir, 'node22/bin/node')}\n`, { mode: 0o755 });
    await symlink(join(dir, 'bin/mise'), join(dir, 'shims/node'));
    const script = join(root, 'install.sh');
    // No system startup files: NixOS's bashrc otherwise resets a fresh
    // environment's PATH to the profile, discarding our fake mise/node.
    const { stdout } = await run('bash', ['--noprofile', '--norc', '-c', `source <(sed '/^case "\${1:-install}"/,$d' "${script}"); node_binary`], {
      // Keep the fake tools first, but let bash find sed/readlink/etc. on
      // this distribution's PATH (NixOS does not put them in /usr/bin).
      env: { PATH: `${join(dir, 'shims')}:${join(dir, 'bin')}:${process.env.PATH}`, HOME: dir },
    });
    assert.equal(stdout.trim(), join(dir, 'node22/bin/node'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pinned downloads: a GitHub clone with no key takes the release; a store clone takes its own with its key; both check the checksum', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinned-'));
  try {
    const file = 'imperfect-android-test.apk';
    const bytes = join(dir, 'bytes');
    await writeFile(bytes, 'apk bytes');
    await writeFile(join(dir, 'binaries.json'), JSON.stringify({ android: { file, sha256: createHash('sha256').update('apk bytes').digest('hex') } }));
    // A stand-in curl: records its arguments and copies the bytes to -o.
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'bin', 'curl'), ['#!/usr/bin/env sh', `echo "$@" >> ${join(dir, 'curl.log')}`, 'out=', 'while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done', `cp ${bytes} "$out"`].join('\n') + '\n', { mode: 0o755 });
    // The functions alone, from this copy of the script, so ROOT is dir.
    const script = await readFile(join(root, 'install.sh'), 'utf8');
    await writeFile(join(dir, 'lib.sh'), script.slice(0, script.indexOf('case "${1:-install}"')));
    await run('git', ['-C', dir, 'init', '-q']);
    const fetchPinned = async origin => {
      await run('git', ['-C', dir, 'config', 'remote.origin.url', origin]);
      await rm(join(dir, 'curl.log'), { force: true }); await rm(join(dir, 'share'), { recursive: true, force: true });
      const { stdout } = await run('bash', ['--noprofile', '--norc', '-c', 'source "$1"; fetch_pinned android', 'bash', join(dir, 'lib.sh')], { env: { PATH: `${join(dir, 'bin')}:${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: dir, XDG_DATA_HOME: join(dir, 'share') } });
      return { path: stdout.trim(), calls: await readFile(join(dir, 'curl.log'), 'utf8').catch(() => '') };
    };

    const github = 'https://github.com/locusrifle/imperfect';
    const fromGitHub = await fetchPinned(github);
    assert.equal(fromGitHub.calls.trim().split(' ').pop(), `https://github.com/locusrifle/imperfect/releases/download/binaries/${file}`);
    assert.doesNotMatch(fromGitHub.calls, /-u /);
    assert.equal(await readFile(fromGitHub.path, 'utf8'), 'apk bytes');

    await writeFile(bytes, 'tampered');
    const refused = await fetchPinned(github).catch(e => e);
    assert.match(refused.stderr, /checksum failed/);

    await writeFile(bytes, 'apk bytes');
    const key = `ic_${'a'.repeat(40)}`;
    const fromStore = await fetchPinned(`https://buyer:${key}@store.test/imperfect.git`);
    assert.match(fromStore.calls, new RegExp(`-u buyer:${key} .*https://store\\.test/download/${file}`));
    assert.equal(await readFile(fromStore.path, 'utf8'), 'apk bytes');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
