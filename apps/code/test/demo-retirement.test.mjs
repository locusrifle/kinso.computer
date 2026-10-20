import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES } from '../../../tools/test-run.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const json = async name => JSON.parse(await readFile(join(root, name), 'utf8'));

test('the retired repository demo has no source directory or package wiring', async () => {
  await assert.rejects(stat(join(root, 'demo')), { code: 'ENOENT' });
  const { scripts } = await json('package.json');
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(name, /demo|glm|relay/i, name);
    assert.doesNotMatch(command, /(?:^|[\s/])demo\/|imperfect-ovh-(?:model|forward)/, name);
  }
  assert.equal(scripts.test, 'node tools/test-run.mjs');
  assert.deepEqual(SUITES, ['apps/code/native/test', 'apps/code/test', 'locker/test', 'desktop/client/build']);
});

async function* sources(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', '.git', '.gradle'].includes(entry.name)) yield* sources(path);
    else if (entry.isFile() && /\.(?:mjs|cjs|js|ts)$/.test(entry.name)) yield path;
  }
}

test('core, build tools and tests do not import or load retired demo source', async () => {
  for (const dir of ['apps', 'desktop', 'locker', 'phone', 'system', 'tools']) {
    for await (const path of sources(join(root, dir))) {
      const source = await readFile(path, 'utf8');
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bnew URL\s*\(\s*)['"]([^'"\n]+)['"]/g)) {
        assert.ok(!match[1].split('/').includes('demo'), `${path}: retired source reference ${match[1]}`);
      }
    }
  }
});

test('the MIT public core, installer and desktop entrypoints remain available without the demo', async () => {
  const pkg = await json('package.json');
  const lock = await json('package-lock.json');
  assert.equal(pkg.license, 'MIT');
  assert.match(await readFile(join(root, 'LICENSE'), 'utf8'), /MIT License/);
  assert.deepEqual(pkg.dependencies, lock.packages[''].dependencies);
  assert.deepEqual(pkg.devDependencies, lock.packages[''].devDependencies);
  assert.equal(pkg.scripts.start, 'node system/start.mjs');
  assert.equal(pkg.scripts['start:website'], 'node tools/serve.mjs');
  assert.equal(pkg.scripts['start:locker'], 'node locker/start.mjs');
  for (const platform of ['linux', 'win', 'mac']) {
    assert.equal(pkg.scripts[`desktop:${platform}`], `node desktop/client/build/package.mjs ${platform}`);
  }
  for (const path of ['install.sh', 'locker/public/install.sh', 'system/start.mjs', 'system/machine.mjs',
    'desktop/client/build/package.mjs', 'desktop/client/build/stage.mjs', 'desktop/mac/install.mjs',
    'tools/serve.mjs', 'website/index.html', 'locker/start.mjs', 'phone/app/build.gradle.kts']) {
    assert.ok((await stat(join(root, path))).isFile(), path);
  }
});
