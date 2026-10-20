import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { clientFiles, stageClient } from './stage.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'imperfect-package-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), output = join(base, 'artifacts');
  const client = join(root, 'desktop', 'client');
  await mkdir(join(client, 'build'), { recursive: true });
  for (const name of clientFiles) await writeFile(join(client, name), '// client fixture\n');
  await writeFile(join(client, 'package.json'), JSON.stringify({ main: 'main.mjs', dependencies: { ws: '8.21.3' } }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3', dependencies: { ws: '8.21.3' } }));
  await writeFile(join(root, 'LICENSE'), 'license');
  await writeFile(join(client, 'build', 'icon.png'), 'icon');
  await mkdir(join(root, 'node_modules', 'ws', 'lib'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'ws', 'package.json'), JSON.stringify({ version: '8.21.3' }));
  await writeFile(join(root, 'node_modules', 'ws', 'lib', 'websocket.js'), '// ws fixture');
  return { root, output, client };
}
test('standalone staging includes only client allowlist, license, icon and root ws', async t => {
  const { root, output, client } = await fixture(t);
  await writeFile(join(client, '.env'), 'DO NOT COPY');
  await writeFile(join(client, 'grant.enc'), 'DO NOT COPY');
  await mkdir(join(root, 'system'), { recursive: true });
  await writeFile(join(root, 'system', 'start.mjs'), 'DO NOT COPY');
  const stage = await stageClient(root, output);
  assert.deepEqual((await readdir(stage)).sort(), [...clientFiles, 'LICENSE', 'icon.png', 'node_modules'].sort());
  assert.deepEqual(await readdir(join(stage, 'node_modules')), ['ws']);
  const manifest = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'));
  assert.equal(manifest.main, 'main.mjs');
  assert.equal(manifest.version, '1.2.3');
  assert.equal(await readFile(join(stage, 'node_modules', 'ws', 'lib', 'websocket.js'), 'utf8'), '// ws fixture');
});
test('staging rejects repository output and output symlinks into repository', async t => {
  const { root, output } = await fixture(t);
  await assert.rejects(stageClient(root, join(root, 'dist')), /outside the repository/);
  await symlink(root, output, 'dir');
  await assert.rejects(stageClient(root, output), /symlink points inside/);
});
test('staging rejects client source symlinks', async t => {
  const { root, output, client } = await fixture(t);
  await rm(join(client, 'main.mjs'));
  await symlink(join(root, 'LICENSE'), join(client, 'main.mjs'));
  await assert.rejects(stageClient(root, output), /Not a regular source file/);
});
test('staging rejects a shared root node_modules symlink', async t => {
  const { root, output } = await fixture(t);
  const shared = join(output, 'shared');
  await mkdir(shared, { recursive: true });
  await rm(join(root, 'node_modules'), { recursive: true });
  await symlink(shared, join(root, 'node_modules'), 'dir');
  await assert.rejects(stageClient(root, output), /independently installed/);
});
test('staging rejects mismatched ws and dependency symlinks', async t => {
  const { root, output } = await fixture(t);
  const ws = join(root, 'node_modules', 'ws');
  await writeFile(join(ws, 'package.json'), '{"version":"0.0.0"}');
  await assert.rejects(stageClient(root, output), /ws version must match/);
  await writeFile(join(ws, 'package.json'), '{"version":"8.21.3"}');
  await symlink(join(root, 'LICENSE'), join(ws, 'secret'));
  await assert.rejects(stageClient(root, output), /symlink in ws/);
});
test('builder isolates renter identity, pins Electron and supports unsigned tester targets', () => {
  const config = createRequire(import.meta.url)('./builder.cjs');
  assert.equal(config.appId, 'computer.imperfect.client');
  assert.equal(config.electronVersion, '44.5.1');
  assert.deepEqual(config.linux.target, ['AppImage', 'deb']);
  assert.deepEqual(config.win.target, ['nsis']);
  assert.deepEqual(config.mac.target, ['zip', 'dmg']);
  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.win.signExecutable, false);
  assert.notEqual(config.win.signAndEditExecutable, false);
  assert.equal(config.npmRebuild, false);
  assert.equal(config.publish, null);
  assert.deepEqual(config.protocols[0].schemes, ['imperfect']);
});
